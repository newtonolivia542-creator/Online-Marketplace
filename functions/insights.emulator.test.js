// Runs the real insights.js against the Firestore emulator:
//
//   npm run test:plans

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.GCLOUD_PROJECT = "demo-lesovia";

admin.initializeApp({ projectId: "demo-lesovia" });

const insights = require("./insights");

const db = admin.firestore();
const DAY = 86400000;
const NOW = Date.now();
const ago = (days) => new Date(NOW - days * DAY);

const COLLECTIONS = ["products", "sellerOrders", "messages", "reviews", "sellerPlans", "sellerInsights", "insightsUsage", "insightsReports", "notifications", "users"];

async function wipe() {
  for (const name of COLLECTIONS) {
    const snap = await db.collection(name).get();

    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

const notificationTypes = async () =>
  (await db.collection("notifications").where("userId", "==", "s1").get()).docs.map((d) => d.data().type).sort();

const sub = (over = {}) => ({
  id: "sub_i1",
  customer: "cus_1",
  status: "active",
  created: 100,
  cancel_at_period_end: false,
  current_period_end: 1900000000,
  metadata: { kind: "insights", sellerId: "s1", insightsTier: "plus" },
  ...over,
});

const event = (type, over = {}, created = 1000) => ({ id: `evt_${Math.random()}`, type, created, data: { object: sub(over) } });

test("a new Insights subscription is recorded, the seller is told, and the tier is unlocked", async () => {
  await wipe();

  await insights.handleInsightsEvent(null, event("customer.subscription.created"));

  const doc = (await db.collection("sellerInsights").doc("s1").get()).data();

  assert.equal(doc.tier, "plus");
  assert.equal(doc.status, "active");
  assert.equal(doc.stripeSubscriptionId, "sub_i1");
  assert.deepEqual(await notificationTypes(), ["insights_changed"]);

  const ent = await insights.entitlement("s1", (await require("./insightsMath")).resolveConfig(null));

  assert.equal(ent.tier, "plus");
  assert.equal(ent.includedByPlan, false);
});

test("events that aren't Insights (listing plans, no seller, other accounts) are ignored", async () => {
  await wipe();

  await insights.handleInsightsEvent(null, event("customer.subscription.created", { metadata: { sellerId: "s1", plan: "plus" } }));
  await insights.handleInsightsEvent(null, event("customer.subscription.created", { metadata: { kind: "insights", insightsTier: "plus" } }));
  await insights.handleInsightsEvent(null, event("customer.subscription.created", { metadata: { kind: "insights", sellerId: "s1", insightsTier: "gold" } }));
  await insights.handleInsightsEvent(null, { ...event("customer.subscription.created"), account: "acct_1" });
  await insights.handleInsightsEvent(null, { id: "e", type: "invoice.payment_failed", created: 1, data: { object: {} } });

  assert.equal((await db.collection("sellerInsights").get()).size, 0);
});

test("an older event can't overwrite a newer one; a duplicate ending can't end the live one", async () => {
  await wipe();

  await insights.handleInsightsEvent(null, event("customer.subscription.updated", { metadata: { kind: "insights", sellerId: "s1", insightsTier: "pro" } }, 5000));
  await insights.handleInsightsEvent(null, event("customer.subscription.updated", { metadata: { kind: "insights", sellerId: "s1", insightsTier: "plus" } }, 4000));

  assert.equal((await db.collection("sellerInsights").doc("s1").get()).data().tier, "pro");

  await insights.handleInsightsEvent(null, event("customer.subscription.deleted", { id: "sub_duplicate", status: "canceled" }, 6000));
  assert.equal((await db.collection("sellerInsights").doc("s1").get()).data().status, "active");

  await insights.handleInsightsEvent(null, event("customer.subscription.deleted", { status: "canceled" }, 7000));
  assert.equal((await db.collection("sellerInsights").doc("s1").get()).data().status, "canceled");
});

test("the Pro and Unlimited listing plans include Insights Pro; Plus and Free don't", async () => {
  const cfg = require("./insightsMath").resolveConfig(null);

  for (const [plan, tier, included] of [["pro", "pro", true], ["unlimited", "pro", true], ["plus", "none", false], [null, "none", false]]) {
    await wipe();
    if (plan) await db.collection("sellerPlans").doc("s1").set({ plan, status: "active" });

    const ent = await insights.entitlement("s1", cfg);

    assert.equal(ent.tier, tier, String(plan));
    assert.equal(ent.includedByPlan, included, String(plan));
  }

  // Bought Plus on top of a Pro listing plan: the bundle (Pro) wins.
  await wipe();
  await db.collection("sellerPlans").doc("s1").set({ plan: "pro", status: "active" });
  await db.collection("sellerInsights").doc("s1").set({ tier: "plus", status: "active" });

  const ent = await insights.entitlement("s1", cfg);

  assert.equal(ent.tier, "pro");
  assert.equal(ent.bought, "plus");
});

const fakeStripe = (subs) => ({ subscriptions: { list: async () => ({ data: subs }) } });

test("sync on return: records the live Insights subscription, preferring one that isn't cancelling", async () => {
  await wipe();
  await db.collection("sellerPlans").doc("s1").set({ stripeCustomerId: "cus_1" });

  await insights.syncFromStripe(fakeStripe([
    sub({ id: "listing", created: 400, metadata: { sellerId: "s1", plan: "pro" } }),
    sub({ id: "cancelling", created: 300, cancel_at_period_end: true }),
    sub({ id: "keep", created: 100, metadata: { kind: "insights", sellerId: "s1", insightsTier: "pro" } }),
    sub({ id: "someone_else", created: 500, metadata: { kind: "insights", sellerId: "other", insightsTier: "pro" } }),
  ]), "s1");

  const doc = (await db.collection("sellerInsights").doc("s1").get()).data();

  assert.equal(doc.stripeSubscriptionId, "keep");
  assert.equal(doc.tier, "pro");

  // Nothing to do for a seller with no Stripe customer.
  await wipe();
  await insights.syncFromStripe(fakeStripe([sub()]), "s1");
  assert.equal((await db.collection("sellerInsights").get()).size, 0);
});

async function seedStore() {
  await db.collection("users").doc("s1").set({ role: "seller" });

  const put = (id, data) => db.collection("products").doc(id).set(data);

  await put("mug", { sellerId: "s1", name: "Mug", price: 20, quantity: 3, category: "home", createdAt: ago(60) });
  await put("plate", { sellerId: "s1", name: "Plate", price: 10, quantity: 20, category: "home", createdAt: ago(60) });
  await put("bowl", { sellerId: "s1", name: "Bowl", price: 8, quantity: 9, category: "home", createdAt: ago(40) });
  await put("lamp", { sellerId: "s1", name: "Lamp", price: 99, quantity: 5, category: "decor", createdAt: ago(40) });

  // other sellers, same category, for the price check
  await put("o1", { sellerId: "o", name: "x", price: 10, quantity: 1, category: "home" });
  await put("o2", { sellerId: "o", name: "x", price: 12, quantity: 1, category: "home" });
  await put("o3", { sellerId: "o2", name: "x", price: 8, quantity: 1, category: "home" });

  const order = (id, daysAgo, lines, extra = {}) =>
    db.collection("sellerOrders").doc(id).set({ sellerId: "s1", buyerId: "b", createdAt: ago(daysAgo), fulfillmentStatus: "delivered", products: lines.map(([productId, quantity, unitPriceCents]) => ({ productId, quantity, unitPriceCents })), ...extra });

  await order("o_a", 3, [["mug", 6, 2000]]);
  await order("o_b", 10, [["mug", 3, 2000], ["plate", 2, 1000]]);
  await order("o_c", 12, [["plate", 5, 1000]], { fulfillmentStatus: "cancelled" });
  await order("other_sellers_order", 3, [["mug", 50, 2000]], { sellerId: "someone-else" });

  await db.collection("messages").doc("m1").set({ senderId: "buyer1", receiverId: "s1", productId: "mug", createdAt: ago(2), text: "private words" });
  await db.collection("messages").doc("m2").set({ senderId: "buyer2", receiverId: "s1", productId: "mug", createdAt: ago(4), text: "more private words" });
  await db.collection("reviews").doc("r1").set({ sellerId: "s1", productId: "mug", rating: 5 });
}

test("Insights Plus: sales, best sellers, slow movers and low stock come from this seller's own orders only", async () => {
  await wipe(); await seedStore();

  const data = await insights.loadData("s1", false);
  const out = insights.buildInsights("s1", "plus", data, NOW);

  const thisMonth = out.salesByMonth[5];

  assert.ok(thisMonth.units + out.salesByMonth[4].units === 11, "6 + 3 mugs and 2 plates, in this or last month; cancelled order and other sellers' orders excluded");
  assert.deepEqual(out.performance.bestSellers.map((p) => [p.productId, p.units]), [["mug", 9], ["plate", 2]]);
  assert.deepEqual(out.performance.slowMovers.map((p) => p.productId).sort(), ["bowl", "lamp"]);
  assert.equal(out.performance.lowStock[0].productId, "mug");
  assert.equal(out.liveListings, 4);
  assert.equal(out.priceCheck, undefined, "Pro-only parts are left out of Plus");
  assert.equal(out.interest, undefined);
});

test("Insights Pro adds the price check and customer interest; no private message text or other sellers' listings leak", async () => {
  await wipe(); await seedStore();

  const data = await insights.loadData("s1", true);
  const out = insights.buildInsights("s1", "pro", data, NOW);
  const byId = Object.fromEntries(out.priceCheck.map((row) => [row.productId, row]));

  assert.equal(byId.mug.median, 10);
  assert.equal(byId.mug.position, "above");
  assert.equal(byId.mug.comparable, 3);
  assert.equal(byId.lamp.position, "not_enough_data");

  assert.deepEqual(out.interest[0], { productId: "mug", name: "Mug", questions: 2, reviews: 1, averageRating: 5 });

  const text = JSON.stringify(out);

  assert.ok(!text.includes("private words"));
  assert.ok(!text.includes('"o1"') && !text.includes('"o2"'));
});

const cfg = require("./insightsMath").resolveConfig(null);
const FACTS = { salesByMonth: [], bestSellers: [], slowMovers: [], lowStock: [], pricing: [], customerInterest: [] };

test("AI summary: made once, reused for 6 hours without using another, then a new one counts", async () => {
  await wipe();

  let calls = 0;
  const callModel = async () => `Summary ${++calls}`;

  const first = await insights.makeSummary({ uid: "s1", facts: FACTS, cfg, callModel, nowMs: NOW });
  const again = await insights.makeSummary({ uid: "s1", facts: FACTS, cfg, callModel, nowMs: NOW + 60 * 60 * 1000 });
  const later = await insights.makeSummary({ uid: "s1", facts: FACTS, cfg, callModel, nowMs: NOW + 7 * 60 * 60 * 1000 });

  assert.equal(first.text, "Summary 1");
  assert.equal(again.cached, true);
  assert.equal(again.text, "Summary 1");
  assert.equal(later.text, "Summary 2");
  assert.equal(calls, 2);
});

test("AI summary: stops at the monthly allowance, and a failed model call gives the use back", async () => {
  await wipe();

  let n = 0;
  const callModel = async () => `Summary ${++n}`;

  for (let i = 0; i < cfg.aiSummariesPerMonth; i++) {
    await insights.makeSummary({ uid: "s1", facts: FACTS, cfg, callModel, nowMs: NOW + i * 7 * 60 * 60 * 1000 });
  }

  const key = (await db.collection("insightsUsage").get()).docs[0].id;

  assert.equal((await db.collection("insightsUsage").doc(key).get()).data().used, cfg.aiSummariesPerMonth);

  await assert.rejects(
    insights.makeSummary({ uid: "s1", facts: FACTS, cfg, callModel, nowMs: NOW + 40 * 60 * 60 * 1000 }),
    /used your 4 AI summaries/
  );
  assert.equal(n, cfg.aiSummariesPerMonth, "the model wasn't called once over the limit");

  // A broken model doesn't cost an allowance.
  await wipe();

  await assert.rejects(
    insights.makeSummary({ uid: "s1", facts: FACTS, cfg, callModel: async () => { throw new Error("boom"); }, nowMs: NOW }),
    /isn't available right now/
  );
  const usage = await db.collection("insightsUsage").get();

  assert.equal(usage.docs[0].data().used, 0);
  assert.equal((await db.collection("insightsReports").get()).size, 0, "nothing saved");
});
