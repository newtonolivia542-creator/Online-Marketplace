// Seller Insights: the paid business-numbers tool. The math and tier rules are in
// insightsMath.js; this file reads the data, sells the subscription, and runs the
// AI summary.
//
// What lives where:
//   sellerInsights/{uid}      the seller's Insights subscription (tier, status,
//                             Stripe ids). Written ONLY here; server-only to read.
//   insightsUsage/{uid}_{ym}  AI summaries used this calendar month (US Central).
//   insightsReports/{uid}     the last AI summary, reused for a few hours so
//                             repeat taps don't cost another one.
//
// Insights is a SEPARATE Stripe subscription from the listing plan, on the same
// Stripe customer, so one "Card & invoices" page shows both. Its subscriptions
// carry metadata.kind = "insights"; listing-plan subscriptions carry metadata.plan
// instead, so each handler ignores the other's.

const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const plans = require("./plans");
const pm = require("./planMath");
const promo = require("./promoMath");
const im = require("./insightsMath");

const { PlanError, endpoint, notify, loadPlanDoc, ensureCustomer, stripeClient, originOf } = plans;

const db = () => admin.firestore();
const serverTime = () => admin.firestore.FieldValue.serverTimestamp();

const withStripe = { secrets: ["STRIPE_SECRET_KEY", "APP_URL"] };
const withAi = { secrets: ["OPENAI_API_KEY"] };

// A saved summary is reused for this long instead of making (and counting) a new one.
const REPORT_REUSE_MS = 6 * 60 * 60 * 1000;

async function loadConfig() {
  const snap = await db().collection("publicConfig").doc("insights").get();

  return im.resolveConfig(snap.exists ? snap.data() : null);
}

const loadInsightsDoc = async (uid) => {
  const snap = await db().collection("sellerInsights").doc(uid).get();

  return snap.exists ? snap.data() : null;
};

// What this seller gets right now, and where it comes from.
async function entitlement(uid, cfg) {
  const [insightsDoc, planDoc] = await Promise.all([loadInsightsDoc(uid), loadPlanDoc(uid)]);
  const listingPlan = pm.effectivePlan(planDoc);
  const tier = im.effectiveTier(insightsDoc, listingPlan, cfg);
  const bought = im.purchasedTier(insightsDoc);

  const included = cfg.bundled[listingPlan] || "none";

  // True when the listing plan, not a purchase, is what gives them this tier.
  const includedByPlan = included !== "none" && im.TIER_ORDER.indexOf(included) > im.TIER_ORDER.indexOf(bought);

  return { tier, bought, listingPlan, insightsDoc, includedByPlan };
}

const hasLiveSubscription = (doc) => doc && doc.stripeSubscriptionId && pm.PAID_STATUSES.has(doc.status);

// ---------------------------------------------------------------- the data

const rowsOf = (snap) => snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

// Everything the numbers are built from, for one seller. Orders and messages are
// capped so one very busy store can't make a request slow.
async function loadData(uid, wantMarket) {
  const [products, orders, messages, reviews] = await Promise.all([
    db().collection("products").where("sellerId", "==", uid).get().then(rowsOf),
    db().collection("sellerOrders").where("sellerId", "==", uid).limit(3000).get().then(rowsOf),
    wantMarket ? db().collection("messages").where("receiverId", "==", uid).limit(2000).get().then(rowsOf) : [],
    wantMarket ? db().collection("reviews").where("sellerId", "==", uid).limit(2000).get().then(rowsOf) : [],
  ]);

  let market = [];

  if (wantMarket) {
    const categories = [...new Set(products.map((p) => p.category).filter(Boolean))].slice(0, 10);

    const lists = await Promise.all(
      categories.map((category) =>
        db().collection("products").where("category", "==", category).select("sellerId", "category", "price", "quantity", "hiddenByPlan").limit(300).get().then(rowsOf)
      )
    );

    market = lists.flat();
  }

  return { products, orders, messages, reviews, market };
}

function buildInsights(uid, tier, data, nowMs) {
  const months = im.salesByMonth(data.orders, nowMs, 6);

  const insights = {
    generatedAt: nowMs,
    salesByMonth: months,
    monthOverMonth: im.monthOverMonth(months),
    performance: im.performance(data.products, data.orders, nowMs, 30),
    liveListings: data.products.filter(im.isLive).length,
  };

  if (im.hasTier(tier, "pro")) {
    insights.priceCheck = im.priceCheck(uid, data.products, data.market);
    insights.interest = im.interest(data.products, data.messages, data.reviews, uid, nowMs, 30);
  }

  return insights;
}

// ---------------------------------------------------------------- endpoints

function statusBody(ent, cfg, usedSummaries) {
  const doc = ent.insightsDoc;

  return {
    tier: ent.tier,
    bought: ent.bought,
    includedByPlan: ent.includedByPlan,
    tiers: Object.fromEntries(Object.entries(cfg.tiers).map(([key, tier]) => [key, { name: tier.name, priceCents: tier.priceCents }])),
    subscription: doc && doc.stripeSubscriptionId
      ? { tier: doc.tier, status: doc.status, currentPeriodEnd: doc.currentPeriodEnd || null, cancelAtPeriodEnd: doc.cancelAtPeriodEnd === true }
      : null,
    aiSummariesLeft: Math.max(0, cfg.aiSummariesPerMonth - usedSummaries),
    aiSummariesPerMonth: cfg.aiSummariesPerMonth,
  };
}

async function summariesUsed(uid, nowMs = Date.now()) {
  const snap = await db().collection("insightsUsage").doc(`${uid}_${promo.monthKey(nowMs)}`).get();

  return snap.exists ? snap.data().used || 0 : 0;
}

// Cheap: just the tier and prices, for the dashboard tile and the pitch.
const insightsStatus = endpoint({}, async ({ user }) => {
  const cfg = await loadConfig();
  const ent = await entitlement(user.uid, cfg);

  return statusBody(ent, cfg, await summariesUsed(user.uid));
});

// The numbers. A seller without a tier gets the pitch (locked) instead of data.
const getInsights = endpoint({}, async ({ user }) => {
  const cfg = await loadConfig();
  const ent = await entitlement(user.uid, cfg);
  const status = statusBody(ent, cfg, await summariesUsed(user.uid));

  if (!im.hasTier(ent.tier, "plus")) return { locked: true, ...status };

  const nowMs = Date.now();
  const data = await loadData(user.uid, im.hasTier(ent.tier, "pro"));

  return { locked: false, ...status, insights: buildInsights(user.uid, ent.tier, data, nowMs) };
});

const insightsProductId = (tier) => `lesovia_insights_${tier}`;

async function ensureStripeProduct(stripe, tier, cfgTier) {
  const id = insightsProductId(tier);

  try {
    await stripe.products.retrieve(id);
  } catch (error) {
    if (error.code !== "resource_missing") throw error;

    await stripe.products.create({ id, name: `Lesovia ${cfgTier.name}`, metadata: { kind: "insights", tier } });
  }

  return id;
}

// Start Insights (Stripe Checkout), or switch an existing Insights subscription to
// the other tier, prorated.
const chooseInsights = endpoint(withStripe, async ({ user, body }) => {
  const tier = body.tier;
  const cfg = await loadConfig();

  if (!cfg.tiers[tier]) throw new PlanError("Choose Insights Plus or Insights Pro.");

  const ent = await entitlement(user.uid, cfg);
  const doc = ent.insightsDoc;

  if (im.TIER_ORDER.indexOf(ent.tier) >= im.TIER_ORDER.indexOf(tier) && !(ent.bought === tier && doc && doc.cancelAtPeriodEnd)) {
    throw new PlanError(ent.includedByPlan ? "That's already included with your listing plan." : "You already have that.");
  }

  const stripe = stripeClient();
  const productId = await ensureStripeProduct(stripe, tier, cfg.tiers[tier]);
  const priceData = { currency: "usd", product: productId, unit_amount: cfg.tiers[tier].priceCents, recurring: { interval: "month" } };
  const metadata = { kind: "insights", sellerId: user.uid, insightsTier: tier };

  if (hasLiveSubscription(doc)) {
    const sub = await stripe.subscriptions.retrieve(doc.stripeSubscriptionId);

    const updated = await stripe.subscriptions.update(sub.id, {
      items: [{ id: sub.items.data[0].id, price_data: priceData }],
      proration_behavior: "create_prorations",
      cancel_at_period_end: false,
      metadata,
    });

    await applyInsightsSubscription(updated, Math.floor(Date.now() / 1000));

    return { updated: true };
  }

  const customer = await ensureCustomer(stripe, user.uid, user.email, await loadPlanDoc(user.uid));
  const origin = originOf();

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ quantity: 1, price_data: priceData }],
    subscription_data: { metadata },
    metadata,
    success_url: `${origin}/seller-insights.html?checkout=success`,
    cancel_url: `${origin}/seller-insights.html?checkout=cancelled`,
  });

  return { url: session.url };
});

// Cancel at the end of the paid period, or take that back.
const setInsightsCancel = endpoint(withStripe, async ({ user, body }) => {
  const doc = await loadInsightsDoc(user.uid);

  if (!hasLiveSubscription(doc)) throw new PlanError("You don't have an Insights subscription.");

  const cancel = body.cancel !== false;

  await stripeClient().subscriptions.update(doc.stripeSubscriptionId, { cancel_at_period_end: cancel });
  await db().collection("sellerInsights").doc(user.uid).set({ cancelAtPeriodEnd: cancel }, { merge: true });

  return { cancelAtPeriodEnd: cancel };
});

// ---------------------------------------------------------------- billing

const periodEndOf = (sub) => {
  const seconds = sub.current_period_end ?? (sub.items && sub.items.data[0] && sub.items.data[0].current_period_end);

  return seconds ? seconds * 1000 : null;
};

// Writes an Insights subscription from Stripe into sellerInsights/{uid}. Shared by
// the webhook and the sync-on-return, so both end in the same state.
async function applyInsightsSubscription(sub, eventCreated, deleted = false) {
  const meta = sub.metadata || {};
  const uid = meta.sellerId;
  const tier = meta.insightsTier;

  if (meta.kind !== "insights" || !uid || !["plus", "pro"].includes(tier)) return;

  const ref = db().collection("sellerInsights").doc(uid);
  const before = (await ref.get()).data() || {};

  if (before.lastEventCreated && eventCreated < before.lastEventCreated) return;

  const ended = deleted || sub.status === "canceled";

  // A duplicate subscription ending must not end the one still paying.
  if (ended && before.stripeSubscriptionId && before.stripeSubscriptionId !== sub.id && pm.PAID_STATUSES.has(before.status)) return;

  await ref.set(
    {
      tier,
      status: ended ? "canceled" : sub.status,
      stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer && sub.customer.id,
      stripeSubscriptionId: sub.id,
      currentPeriodEnd: periodEndOf(sub),
      cancelAtPeriodEnd: sub.cancel_at_period_end === true,
      lastEventCreated: eventCreated,
      updatedAt: serverTime(),
    },
    { merge: true }
  );

  const cfg = await loadConfig();
  const was = im.purchasedTier(before);
  const now = ended ? "none" : im.purchasedTier({ tier, status: sub.status });

  if (was !== now) {
    await notify(uid, {
      type: "insights_changed",
      title: now === "none" ? "Your Insights subscription ended" : `You have ${cfg.tiers[now].name}`,
      message: now === "none" ? "Your business numbers are locked again. Subscribe any time to unlock them." : "Your business numbers are ready on the Insights page.",
      link: "seller-insights.html",
    });
  }
}

// customer.subscription.* from Lesovia's own account. Not ours (no kind, or from a
// connected account) -> ignored.
async function handleInsightsEvent(stripe, event) {
  if (event.account || event.type === "invoice.payment_failed") return;

  await applyInsightsSubscription(event.data.object, event.created, event.type === "customer.subscription.deleted");
}

// Asks Stripe what this seller's Insights subscription is and records it: the
// safety net for a webhook that isn't set up, run when the seller lands back from
// checkout. Prefers a subscription that isn't set to cancel, then the newest.
async function syncFromStripe(stripe, uid) {
  const planDoc = await loadPlanDoc(uid);
  const doc = await loadInsightsDoc(uid);
  const customer = (doc && doc.stripeCustomerId) || (planDoc && planDoc.stripeCustomerId);

  if (!customer) return;

  const list = await stripe.subscriptions.list({ customer, status: "all", limit: 20 });

  const ours = list.data.filter((sub) => sub.metadata && sub.metadata.kind === "insights" && sub.metadata.sellerId === uid && ["plus", "pro"].includes(sub.metadata.insightsTier));

  const paid = ours
    .filter((sub) => pm.PAID_STATUSES.has(sub.status))
    .sort((a, b) => (a.cancel_at_period_end ? 1 : 0) - (b.cancel_at_period_end ? 1 : 0) || b.created - a.created);

  const chosen = paid[0] || ours.sort((a, b) => b.created - a.created)[0];

  if (chosen) await applyInsightsSubscription(chosen, Math.floor(Date.now() / 1000));
}

const syncInsights = endpoint(withStripe, async ({ user }) => {
  await syncFromStripe(stripeClient(), user.uid);

  const cfg = await loadConfig();
  const ent = await entitlement(user.uid, cfg);

  return { tier: ent.tier };
});

// ------------------------------------------------------------- AI summary

// Makes (or reuses) the seller's AI summary. `callModel(prompt)` returns the text;
// it is passed in so tests can run without OpenAI. A summary uses one of the
// month's allowance only when a NEW one is made, and the use is given back if
// the model call fails.
async function makeSummary({ uid, facts, cfg, callModel, nowMs = Date.now() }) {
  const reportRef = db().collection("insightsReports").doc(uid);
  const usageRef = db().collection("insightsUsage").doc(`${uid}_${promo.monthKey(nowMs)}`);

  const report = await reportRef.get();

  if (report.exists && nowMs - report.data().createdAtMs < REPORT_REUSE_MS) {
    return { text: report.data().text, cached: true, createdAtMs: report.data().createdAtMs };
  }

  await db().runTransaction(async (tx) => {
    const usage = await tx.get(usageRef);
    const used = usage.exists ? usage.data().used || 0 : 0;

    if (used >= cfg.aiSummariesPerMonth) {
      throw new PlanError(`You've used your ${cfg.aiSummariesPerMonth} AI summaries for this month. They reset on the 1st.`);
    }

    tx.set(usageRef, { sellerId: uid, used: used + 1, updatedAt: serverTime() }, { merge: true });
  });

  let text;

  try {
    text = String(await callModel(im.summaryPrompt(facts)) || "").trim();

    if (!text) throw new Error("The AI returned nothing.");
  } catch (error) {
    logger.error("AI summary failed:", error);

    // Give the use back: they didn't get a summary.
    await db().runTransaction(async (tx) => {
      const usage = await tx.get(usageRef);

      tx.set(usageRef, { used: Math.max(0, (usage.data().used || 1) - 1) }, { merge: true });
    });

    throw new PlanError("The AI summary isn't available right now. You weren't charged a summary; please try again in a few minutes.", 503);
  }

  await reportRef.set({ text, createdAtMs: nowMs, createdAt: serverTime() });

  return { text, cached: false, createdAtMs: nowMs };
}

async function callOpenAi(prompt) {
  const OpenAI = require("openai").default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.responses.create({ model: "gpt-5.5", input: prompt });

  return response.output_text;
}

const insightsSummary = endpoint(withAi, async ({ user }) => {
  const cfg = await loadConfig();
  const ent = await entitlement(user.uid, cfg);

  if (!im.hasTier(ent.tier, "pro")) throw new PlanError("The AI summary is part of Insights Pro.", 403);

  const nowMs = Date.now();
  const data = await loadData(user.uid, true);
  const facts = im.summaryFacts(buildInsights(user.uid, ent.tier, data, nowMs));

  const result = await makeSummary({ uid: user.uid, facts, cfg, callModel: callOpenAi, nowMs });

  return { ...result, aiSummariesLeft: Math.max(0, cfg.aiSummariesPerMonth - (await summariesUsed(user.uid, nowMs))) };
});

module.exports = {
  entitlement,
  buildInsights,
  loadData,
  applyInsightsSubscription,
  handleInsightsEvent,
  syncFromStripe,
  makeSummary,
  insightsStatus,
  getInsights,
  chooseInsights,
  setInsightsCancel,
  syncInsights,
  insightsSummary,
};
