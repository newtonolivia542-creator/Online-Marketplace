// Returns and cancellations: the endpoints a buyer, a seller and an admin use,
// the refund itself, and the daily deadline sweep. Every write to a return, and
// every refund, happens here through the Admin SDK -- Firestore rules give
// clients read access only -- so the window, the amounts and who may do what
// are all decided on the server (the rules and math live in returnMath.js).
//
// Who can do what:
//   buyer   request / cancel a return, add return tracking, ask an admin to
//           review a decline, cancel an order the seller never shipped
//   seller  approve or decline a request, confirm the package arrived (which
//           releases the refund), or report a problem with it
//   admin   everything a seller can, plus final say: an admin's decision
//           overrides the seller's, at any stage before the refund is sent
//
// Money: see computeReturnPlan. On a single-seller order the refund comes out of
// the seller's Stripe balance; on a multi-seller order the seller's transfer is
// reversed first and the buyer is then refunded from Lesovia's own balance.

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const Stripe = require("stripe");
const admin = require("firebase-admin");
const crypto = require("crypto");

const rm = require("./returnMath");
const { ReturnError } = rm;

const db = () => admin.firestore();
const now = () => Date.now();
const serverTime = () => admin.firestore.FieldValue.serverTimestamp();
const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;

// A refund that was claimed but never finished (the function died mid-way) can
// be picked up again after this long.
const STALE_REFUND_MS = 10 * 60 * 1000;

const RETURN_ID = /^[A-Za-z0-9_-]{16,64}$/;

// ---------------------------------------------------------------- plumbing

async function authenticate(req) {
  const match = (req.headers.authorization || "").match(/^Bearer (.+)$/);

  if (!match) throw new ReturnError("Authentication required.", 401);

  let decoded;

  try {
    decoded = await admin.auth().verifyIdToken(match[1]);
  } catch (error) {
    throw new ReturnError("Authentication required.", 401);
  }

  const snap = await db().collection("users").doc(decoded.uid).get();

  return { uid: decoded.uid, role: snap.exists ? snap.data().role : null };
}

// The policy numbers live in publicConfig/returnPolicy: readable by the app (so
// the buttons and dates it shows match what the server enforces), writable only
// through the Admin SDK / Firebase console. A missing document, or a field of
// the wrong type, falls back to the defaults in returnMath.js.
async function loadPolicy() {
  const snap = await db().collection("publicConfig").doc("returnPolicy").get();

  return rm.resolvePolicy(snap.exists ? snap.data() : null);
}

// Wraps an endpoint: turns ReturnError into its status/message and anything
// else into a logged 500.
function endpoint(options, handler) {
  return onRequest({ cors: true, ...options }, async (req, res) => {
    try {
      const user = await authenticate(req);
      const body = await handler({ req, user, body: req.body || {} });

      res.send(body);
    } catch (error) {
      if (error instanceof ReturnError) {
        return res.status(error.status).send({ error: error.message });
      }

      logger.error(error);
      res.status(500).send({ error: error.message });
    }
  });
}

const stripeClient = () => Stripe(process.env.STRIPE_SECRET_KEY);
const withStripe = { secrets: ["STRIPE_SECRET_KEY"] };

async function notify(userId, { type, title, message, link }) {
  await db().collection("notifications").doc().set({
    userId, type, title, message, link, read: false, createdAt: serverTime(),
  });
}

async function notifyAdmins(payload) {
  const snap = await db().collection("users").where("role", "==", "admin").get();

  for (const doc of snap.docs) await notify(doc.id, payload);
}

const buyerLink = (ret) => `order.html?orderId=${ret.checkoutId}`;
const sellerLink = (ret) => `seller-orders.html?orderId=${ret.sellerOrderId}`;
const adminLink = (ret) => `admin-returns.html?returnId=${ret.id}`;

async function loadReturn(returnId) {
  if (typeof returnId !== "string" || !returnId) throw new ReturnError("Missing returnId.");

  const snap = await db().collection("returns").doc(returnId).get();

  if (!snap.exists) throw new ReturnError("Return not found.", 404);

  return { id: returnId, ...snap.data() };
}

async function loadSellerOrder(sellerOrderId) {
  if (typeof sellerOrderId !== "string" || !sellerOrderId) throw new ReturnError("Missing sellerOrderId.");

  const snap = await db().collection("sellerOrders").doc(sellerOrderId).get();

  if (!snap.exists) throw new ReturnError("Order not found.", 404);

  return snap.data();
}

function requireActor(user, ret, roles) {
  const is = {
    buyer: user.uid === ret.buyerId,
    seller: user.uid === ret.sellerId,
    admin: user.role === "admin",
  };

  const actor = roles.find((role) => is[role]);

  if (!actor) throw new ReturnError("You can't do that on this return.", 403);

  return actor;
}

// One place that moves a return from one status to another, atomically: it
// checks the current status (so two people acting at once can't both win),
// applies the change, appends to the return's history, and keeps the copy on
// the sub-order (returnStatus) in step for the order pages.
async function transition(returnId, { from, to, actor, action, note = null, patch = {}, orderPatch = {} }) {
  const retRef = db().collection("returns").doc(returnId);

  return db().runTransaction(async (tx) => {
    const snap = await tx.get(retRef);

    if (!snap.exists) throw new ReturnError("Return not found.", 404);

    const current = snap.data();

    if (!from.includes(current.status)) {
      throw new ReturnError(`This return can't be changed right now (it is "${current.status}").`, 409);
    }

    const update = {
      ...patch,
      status: to,
      updatedAt: serverTime(),
      history: [...(current.history || []), { atMs: now(), actor, action, note }],
    };

    tx.update(retRef, update);
    tx.update(db().collection("sellerOrders").doc(current.sellerOrderId), { returnStatus: to, ...orderPatch });

    return { ...current, ...update, id: returnId };
  });
}

// ------------------------------------------------------- money (Stripe side)

// The processing fee Stripe charged on this order's charge. If it can't be read
// the standard 2.9% + 30c is used and the return is marked as an estimate.
async function chargeFeeCents(stripe, sellerOrder) {
  try {
    const options = sellerOrder.chargeType === "direct" ? { stripeAccount: sellerOrder.stripeAccountId } : undefined;
    const charge = await stripe.charges.retrieve(sellerOrder.stripeChargeId, { expand: ["balance_transaction"] }, options);
    const details = (charge.balance_transaction && charge.balance_transaction.fee_details) || [];

    return {
      feeCents: details.filter((d) => d.type === "stripe_fee").reduce((sum, d) => sum + d.amount, 0),
      estimated: false,
    };
  } catch (error) {
    logger.error(`Could not read the Stripe fee for ${sellerOrder.stripeChargeId}; estimating:`, error);

    return { feeCents: Math.round(sellerOrder.buyerTotalCents * 0.029 + 30), estimated: true };
  }
}

async function checkoutTotalCents(sellerOrder) {
  if (sellerOrder.chargeType !== "separate") return sellerOrder.buyerTotalCents;

  const snap = await db().collection("checkoutOrders").doc(sellerOrder.checkoutId).get();

  return snap.exists ? snap.data().totalAmountCents : sellerOrder.buyerTotalCents;
}

// Everything the buyer is shown before asking, and what is stored with the
// request: the plan and the fee it was based on.
async function buildPlan({ stripe, sellerOrder, items, reason, kind, forceFull = false, policy }) {
  const fee = await chargeFeeCents(stripe, sellerOrder);

  const stripeFeeCents = rm.attributableStripeFee({
    chargeType: sellerOrder.chargeType,
    chargeFeeCents: fee.feeCents,
    subOrderTotalCents: sellerOrder.buyerTotalCents,
    checkoutTotalCents: await checkoutTotalCents(sellerOrder),
  });

  const mode = rm.chooseRefundMode({ kind, reason, forceFull, policy });
  const plan = rm.computeReturnPlan({ sellerOrder, items, stripeFeeCents, mode });

  return { plan, stripeFeeCents, stripeFeeEstimated: fee.estimated };
}

const stripeOptionsFor = (sellerOrder) =>
  sellerOrder.chargeType === "direct" ? { stripeAccount: sellerOrder.stripeAccountId } : undefined;

// Sends the money: reverses the seller's transfer (multi-seller orders), then
// refunds the buyer. Each step is remembered on the return as soon as it
// succeeds, and looks for an earlier attempt at Stripe before creating anything,
// so running it again after a failure or a crash never pays out twice.
async function moveMoney(stripe, ret, sellerOrder, plan, { skipReversal }) {
  const options = stripeOptionsFor(sellerOrder);
  const retRef = db().collection("returns").doc(ret.id);
  const metadata = { returnId: ret.id, sellerOrderId: ret.sellerOrderId, checkoutId: ret.checkoutId };
  const done = { ...(ret.refund || {}) };

  // 1. Take the money back from the seller (they were paid by a transfer).
  if (
    sellerOrder.chargeType === "separate" &&
    !skipReversal &&
    !done.stripeReversalId &&
    plan.sellerReversalCents > 0 &&
    sellerOrder.stripeTransferId &&
    ["transferred", "partially_reversed"].includes(sellerOrder.transferStatus)
  ) {
    const transfer = await stripe.transfers.retrieve(sellerOrder.stripeTransferId);
    const reversible = transfer.amount - (transfer.amount_reversed || 0);
    const amount = Math.min(plan.sellerReversalCents, reversible);

    if (amount > 0) {
      const earlier = await stripe.transfers.listReversals(transfer.id, { limit: 20 });
      let reversal = earlier.data.find((r) => r.metadata && r.metadata.returnId === ret.id);

      if (!reversal) {
        reversal = await stripe.transfers.createReversal(
          transfer.id,
          { amount, metadata },
          { idempotencyKey: `return_reversal_${ret.id}_${ret.refundAttempts || 1}` }
        );
      }

      done.stripeReversalId = reversal.id;
      done.reversedCents = reversal.amount;
      await retRef.update({ refund: done });
    }
  }

  // 2. Refund the buyer.
  if (!done.stripeRefundId) {
    const earlier = await stripe.refunds.list({ payment_intent: sellerOrder.stripePaymentIntentId, limit: 20 }, options);
    let refund = earlier.data.find((r) => r.metadata && r.metadata.returnId === ret.id);

    if (!refund) {
      refund = await stripe.refunds.create(
        {
          payment_intent: sellerOrder.stripePaymentIntentId,
          amount: plan.buyerRefundCents,
          metadata,
          ...(sellerOrder.chargeType === "direct" && plan.refundApplicationFee ? { refund_application_fee: true } : {}),
        },
        { ...(options || {}), idempotencyKey: `return_refund_${ret.id}_${ret.refundAttempts || 1}` }
      );
    }

    done.stripeRefundId = refund.id;
    done.refundedCents = refund.amount;
  }

  return done;
}

// Runs the refund for a return, claiming it first so two people (or a retry and
// the original) can't both send it.
async function executeRefund(stripe, returnId, { from, actor, forceFull = false, skipReversal = false }) {
  const retRef = db().collection("returns").doc(returnId);

  const claimed = await db().runTransaction(async (tx) => {
    const snap = await tx.get(retRef);

    if (!snap.exists) throw new ReturnError("Return not found.", 404);

    const current = snap.data();
    const stale = current.status === "refunding" && now() - (current.refundStartedMs || 0) > STALE_REFUND_MS;

    if (!from.includes(current.status) && !stale) {
      throw new ReturnError(`A refund can't be sent from status "${current.status}".`, 409);
    }

    const attempts = (current.refundAttempts || 0) + 1;

    tx.update(retRef, {
      status: "refunding",
      refundAttempts: attempts,
      refundStartedMs: now(),
      history: [...(current.history || []), { atMs: now(), actor, action: "refund_started", note: forceFull ? "full refund" : null }],
    });
    tx.update(db().collection("sellerOrders").doc(current.sellerOrderId), { returnStatus: "refunding" });

    return { ...current, id: returnId, refundAttempts: attempts };
  });

  const sellerOrder = await loadSellerOrder(claimed.sellerOrderId);
  const policy = await loadPolicy();

  // An admin can decide, at refund time, that the buyer gets everything back.
  let plan = claimed.plan;

  if (forceFull && plan.mode !== "full") {
    plan = rm.computeReturnPlan({
      sellerOrder,
      items: claimed.items,
      stripeFeeCents: claimed.stripeFeeCents,
      mode: "full",
    });
  }

  try {
    // The buyer's bank may have opened a dispute since this was approved; the
    // money would then go out twice.
    if (rm.hasOpenDispute(sellerOrder)) {
      throw new Error("The buyer's bank has an open dispute on this payment, so a refund can't be sent from here. Resolve the dispute first.");
    }

    const done = await moveMoney(stripe, claimed, sellerOrder, plan, { skipReversal });

    await finishRefund(claimed, sellerOrder, plan, done, actor);

    return { status: "refunded", buyerRefundCents: plan.buyerRefundCents };
  } catch (error) {
    logger.error(`Refund for return ${returnId} failed:`, error);

    await transition(returnId, {
      from: ["refunding"],
      to: "refund_failed",
      actor: "system",
      action: "refund_failed",
      note: String(error.message).slice(0, 300),
      patch: { refundError: String(error.message).slice(0, 300), plan },
    });

    await notifyAdmins({
      type: "refund_failed",
      title: "Refund needs attention",
      message: `The refund for order ${claimed.orderNumber} could not be sent: ${String(error.message).slice(0, 160)}`,
      link: adminLink(claimed),
    });

    return { status: "refund_failed", error: String(error.message).slice(0, 300) };
  }
}

async function finishRefund(ret, sellerOrder, plan, done, actor) {
  const retRef = db().collection("returns").doc(ret.id);
  const soRef = db().collection("sellerOrders").doc(ret.sellerOrderId);
  const checkoutRef = db().collection("checkoutOrders").doc(ret.checkoutId);
  const isCancellation = ret.kind === "cancellation";

  await db().runTransaction(async (tx) => {
    const [soSnap, checkoutSnap] = await Promise.all([tx.get(soRef), tx.get(checkoutRef)]);
    const so = soSnap.data();

    const productRefs = isCancellation
      ? [...new Set(ret.items.map((item) => item.productId))].map((id) => db().collection("products").doc(id))
      : [];
    const productSnaps = await Promise.all(productRefs.map((ref) => tx.get(ref)));

    const refundedTotal = (so.refundedAmountCents || 0) + plan.buyerRefundCents;

    tx.update(retRef, {
      status: "refunded",
      plan,
      refund: { ...done, status: "succeeded", buyerRefundCents: plan.buyerRefundCents, completedMs: now() },
      refundError: null,
      completedAt: serverTime(),
      updatedAt: serverTime(),
      history: [...(ret.history || []), { atMs: now(), actor, action: "refunded", note: dollars(plan.buyerRefundCents) }],
    });

    tx.update(soRef, {
      returnStatus: "refunded",
      refundedAmountCents: refundedTotal,
      refundStatus: plan.fullReturn ? "refunded" : "partially_refunded",
      ...(plan.fullReturn ? { fulfillmentStatus: isCancellation ? "cancelled" : "returned" } : {}),
    });

    if (checkoutSnap.exists) {
      tx.update(checkoutRef, {
        refundedAmountCents: (checkoutSnap.data().refundedAmountCents || 0) + plan.buyerRefundCents,
      });
    }

    // Goods that never left the seller go back on the shelf.
    if (isCancellation) {
      productSnaps.forEach((snap, index) => {
        if (!snap.exists) return;

        const back = ret.items
          .filter((item) => item.productId === productRefs[index].id)
          .reduce((sum, item) => sum + item.quantity, 0);

        tx.update(productRefs[index], { quantity: (snap.data().quantity || 0) + back });
      });
    }
  });

  await notify(ret.buyerId, {
    type: "refund",
    title: isCancellation ? "Order cancelled and refunded" : "Refund sent",
    message: `${dollars(plan.buyerRefundCents)} for order ${ret.orderNumber} is on its way back to your card. Banks usually show it within 5 to 10 business days.`,
    link: buyerLink(ret),
  });

  await notify(ret.sellerId, {
    type: "refund",
    title: isCancellation ? "Order cancelled" : "Return completed",
    message: `Order ${ret.orderNumber} was ${isCancellation ? "cancelled" : "returned"} and ${dollars(plan.buyerRefundCents)} was refunded to the buyer.`,
    link: sellerLink(ret),
  });
}

// --------------------------------------------------------------- endpoints

// What a return would refund, shown to the buyer before they commit. Nothing is
// written.
exports.previewReturn = endpoint(withStripe, async ({ user, body }) => {
  const sellerOrder = await loadSellerOrder(body.sellerOrderId);

  if (sellerOrder.buyerId !== user.uid) throw new ReturnError("This order does not belong to you.", 403);

  const policy = await loadPolicy();
  const eligibility = rm.checkReturnEligibility({
    sellerOrder,
    existingReturns: sellerOrder.activeReturnId ? [{ status: sellerOrder.returnStatus || "requested" }] : [],
    nowMs: now(),
    policy,
  });

  if (!eligibility.ok) throw new ReturnError(eligibility.message, 409);

  const reason = rm.REASONS[body.reason] ? body.reason : "other";
  const items = rm.selectReturnItems(sellerOrder, body.items);
  const { plan, stripeFeeEstimated } = await buildPlan({ stripe: stripeClient(), sellerOrder, items, reason, kind: "return", policy });

  return { plan, stripeFeeEstimated, windowEndsMs: eligibility.windowEndsMs, returnShipDays: policy.returnShipDays };
});

exports.requestReturn = endpoint(withStripe, async ({ user, body }) => {
  const { returnId, sellerOrderId } = body;

  if (typeof returnId !== "string" || !RETURN_ID.test(returnId)) throw new ReturnError("Invalid return id.");

  const sellerOrder = await loadSellerOrder(sellerOrderId);

  if (sellerOrder.buyerId !== user.uid) throw new ReturnError("This order does not belong to you.", 403);

  // The same request arriving twice (a double click, a retry) is a no-op.
  const existing = await db().collection("returns").doc(returnId).get();

  if (existing.exists) {
    if (existing.data().buyerId !== user.uid) throw new ReturnError("Invalid return id.");

    return { returnId, status: existing.data().status, plan: existing.data().plan, alreadyExists: true };
  }

  if (body.acknowledgedFees !== true) {
    throw new ReturnError("Please confirm you've read what is and isn't refunded before continuing.");
  }

  const policy = await loadPolicy();

  const eligibility = rm.checkReturnEligibility({
    sellerOrder,
    existingReturns: sellerOrder.activeReturnId ? [{ status: sellerOrder.returnStatus || "requested" }] : [],
    nowMs: now(),
    policy,
  });

  if (!eligibility.ok) throw new ReturnError(eligibility.message, 409);

  const details = rm.validateReasonDetails(body, policy);
  const items = rm.selectReturnItems(sellerOrder, body.items);

  // Photos must be ones this buyer uploaded for this exact return.
  const photoPrefix = `returnPhotos/${user.uid}/${sellerOrder.sellerId}/${returnId}/`;
  const photos = (Array.isArray(body.photos) ? body.photos : []).map((photo) => {
    const path = photo && photo.path;
    const url = photo && photo.url;

    if (
      typeof path !== "string" || !path.startsWith(photoPrefix) || path.includes("..") ||
      typeof url !== "string" || !url.startsWith("https://firebasestorage.googleapis.com/") ||
      !url.includes(encodeURIComponent(path))
    ) {
      throw new ReturnError("One of the photos wasn't uploaded correctly. Please attach it again.");
    }

    return { path, url };
  });

  const { plan, stripeFeeCents, stripeFeeEstimated } = await buildPlan({
    stripe: stripeClient(), sellerOrder, items, reason: details.reason, kind: "return", policy,
  });

  if (plan.buyerRefundCents < 1) {
    throw new ReturnError("After Lesovia's commission and payment processing fees, nothing would be left to refund on this item, so it can't be returned here.");
  }

  const retRef = db().collection("returns").doc(returnId);
  const soRef = db().collection("sellerOrders").doc(sellerOrderId);
  const requestedMs = now();

  const record = {
    kind: "return",
    sellerOrderId,
    checkoutId: sellerOrder.checkoutId,
    orderNumber: sellerOrder.orderNumber,
    buyerId: user.uid,
    sellerId: sellerOrder.sellerId,
    storeName: sellerOrder.storeName || null,
    status: "requested",
    reason: details.reason,
    reasonLabel: rm.REASONS[details.reason].label,
    sellerFault: rm.isSellerFault(details.reason),
    description: details.description,
    photos,
    items,
    plan,
    stripeFeeCents,
    stripeFeeEstimated,
    acknowledgedFeesAtMs: requestedMs,
    requestedMs,
    sellerRespondByMs: requestedMs + policy.sellerResponseDays * rm.DAY_MS,
    refundAttempts: 0,
    refund: null,
    history: [{ atMs: requestedMs, actor: user.uid, action: "requested", note: null }],
    createdAt: serverTime(),
    updatedAt: serverTime(),
  };

  await db().runTransaction(async (tx) => {
    const [soSnap, retSnap] = await Promise.all([tx.get(soRef), tx.get(retRef)]);

    if (retSnap.exists) throw new ReturnError("Invalid return id.");

    // The guard against two requests for the same order racing each other.
    if (soSnap.data().activeReturnId) throw new ReturnError("A return has already been started for this order.", 409);

    tx.set(retRef, record);
    tx.update(soRef, { activeReturnId: returnId, returnStatus: "requested" });
  });

  await notify(sellerOrder.sellerId, {
    type: "return_requested",
    title: "Return requested",
    message: `A buyer asked to return order ${sellerOrder.orderNumber}: ${record.reasonLabel}. Please approve or decline.`,
    link: sellerLink({ sellerOrderId }),
  });

  return { returnId, status: "requested", plan };
});

// Seller or admin: approve or decline. An admin can decide at any stage before
// the buyer has sent the item, and their decision replaces the seller's.
exports.decideReturn = endpoint({}, async ({ user, body }) => {
  const ret = await loadReturn(body.returnId);
  const actor = requireActor(user, ret, ["admin", "seller"]);
  const policy = await loadPolicy();
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";

  const from = actor === "admin" ? ["requested", "escalated", "declined", "approved"] : ["requested"];

  if (body.decision === "approve") {
    const nextMs = now();

    const updated = await transition(ret.id, {
      from,
      to: "approved",
      actor: user.uid,
      action: `approved_by_${actor}`,
      note: note || null,
      patch: {
        approvedMs: nextMs,
        approvedBy: actor,
        decisionNote: note || null,
        shipDeadlineMs: nextMs + policy.returnShipDays * rm.DAY_MS,
      },
    });

    const address = (await loadSellerOrder(ret.sellerOrderId)).returnAddress;

    await notify(ret.buyerId, {
      type: "return_approved",
      title: "Return approved",
      message: `Your return for order ${ret.orderNumber} was approved. Send it back within ${policy.returnShipDays} days${address ? "" : " (the seller will share the return address)"} and add the tracking number on your order page.`,
      link: buyerLink(ret),
    });

    return { status: updated.status };
  }

  if (body.decision === "decline") {
    if (note.length < 5) throw new ReturnError("Please give the buyer a short reason for declining.");

    const updated = await transition(ret.id, {
      from,
      to: "declined",
      actor: user.uid,
      action: `declined_by_${actor}`,
      note,
      patch: { declinedBy: actor, decisionNote: note },
    });

    await notify(ret.buyerId, {
      type: "return_declined",
      title: "Return declined",
      message: `Your return for order ${ret.orderNumber} was declined: ${note}${actor === "seller" ? " You can ask Lesovia to review this from your order page." : ""}`,
      link: buyerLink(ret),
    });

    return { status: updated.status };
  }

  throw new ReturnError("Choose approve or decline.");
});

exports.escalateReturn = endpoint({}, async ({ user, body }) => {
  const ret = await loadReturn(body.returnId);

  requireActor(user, ret, ["buyer"]);

  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";

  await transition(ret.id, {
    from: ["declined"],
    to: "escalated",
    actor: user.uid,
    action: "escalated_by_buyer",
    note: note || null,
  });

  await notifyAdmins({
    type: "return_escalated",
    title: "Return needs review",
    message: `A buyer asked Lesovia to review the declined return for order ${ret.orderNumber}.`,
    link: adminLink(ret),
  });

  return { status: "escalated" };
});

exports.cancelReturn = endpoint({}, async ({ user, body }) => {
  const ret = await loadReturn(body.returnId);

  requireActor(user, ret, ["buyer"]);

  await transition(ret.id, {
    from: ["requested", "approved"],
    to: "cancelled",
    actor: user.uid,
    action: "cancelled_by_buyer",
    // Withdrawn, so the buyer may start a new return while their window lasts.
    orderPatch: { activeReturnId: null },
  });

  await notify(ret.sellerId, {
    type: "return_cancelled",
    title: "Return withdrawn",
    message: `The buyer withdrew the return request for order ${ret.orderNumber}.`,
    link: sellerLink(ret),
  });

  return { status: "cancelled" };
});

exports.submitReturnTracking = endpoint({}, async ({ user, body }) => {
  const ret = await loadReturn(body.returnId);

  requireActor(user, ret, ["buyer"]);

  const carrier = typeof body.carrier === "string" ? body.carrier.trim().slice(0, 60) : "";
  const trackingNumber = typeof body.trackingNumber === "string" ? body.trackingNumber.trim().slice(0, 80) : "";

  if (!carrier) throw new ReturnError("Please enter the shipping carrier (for example USPS, UPS, FedEx).");
  if (trackingNumber.length < 5) throw new ReturnError("Please enter the tracking number from your shipping receipt.");

  if (ret.status === "approved" && now() > ret.shipDeadlineMs) {
    await transition(ret.id, {
      from: ["approved"], to: "expired", actor: "system", action: "expired",
      orderPatch: { activeReturnId: null },
    });

    throw new ReturnError("The time to send this item back has passed, so the return has expired.", 409);
  }

  const policy = await loadPolicy();

  await transition(ret.id, {
    from: ["approved"],
    to: "shipped_back",
    actor: user.uid,
    action: "tracking_added",
    note: `${carrier} ${trackingNumber}`,
    patch: {
      returnTracking: { carrier, trackingNumber, addedMs: now() },
      receiptDeadlineMs: now() + policy.sellerReceiptDays * rm.DAY_MS,
    },
  });

  await notify(ret.sellerId, {
    type: "return_shipped",
    title: "Return on its way",
    message: `The buyer sent order ${ret.orderNumber} back (${carrier} ${trackingNumber}). Confirm it when it arrives.`,
    link: sellerLink(ret),
  });

  return { status: "shipped_back" };
});

// Seller (or admin): the package arrived. This is what releases the refund.
exports.confirmReturnReceived = endpoint(withStripe, async ({ user, body }) => {
  const ret = await loadReturn(body.returnId);

  requireActor(user, ret, ["admin", "seller"]);

  return executeRefund(stripeClient(), ret.id, { from: ["shipped_back"], actor: user.uid });
});

exports.reportReturnProblem = endpoint({}, async ({ user, body }) => {
  const ret = await loadReturn(body.returnId);

  requireActor(user, ret, ["seller"]);

  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";

  if (note.length < 10) throw new ReturnError("Please describe what's wrong with the returned package.");

  await transition(ret.id, {
    from: ["shipped_back"],
    to: "problem_reported",
    actor: user.uid,
    action: "problem_reported_by_seller",
    note,
    patch: { problemNote: note },
  });

  await notifyAdmins({
    type: "return_problem",
    title: "Return problem reported",
    message: `The seller reported a problem with the returned package for order ${ret.orderNumber}.`,
    link: adminLink(ret),
  });

  await notify(ret.buyerId, {
    type: "return_problem",
    title: "Question about your return",
    message: `The seller reported a problem with the package you returned for order ${ret.orderNumber}. Lesovia is reviewing it.`,
    link: buyerLink(ret),
  });

  return { status: "problem_reported" };
});

// Admin's final say once the item is on its way: refund it (optionally in full,
// or without taking the money back from the seller), close it with no refund,
// or retry a refund that failed.
exports.adminResolveReturn = endpoint(withStripe, async ({ user, body }) => {
  if (user.role !== "admin") throw new ReturnError("Admins only.", 403);

  const ret = await loadReturn(body.returnId);
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";

  if (body.action === "refund") {
    return executeRefund(stripeClient(), ret.id, {
      from: ["shipped_back", "problem_reported", "approved", "escalated", "refund_failed"],
      actor: user.uid,
      forceFull: body.refundInFull === true,
      skipReversal: body.skipReversal === true,
    });
  }

  if (body.action === "reject") {
    if (note.length < 5) throw new ReturnError("Please give a short reason.");

    await transition(ret.id, {
      from: ["shipped_back", "problem_reported", "escalated", "approved", "declined", "refund_failed"],
      to: "rejected",
      actor: user.uid,
      action: "rejected_by_admin",
      note,
      patch: { decisionNote: note },
    });

    await notify(ret.buyerId, {
      type: "return_declined",
      title: "Return closed without a refund",
      message: `Lesovia reviewed the return for order ${ret.orderNumber} and closed it without a refund: ${note}`,
      link: buyerLink(ret),
    });

    await notify(ret.sellerId, {
      type: "return_declined",
      title: "Return closed",
      message: `Lesovia closed the return for order ${ret.orderNumber} without a refund.`,
      link: sellerLink(ret),
    });

    return { status: "rejected" };
  }

  throw new ReturnError("Unknown action.");
});

// The seller never shipped: after the waiting period the buyer can cancel and is
// refunded in full straight away -- there is nothing to approve.
exports.cancelUnshippedOrder = endpoint(withStripe, async ({ user, body }) => {
  const { sellerOrderId } = body;
  const sellerOrder = await loadSellerOrder(sellerOrderId);

  if (sellerOrder.buyerId !== user.uid) throw new ReturnError("This order does not belong to you.", 403);

  const policy = await loadPolicy();

  const eligibility = rm.checkCancelEligibility({
    sellerOrder,
    existingReturns: sellerOrder.activeReturnId ? [{ status: sellerOrder.returnStatus || "requested" }] : [],
    nowMs: now(),
    policy,
  });

  if (!eligibility.ok) throw new ReturnError(eligibility.message, 409);

  const items = rm.selectReturnItems(
    sellerOrder,
    (sellerOrder.products || []).map((line, lineIndex) => ({ lineIndex, quantity: line.quantity }))
  );

  const stripe = stripeClient();
  const { plan, stripeFeeCents, stripeFeeEstimated } = await buildPlan({
    stripe, sellerOrder, items, reason: "not_shipped", kind: "cancellation", policy,
  });

  // One cancellation per sub-order, so its id is derived from the sub-order's.
  // Hashed because a sub-order id (checkout id + seller uid) is longer than a
  // return id may be, and cutting it short could make two sellers collide.
  const returnId = `cancel_${crypto.createHash("sha256").update(sellerOrderId).digest("hex").slice(0, 40)}`;
  const retRef = db().collection("returns").doc(returnId);
  const soRef = db().collection("sellerOrders").doc(sellerOrderId);
  const ts = now();

  await db().runTransaction(async (tx) => {
    const [soSnap, retSnap] = await Promise.all([tx.get(soRef), tx.get(retRef)]);

    if (soSnap.data().activeReturnId || retSnap.exists) {
      throw new ReturnError("A return or cancellation has already been started for this order.", 409);
    }

    tx.set(retRef, {
      kind: "cancellation",
      sellerOrderId,
      checkoutId: sellerOrder.checkoutId,
      orderNumber: sellerOrder.orderNumber,
      buyerId: user.uid,
      sellerId: sellerOrder.sellerId,
      storeName: sellerOrder.storeName || null,
      status: "queued",
      reason: "not_shipped",
      reasonLabel: `The seller hadn't shipped the order after ${policy.cancelUnshippedAfterDays} days`,
      sellerFault: true,
      description: null,
      photos: [],
      items,
      plan,
      stripeFeeCents,
      stripeFeeEstimated,
      requestedMs: ts,
      refundAttempts: 0,
      refund: null,
      history: [{ atMs: ts, actor: user.uid, action: "cancelled_unshipped", note: null }],
      createdAt: serverTime(),
      updatedAt: serverTime(),
    });

    tx.update(soRef, { activeReturnId: returnId, returnStatus: "queued" });
  });

  return executeRefund(stripe, returnId, { from: ["queued"], actor: user.uid });
});

// ----------------------------------------------------------------- background

// The delivery and shipping times the return window depends on are stamped by
// the server the moment the status changes. The timestamps a seller writes
// themselves come from their own browser and could say anything.
exports.stampShipmentTimes = onDocumentUpdated("sellerOrders/{sellerOrderId}", async (event) => {
  const after = event.data && event.data.after && event.data.after.data();

  if (!after) return;

  const patch = {};

  if ((after.fulfillmentStatus === "shipped" || after.fulfillmentStatus === "delivered") && !after.shippedAtServer) {
    patch.shippedAtServer = serverTime();
  }

  if (after.fulfillmentStatus === "delivered" && !after.deliveredAtServer) {
    patch.deliveredAtServer = serverTime();
  }

  if (Object.keys(patch).length > 0) {
    await event.data.after.ref.update(patch);
  }
});

// Runs every few hours: hands stalled returns to an admin (never auto-approves
// or auto-refunds anything), and lets an expired return go.
async function sweepReturnDeadlines() {
  const nowMs = now();
  const byStatus = async (status) => (await db().collection("returns").where("status", "==", status).get()).docs;

  for (const doc of await byStatus("requested")) {
    const ret = { id: doc.id, ...doc.data() };

    if (!(ret.sellerRespondByMs < nowMs)) continue;

    await transition(ret.id, { from: ["requested"], to: "escalated", actor: "system", action: "seller_did_not_respond" });

    await notifyAdmins({ type: "return_escalated", title: "Return needs a decision", message: `The seller didn't respond to the return request for order ${ret.orderNumber}.`, link: adminLink(ret) });
    await notify(ret.buyerId, { type: "return_escalated", title: "Your return is with Lesovia", message: `The seller didn't respond in time, so Lesovia is reviewing your return for order ${ret.orderNumber}.`, link: buyerLink(ret) });
    await notify(ret.sellerId, { type: "return_escalated", title: "Return passed to Lesovia", message: `You didn't respond to the return request for order ${ret.orderNumber} in time, so Lesovia will decide it.`, link: sellerLink(ret) });
  }

  for (const doc of await byStatus("approved")) {
    const ret = { id: doc.id, ...doc.data() };

    if (!(ret.shipDeadlineMs < nowMs)) continue;

    await transition(ret.id, { from: ["approved"], to: "expired", actor: "system", action: "expired", orderPatch: { activeReturnId: null } });
    await notify(ret.buyerId, { type: "return_expired", title: "Return expired", message: `The time to send back order ${ret.orderNumber} has passed, so the return was closed.`, link: buyerLink(ret) });
    await notify(ret.sellerId, { type: "return_expired", title: "Return expired", message: `The buyer didn't send back order ${ret.orderNumber} in time, so the return was closed.`, link: sellerLink(ret) });
  }

  for (const doc of await byStatus("shipped_back")) {
    const ret = { id: doc.id, ...doc.data() };

    if (!(ret.receiptDeadlineMs < nowMs)) continue;

    await transition(ret.id, {
      from: ["shipped_back"], to: "problem_reported", actor: "system", action: "seller_did_not_confirm",
      note: "The seller didn't confirm or report the returned package in time.",
      patch: { problemNote: "The seller didn't confirm or report the returned package in time." },
    });

    await notifyAdmins({ type: "return_problem", title: "Return needs a decision", message: `The seller didn't confirm the returned package for order ${ret.orderNumber} in time.`, link: adminLink(ret) });
    await notify(ret.buyerId, { type: "return_escalated", title: "Your return is with Lesovia", message: `Lesovia is checking on the package you sent back for order ${ret.orderNumber}.`, link: buyerLink(ret) });
  }
}

exports.sweepReturnDeadlines = onSchedule("every 6 hours", async () => {
  await sweepReturnDeadlines();
});

// Exposed so tests can drive the sweep without a scheduler.
exports._internal = { sweepReturnDeadlines, executeRefund };
