// Runs the real plans.js (listing reconciliation and the Stripe subscription
// webhook handler) against the Firestore emulator:
//
//   npm run test:plans

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.GCLOUD_PROJECT = "demo-lesovia";

admin.initializeApp({ projectId: "demo-lesovia" });

const plans = require("./plans");

const db = admin.firestore();
const IN_FREE_YEAR = Date.parse("2027-03-01T12:00:00Z");
const AFTER_FREE_YEAR = Date.parse("2027-11-02T12:00:00Z");

async function wipe() {
  for (const name of ["products", "sellerPlans", "notifications", "users"]) {
    const snap = await db.collection(name).get();

    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

async function seedSeller(uid, count, extra = {}) {
  await db.collection("users").doc(uid).set({ role: "seller" });

  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      db.collection("products").doc(`${uid}-p${String(i + 1).padStart(3, "0")}`).set({
        sellerId: uid,
        name: `Item ${i + 1}`,
        quantity: 2,
        createdAt: new Date(Date.parse("2026-11-01T00:00:00Z") + i * 1000),
        ...extra,
      })
    )
  );
}

const visibleIds = async (uid) =>
  (await db.collection("products").where("sellerId", "==", uid).get()).docs
    .filter((d) => d.data().hiddenByPlan !== true)
    .map((d) => d.id)
    .sort();

const notificationTypes = async (uid) =>
  (await db.collection("notifications").where("userId", "==", uid).get()).docs.map((d) => d.data().type).sort();

const subEvent = (type, overrides = {}, created = 1000) => ({
  id: `evt_${Math.random()}`,
  type,
  created,
  data: {
    object: {
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      cancel_at_period_end: false,
      current_period_end: 1900000000,
      metadata: { sellerId: "s1", plan: "plus" },
      ...overrides,
    },
  },
});

test("free seller within the allowance: nothing hidden", async () => {
  await wipe(); await seedSeller("s1", 15);

  const out = await plans.reconcileSeller("s1", IN_FREE_YEAR);

  assert.deepEqual(out.hide, []);
  assert.equal((await visibleIds("s1")).length, 15);
  assert.deepEqual(await notificationTypes("s1"), []);
});

test("the 15th..11th newest are hidden the moment the free year ends, and the seller is told once", async () => {
  await wipe(); await seedSeller("s1", 15);

  await plans.reconcileSeller("s1", AFTER_FREE_YEAR);

  const visible = await visibleIds("s1");

  assert.equal(visible.length, 10);
  assert.equal(visible[0], "s1-p001");
  assert.equal(visible[9], "s1-p010");
  assert.deepEqual(await notificationTypes("s1"), ["listings_hidden"]);

  // Running it again changes nothing and says nothing more.
  const again = await plans.reconcileSeller("s1", AFTER_FREE_YEAR);

  assert.deepEqual(again.hide, []);
  assert.deepEqual(await notificationTypes("s1"), ["listings_hidden"]);

  // Nothing was deleted.
  assert.equal((await db.collection("products").where("sellerId", "==", "s1").get()).size, 15);
});

test("other sellers are untouched", async () => {
  await wipe(); await seedSeller("s1", 15); await seedSeller("s2", 12);

  await plans.reconcileSeller("s1", AFTER_FREE_YEAR);

  assert.equal((await visibleIds("s2")).length, 12);
});

test("subscribing shows everything again; the plan is saved; the seller is told", async () => {
  await wipe(); await seedSeller("s1", 15);
  await plans.reconcileSeller("s1", AFTER_FREE_YEAR);

  await plans.handlePlanEvent(null, subEvent("customer.subscription.created"));

  const plan = (await db.collection("sellerPlans").doc("s1").get()).data();

  assert.equal(plan.plan, "plus");
  assert.equal(plan.status, "active");
  assert.equal(plan.stripeCustomerId, "cus_1");
  assert.equal(plan.stripeSubscriptionId, "sub_1");
  assert.equal(plan.currentPeriodEnd, 1900000000 * 1000);

  assert.equal((await visibleIds("s1")).length, 15);
  assert.deepEqual(await notificationTypes("s1"), ["listings_hidden", "listings_restored", "plan_changed"]);
});

test("a subscription that ends hides the overflow again (after the free year)", async () => {
  await wipe(); await seedSeller("s1", 15);
  await plans.handlePlanEvent(null, subEvent("customer.subscription.created", {}, 1000));
  assert.equal((await visibleIds("s1")).length, 15);

  // Free limit right now is 15 (we're in the free year), so use 40 listings to see the effect.
  await wipe(); await seedSeller("s1", 40);
  await plans.handlePlanEvent(null, subEvent("customer.subscription.created", {}, 1000));
  assert.equal((await visibleIds("s1")).length, 35);

  await plans.handlePlanEvent(null, subEvent("customer.subscription.deleted", { status: "canceled" }, 2000));

  const plan = (await db.collection("sellerPlans").doc("s1").get()).data();

  assert.equal(plan.status, "canceled");
  assert.equal((await visibleIds("s1")).length, 15); // back to the free allowance, nothing deleted
  assert.equal((await db.collection("products").where("sellerId", "==", "s1").get()).size, 40);
});

test("an older event can't overwrite a newer one", async () => {
  await wipe(); await seedSeller("s1", 3);

  await plans.handlePlanEvent(null, subEvent("customer.subscription.updated", { metadata: { sellerId: "s1", plan: "pro" } }, 5000));
  await plans.handlePlanEvent(null, subEvent("customer.subscription.updated", { metadata: { sellerId: "s1", plan: "plus" } }, 4000));

  assert.equal((await db.collection("sellerPlans").doc("s1").get()).data().plan, "pro");
});

test("events that aren't ours are ignored", async () => {
  await wipe(); await seedSeller("s1", 3);

  // no sellerId
  await plans.handlePlanEvent(null, subEvent("customer.subscription.created", { metadata: {} }));
  // unknown plan
  await plans.handlePlanEvent(null, subEvent("customer.subscription.created", { metadata: { sellerId: "s1", plan: "platinum" } }));
  // from a connected account
  await plans.handlePlanEvent(null, { ...subEvent("customer.subscription.created"), account: "acct_123" });

  assert.equal((await db.collection("sellerPlans").get()).size, 0);
});

test("past_due keeps the paid plan; unpaid drops it", async () => {
  await wipe(); await seedSeller("s1", 20);

  await plans.handlePlanEvent(null, subEvent("customer.subscription.created", {}, 1000));
  await plans.handlePlanEvent(null, subEvent("customer.subscription.updated", { status: "past_due" }, 2000));
  assert.equal((await visibleIds("s1")).length, 20);

  await plans.handlePlanEvent(null, subEvent("customer.subscription.updated", { status: "unpaid" }, 3000));
  assert.equal((await visibleIds("s1")).length, 15);
});

test("a failed plan payment notifies the right seller, and ignores other customers", async () => {
  await wipe(); await seedSeller("s1", 1);
  await db.collection("sellerPlans").doc("s1").set({ stripeCustomerId: "cus_1", plan: "plus", status: "active" });

  await plans.handlePlanEvent(null, { id: "e1", type: "invoice.payment_failed", created: 1, data: { object: { customer: "cus_1" } } });
  await plans.handlePlanEvent(null, { id: "e2", type: "invoice.payment_failed", created: 1, data: { object: { customer: "cus_other" } } });

  assert.deepEqual(await notificationTypes("s1"), ["plan_payment_failed"]);
});

test("sold-out listings don't count against the limit", async () => {
  await wipe(); await seedSeller("s1", 15);
  await Promise.all(
    Array.from({ length: 5 }, (_, i) => db.collection("products").doc(`s1-sold${i}`).set({ sellerId: "s1", quantity: 0, createdAt: new Date(0) }))
  );

  await plans.reconcileSeller("s1", IN_FREE_YEAR);

  assert.equal((await visibleIds("s1")).length, 20); // 15 in stock + 5 sold-out (never hidden)
});
