const test = require("node:test");
const assert = require("node:assert/strict");

const im = require("./insightsMath");

const cfg = im.resolveConfig(null);
const NOW = Date.parse("2026-11-20T18:00:00Z");
const DAY = 86400000;
const ago = (days) => new Date(NOW - days * DAY);

const order = (daysAgo, lines, extra = {}) => ({
  createdAt: ago(daysAgo),
  fulfillmentStatus: "delivered",
  refundStatus: null,
  products: lines.map(([productId, quantity, unitPriceCents]) => ({ productId, quantity, unitPriceCents })),
  ...extra,
});

test("config: Plus $5.99, Pro $9.99, Pro and Unlimited plans include Insights Pro; bad fields fall back", () => {
  assert.equal(cfg.tiers.plus.priceCents, 599);
  assert.equal(cfg.tiers.pro.priceCents, 999);
  assert.deepEqual(cfg.bundled, { free: "none", plus: "none", pro: "pro", unlimited: "pro" });
  assert.equal(cfg.aiSummariesPerMonth, 4);

  const odd = im.resolveConfig({ tiers: { pro: { priceCents: "ten", name: "  " } }, bundled: { pro: "gold", plus: "plus" }, aiSummariesPerMonth: -1 });

  assert.equal(odd.tiers.pro.priceCents, 999);
  assert.equal(odd.tiers.pro.name, "Insights Pro");
  assert.equal(odd.bundled.pro, "pro");
  assert.equal(odd.bundled.plus, "plus");
  assert.equal(odd.aiSummariesPerMonth, 4);
});

test("tier: the higher of what was bought and what the listing plan includes", () => {
  const paid = (tier, status = "active") => ({ tier, status });

  assert.equal(im.effectiveTier(null, "free", cfg), "none");
  assert.equal(im.effectiveTier(paid("plus"), "free", cfg), "plus");
  assert.equal(im.effectiveTier(paid("pro"), "free", cfg), "pro");
  assert.equal(im.effectiveTier(null, "pro", cfg), "pro", "included with the Pro listing plan");
  assert.equal(im.effectiveTier(null, "unlimited", cfg), "pro");
  assert.equal(im.effectiveTier(paid("plus"), "pro", cfg), "pro", "bundle beats a lower purchase");
  assert.equal(im.effectiveTier(paid("pro"), "plus", cfg), "pro");
  assert.equal(im.effectiveTier(paid("plus", "past_due"), "free", cfg), "plus", "still paid while Stripe retries");
  assert.equal(im.effectiveTier(paid("pro", "canceled"), "free", cfg), "none");
  assert.equal(im.effectiveTier(paid("gold"), "free", cfg), "none");

  assert.equal(im.hasTier("pro", "plus"), true);
  assert.equal(im.hasTier("plus", "pro"), false);
  assert.equal(im.hasTier("none", "plus"), false);
});

test("countsAsSale: cancelled, returned and fully refunded orders are not sales", () => {
  assert.equal(im.countsAsSale({ fulfillmentStatus: "paid" }), true);
  assert.equal(im.countsAsSale({ fulfillmentStatus: "delivered", refundStatus: "partially_refunded" }), true);
  assert.equal(im.countsAsSale({ fulfillmentStatus: "cancelled" }), false);
  assert.equal(im.countsAsSale({ fulfillmentStatus: "returned" }), false);
  assert.equal(im.countsAsSale({ fulfillmentStatus: "delivered", refundStatus: "refunded" }), false);
});

test("salesByMonth: six zero-filled months, oldest first, units and revenue summed, refunds left out", () => {
  const orders = [
    order(2, [["a", 2, 1000], ["b", 1, 500]]),         // Nov: 3 units, $25
    order(10, [["a", 1, 1000]]),                        // Nov: 1 unit, $10
    order(25, [["a", 4, 1000]]),                        // Oct: 4 units, $40
    order(5, [["a", 9, 1000]], { fulfillmentStatus: "cancelled" }), // ignored
    order(8, [["b", 9, 500]], { refundStatus: "refunded" }),         // ignored
    order(400, [["a", 1, 1000]]),                       // outside the window
  ];

  const months = im.salesByMonth(orders, NOW, 6);

  assert.equal(months.length, 6);
  assert.deepEqual(months.map((m) => m.month), ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
  assert.deepEqual(months[5], { month: "2026-11", label: "Nov 2026", units: 4, revenueCents: 3500, orders: 2 });
  assert.deepEqual(months[4], { month: "2026-10", label: "Oct 2026", units: 4, revenueCents: 4000, orders: 1 });
  assert.equal(months[0].units, 0);
});

test("salesByMonth: wraps across the new year", () => {
  const months = im.salesByMonth([], Date.parse("2027-02-10T12:00:00Z"), 4);

  assert.deepEqual(months.map((m) => m.month), ["2026-11", "2026-12", "2027-01", "2027-02"]);
});

test("monthOverMonth: percent change, null when last month had nothing", () => {
  const months = [{ units: 4, revenueCents: 4000 }, { units: 6, revenueCents: 3000 }];

  assert.deepEqual(im.monthOverMonth(months), { thisMonth: months[1], lastMonth: months[0], unitsChangePct: 50, revenueChangePct: -25 });
  assert.equal(im.monthOverMonth([{ units: 0, revenueCents: 0 }, { units: 3, revenueCents: 300 }]).unitsChangePct, null);
});

const products = [
  { id: "a", name: "Mug", quantity: 3, createdAt: ago(60), price: 10, category: "home" },
  { id: "b", name: "Plate", quantity: 20, createdAt: ago(60), price: 5, category: "home" },
  { id: "c", name: "Bowl", quantity: 9, createdAt: ago(40), price: 8, category: "home" },
  { id: "d", name: "New thing", quantity: 9, createdAt: ago(3), price: 8, category: "home" },
  { id: "e", name: "Sold out", quantity: 0, createdAt: ago(90), price: 8, category: "home" },
  { id: "f", name: "Hidden", quantity: 5, createdAt: ago(90), price: 8, hiddenByPlan: true },
];

test("performance: best sellers, slow movers and low stock over 30 days", () => {
  const orders = [
    order(3, [["a", 6, 1000]]),
    order(10, [["a", 3, 1000], ["b", 2, 500]]),
    order(40, [["c", 5, 800]]),                      // too old for the 30-day window
  ];

  const out = im.performance(products, orders, NOW, 30);

  assert.deepEqual(out.bestSellers.map((p) => [p.productId, p.units]), [["a", 9], ["b", 2]]);

  // Bowl sold 40 days ago, nothing in 30 -> slow. "New thing" is under 14 days old, sold-out and hidden never count.
  assert.deepEqual(out.slowMovers.map((p) => p.productId), ["c"]);

  // Mug: 3 left, selling 9 per 30 days = 0.3/day -> 10 days left.
  assert.deepEqual(out.lowStock, [{ productId: "a", name: "Mug", quantity: 3, daysLeft: 10 }]);
});

test("performance: nothing sold is an empty, calm result", () => {
  const out = im.performance(products, [], NOW, 30);

  assert.deepEqual(out.bestSellers, []);
  assert.deepEqual(out.lowStock, []);
  assert.deepEqual(out.slowMovers.map((p) => p.productId), ["a", "b", "c"], "oldest listings first");
});

test("priceCheck: compares with OTHER sellers' median, needs 3+ comparables, never exposes their listings", () => {
  const mine = [
    { id: "m1", name: "My mug", price: 20, category: "Home", quantity: 3 },
    { id: "m2", name: "My lamp", price: 10, category: "Home", quantity: 3 },
    { id: "m3", name: "My rare thing", price: 99, category: "Rare", quantity: 3 },
    { id: "m4", name: "My cheap", price: 5, category: "home", quantity: 3 },
  ];

  const market = [
    { id: "x1", sellerId: "other", category: "home", price: 10, quantity: 1 },
    { id: "x2", sellerId: "other", category: "HOME", price: 12, quantity: 1 },
    { id: "x3", sellerId: "other2", category: "home", price: 8, quantity: 1 },
    { id: "x4", sellerId: "me", category: "home", price: 1000, quantity: 1 },          // my own: excluded
    { id: "x5", sellerId: "other", category: "home", price: 500, quantity: 0 },         // sold out: excluded
    { id: "x6", sellerId: "other", category: "home", price: 500, quantity: 2, hiddenByPlan: true }, // hidden: excluded
    { id: "x7", sellerId: "other", category: "rare", price: 100, quantity: 1 },
  ];

  const out = im.priceCheck("me", mine, market);
  const byId = Object.fromEntries(out.map((row) => [row.productId, row]));

  assert.equal(byId.m1.median, 10);
  assert.equal(byId.m1.diffPct, 100);
  assert.equal(byId.m1.position, "above");
  assert.equal(byId.m1.comparable, 3);
  assert.equal(byId.m2.position, "in_line");
  assert.equal(byId.m4.position, "below");
  assert.equal(byId.m3.position, "not_enough_data");
  assert.deepEqual(Object.keys(byId.m1).sort(), ["category", "comparable", "diffPct", "median", "name", "position", "price", "productId"], "only aggregates, no other seller's data");
  assert.equal(out[0].productId, "m1", "biggest gap first");
});

test("interest: buyer questions per listing in the last 30 days, and review counts", () => {
  const messages = [
    { senderId: "buyer1", productId: "a", createdAt: ago(2) },
    { senderId: "buyer2", productId: "a", createdAt: ago(5) },
    { senderId: "buyer1", productId: "b", createdAt: ago(40) },   // too old
    { senderId: "me", productId: "a", createdAt: ago(1) },        // my own reply
  ];
  const reviews = [{ productId: "a", rating: 5 }, { productId: "a", rating: 4 }, { productId: "c", rating: 3 }];

  const out = im.interest(products, messages, reviews, "me", NOW, 30);

  assert.deepEqual(out[0], { productId: "a", name: "Mug", questions: 2, reviews: 2, averageRating: 4.5 });
  assert.deepEqual(out.map((r) => r.productId), ["a", "c"]);
});

test("AI facts hold no personal data, and the prompt carries only those facts", () => {
  const insights = {
    salesByMonth: [{ label: "Nov 2026", units: 4, revenueCents: 3500, orders: 2 }],
    performance: { bestSellers: [{ name: "Mug", units: 9 }], slowMovers: [{ name: "Bowl", daysListed: 40 }], lowStock: [{ name: "Mug", quantity: 3, daysLeft: 10 }] },
    priceCheck: [{ name: "Mug", price: 20, median: 10, position: "above" }, { name: "Rare", position: "not_enough_data" }],
    interest: [{ name: "Mug", questions: 2, reviews: 2, averageRating: 4.5 }],
  };

  const facts = im.summaryFacts(insights);

  assert.deepEqual(facts.pricing, [{ name: "Mug", price: 20, marketMedian: 10, position: "above" }]);
  assert.equal(facts.salesByMonth[0].revenue, 35);

  const prompt = im.summaryPrompt(facts);

  assert.match(prompt, /Use ONLY these numbers/);
  assert.ok(prompt.includes('"Mug"'));
});
