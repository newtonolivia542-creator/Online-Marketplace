const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CheckoutError,
  resolveChargeType,
  resolveShipping,
  computeSellerBreakdown,
} = require("./paymentMath");

test("one seller -> direct charge at 7%", () => {
  assert.deepEqual(resolveChargeType(1), { chargeType: "direct", commissionRate: 0.07 });
});

test("two or more sellers -> separate charges at 10%", () => {
  assert.deepEqual(resolveChargeType(2), { chargeType: "separate", commissionRate: 0.1 });
  assert.deepEqual(resolveChargeType(5), { chargeType: "separate", commissionRate: 0.1 });
});

test("7% of $100.00 subtotal is $7.00 (example from the requirements: 700 cents)", () => {
  const b = computeSellerBreakdown({
    productSubtotalCents: 10000,
    shippingCents: 0,
    taxCents: 0,
    commissionRate: 0.07,
  });

  assert.equal(b.commissionAmountCents, 700);
  assert.equal(b.sellerProceedsCents, 9300);
});

test("10% of $100.00 subtotal is $10.00 (1000 cents)", () => {
  const b = computeSellerBreakdown({
    productSubtotalCents: 10000,
    shippingCents: 0,
    taxCents: 0,
    commissionRate: 0.1,
  });

  assert.equal(b.commissionAmountCents, 1000);
});

test("commission ignores shipping and tax; seller keeps shipping; tax is pass-through", () => {
  const b = computeSellerBreakdown({
    productSubtotalCents: 10000,
    shippingCents: 978,
    taxCents: 825,
    commissionRate: 0.07,
  });

  assert.equal(b.commissionAmountCents, 700);
  assert.equal(b.sellerProceedsCents, 10000 - 700 + 978);
  assert.equal(b.buyerTotalCents, 10000 + 978 + 825);
});

test("commission rounds to whole cents", () => {
  const b = computeSellerBreakdown({
    productSubtotalCents: 204,
    shippingCents: 0,
    taxCents: 0,
    commissionRate: 0.07,
  });

  assert.equal(b.commissionAmountCents, 14);
  assert.equal(b.sellerProceedsCents, 190);
});

test("a 1-cent subtotal rounds commission to 0 and never goes negative", () => {
  const b = computeSellerBreakdown({
    productSubtotalCents: 1,
    shippingCents: 0,
    taxCents: 0,
    commissionRate: 0.07,
  });

  assert.equal(b.commissionAmountCents, 0);
  assert.equal(b.sellerProceedsCents, 1);
});

test("standard shipping is free when the seller offers free shipping", () => {
  assert.deepEqual(resolveShipping({ freeShipping: true, flatRateCents: 978 }), {
    shippingMethod: "free",
    shippingCents: 0,
  });
});

test("standard shipping is the flat rate otherwise", () => {
  assert.deepEqual(resolveShipping({ freeShipping: false, flatRateCents: 978 }, "standard"), {
    shippingMethod: "flat",
    shippingCents: 978,
  });
});

test("express shipping needs to be enabled by the seller", () => {
  const config = { freeShipping: true, expressEnabled: true, expressRateCents: 2500 };

  assert.deepEqual(resolveShipping(config, "express"), {
    shippingMethod: "express",
    shippingCents: 2500,
  });

  assert.throws(
    () => resolveShipping({ freeShipping: true, expressEnabled: false }, "express"),
    CheckoutError
  );
});

test("missing or malformed shipping config fails closed", () => {
  assert.throws(() => resolveShipping(undefined), CheckoutError);
  assert.throws(() => resolveShipping({ freeShipping: false }), CheckoutError);
  assert.throws(() => resolveShipping({ freeShipping: false, flatRateCents: -5 }), CheckoutError);
  assert.throws(() => resolveShipping({ freeShipping: false, flatRateCents: 9.5 }), CheckoutError);
});

test("unknown shipping methods from the client are rejected", () => {
  assert.throws(() => resolveShipping({ freeShipping: true }, "overnight"), CheckoutError);
});
