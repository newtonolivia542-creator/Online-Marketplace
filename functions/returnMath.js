// Pure rules and money math for returns and cancellations. No Firebase or
// Stripe imports, so all of it can be unit-tested. Everything here works in
// integer cents. The functions that actually move money (index.js / returns.js)
// only ever call these to decide WHAT is allowed and HOW MUCH.

class ReturnError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Every knob of the policy. Overridable from config/platformSettings.returnPolicy
// (Admin SDK only) without a code change -- see resolvePolicy.
const DEFAULT_POLICY = {
  // A buyer may start a return within this many days of delivery...
  returnWindowDays: 7,
  // ...counted from the delivery date, but never earlier than this many days
  // after the seller marked the order shipped. "Delivered" is clicked by the
  // seller, so this stops an early click from using up the buyer's window
  // before the package has actually arrived.
  minDaysAfterShipBeforeWindow: 5,
  // After a return is approved, the buyer has this long to send it back.
  returnShipDays: 30,
  // A seller who doesn't answer a request within this long has it escalated to
  // an admin (never auto-approved).
  sellerResponseDays: 5,
  // A seller who doesn't confirm a returned package within this long after the
  // buyer adds tracking has it escalated to an admin (never auto-refunded).
  sellerReceiptDays: 14,
  // An order the seller never shipped can be cancelled by the buyer after this.
  cancelUnshippedAfterDays: 14,
  // false: Lesovia's commission and Stripe's processing fee are kept from every
  // return refund, whatever the reason. true: returns for seller-fault reasons
  // (damaged / wrong item / not as described) are refunded in full instead.
  sellerFaultFullRefund: false,
  maxPhotos: 5,
  minDescriptionChars: 10,
  maxDescriptionChars: 1000,
};

const POLICY_KEYS = Object.keys(DEFAULT_POLICY);

// Merges stored overrides over the defaults, ignoring anything that isn't the
// right type -- a bad value in the config doc must never break returns or
// silently disable a deadline.
function resolvePolicy(overrides) {
  const policy = { ...DEFAULT_POLICY };

  if (!overrides || typeof overrides !== "object") return policy;

  for (const key of POLICY_KEYS) {
    const value = overrides[key];

    if (typeof DEFAULT_POLICY[key] === "boolean") {
      if (typeof value === "boolean") policy[key] = value;
    } else if (Number.isFinite(value) && value >= 0) {
      policy[key] = value;
    }
  }

  return policy;
}

// What a buyer can pick as the reason. `sellerFault` reasons need photo
// evidence and, if the policy says so, are refunded in full.
const REASONS = {
  damaged: { label: "Item or package arrived damaged / broken", sellerFault: true, photosRequired: true },
  wrong_item: { label: "I received a different item than I ordered", sellerFault: true, photosRequired: true },
  not_as_described: { label: "Not as described in the listing", sellerFault: true, photosRequired: true },
  too_big: { label: "Too big", sellerFault: false, photosRequired: false },
  too_small: { label: "Too small", sellerFault: false, photosRequired: false },
  not_liked: { label: "I don't like how it looks", sellerFault: false, photosRequired: false },
  other: { label: "Something else", sellerFault: false, photosRequired: false },
};

const isSellerFault = (reason) => Boolean(REASONS[reason] && REASONS[reason].sellerFault);

// ---- times ----

// Firestore Timestamp, JS Date, or epoch millis -> epoch millis (or null).
function toMillis(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  return null;
}

// The delivery / shipping times the rules rely on are stamped by the server
// (see stampShipmentTimes), because the ones a seller writes from their own
// browser can be set to anything. The seller-written value is only a fallback
// for orders shipped before the server stamp existed.
function shipmentTimes(sellerOrder) {
  return {
    shippedMs: toMillis(sellerOrder.shippedAtServer) ?? toMillis(sellerOrder.shippedAt),
    deliveredMs: toMillis(sellerOrder.deliveredAtServer) ?? toMillis(sellerOrder.deliveredAt),
  };
}

function returnWindowEndsAt(sellerOrder, policy) {
  const { shippedMs, deliveredMs } = shipmentTimes(sellerOrder);

  if (deliveredMs == null) return null;

  const earliestStart = shippedMs != null ? shippedMs + policy.minDaysAfterShipBeforeWindow * DAY_MS : deliveredMs;
  const windowStart = Math.max(deliveredMs, earliestStart);

  return windowStart + policy.returnWindowDays * DAY_MS;
}

const OPEN_DISPUTE = ["needs_response", "under_review", "warning_needs_response", "warning_under_review"];

// A buyer whose bank is already disputing the charge must not also be refunded
// through us, or the money leaves twice.
function hasOpenDispute(sellerOrder) {
  return OPEN_DISPUTE.includes(sellerOrder.disputeStatus);
}

// Returns that ended without anything being decided against the buyer, so a new
// request is still allowed (while the return window lasts). A declined or
// rejected return is a decision, not a lapse: it stands (the buyer can ask an
// admin to review a decline), so it still blocks a fresh request.
const CLOSED_WITHOUT_REFUND = ["cancelled", "expired"];

// existingReturns: this sub-order's earlier return / cancellation documents.
function hasBlockingReturn(existingReturns) {
  return existingReturns.some((r) => !CLOSED_WITHOUT_REFUND.includes(r.status));
}

function checkReturnEligibility({ sellerOrder, existingReturns = [], nowMs, policy }) {
  if (sellerOrder.fulfillmentStatus !== "delivered") {
    return { ok: false, message: "Returns can be requested once the order has been delivered." };
  }

  const endsAt = returnWindowEndsAt(sellerOrder, policy);

  if (endsAt == null) {
    return { ok: false, message: "We couldn't confirm the delivery date for this order yet. Please try again in a few minutes." };
  }

  if (nowMs > endsAt) {
    return { ok: false, message: `The ${policy.returnWindowDays}-day return window for this order has ended.` };
  }

  if (hasOpenDispute(sellerOrder)) {
    return { ok: false, message: "This payment is already being disputed with your bank, so a return can't be started here." };
  }

  if (hasBlockingReturn(existingReturns)) {
    return { ok: false, message: "A return has already been started for this order." };
  }

  if ((sellerOrder.refundedAmountCents || 0) > 0) {
    return { ok: false, message: "This order has already been refunded." };
  }

  if (!sellerOrder.stripeChargeId) {
    return { ok: false, message: "This order can't be returned online. Please contact support." };
  }

  return { ok: true, windowEndsMs: endsAt };
}

function checkCancelEligibility({ sellerOrder, existingReturns = [], nowMs, policy }) {
  if (sellerOrder.fulfillmentStatus !== "paid") {
    return { ok: false, message: "Only orders that haven't shipped can be cancelled." };
  }

  const createdMs = toMillis(sellerOrder.createdAt);

  if (createdMs == null) {
    return { ok: false, message: "We couldn't confirm when this order was placed." };
  }

  const availableMs = createdMs + policy.cancelUnshippedAfterDays * DAY_MS;

  if (nowMs < availableMs) {
    return {
      ok: false,
      message: `This order can be cancelled if the seller still hasn't shipped it ${policy.cancelUnshippedAfterDays} days after it was placed.`,
      availableAtMs: availableMs,
    };
  }

  if (hasOpenDispute(sellerOrder)) {
    return { ok: false, message: "This payment is already being disputed with your bank, so it can't be cancelled here." };
  }

  if (hasBlockingReturn(existingReturns)) {
    return { ok: false, message: "A return or cancellation has already been started for this order." };
  }

  if ((sellerOrder.refundedAmountCents || 0) > 0) {
    return { ok: false, message: "This order has already been refunded." };
  }

  if (!sellerOrder.stripeChargeId) {
    return { ok: false, message: "This order can't be cancelled online. Please contact support." };
  }

  return { ok: true };
}

// ---- what is being returned ----

// requested: [{ lineIndex, quantity }] -- which product lines of the sub-order,
// and how many of each. Returns the validated selection (in line order).
function selectReturnItems(sellerOrder, requested) {
  const lines = sellerOrder.products || [];

  if (!Array.isArray(requested) || requested.length === 0) {
    throw new ReturnError("Choose at least one item to return.");
  }

  const byLine = new Map();

  for (const entry of requested) {
    const lineIndex = Number(entry && entry.lineIndex);
    const quantity = Number(entry && entry.quantity);

    if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) {
      throw new ReturnError("One of the selected items isn't part of this order.");
    }

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > lines[lineIndex].quantity) {
      throw new ReturnError(`Quantity for "${lines[lineIndex].name}" must be between 1 and ${lines[lineIndex].quantity}.`);
    }

    if (byLine.has(lineIndex)) {
      throw new ReturnError("An item was selected twice.");
    }

    byLine.set(lineIndex, quantity);
  }

  return [...byLine.entries()]
    .sort(([a], [b]) => a - b)
    .map(([lineIndex, quantity]) => {
      const line = lines[lineIndex];

      return {
        lineIndex,
        productId: line.productId,
        name: line.name,
        image: line.image || null,
        color: line.color || null,
        size: line.size || null,
        quantity,
        unitPriceCents: line.unitPriceCents,
      };
    });
}

// Trims and validates the buyer's written reason.
function validateReasonDetails({ reason, description, photos }, policy) {
  if (!REASONS[reason]) {
    throw new ReturnError("Please choose a reason for the return.");
  }

  const text = typeof description === "string" ? description.trim() : "";

  if (text.length < policy.minDescriptionChars) {
    throw new ReturnError(`Please describe the problem in at least ${policy.minDescriptionChars} characters.`);
  }

  if (text.length > policy.maxDescriptionChars) {
    throw new ReturnError(`Please keep the description under ${policy.maxDescriptionChars} characters.`);
  }

  const photoList = Array.isArray(photos) ? photos : [];

  if (photoList.length > policy.maxPhotos) {
    throw new ReturnError(`You can attach up to ${policy.maxPhotos} photos.`);
  }

  if (REASONS[reason].photosRequired && photoList.length === 0) {
    throw new ReturnError("Please attach at least one photo showing the problem.");
  }

  return { reason, description: text };
}

// ---- money ----

// How much of the Stripe processing fee belongs to this sub-order.
//   direct:   the whole charge is this one order, so all of it.
//   separate: one charge covers every seller's order in the checkout, so it's
//             split in proportion to what each sub-order paid.
function attributableStripeFee({ chargeType, chargeFeeCents, subOrderTotalCents, checkoutTotalCents }) {
  const fee = Math.max(0, Math.round(Number(chargeFeeCents) || 0));

  if (chargeType !== "separate") return fee;

  if (!(checkoutTotalCents > 0)) return 0;

  return Math.round((fee * subOrderTotalCents) / checkoutTotalCents);
}

// "standard": the buyer is refunded what they paid MINUS Lesovia's commission
//   and Stripe's processing fee on the part being returned. Seller ends up
//   exactly even, Lesovia keeps its commission, Stripe keeps its fee.
// "full": the buyer is refunded everything they paid for the returned part
//   (Lesovia gives its commission back; the fee is simply lost). Used for
//   orders the seller never shipped, when an admin decides so, and -- if the
//   policy says so -- for seller-fault returns.
function chooseRefundMode({ kind, reason, forceFull, policy }) {
  if (forceFull) return "full";
  if (kind === "cancellation") return "full";
  if (policy.sellerFaultFullRefund && isSellerFault(reason)) return "full";
  return "standard";
}

// items: the validated selection from selectReturnItems (all lines, full
// quantities, for a cancellation). stripeFeeCents: this sub-order's share of
// the processing fee (see attributableStripeFee).
function computeReturnPlan({ sellerOrder, items, stripeFeeCents, mode }) {
  const lines = sellerOrder.products || [];
  const subtotal = sellerOrder.productSubtotalCents;

  const returnedSubtotalCents = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);

  // Shipping only comes back when everything in the order is going back.
  const fullReturn =
    items.length === lines.length &&
    items.every((item) => item.quantity === lines[item.lineIndex].quantity);

  const shippingRefundCents = fullReturn ? sellerOrder.shippingCents || 0 : 0;

  const taxRefundCents = subtotal > 0
    ? Math.round(((sellerOrder.taxCents || 0) * returnedSubtotalCents) / subtotal)
    : 0;

  const grossCents = returnedSubtotalCents + shippingRefundCents + taxRefundCents;

  // The commission was frozen on the sub-order when it was paid, on the
  // product subtotal only. Returning items returns that share of it.
  const commissionShareCents = fullReturn
    ? sellerOrder.commissionAmountCents || 0
    : subtotal > 0
      ? Math.round(((sellerOrder.commissionAmountCents || 0) * returnedSubtotalCents) / subtotal)
      : 0;

  const commissionKeptCents = mode === "full" ? 0 : commissionShareCents;

  const stripeFeeWithheldCents = mode === "full" || !(sellerOrder.buyerTotalCents > 0)
    ? 0
    : Math.min(
        Math.round((Math.max(0, stripeFeeCents) * grossCents) / sellerOrder.buyerTotalCents),
        Math.max(0, grossCents - commissionKeptCents)
      );

  const buyerRefundCents = Math.max(0, grossCents - commissionKeptCents - stripeFeeWithheldCents);

  // On a multi-seller order the seller was PAID by a transfer from Lesovia
  // (items - commission + shipping, never tax); that is what they hand back.
  const sellerReversalCents = returnedSubtotalCents - commissionShareCents + shippingRefundCents;

  return {
    mode,
    fullReturn,
    returnedSubtotalCents,
    shippingRefundCents,
    taxRefundCents,
    grossCents,
    commissionShareCents,
    commissionKeptCents,
    stripeFeeWithheldCents,
    buyerRefundCents,
    sellerReversalCents,
    // Direct charge: the seller's balance funds the refund; in "full" mode
    // Lesovia's application fee is handed back with it.
    refundApplicationFee: mode === "full",
  };
}

// ---- the life of a return ----
//
//  requested --seller/admin approve--> approved --buyer adds tracking--> shipped_back
//      |  \--seller/admin decline--> declined --buyer asks for review--> escalated
//      |  \--seller silent for N days--> escalated                         |
//      \--buyer cancels--> cancelled                       admin approves/declines
//  approved --buyer too slow--> expired
//  shipped_back --seller confirms received--> refunding --> refunded
//               \--seller reports a problem--> problem_reported --admin--> refunding | rejected
//               \--seller silent for N days--> problem_reported (an admin decides)
//  refunding --Stripe error--> refund_failed --admin retries--> refunding
//  cancellation (never shipped): created straight into refunding.
const ACTIVE_STATUSES = [
  "requested", "approved", "declined", "escalated", "shipped_back",
  "problem_reported", "refunding", "refund_failed",
];

// One sentence telling a SELLER where the refund money came from, so "the buyer
// was refunded" is never mistaken for "Lesovia paid it".
//   direct charge -> it came out of the seller's own Stripe balance
//   multi-seller  -> Lesovia refunded the buyer and took the seller's share back
//                    (reversedCents = 0 when an admin chose to cover it instead)
function sellerRefundSource({ chargeType, plan, reversedCents = 0 }) {
  const money = (cents) => `$${((Number(cents) || 0) / 100).toFixed(2)}`;
  const refund = money(plan.buyerRefundCents);

  if (chargeType === "direct") {
    const base = `${refund} was refunded to the buyer from your Stripe balance.`;

    if (plan.mode === "full") {
      return plan.commissionShareCents > 0
        ? `${base} Lesovia returned its ${money(plan.commissionShareCents)} commission to you; Stripe's processing fee isn't returned.`
        : `${base} Stripe's processing fee isn't returned.`;
    }

    return `${base} Lesovia's commission and Stripe's processing fee were kept out of the refund, so you're left even on this sale.`;
  }

  return reversedCents > 0
    ? `Lesovia refunded the buyer ${refund} and took back the ${money(reversedCents)} it had sent you for this order.`
    : `Lesovia refunded the buyer ${refund} from its own balance; nothing was taken back from you.`;
}

module.exports = {
  ReturnError,
  DAY_MS,
  DEFAULT_POLICY,
  resolvePolicy,
  REASONS,
  isSellerFault,
  toMillis,
  shipmentTimes,
  returnWindowEndsAt,
  hasOpenDispute,
  hasBlockingReturn,
  CLOSED_WITHOUT_REFUND,
  ACTIVE_STATUSES,
  checkReturnEligibility,
  checkCancelEligibility,
  selectReturnItems,
  validateReasonDetails,
  attributableStripeFee,
  chooseRefundMode,
  computeReturnPlan,
  sellerRefundSource,
};
