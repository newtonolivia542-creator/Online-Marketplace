// Promoted listings: a seller pays $5 (or uses a free promotion their plan
// includes) and one listing sits higher in the shop and search for 30 days,
// labeled "Sponsored". The rules and math are in promoMath.js.
//
// What lives where:
//   products/{id}.promotedUntil   written ONLY here (Firestore rules block clients).
//   promotions/{id}               one record per promotion bought or used. For a
//                                 paid one the id is the Stripe Checkout session id,
//                                 which is what makes applying it idempotent: the
//                                 webhook and the seller's return from checkout can
//                                 both try, and the days are added only once.
//   promotionUsage/{uid}_{YYYY-MM} free promotions used this month.
//   promotionNotices/{id}         "ending soon" reminders already sent.
//
// Payment is a one-time Stripe Checkout on Lesovia's own account.

const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const plans = require("./plans");
const pm = require("./planMath");
const promo = require("./promoMath");

const { PlanError, endpoint, notify, loadPlanDoc, stripeClient, withStripe, originOf } = plans;

const db = () => admin.firestore();
const serverTime = () => admin.firestore.FieldValue.serverTimestamp();

async function loadConfig() {
  const snap = await db().collection("publicConfig").doc("promotions").get();

  return promo.resolveConfig(snap.exists ? snap.data() : null);
}

const dateText = (ms) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });

// ----------------------------------------------------------------- applying

// Adds the promotion's days to the listing. Safe to call twice for the same
// payment: `recordId` (the Checkout session id for a paid promotion) is claimed
// inside the transaction, and a second call finds it and changes nothing.
//   source "paid"      -> recordId is the session id
//   source "allowance" -> recordId is left out; one free promotion is used up
async function applyPromotion({ sellerId, productId, source, recordId, amountCents = 0, days, nowMs = Date.now() }) {
  const cfg = await loadConfig();
  const ref = recordId ? db().collection("promotions").doc(recordId) : db().collection("promotions").doc();
  const productRef = db().collection("products").doc(productId);

  const result = await db().runTransaction(async (tx) => {
    const record = await tx.get(ref);

    if (record.exists) return { duplicate: true, until: record.data().until };

    const productSnap = await tx.get(productRef);
    const product = productSnap.exists ? productSnap.data() : null;

    if (!product || product.sellerId !== sellerId) return { missing: true };

    const currentUntil = promo.untilMillis(product.promotedUntil);

    if (source === "allowance") {
      const problem = promo.eligibleListing(product, sellerId) || promo.canPromote(currentUntil, nowMs, cfg);

      if (problem) throw new PlanError(problem);

      const planSnap = await tx.get(db().collection("sellerPlans").doc(sellerId));
      const plan = pm.effectivePlan(planSnap.exists ? planSnap.data() : null);
      const usageRef = db().collection("promotionUsage").doc(`${sellerId}_${promo.monthKey(nowMs)}`);
      const usage = await tx.get(usageRef);
      const used = usage.exists ? usage.data().used : 0;

      if (promo.allowanceLeft(plan, used, cfg) <= 0) throw new PlanError("You've used your free promotions for this month.");

      tx.set(usageRef, { sellerId, used: used + 1, updatedAt: serverTime() }, { merge: true });
    }

    const until = promo.newUntil(currentUntil, nowMs, days);

    tx.update(productRef, { promotedUntil: admin.firestore.Timestamp.fromMillis(until) });
    tx.set(ref, { sellerId, productId, source, amountCents, days, until, createdAt: serverTime() });

    return { until, name: product.name };
  });

  if (result.missing) return result;

  if (!result.duplicate) {
    await notify(sellerId, {
      type: "listing_promoted",
      title: "Your listing is promoted",
      message: `${result.name ? `"${result.name}" is` : "Your listing is"} promoted until ${dateText(result.until)}. It's shown higher in the shop and marked Sponsored.`,
      link: "seller dashboard.html",
    });
  }

  return result;
}

// A paid Checkout session -> the promotion it bought. Checks the payment really
// went through and that the session is one of ours (mode payment, type
// "promotion"); anything else is ignored.
async function applyPaidSession(session) {
  const meta = session.metadata || {};

  if (meta.type !== "promotion" || session.mode !== "payment") return { ignored: true };
  if (session.payment_status !== "paid") return { ignored: true, unpaid: true };

  const days = Number(meta.days);

  if (!meta.sellerId || !meta.productId || !Number.isInteger(days) || days < 1) {
    logger.error(`Promotion session ${session.id} has incomplete metadata`);
    return { ignored: true };
  }

  const result = await applyPromotion({
    sellerId: meta.sellerId,
    productId: meta.productId,
    source: "paid",
    recordId: session.id,
    amountCents: session.amount_total || 0,
    days,
  });

  if (result.missing) {
    logger.error(`Promotion ${session.id} was paid but listing ${meta.productId} is gone -- refund needed`);

    await notify(meta.sellerId, {
      type: "promotion_failed",
      title: "We couldn't promote that listing",
      message: "Your payment went through but the listing no longer exists. Email support@lesovia.com and we'll refund you.",
      link: "seller dashboard.html",
    });
  }

  return result;
}

// checkout.session.completed from Lesovia's own Stripe account. Plan
// subscriptions send this event too; applyPaidSession ignores those.
async function handleCheckoutCompleted(stripe, event) {
  if (event.account) return;

  await applyPaidSession(event.data.object);
}

// ---------------------------------------------------------------- endpoints

// What a seller needs to decide how to promote: the price, and how many free
// promotions they have left this month.
const promotionStatus = endpoint({}, async ({ user }) => {
  const cfg = await loadConfig();
  const planDoc = await loadPlanDoc(user.uid);
  const plan = pm.effectivePlan(planDoc);
  const usage = await db().collection("promotionUsage").doc(`${user.uid}_${promo.monthKey(Date.now())}`).get();

  return {
    priceCents: cfg.priceCents,
    days: cfg.days,
    renewWindowDays: cfg.renewWindowDays,
    allowanceLeft: promo.allowanceLeft(plan, usage.exists ? usage.data().used : 0, cfg),
  };
});

// Start a promotion. With useAllowance the seller spends one of their free
// promotions and it starts immediately; otherwise they're sent to Stripe to pay.
const promoteListing = endpoint(withStripe, async ({ user, body }) => {
  const productId = typeof body.productId === "string" ? body.productId : "";

  if (!productId || productId.includes("/")) throw new PlanError("Choose a listing to promote.");

  const cfg = await loadConfig();
  const productSnap = await db().collection("products").doc(productId).get();
  const product = productSnap.exists ? productSnap.data() : null;
  const nowMs = Date.now();

  const problem = promo.eligibleListing(product, user.uid) || promo.canPromote(promo.untilMillis(product && product.promotedUntil), nowMs, cfg);

  if (problem) throw new PlanError(problem);

  if (body.useAllowance === true) {
    const result = await applyPromotion({ sellerId: user.uid, productId, source: "allowance", days: cfg.days, nowMs });

    if (result.missing) throw new PlanError("That listing doesn't exist.");

    return { done: true, until: result.until };
  }

  const origin = originOf();

  const session = await stripeClient().checkout.sessions.create({
    mode: "payment",
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: cfg.priceCents,
        product_data: { name: `Promote "${String(product.name || "listing").slice(0, 80)}" for ${cfg.days} days` },
      },
    }],
    metadata: { type: "promotion", sellerId: user.uid, productId, days: String(cfg.days) },
    payment_intent_data: { metadata: { type: "promotion", sellerId: user.uid, productId } },
    customer_email: user.email || undefined,
    success_url: `${origin}/seller%20dashboard.html?promo=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/seller%20dashboard.html?promo=cancelled`,
  });

  return { url: session.url };
});

// Called when the seller lands back from Stripe: asks Stripe directly whether the
// session was paid and applies it (the same code the webhook runs, and just as
// safe to repeat). Only the seller who started the session can claim it.
async function syncSession(stripe, uid, sessionId) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId || "")) throw new PlanError("That isn't a valid checkout.");

  const session = await stripe.checkout.sessions.retrieve(sessionId);

  if (!session.metadata || session.metadata.sellerId !== uid) throw new PlanError("That checkout isn't yours.", 403);

  const result = await applyPaidSession(session);

  if (result.unpaid) throw new PlanError("That payment hasn't gone through yet.");
  if (result.ignored) throw new PlanError("That isn't a promotion checkout.");
  if (result.missing) throw new PlanError("That listing no longer exists. Email support@lesovia.com for a refund.");

  return { until: result.until };
}

const syncPromotion = endpoint(withStripe, async ({ user, body }) => syncSession(stripeClient(), user.uid, body.sessionId));

// ------------------------------------------------------------------ reminder

const REMINDER_DAYS = 3;

// A heads-up when a promotion has a few days left, so the seller can renew in
// time. Once per promotion run (the marker includes the end time).
const sweepPromotionReminders = onSchedule({ schedule: "every day 01:00", timeZone: "America/Chicago" }, async () => {
  const nowMs = Date.now();
  const soon = admin.firestore.Timestamp.fromMillis(nowMs + REMINDER_DAYS * promo.DAY_MS);
  const now = admin.firestore.Timestamp.fromMillis(nowMs);

  const snap = await db().collection("products").where("promotedUntil", ">", now).where("promotedUntil", "<=", soon).get();

  for (const doc of snap.docs) {
    const product = doc.data();
    const until = promo.untilMillis(product.promotedUntil);

    try {
      await db().collection("promotionNotices").doc(`${doc.id}_${until}`).create({ sentAt: serverTime() });
    } catch (error) {
      continue; // already sent
    }

    await notify(product.sellerId, {
      type: "promotion_ending",
      title: "A promotion is ending soon",
      message: `"${product.name || "Your listing"}" is promoted until ${dateText(until)}. Renew it from your dashboard to keep it at the top.`,
      link: "seller dashboard.html",
    });
  }
});

module.exports = {
  applyPromotion,
  applyPaidSession,
  handleCheckoutCompleted,
  syncSession,
  promotionStatus,
  promoteListing,
  syncPromotion,
  sweepPromotionReminders,
};
