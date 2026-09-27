// Pure decisions for the Stripe webhook handlers: given what Stripe reported,
// what should be written to our documents? No Firebase or Stripe imports, so
// they can be unit-tested. Every patch sets absolute values (never "add to
// what's there"), so replaying the same event is harmless -- Stripe does
// redeliver.

// Derives a simple status string from a Stripe Connect Account object.
// A populated disabled_reason normally means something needs the seller's
// attention ("restricted") -- except the two reasons that just mean Stripe is
// still checking what was submitted, which is what every account reports for
// a few seconds after onboarding is submitted.
const WAITING_ON_STRIPE = /^(requirements\.pending_verification|under_review)/;

function computeOnboardingStatus(account) {
  if (account.charges_enabled && account.payouts_enabled) {
    return "complete";
  }

  const reason = account.requirements && account.requirements.disabled_reason;

  if (reason && !WAITING_ON_STRIPE.test(reason)) {
    return "restricted";
  }

  return "pending";
}

// A charge was refunded (fully or partly) -- including from the Stripe
// Dashboard, not just by us. `sellerOrders` are all the sub-orders paid by
// that charge: one for a single-seller checkout, one per seller otherwise.
//
// A partial refund on a multi-seller charge can't be pinned on one seller from
// the charge alone, so it is recorded on the checkout only; a full refund
// refunds every seller's slice, so that is recorded on each.
function planRefundUpdate(charge, sellerOrders) {
  const refundedCents = Number(charge.amount_refunded) || 0;
  const fullyRefunded = Boolean(charge.refunded);
  const refundStatus = fullyRefunded ? "refunded" : refundedCents > 0 ? "partially_refunded" : null;

  const sellers = [];

  if (sellerOrders.length === 1) {
    sellers.push({
      id: sellerOrders[0].id,
      patch: { refundedAmountCents: refundedCents, refundStatus },
    });
  } else if (fullyRefunded) {
    for (const { id, data } of sellerOrders) {
      sellers.push({
        id,
        patch: { refundedAmountCents: data.buyerTotalCents, refundStatus: "refunded" },
      });
    }
  }

  return {
    checkout: { refundedAmountCents: refundedCents, refundStatus },
    sellers,
  };
}

// A buyer's bank disputed the charge. A dispute covers the whole charge, so
// every seller paid by it carries the same dispute state.
function disputePatch(dispute) {
  return {
    disputeStatus: dispute.status || null,
    disputeReason: dispute.reason || null,
    disputeAmountCents: Number(dispute.amount) || 0,
  };
}

// Wording for the seller's order card. Direct-charge sellers answer disputes in
// their own Stripe Dashboard; on multi-seller orders Lesovia does.
const DISPUTE_LABELS = {
  warning_needs_response: "the buyer's bank has raised an inquiry",
  warning_under_review: "an inquiry from the buyer's bank is under review",
  warning_closed: "an inquiry from the buyer's bank was closed",
  needs_response: "the buyer's bank disputed this payment",
  under_review: "the buyer's bank disputed this payment; the dispute is under review",
  won: "the buyer's bank disputed this payment; the dispute was resolved in your favor",
  lost: "the buyer's bank disputed this payment; the dispute was not resolved in your favor",
  charge_refunded: "the payment was refunded, so the dispute was closed",
};

function describeDispute(status) {
  return DISPUTE_LABELS[status] || "the buyer's bank disputed this payment";
}

// A transfer to a seller was (fully or partly) reversed.
function transferReversalPatch(transfer) {
  const reversed = Number(transfer.amount_reversed) || 0;
  const total = Number(transfer.amount) || 0;

  return {
    transferStatus: total > 0 && reversed >= total ? "reversed" : "partially_reversed",
    transferReversedCents: reversed,
  };
}

// Once a seller has been paid -- or the payment was clawed back -- nothing
// should send them the money again.
const TRANSFER_SETTLED = ["transferred", "reversed", "partially_reversed"];

module.exports = {
  computeOnboardingStatus,
  planRefundUpdate,
  disputePatch,
  describeDispute,
  transferReversalPatch,
  TRANSFER_SETTLED,
};
