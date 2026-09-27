const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ReturnError, DAY_MS, DEFAULT_POLICY, resolvePolicy, REASONS, isSellerFault,
  toMillis, returnWindowEndsAt, checkReturnEligibility, checkCancelEligibility,
  selectReturnItems, validateReasonDetails, attributableStripeFee,
  chooseRefundMode, computeReturnPlan,
} = require("./returnMath");

const policy = resolvePolicy();
const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const ago = (days) => NOW - days * DAY_MS;
const ts = (ms) => ({ toMillis: () => ms });

// $300 order, $9.78 shipping, 7% commission = $21.00 (the real LSV-000005-1)
const single = (over = {}) => ({
  fulfillmentStatus: "delivered",
  products: [{ productId: "p1", name: "Cheap product", quantity: 1, unitPriceCents: 30000, image: "i.png" }],
  productSubtotalCents: 30000,
  shippingCents: 978,
  taxCents: 0,
  commissionRate: 0.07,
  commissionAmountCents: 2100,
  sellerProceedsCents: 28878,
  buyerTotalCents: 30978,
  chargeType: "direct",
  stripeChargeId: "ch_1",
  createdAt: ts(ago(20)),
  shippedAtServer: ts(ago(12)),
  deliveredAtServer: ts(ago(3)),
  ...over,
});

// ---------------- policy ----------------
test("policy: defaults, and only well-typed overrides are applied", () => {
  assert.deepEqual(resolvePolicy(), DEFAULT_POLICY);
  assert.equal(policy.returnWindowDays, 7);
  assert.equal(policy.returnShipDays, 30);
  assert.equal(policy.cancelUnshippedAfterDays, 14);
  assert.equal(policy.sellerFaultFullRefund, false);

  const p = resolvePolicy({ returnWindowDays: 10, sellerFaultFullRefund: true, returnShipDays: "soon", cancelUnshippedAfterDays: -3, bogus: 1 });
  assert.equal(p.returnWindowDays, 10);
  assert.equal(p.sellerFaultFullRefund, true);
  assert.equal(p.returnShipDays, 30);           // wrong type -> default
  assert.equal(p.cancelUnshippedAfterDays, 14); // negative -> default
  assert.equal(p.bogus, undefined);
  assert.equal(resolvePolicy("nonsense").returnWindowDays, 7);
});

test("reasons: damaged / wrong item / not as described are seller-fault and need photos", () => {
  for (const r of ["damaged", "wrong_item", "not_as_described"]) {
    assert.ok(isSellerFault(r));
    assert.ok(REASONS[r].photosRequired);
  }
  for (const r of ["too_big", "too_small", "not_liked", "other"]) assert.ok(!isSellerFault(r));
  assert.ok(!isSellerFault("nope"));
});

// ---------------- the return window ----------------
test("window: 7 days from delivery, but never before 5 days after shipping", () => {
  // shipped 12 days ago, delivered 3 days ago -> window = 3 days ago + 7d
  assert.equal(returnWindowEndsAt(single(), policy), ago(3) + 7 * DAY_MS);

  // seller marked delivered 1 minute after shipping: window starts 5 days after shipping instead
  const early = single({ shippedAtServer: ts(ago(2)), deliveredAtServer: ts(ago(2) + 60000) });
  assert.equal(returnWindowEndsAt(early, policy), ago(2) + 5 * DAY_MS + 7 * DAY_MS);

  assert.equal(returnWindowEndsAt(single({ deliveredAtServer: null, deliveredAt: null }), policy), null);
});

test("window: server-stamped times win over seller-written ones; the seller's are only a fallback", () => {
  const forged = single({ deliveredAt: ts(ago(30)) }); // seller wrote an old date
  assert.equal(returnWindowEndsAt(forged, policy), ago(3) + 7 * DAY_MS);

  const legacy = single({ deliveredAtServer: null, shippedAtServer: null, deliveredAt: ts(ago(2)), shippedAt: ts(ago(9)) });
  assert.equal(returnWindowEndsAt(legacy, policy), ago(2) + 7 * DAY_MS);
});

test("eligibility: delivered, inside the window, nothing else in the way", () => {
  assert.equal(checkReturnEligibility({ sellerOrder: single(), nowMs: NOW, policy }).ok, true);
});

test("eligibility: refuses everything it should", () => {
  const check = (over, extra = {}) => checkReturnEligibility({ sellerOrder: single(over), nowMs: NOW, policy, ...extra });

  assert.match(check({ fulfillmentStatus: "shipped" }).message, /once the order has been delivered/);
  assert.match(check({ fulfillmentStatus: "paid" }).message, /once the order has been delivered/);
  assert.match(check({ deliveredAtServer: ts(ago(20)), shippedAtServer: ts(ago(25)) }).message, /7-day return window .* has ended/);
  assert.match(check({ deliveredAtServer: null, deliveredAt: null }).message, /couldn't confirm the delivery date/);
  assert.match(check({ disputeStatus: "needs_response" }).message, /disputed with your bank/);
  assert.match(check({ refundedAmountCents: 500 }).message, /already been refunded/);
  assert.match(check({ stripeChargeId: null }).message, /can't be returned online/);
  assert.match(check({}, { existingReturns: [{ status: "requested" }] }).message, /already been started/);
  assert.match(check({}, { existingReturns: [{ status: "declined" }] }).message, /already been started/);
  assert.match(check({}, { existingReturns: [{ status: "refunded" }] }).message, /already been started/);

  // a lapsed or withdrawn one doesn't block a fresh request
  assert.equal(check({}, { existingReturns: [{ status: "cancelled" }, { status: "expired" }] }).ok, true);
});

test("the last moment of the window still counts, the next does not", () => {
  const end = returnWindowEndsAt(single(), policy);
  assert.equal(checkReturnEligibility({ sellerOrder: single(), nowMs: end, policy }).ok, true);
  assert.equal(checkReturnEligibility({ sellerOrder: single(), nowMs: end + 1, policy }).ok, false);
});

// ---------------- cancelling an order that never shipped ----------------
test("cancel: only unshipped orders, only after 14 days", () => {
  const unshipped = (days, over = {}) => single({ fulfillmentStatus: "paid", shippedAtServer: null, deliveredAtServer: null, createdAt: ts(ago(days)), ...over });
  const check = (o, extra = {}) => checkCancelEligibility({ sellerOrder: o, nowMs: NOW, policy, ...extra });

  const tooSoon = check(unshipped(13));
  assert.equal(tooSoon.ok, false);
  assert.match(tooSoon.message, /14 days after it was placed/);
  assert.equal(tooSoon.availableAtMs, ago(13) + 14 * DAY_MS);

  assert.equal(check(unshipped(14)).ok, true);
  assert.equal(check(unshipped(40)).ok, true);

  assert.match(check(unshipped(20, { fulfillmentStatus: "shipped" })).message, /haven't shipped/);
  assert.match(check(unshipped(20, { disputeStatus: "under_review" })).message, /disputed/);
  assert.match(check(unshipped(20), { existingReturns: [{ status: "refunded" }] }).message, /already been started/);
  assert.match(check(unshipped(20, { refundedAmountCents: 1 })).message, /already been refunded/);
});

// ---------------- what is being returned ----------------
const twoLines = () => single({
  products: [
    { productId: "a", name: "Sticker", quantity: 2, unitPriceCents: 600 },
    { productId: "b", name: "Fan", quantity: 1, unitPriceCents: 2013, color: "red" },
  ],
  productSubtotalCents: 3213, shippingCents: 978, commissionAmountCents: 225, buyerTotalCents: 4191,
});

test("items: valid selection is normalised and snapshotted", () => {
  const items = selectReturnItems(twoLines(), [{ lineIndex: 1, quantity: 1 }, { lineIndex: 0, quantity: 2 }]);
  assert.deepEqual(items.map((i) => [i.lineIndex, i.quantity, i.unitPriceCents, i.name]), [[0, 2, 600, "Sticker"], [1, 1, 2013, "Fan"]]);
  assert.equal(items[1].color, "red");
});

test("items: bad selections are refused", () => {
  const o = twoLines();
  for (const bad of [undefined, [], "x", [{ lineIndex: 5, quantity: 1 }], [{ lineIndex: -1, quantity: 1 }],
    [{ lineIndex: 0, quantity: 3 }], [{ lineIndex: 0, quantity: 0 }], [{ lineIndex: 0, quantity: 1.5 }],
    [{ lineIndex: 0, quantity: 1 }, { lineIndex: 0, quantity: 1 }], [null]]) {
    assert.throws(() => selectReturnItems(o, bad), ReturnError);
  }
});

test("reason details: reason required, description length, photos", () => {
  const ok = { reason: "too_big", description: "It is much bigger than I expected", photos: [] };
  assert.equal(validateReasonDetails(ok, policy).reason, "too_big");
  assert.equal(validateReasonDetails({ ...ok, description: "  padded description here  " }, policy).description, "padded description here");

  assert.throws(() => validateReasonDetails({ ...ok, reason: "bogus" }, policy), /choose a reason/);
  assert.throws(() => validateReasonDetails({ ...ok, description: "short" }, policy), /at least 10/);
  assert.throws(() => validateReasonDetails({ ...ok, description: "x".repeat(1001) }, policy), /under 1000/);
  assert.throws(() => validateReasonDetails({ ...ok, photos: [1, 2, 3, 4, 5, 6] }, policy), /up to 5 photos/);
  assert.throws(() => validateReasonDetails({ ...ok, reason: "damaged" }, policy), /at least one photo/);
  assert.equal(validateReasonDetails({ ...ok, reason: "damaged", photos: [1] }, policy).reason, "damaged");
});

// ---------------- money ----------------
test("stripe fee share: direct = all of it; separate = the sub-order's share of the charge", () => {
  assert.equal(attributableStripeFee({ chargeType: "direct", chargeFeeCents: 928, subOrderTotalCents: 30978, checkoutTotalCents: 30978 }), 928);
  assert.equal(attributableStripeFee({ chargeType: "separate", chargeFeeCents: 8772, subOrderTotalCents: 300981, checkoutTotalCents: 301478 }), Math.round((8772 * 300981) / 301478));
  assert.equal(attributableStripeFee({ chargeType: "separate", chargeFeeCents: 100, subOrderTotalCents: 1, checkoutTotalCents: 0 }), 0);
  assert.equal(attributableStripeFee({ chargeType: "direct", chargeFeeCents: -5 }), 0);
});

test("refund mode: standard unless never-shipped, admin override, or the seller-fault setting", () => {
  const mode = (o) => chooseRefundMode({ kind: "return", reason: "too_big", forceFull: false, policy, ...o });
  assert.equal(mode({}), "standard");
  assert.equal(mode({ reason: "damaged" }), "standard");               // policy default: fees kept even then
  assert.equal(mode({ kind: "cancellation", reason: "not_shipped" }), "full");
  assert.equal(mode({ forceFull: true }), "full");
  const generous = resolvePolicy({ sellerFaultFullRefund: true });
  assert.equal(mode({ reason: "damaged", policy: generous }), "full");
  assert.equal(mode({ reason: "too_big", policy: generous }), "standard");
});

test("PLAN, one seller, whole order back: buyer gets $279.50 of $309.78 (commission $21.00 and Stripe fee $9.28 kept)", () => {
  const order = single();
  const items = selectReturnItems(order, [{ lineIndex: 0, quantity: 1 }]);
  const plan = computeReturnPlan({ sellerOrder: order, items, stripeFeeCents: 928, mode: "standard" });

  assert.equal(plan.fullReturn, true);
  assert.equal(plan.grossCents, 30978);
  assert.equal(plan.shippingRefundCents, 978);
  assert.equal(plan.commissionKeptCents, 2100);
  assert.equal(plan.stripeFeeWithheldCents, 928);
  assert.equal(plan.buyerRefundCents, 27950);
  assert.equal(plan.refundApplicationFee, false);

  // what the seller received = 30978 - 2100 (commission) - 928 (fee); the refund is exactly that
  assert.equal(order.buyerTotalCents - 2100 - 928, plan.buyerRefundCents);
});

test("PLAN, two sellers ($309.78 order, 10% commission): buyer gets $270.50; the seller hands back what they were sent", () => {
  const order = single({ chargeType: "separate", commissionRate: 0.1, commissionAmountCents: 3000, sellerProceedsCents: 27978 });
  const items = selectReturnItems(order, [{ lineIndex: 0, quantity: 1 }]);
  const plan = computeReturnPlan({ sellerOrder: order, items, stripeFeeCents: 928, mode: "standard" });

  assert.equal(plan.buyerRefundCents, 27050);
  assert.equal(plan.sellerReversalCents, 27978);       // exactly the transfer they received
  assert.equal(plan.sellerReversalCents, order.sellerProceedsCents);
});

test("PLAN, full mode: buyer gets everything back, commission returned, fee not withheld", () => {
  const order = single();
  const items = selectReturnItems(order, [{ lineIndex: 0, quantity: 1 }]);
  const plan = computeReturnPlan({ sellerOrder: order, items, stripeFeeCents: 928, mode: "full" });

  assert.equal(plan.buyerRefundCents, 30978);
  assert.equal(plan.commissionKeptCents, 0);
  assert.equal(plan.stripeFeeWithheldCents, 0);
  assert.equal(plan.refundApplicationFee, true);
});

test("PLAN, partial return: only those items; shipping stays; commission and fee scale down", () => {
  const order = twoLines(); // sticker x2 ($12) + fan ($20.13), shipping $9.78, commission $2.25
  const items = selectReturnItems(order, [{ lineIndex: 1, quantity: 1 }]); // just the fan
  const plan = computeReturnPlan({ sellerOrder: order, items, stripeFeeCents: 150, mode: "standard" });

  assert.equal(plan.fullReturn, false);
  assert.equal(plan.returnedSubtotalCents, 2013);
  assert.equal(plan.shippingRefundCents, 0);
  assert.equal(plan.grossCents, 2013);
  assert.equal(plan.commissionShareCents, Math.round((225 * 2013) / 3213));       // 141
  assert.equal(plan.stripeFeeWithheldCents, Math.round((150 * 2013) / 4191));      // 72
  assert.equal(plan.buyerRefundCents, 2013 - 141 - 72);
});

test("PLAN, partial return of part of a line: quantity counts, shipping only when EVERYTHING goes back", () => {
  const order = twoLines();
  const one = computeReturnPlan({ sellerOrder: order, items: selectReturnItems(order, [{ lineIndex: 0, quantity: 1 }]), stripeFeeCents: 0, mode: "standard" });
  assert.equal(one.returnedSubtotalCents, 600);
  assert.equal(one.fullReturn, false);

  const all = computeReturnPlan({ sellerOrder: order, items: selectReturnItems(order, [{ lineIndex: 0, quantity: 2 }, { lineIndex: 1, quantity: 1 }]), stripeFeeCents: 0, mode: "standard" });
  assert.equal(all.fullReturn, true);
  assert.equal(all.shippingRefundCents, 978);
  assert.equal(all.commissionShareCents, 225);   // the whole frozen commission, no rounding drift
});

test("PLAN, tax comes back in proportion but is never part of what the seller hands back", () => {
  const order = single({ taxCents: 264, buyerTotalCents: 31242 });
  const items = selectReturnItems(order, [{ lineIndex: 0, quantity: 1 }]);
  const plan = computeReturnPlan({ sellerOrder: order, items, stripeFeeCents: 0, mode: "full" });

  assert.equal(plan.taxRefundCents, 264);
  assert.equal(plan.grossCents, 30000 + 978 + 264);
  assert.equal(plan.sellerReversalCents, 30000 - 2100 + 978);
});

test("PLAN: a refund never goes negative, and the fee withheld never exceeds what's left", () => {
  const order = single({
    products: [{ productId: "p", name: "Pin", quantity: 1, unitPriceCents: 100 }],
    productSubtotalCents: 100, shippingCents: 0, commissionAmountCents: 10, buyerTotalCents: 100,
  });
  const items = selectReturnItems(order, [{ lineIndex: 0, quantity: 1 }]);
  const plan = computeReturnPlan({ sellerOrder: order, items, stripeFeeCents: 500, mode: "standard" });

  assert.equal(plan.buyerRefundCents, 0);
  assert.equal(plan.stripeFeeWithheldCents, 90);   // capped at gross - commission
});
