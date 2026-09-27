const test = require("node:test");
const assert = require("node:assert/strict");

const {
  aggregateQuantities,
  findInsufficientStock,
  describePurchase,
  chargeIdOf,
  buildSellerOrder,
  buildCheckoutOrder,
} = require("./orderDocs");

test("quantities are combined per product across cart lines", () => {
  const totals = aggregateQuantities([
    { productId: "p1", quantity: 2, color: "red" },
    { productId: "p1", quantity: 1, color: "blue" },
    { productId: "p2", quantity: 4 },
  ]);

  assert.equal(totals.get("p1"), 3);
  assert.equal(totals.get("p2"), 4);
});

test("stock check uses the combined amount, not each line", () => {
  const needed = aggregateQuantities([
    { productId: "p1", quantity: 2 },
    { productId: "p1", quantity: 2 },
  ]);

  // 3 in stock covers each line of 2 on its own, but not the 4 actually bought
  assert.equal(findInsufficientStock(needed, new Map([["p1", 3]])), "p1");
  assert.equal(findInsufficientStock(needed, new Map([["p1", 4]])), null);
});

test("a deleted product counts as out of stock", () => {
  const needed = aggregateQuantities([{ productId: "gone", quantity: 1 }]);
  assert.equal(findInsufficientStock(needed, new Map([["gone", 0]])), "gone");
  assert.equal(findInsufficientStock(needed, new Map()), "gone");
});

test("purchase descriptions for notifications", () => {
  assert.equal(describePurchase([{ name: "Sticker" }]), "Sticker");
  assert.equal(describePurchase([{ name: "Sticker" }, { name: "Fan" }]), "Sticker and 1 more item");
  assert.equal(
    describePurchase([{ name: "Sticker" }, { name: "Fan" }, { name: "Bear" }]),
    "Sticker and 2 more items"
  );
});

test("charge id is read from a string or an expanded charge", () => {
  assert.equal(chargeIdOf({ latest_charge: "ch_1" }), "ch_1");
  assert.equal(chargeIdOf({ latest_charge: { id: "ch_2" } }), "ch_2");
  assert.equal(chargeIdOf({ latest_charge: null }), null);
});

const seller = {
  sellerId: "sA",
  stripeAccountId: "acct_A",
  storeName: "Shop A",
  productSubtotalCents: 1200,
  shippingCents: 978,
  shippingMethod: "flat",
  taxCents: 0,
  taxCalculationId: null,
  commissionRate: 0.07,
  commissionAmountCents: 84,
  sellerProceedsCents: 2094,
  buyerTotalCents: 2178,
};

const items = [
  { productId: "p1", sellerId: "sA", quantity: 2, unitPriceCents: 600, color: null, size: null, name: "Sticker" },
  { productId: "p9", sellerId: "sB", quantity: 1, unitPriceCents: 500, color: null, size: null, name: "Other" },
];

test("a sub-order holds only that seller's products, snapshotted, with frozen money fields", () => {
  const order = buildSellerOrder({
    checkoutId: "c1",
    buyerId: "buyer1",
    seller,
    items,
    productsById: new Map([["p1", { name: "Sticker v2", images: ["img.png"], description: "Nice" }]]),
    orderNumber: "LSV-000001-1",
    deliveryAddress: { city: "Sioux City" },
    paymentIntent: { id: "pi_1", latest_charge: "ch_1" },
    chargeType: "direct",
    taxLiabilityAtPurchase: "not_yet_determined",
    createdAt: "TS",
  });

  assert.equal(order.products.length, 1);
  assert.deepEqual(order.productIds, ["p1"]);
  assert.equal(order.storeName, "Shop A");
  assert.equal(order.products[0].name, "Sticker v2");
  assert.equal(order.products[0].image, "img.png");
  assert.equal(order.commissionRate, 0.07);
  assert.equal(order.commissionAmountCents, 84);
  assert.equal(order.sellerProceedsCents, 2094);
  assert.equal(order.stripeChargeId, "ch_1");
  assert.equal(order.fulfillmentStatus, "paid");
  assert.equal(order.taxLiabilityAtPurchase, "not_yet_determined");
});

test("transfer tracking exists only for multi-seller (separate charge) sub-orders", () => {
  const args = {
    checkoutId: "c1",
    buyerId: "b",
    seller,
    items,
    productsById: new Map(),
    orderNumber: "LSV-000001-1",
    deliveryAddress: null,
    paymentIntent: { id: "pi_1", latest_charge: "ch_1" },
    taxLiabilityAtPurchase: "not_yet_determined",
    createdAt: "TS",
  };

  assert.equal(buildSellerOrder({ ...args, chargeType: "direct" }).transferStatus, null);
  assert.equal(buildSellerOrder({ ...args, chargeType: "separate" }).transferStatus, "pending");
});

test("the parent order carries the buyer's total and links its sub-orders", () => {
  const parent = buildCheckoutOrder({
    checkoutId: "c1",
    pending: { buyerId: "buyer1", amount: 3603, currency: "usd", chargeType: "separate", stripeAccountId: null },
    orderNumber: "LSV-000001",
    deliveryAddress: null,
    sellerOrderIds: ["c1_sA", "c1_sB"],
    paymentIntent: { id: "pi_1" },
    createdAt: "TS",
  });

  assert.equal(parent.totalAmountCents, 3603);
  assert.equal(parent.chargeType, "separate");
  assert.deepEqual(parent.sellerOrderIds, ["c1_sA", "c1_sB"]);
  assert.equal(parent.stripeAccountId, null);
});
