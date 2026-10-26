// Seller plans: the live-listing limit, Stripe Billing subscriptions, and the
// sweep that applies the free-year change. The rules and math are in
// planMath.js; this file reads and writes Firestore and talks to Stripe.
//
// What lives where:
//   sellerPlans/{uid}      written ONLY here (Admin SDK); the owner may read it.
//                          { plan, status, stripeCustomerId, stripeSubscriptionId,
//                            currentPeriodEnd, cancelAtPeriodEnd, lastEventCreated }
//   products/{id}          hiddenByPlan is set ONLY here. Over the limit, listings
//                          are hidden (never deleted) and return when there's room.
//   publicConfig/plans     optional overrides for the dates, limits and prices;
//                          anything missing falls back to planMath.DEFAULTS.
//
// Subscriptions are billed on Lesovia's own Stripe account (not a seller's
// connected account). Prices are passed inline with each request, so nothing has
// to be created in the Stripe dashboard first; each plan gets one Stripe
// Product with a fixed id the first time it's used.

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const Stripe = require("stripe");
const admin = require("firebase-admin");

const pm = require("./planMath");

const db = () => admin.firestore();
const serverTime = () => admin.firestore.FieldValue.serverTimestamp();

class PlanError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const stripeClient = () => Stripe(process.env.STRIPE_SECRET_KEY);
const withStripe = { secrets: ["STRIPE_SECRET_KEY", "APP_URL"] };

// ---------------------------------------------------------------- plumbing

async function authenticate(req) {
  const match = (req.headers.authorization || "").match(/^Bearer (.+)$/);

  if (!match) throw new PlanError("Authentication required.", 401);

  let decoded;

  try {
    decoded = await admin.auth().verifyIdToken(match[1]);
  } catch (error) {
    throw new PlanError("Authentication required.", 401);
  }

  const snap = await db().collection("users").doc(decoded.uid).get();
  const user = snap.exists ? snap.data() : {};

  if (user.role !== "seller") throw new PlanError("Only sellers have a plan.", 403);

  return { uid: decoded.uid, email: decoded.email || user.email || null };
}

function endpoint(options, handler) {
  return onRequest({ cors: true, ...options }, async (req, res) => {
    try {
      const user = await authenticate(req);
      const body = await handler({ user, body: req.body || {} });

      res.send(body);
    } catch (error) {
      if (error instanceof PlanError) return res.status(error.status).send({ error: error.message });

      logger.error(error);
      res.status(500).send({ error: "Something went wrong. Please try again." });
    }
  });
}

async function loadConfig() {
  const snap = await db().collection("publicConfig").doc("plans").get();

  return pm.resolveConfig(snap.exists ? snap.data() : null);
}

async function loadPlanDoc(uid) {
  const snap = await db().collection("sellerPlans").doc(uid).get();

  return snap.exists ? snap.data() : null;
}

const productRow = (docSnap) => {
  const data = docSnap.data();

  return { id: docSnap.id, quantity: data.quantity, hiddenByPlan: data.hiddenByPlan === true, createdAt: data.createdAt, name: data.name, price: data.price };
};

async function loadProducts(uid) {
  const snap = await db().collection("products").where("sellerId", "==", uid).get();

  return snap.docs.map(productRow);
}

async function notify(userId, { type, title, message, link }) {
  await db().collection("notifications").doc().set({
    userId, type, title, message, link, read: false, createdAt: serverTime(),
  });
}

const originOf = () => new URL(process.env.APP_URL).origin;

// ---------------------------------------------------------- listing limit

// Brings one seller's listings in line with their plan, atomically (so two
// product writes at once can't both decide the same thing). Idempotent: when
// nothing needs to change it writes nothing. Notifies the seller afterwards,
// outside the transaction, if listings were hidden or brought back.
async function reconcileSeller(uid, nowMs = Date.now()) {
  const cfg = await loadConfig();

  const outcome = await db().runTransaction(async (tx) => {
    const planSnap = await tx.get(db().collection("sellerPlans").doc(uid));
    const productsSnap = await tx.get(db().collection("products").where("sellerId", "==", uid));

    const plan = pm.effectivePlan(planSnap.exists ? planSnap.data() : null);
    const limit = pm.limitFor(plan, cfg, nowMs);
    const { hide, show } = pm.planVisibility(productsSnap.docs.map(productRow), limit);

    for (const doc of productsSnap.docs) {
      if (hide.includes(doc.id)) tx.update(doc.ref, { hiddenByPlan: true });
      else if (show.includes(doc.id)) tx.update(doc.ref, { hiddenByPlan: false });
    }

    return { hide, show, limit };
  });

  if (outcome.hide.length > 0) {
    await notify(uid, {
      type: "listings_hidden",
      title: "Some listings are hidden",
      message: `Your plan allows ${outcome.limit} live listing${outcome.limit === 1 ? "" : "s"}, so ${outcome.hide.length} ${outcome.hide.length === 1 ? "is" : "are"} hidden from buyers. Nothing was deleted. Choose which ones stay live, or upgrade to show them all.`,
      link: "seller-plan.html",
    });
  }

  if (outcome.show.length > 0) {
    await notify(uid, {
      type: "listings_restored",
      title: "Listings are live again",
      message: `${outcome.show.length} hidden listing${outcome.show.length === 1 ? " is" : "s are"} visible to buyers again.`,
      link: "seller-plan.html",
    });
  }

  return outcome;
}

// Any change that can alter what counts toward a limit: a listing created or
// deleted, or one going out of / back into stock. Everything else (price edits,
// our own hiddenByPlan writes) is ignored, which also stops this from
// triggering itself.
const reconcileOnProductWrite = onDocumentWritten("products/{productId}", async (event) => {
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after = event.data.after.exists ? event.data.after.data() : null;

  const seller = (after && after.sellerId) || (before && before.sellerId);

  if (!seller) return;

  const stockChanged = before && after && pm.inStock(before) !== pm.inStock(after);

  if (before && after && !stockChanged && before.sellerId === after.sellerId) return;

  await reconcileSeller(seller);

  if (before && after && before.sellerId !== after.sellerId) await reconcileSeller(before.sellerId);
});

// ------------------------------------------------------------- endpoints

const status = endpoint({}, async ({ user }) => {
  const cfg = await loadConfig();
  const planDoc = await loadPlanDoc(user.uid);
  const products = await loadProducts(user.uid);
  const nowMs = Date.now();

  return {
    ...pm.planStatus({ planDoc, products, cfg, nowMs }),
    canAddMore: pm.limitFor(pm.effectivePlan(planDoc), cfg, nowMs) > products.filter(pm.inStock).filter((p) => !p.hiddenByPlan).length,
    subscription: planDoc && planDoc.stripeSubscriptionId
      ? {
          plan: planDoc.plan,
          status: planDoc.status,
          currentPeriodEnd: planDoc.currentPeriodEnd || null,
          cancelAtPeriodEnd: planDoc.cancelAtPeriodEnd === true,
        }
      : null,
    tiers: Object.fromEntries(
      Object.entries(cfg.tiers).map(([key, tier]) => [key, { name: tier.name, maxItems: tier.maxItems, priceCents: tier.priceCents }])
    ),
    listings: products.filter(pm.inStock).map((p) => ({ id: p.id, name: p.name || "Untitled", price: p.price, hidden: p.hiddenByPlan })),
  };
});

async function ensureProduct(stripe, plan, tier) {
  const id = `lesovia_plan_${plan}`;

  try {
    await stripe.products.retrieve(id);
  } catch (error) {
    if (error.code !== "resource_missing") throw error;

    await stripe.products.create({ id, name: `Lesovia ${tier.name} seller plan`, metadata: { plan } });
  }

  return id;
}

async function ensureCustomer(stripe, uid, email, planDoc) {
  if (planDoc && planDoc.stripeCustomerId) return planDoc.stripeCustomerId;

  const customer = await stripe.customers.create({ email: email || undefined, metadata: { sellerId: uid } });

  await db().collection("sellerPlans").doc(uid).set({ stripeCustomerId: customer.id }, { merge: true });

  return customer.id;
}

const hasLiveSubscription = (planDoc) =>
  planDoc && planDoc.stripeSubscriptionId && pm.PAID_STATUSES.has(planDoc.status);

// Start a plan (Stripe Checkout), or switch an existing subscription to another
// plan, prorated. Moving to a plan with a lower limit is refused until the
// seller is under it.
const choosePlan = endpoint(withStripe, async ({ user, body }) => {
  const plan = body.plan;
  const cfg = await loadConfig();

  if (!cfg.tiers[plan]) throw new PlanError("Choose Plus, Pro or Unlimited.");

  const planDoc = await loadPlanDoc(user.uid);
  const current = pm.effectivePlan(planDoc);

  if (current === plan && !(planDoc && planDoc.cancelAtPeriodEnd)) throw new PlanError("You're already on that plan.");

  const nowMs = Date.now();
  const products = await loadProducts(user.uid);
  const visible = products.filter(pm.inStock).filter((p) => !p.hiddenByPlan).length;

  if (pm.ranked(plan) < pm.ranked(current)) {
    const blocked = pm.downgradeError(visible, plan, cfg, nowMs);

    if (blocked) throw new PlanError(blocked);
  }

  const stripe = stripeClient();
  const tier = cfg.tiers[plan];
  const productId = await ensureProduct(stripe, plan, tier);
  const priceData = { currency: "usd", product: productId, unit_amount: tier.priceCents, recurring: { interval: "month" } };

  if (hasLiveSubscription(planDoc)) {
    const sub = await stripe.subscriptions.retrieve(planDoc.stripeSubscriptionId);

    const updated = await stripe.subscriptions.update(sub.id, {
      items: [{ id: sub.items.data[0].id, price_data: priceData }],
      proration_behavior: "create_prorations",
      cancel_at_period_end: false,
      metadata: { sellerId: user.uid, plan },
    });

    // Record the switch now rather than waiting for Stripe's webhook to say so.
    await applySubscription(updated, Math.floor(Date.now() / 1000));

    return { updated: true };
  }

  const customer = await ensureCustomer(stripe, user.uid, user.email, planDoc);
  const origin = originOf();

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ quantity: 1, price_data: priceData }],
    subscription_data: { metadata: { sellerId: user.uid, plan } },
    metadata: { sellerId: user.uid, plan },
    success_url: `${origin}/seller-plan.html?checkout=success`,
    cancel_url: `${origin}/seller-plan.html?checkout=cancelled`,
  });

  return { url: session.url };
});

// Cancel at the end of the paid period (the seller keeps what they paid for),
// or take that back.
const setCancel = endpoint(withStripe, async ({ user, body }) => {
  const planDoc = await loadPlanDoc(user.uid);

  if (!hasLiveSubscription(planDoc)) throw new PlanError("You don't have a paid plan.");

  const cancel = body.cancel !== false;

  await stripeClient().subscriptions.update(planDoc.stripeSubscriptionId, { cancel_at_period_end: cancel });

  await db().collection("sellerPlans").doc(user.uid).set({ cancelAtPeriodEnd: cancel }, { merge: true });

  return { cancelAtPeriodEnd: cancel };
});

// Stripe's hosted page for updating the card and downloading invoices.
const billingPortal = endpoint(withStripe, async ({ user }) => {
  const planDoc = await loadPlanDoc(user.uid);

  if (!planDoc || !planDoc.stripeCustomerId) throw new PlanError("You don't have any billing yet.");

  const session = await stripeClient().billingPortal.sessions.create({
    customer: planDoc.stripeCustomerId,
    return_url: `${originOf()}/seller-plan.html`,
  });

  return { url: session.url };
});

// The seller picks which listings are visible. Always exactly their choice:
// every other in-stock listing is hidden.
const chooseLive = endpoint({}, async ({ user, body }) => {
  const cfg = await loadConfig();
  const planDoc = await loadPlanDoc(user.uid);
  const limit = pm.limitFor(pm.effectivePlan(planDoc), cfg, Date.now());

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(db().collection("products").where("sellerId", "==", user.uid));
    const rows = snap.docs.map(productRow);

    const problem = pm.validateChoice(body.productIds, rows, limit);

    if (problem) throw new PlanError(problem);

    const { hide, show } = pm.applyChoice(body.productIds, rows);

    for (const doc of snap.docs) {
      if (hide.includes(doc.id)) tx.update(doc.ref, { hiddenByPlan: true });
      else if (show.includes(doc.id)) tx.update(doc.ref, { hiddenByPlan: false });
    }
  });

  return { ok: true };
});

// ---------------------------------------------------------------- webhook

const periodEndOf = (sub) => {
  const seconds = sub.current_period_end ?? (sub.items && sub.items.data[0] && sub.items.data[0].current_period_end);

  return seconds ? seconds * 1000 : null;
};

// customer.subscription.* and invoice.payment_failed from Lesovia's own
// Stripe account. Anything that isn't one of our plan subscriptions (no
// sellerId in its metadata, or an event from a connected account) is ignored.
async function handlePlanEvent(stripe, event) {
  if (event.account) return;

  if (event.type === "invoice.payment_failed") return handlePaymentFailed(event);

  await applySubscription(event.data.object, event.created, event.type === "customer.subscription.deleted");
}

// Writes a Stripe subscription into sellerPlans/{uid}, tells the seller if their
// plan changed, and brings their listings in line. Shared by the webhook and by
// syncFromStripe, so both end in exactly the same state.
async function applySubscription(sub, eventCreated, deleted = false) {
  const uid = sub.metadata && sub.metadata.sellerId;
  const plan = sub.metadata && sub.metadata.plan;

  if (!uid || !pm.PLAN_ORDER.includes(plan) || plan === "free") return;

  const ref = db().collection("sellerPlans").doc(uid);
  const before = (await ref.get()).data() || {};

  // Stripe doesn't promise event order; never let an older event overwrite a newer one.
  if (before.lastEventCreated && eventCreated < before.lastEventCreated) return;

  const ended = deleted || sub.status === "canceled";

  // A second subscription for the same seller (a double checkout, say) ending
  // must not end the plan another subscription still provides.
  if (ended && before.stripeSubscriptionId && before.stripeSubscriptionId !== sub.id && pm.PAID_STATUSES.has(before.status)) return;

  await ref.set(
    {
      plan,
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
  const wasPlan = pm.effectivePlan(before);
  const nowPlan = ended ? "free" : pm.effectivePlan({ plan, status: sub.status });

  if (wasPlan !== nowPlan) {
    await notify(uid, {
      type: "plan_changed",
      title: nowPlan === "free" ? "Your paid plan ended" : `You're on the ${cfg.tiers[nowPlan].name} plan`,
      message:
        nowPlan === "free"
          ? "You're back on the free plan. Listings over your free allowance are hidden, not deleted."
          : `You can now keep ${pm.limitFor(nowPlan, cfg, Date.now()) === Infinity ? "any number of" : pm.limitFor(nowPlan, cfg, Date.now())} live listings.`,
      link: "seller-plan.html",
    });
  }

  await reconcileSeller(uid);
}

// Asks Stripe directly what this seller's subscription is, and records it. The
// webhook normally does this the moment a seller pays; this is the safety net
// for when it can't (a webhook that isn't set up, an outage), and it runs when a
// seller lands back from checkout. Only subscriptions that carry this seller's
// id in their metadata count.
async function syncFromStripe(stripe, uid) {
  const planDoc = await loadPlanDoc(uid);

  if (!planDoc || !planDoc.stripeCustomerId) return;

  const list = await stripe.subscriptions.list({ customer: planDoc.stripeCustomerId, status: "all", limit: 20 });

  const ours = list.data.filter((sub) => sub.metadata && sub.metadata.sellerId === uid && pm.PLAN_ORDER.includes(sub.metadata.plan));

  // Among the live ones, prefer a subscription that isn't set to cancel (a seller
  // who cancelled duplicates is still paying for the one they kept), then the newest.
  const paid = ours
    .filter((sub) => pm.PAID_STATUSES.has(sub.status))
    .sort((a, b) => (a.cancel_at_period_end ? 1 : 0) - (b.cancel_at_period_end ? 1 : 0) || b.created - a.created);
  const chosen = paid[0] || ours.sort((a, b) => b.created - a.created)[0];

  if (chosen) await applySubscription(chosen, Math.floor(Date.now() / 1000));
}

const syncPlan = endpoint(withStripe, async ({ user }) => {
  await syncFromStripe(stripeClient(), user.uid);

  const planDoc = await loadPlanDoc(user.uid);

  return { plan: pm.effectivePlan(planDoc) };
});

async function handlePaymentFailed(event) {
  const invoice = event.data.object;
  const customer = typeof invoice.customer === "string" ? invoice.customer : invoice.customer && invoice.customer.id;

  if (!customer) return;

  const snap = await db().collection("sellerPlans").where("stripeCustomerId", "==", customer).limit(1).get();

  if (snap.empty) return; // not one of our plan customers

  await notify(snap.docs[0].id, {
    type: "plan_payment_failed",
    title: "Your plan payment didn't go through",
    message: "We couldn't charge your card for your Lesovia plan. Update your payment method to keep your listings live.",
    link: "seller-plan.html",
  });
}

// ------------------------------------------------------------------ sweep

const HEADS_UP_DAYS = [60, 30, 7];

// Runs just after midnight Central: applies the free-year change the moment it
// takes effect, retries anything a trigger missed, and warns free sellers who
// will lose visibility of listings 60, 30 and 7 days ahead.
const sweepListingLimits = onSchedule({ schedule: "every day 00:30", timeZone: "America/Chicago" }, async () => {
  const cfg = await loadConfig();
  const nowMs = Date.now();
  const days = pm.daysUntilFreeYearEnds(cfg, nowMs);

  const sellers = await db().collection("users").where("role", "==", "seller").get();

  for (const seller of sellers.docs) {
    try {
      await reconcileSeller(seller.id, nowMs);

      if (days !== null && days <= HEADS_UP_DAYS[0]) await sendHeadsUp(seller.id, cfg, nowMs, days);
    } catch (error) {
      logger.error(`Listing sweep failed for ${seller.id}:`, error);
    }
  }
});

async function sendHeadsUp(uid, cfg, nowMs, days) {
  const planDoc = await loadPlanDoc(uid);

  if (pm.effectivePlan(planDoc) !== "free") return;

  const products = await loadProducts(uid);
  const live = products.filter(pm.inStock).filter((p) => !p.hiddenByPlan).length;

  if (live <= cfg.freeLimitAfter) return;

  // The loosest threshold we've reached that hasn't been sent yet.
  const threshold = [...HEADS_UP_DAYS].reverse().find((t) => days <= t);

  const marker = db().collection("planNotices").doc(`${uid}_${threshold}`);

  try {
    await marker.create({ sentAt: serverTime() });
  } catch (error) {
    return; // already sent
  }

  const date = new Date(cfg.freeYearEndsAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" });

  await notify(uid, {
    type: "free_limit_changing",
    title: `Free listings drop to ${cfg.freeLimitAfter} on ${date}`,
    message: `From ${date}, free sellers keep ${cfg.freeLimitAfter} live listings. You have ${live}. Choose which ones stay live, or pick a plan to keep them all. Nothing is deleted.`,
    link: "seller-plan.html",
  });
}

module.exports = {
  PlanError,
  // shared with promotions.js
  endpoint,
  notify,
  loadPlanDoc,
  stripeClient,
  withStripe,
  originOf,
  reconcileSeller,
  reconcileOnProductWrite,
  status,
  choosePlan,
  setCancel,
  billingPortal,
  chooseLive,
  handlePlanEvent,
  syncFromStripe,
  syncPlan,
  sweepListingLimits,
};
