const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeOnboardingStatus,
  planRefundUpdate,
  disputePatch,
  describeDispute,
  transferReversalPatch,
  TRANSFER_SETTLED,
} = require("./webhookPatches");

// ---- seller onboarding status ----
test("onboarding: complete only when charges AND payouts are enabled", () => {
  assert.equal(computeOnboardingStatus({ charges_enabled: true, payouts_enabled: true }), "complete");
  assert.equal(computeOnboardingStatus({ charges_enabled: true, payouts_enabled: false }), "pending");
});

test("onboarding: a real problem is restricted, but 'Stripe is still checking' is just pending", () => {
  const withReason = (disabled_reason) => ({ charges_enabled: false, payouts_enabled: false, requirements: { disabled_reason } });

  assert.equal(computeOnboardingStatus(withReason("requirements.past_due")), "restricted");
  assert.equal(computeOnboardingStatus(withReason("rejected.fraud")), "restricted");
  assert.equal(computeOnboardingStatus(withReason("requirements.pending_verification")), "pending");
  assert.equal(computeOnboardingStatus(withReason("under_review")), "pending");
  assert.equal(computeOnboardingStatus(withReason(null)), "pending");
  assert.equal(computeOnboardingStatus({ charges_enabled: false, payouts_enabled: false }), "pending");
});

// ---- refunds ----
const so = (id, buyerTotalCents) => ({ id, data: { buyerTotalCents } });

test("refund: single-seller charge -> the one sub-order and the checkout carry the amount", () => {
  const plan = planRefundUpdate({ amount_refunded: 500, refunded: false }, [so("c1_a", 2178)]);

  assert.deepEqual(plan.checkout, { refundedAmountCents: 500, refundStatus: "partially_refunded" });
  assert.deepEqual(plan.sellers, [
    { id: "c1_a", patch: { refundedAmountCents: 500, refundStatus: "partially_refunded" } },
  ]);
});

test("refund: a full refund is 'refunded'", () => {
  const plan = planRefundUpdate({ amount_refunded: 2178, refunded: true }, [so("c1_a", 2178)]);
  assert.equal(plan.checkout.refundStatus, "refunded");
  assert.equal(plan.sellers[0].patch.refundStatus, "refunded");
});

test("refund: full refund of a multi-seller charge refunds every seller's whole slice", () => {
  const plan = planRefundUpdate({ amount_refunded: 33978, refunded: true }, [so("m_a", 30978), so("m_b", 3000)]);

  assert.deepEqual(plan.sellers, [
    { id: "m_a", patch: { refundedAmountCents: 30978, refundStatus: "refunded" } },
    { id: "m_b", patch: { refundedAmountCents: 3000, refundStatus: "refunded" } },
  ]);
  assert.equal(plan.checkout.refundedAmountCents, 33978);
});

test("refund: a PARTIAL refund of a multi-seller charge is not pinned on any one seller", () => {
  const plan = planRefundUpdate({ amount_refunded: 1000, refunded: false }, [so("m_a", 30978), so("m_b", 3000)]);

  assert.deepEqual(plan.sellers, []);
  assert.deepEqual(plan.checkout, { refundedAmountCents: 1000, refundStatus: "partially_refunded" });
});

test("refund: replaying the same event gives the identical plan", () => {
  const charge = { amount_refunded: 500, refunded: false };
  assert.deepEqual(planRefundUpdate(charge, [so("a", 900)]), planRefundUpdate(charge, [so("a", 900)]));
});

// ---- disputes ----
test("dispute patch carries status, reason and amount", () => {
  assert.deepEqual(
    disputePatch({ status: "needs_response", reason: "fraudulent", amount: 30978 }),
    { disputeStatus: "needs_response", disputeReason: "fraudulent", disputeAmountCents: 30978 }
  );
});

test("every Stripe dispute status has wording, and an unknown one falls back safely", () => {
  for (const status of ["warning_needs_response", "warning_under_review", "warning_closed", "needs_response", "under_review", "won", "lost", "charge_refunded"]) {
    assert.match(describeDispute(status), /\w/);
  }
  assert.match(describeDispute("something_new"), /disputed/);
});

// ---- transfers ----
test("transfer reversal: full vs partial", () => {
  assert.deepEqual(transferReversalPatch({ amount: 27978, amount_reversed: 27978 }), { transferStatus: "reversed", transferReversedCents: 27978 });
  assert.deepEqual(transferReversalPatch({ amount: 27978, amount_reversed: 1000 }), { transferStatus: "partially_reversed", transferReversedCents: 1000 });
});

test("a paid-or-clawed-back transfer is never re-sent", () => {
  for (const status of ["transferred", "reversed", "partially_reversed"]) assert.ok(TRANSFER_SETTLED.includes(status));
  for (const status of ["pending", "failed", null]) assert.ok(!TRANSFER_SETTLED.includes(status));
});
