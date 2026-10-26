// Runs the real promotions.js against the Firestore emulator:
//
//   npm run test:plans

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.GCLOUD_PROJECT = "demo-lesovia";

admin.initializeApp({ projectId: "demo-lesovia" });

const promotions = require("./promotions");

const db = admin.firestore();
const DAY = 86400000;

async function wipe() {
  for (const name of ["products", "sellerPlans", "notifications", "promotions", "promotionUsage", "users"]) {
    const snap = await db.collection(name).get();

    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

async function seed({ plan = null, product = {} } = {}) {
  await db.collection("users").doc("s1").set({ role: "seller" });
  await db.collection("products").doc("p1").set({ sellerId: "s1", name: "Mug", quantity: 4, createdAt: new Date(0), ...product });

  if (plan) await db.collection("sellerPlans").doc("s1").set({ plan, status: "active" });
}

const until = async () => {
  const value = (await db.collection("products").doc("p1").get()).data().promotedUntil;

  return value ? value.toMillis() : 0;
};

const notificationTypes = async () =>
  (await db.collection("notifications").where("userId", "==", "s1").get()).docs.map((d) => d.data().type).sort();

const session = (over = {}) => ({
  id: "cs_test_1",
  mode: "payment",
  payment_status: "paid",
  amount_total: 500,
  metadata: { type: "promotion", sellerId: "s1", productId: "p1", days: "30" },
  ...over,
});

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 60000, `${new Date(actual).toISOString()} vs ${new Date(expected).toISOString()}`);

test("a paid session promotes the listing for 30 days and tells the seller", async () => {
  await wipe(); await seed();

  const out = await promotions.applyPaidSession(session());

  near(out.until, Date.now() + 30 * DAY);
  near(await until(), Date.now() + 30 * DAY);
  assert.deepEqual(await notificationTypes(), ["listing_promoted"]);

  const record = (await db.collection("promotions").doc("cs_test_1").get()).data();

  assert.equal(record.source, "paid");
  assert.equal(record.amountCents, 500);
});

test("the same payment applied twice (webhook AND the return from checkout) adds the days once", async () => {
  await wipe(); await seed();

  await promotions.applyPaidSession(session());
  const first = await until();
  const again = await promotions.applyPaidSession(session());

  assert.equal(again.duplicate, true);
  assert.equal(await until(), first);
  assert.deepEqual(await notificationTypes(), ["listing_promoted"], "told once");
  assert.equal((await db.collection("promotions").get()).size, 1);
});

test("renewing early adds to what is left", async () => {
  await wipe(); await seed({ product: { promotedUntil: admin.firestore.Timestamp.fromMillis(Date.now() + 3 * DAY) } });

  await promotions.applyPaidSession(session({ id: "cs_test_renew" }));

  near(await until(), Date.now() + 33 * DAY);
});

test("unpaid, subscription and unmarked sessions are ignored", async () => {
  await wipe(); await seed();

  assert.equal((await promotions.applyPaidSession(session({ payment_status: "unpaid" }))).unpaid, true);
  assert.equal((await promotions.applyPaidSession(session({ mode: "subscription" }))).ignored, true);
  assert.equal((await promotions.applyPaidSession(session({ metadata: {} }))).ignored, true);
  assert.equal((await promotions.applyPaidSession(session({ metadata: { type: "promotion", sellerId: "s1", productId: "p1", days: "zero" } }))).ignored, true);

  assert.equal(await until(), 0);
  assert.equal((await db.collection("promotions").get()).size, 0);
});

test("a payment for someone else's (or a deleted) listing changes nothing and warns the seller", async () => {
  await wipe(); await seed();
  await db.collection("products").doc("p2").set({ sellerId: "other", name: "Not yours", quantity: 1 });

  const out = await promotions.applyPaidSession(session({ id: "cs_x", metadata: { type: "promotion", sellerId: "s1", productId: "p2", days: "30" } }));

  assert.equal(out.missing, true);
  assert.equal((await db.collection("products").doc("p2").get()).data().promotedUntil, undefined);
  assert.deepEqual(await notificationTypes(), ["promotion_failed"]);
});

test("the checkout.session.completed webhook ignores connected-account events", async () => {
  await wipe(); await seed();

  await promotions.handleCheckoutCompleted(null, { account: "acct_1", data: { object: session() } });
  assert.equal(await until(), 0);

  await promotions.handleCheckoutCompleted(null, { data: { object: session() } });
  near(await until(), Date.now() + 30 * DAY);
});

test("free promotions: a Pro seller gets 1 a month; the next is refused and nothing changes", async () => {
  await wipe(); await seed({ plan: "pro" });

  const first = await promotions.applyPromotion({ sellerId: "s1", productId: "p1", source: "allowance", days: 30 });

  near(first.until, Date.now() + 30 * DAY);

  await db.collection("products").doc("p1").update({ promotedUntil: admin.firestore.FieldValue.delete() });
  await db.collection("products").doc("p2").set({ sellerId: "s1", name: "Plate", quantity: 2 });

  await assert.rejects(
    promotions.applyPromotion({ sellerId: "s1", productId: "p2", source: "allowance", days: 30 }),
    /used your free promotions/
  );
  assert.equal((await db.collection("products").doc("p2").get()).data().promotedUntil, undefined);
});

test("free promotions reset next month, and Unlimited gets 3", async () => {
  await wipe(); await seed({ plan: "pro" });

  const now = Date.parse("2026-11-10T15:00:00Z");
  const nextMonth = Date.parse("2026-12-05T15:00:00Z");

  await promotions.applyPromotion({ sellerId: "s1", productId: "p1", source: "allowance", days: 30, nowMs: now });
  await db.collection("products").doc("p1").update({ promotedUntil: admin.firestore.FieldValue.delete() });
  await promotions.applyPromotion({ sellerId: "s1", productId: "p1", source: "allowance", days: 30, nowMs: nextMonth });

  assert.equal((await db.collection("promotionUsage").get()).size, 2);

  await wipe(); await seed({ plan: "unlimited" });

  for (let i = 0; i < 3; i++) {
    await promotions.applyPromotion({ sellerId: "s1", productId: "p1", source: "allowance", days: 30, nowMs: now });
    await db.collection("products").doc("p1").update({ promotedUntil: admin.firestore.FieldValue.delete() });
  }

  await assert.rejects(promotions.applyPromotion({ sellerId: "s1", productId: "p1", source: "allowance", days: 30, nowMs: now }), /used your free/);
});

test("free promotions: Free and Plus sellers have none", async () => {
  for (const plan of [null, "plus"]) {
    await wipe(); await seed({ plan });

    await assert.rejects(promotions.applyPromotion({ sellerId: "s1", productId: "p1", source: "allowance", days: 30 }), /used your free/);
    assert.equal(await until(), 0);
  }
});

test("free promotions: an already-promoted listing is refused without using up the allowance", async () => {
  await wipe(); await seed({ plan: "pro", product: { promotedUntil: admin.firestore.Timestamp.fromMillis(Date.now() + 20 * DAY) } });

  await assert.rejects(promotions.applyPromotion({ sellerId: "s1", productId: "p1", source: "allowance", days: 30 }), /already promoted/);
  assert.equal((await db.collection("promotionUsage").get()).size, 0);
});

test("free promotions: sold-out and hidden listings can't be promoted", async () => {
  for (const product of [{ quantity: 0 }, { hiddenByPlan: true }]) {
    await wipe(); await seed({ plan: "pro", product });

    await assert.rejects(promotions.applyPromotion({ sellerId: "s1", productId: "p1", source: "allowance", days: 30 }), /Sold-out|Hidden/);
  }
});

const fakeStripe = (sessions) => ({ checkout: { sessions: { retrieve: async (id) => sessions[id] } } });

test("sync on return: applies the session, but only for the seller who started it", async () => {
  await wipe(); await seed();

  const stripe = fakeStripe({ cs_test_1: session(), cs_test_theirs: session({ id: "cs_test_theirs", metadata: { type: "promotion", sellerId: "someone-else", productId: "p1", days: "30" } }) });

  const out = await promotions.syncSession(stripe, "s1", "cs_test_1");

  near(out.until, Date.now() + 30 * DAY);

  await assert.rejects(promotions.syncSession(stripe, "s1", "cs_test_theirs"), /isn't yours/);
  await assert.rejects(promotions.syncSession(stripe, "s1", "not a session"), /valid checkout/);
});

test("sync on return: refuses an unpaid session; repeating a paid one changes nothing", async () => {
  await wipe(); await seed();

  await assert.rejects(promotions.syncSession(fakeStripe({ cs_test_1: session({ payment_status: "unpaid" }) }), "s1", "cs_test_1"), /hasn't gone through/);
  assert.equal(await until(), 0);

  const paid = fakeStripe({ cs_test_1: session() });

  await promotions.syncSession(paid, "s1", "cs_test_1");
  const first = await until();
  await promotions.syncSession(paid, "s1", "cs_test_1");

  assert.equal(await until(), first);
});
