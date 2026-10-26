// Firestore security-rules tests. They run against the local Firestore
// emulator over its REST API (no extra packages needed):
//
//   npm run test:rules
//
// `Authorization: Bearer owner` bypasses rules (used to seed data); any
// other caller sends an unsigned token, which the emulator accepts and
// evaluates rules against -- the same way the client SDKs are tested.

const test = require("node:test");
const assert = require("node:assert/strict");

const PROJECT = "demo-lesovia";
const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const DOCS = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

function tokenFor(uid) {
  const now = Math.floor(Date.now() / 1000);

  return `${b64({ alg: "none", typ: "JWT" })}.${b64({
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    sub: uid,
    user_id: uid,
    auth_time: now,
    iat: now,
    exp: now + 3600,
    firebase: { identity_provider: "custom", sign_in_provider: "custom" },
  })}.`;
}

function toValue(v) {
  if (v === null) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  return { mapValue: { fields: toFields(v) } };
}

function toFields(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toValue(v)]));
}

// A caller: uid = null is signed out, "owner" bypasses the rules.
function as(uid) {
  const headers = { "Content-Type": "application/json" };
  if (uid === "owner") headers.Authorization = "Bearer owner";
  else if (uid) headers.Authorization = `Bearer ${tokenFor(uid)}`;

  const send = (method, path, body) =>
    fetch(`${DOCS}/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });

  return {
    get: (path) => send("GET", path),
    create: (path, data) => send("PATCH", `${path}?currentDocument.exists=false`, { fields: toFields(data) }),
    // like updateDoc: only the listed fields change, and the doc must exist
    update: (path, data) => {
      const mask = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
      return send("PATCH", `${path}?currentDocument.exists=true&${mask}`, { fields: toFields(data) });
    },
    delete: (path) => send("DELETE", path),
    query: (collectionId, field, value) =>
      fetch(`${DOCS}:runQuery`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId }],
            where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: toValue(value) } },
          },
        }),
      }),
    listAll: (collectionId) =>
      fetch(`${DOCS}:runQuery`, {
        method: "POST",
        headers,
        body: JSON.stringify({ structuredQuery: { from: [{ collectionId }] } }),
      }),
  };
}

const owner = as("owner");

async function reset() {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
}

async function seed(path, data) {
  const res = await owner.create(path, data);
  assert.equal(res.status, 200, `seeding ${path} failed: ${await res.text()}`);
}

const ok = (res, msg) => assert.equal(res.status, 200, msg || `expected allowed, got ${res.status}`);
const denied = (res, msg) => assert.equal(res.status, 403, msg || `expected denied, got ${res.status}`);

const PROTECTED = [
  ["stripeAccountId", "acct_forged"],
  ["stripeChargesEnabled", true],
  ["stripePayoutsEnabled", true],
  ["stripeDetailsSubmitted", true],
  ["stripeOnboardingStatus", "complete"],
];

async function seedPeople() {
  await seed("users/admin1", { role: "admin" });
  await seed("users/seller1", { role: "seller", storeName: "Shop One", stripeChargesEnabled: false });
  await seed("users/seller2", { role: "seller", storeName: "Shop Two" });
  await seed("users/buyer1", { role: "buyer", fullName: "Buyer One" });
  await seed("users/buyer2", { role: "buyer", fullName: "Buyer Two" });
}

// ---------------------------------------------------------------- users
test("users: a seller can edit their own profile and shipping settings", async () => {
  await reset(); await seedPeople();

  ok(await as("seller1").update("users/seller1", { storeName: "Renamed" }));
  ok(await as("seller1").update("users/seller1", {
    shipping: { freeShipping: false, flatRateCents: 978, expressEnabled: true, expressRateCents: 2500 },
  }));
});

for (const [field, value] of PROTECTED) {
  test(`users: a seller can NOT write their own ${field}`, async () => {
    await reset(); await seedPeople();
    denied(await as("seller1").update("users/seller1", { [field]: value }));
  });
}

test("users: protected Stripe fields can't be smuggled in alongside an allowed edit", async () => {
  await reset(); await seedPeople();
  denied(await as("seller1").update("users/seller1", { storeName: "Innocent", stripeChargesEnabled: true }));
});

test("users: nobody can change their own role", async () => {
  await reset(); await seedPeople();
  denied(await as("seller1").update("users/seller1", { role: "admin" }));
});

test("users: nobody can edit someone else's profile", async () => {
  await reset(); await seedPeople();
  denied(await as("seller2").update("users/seller1", { storeName: "Hijacked" }));
});

test("users: an admin can only ban/unban, nothing else", async () => {
  await reset(); await seedPeople();
  ok(await as("admin1").update("users/buyer1", { status: "banned", banReason: "spam" }));
  denied(await as("admin1").update("users/buyer1", { fullName: "Renamed by admin" }));
  denied(await as("admin1").update("users/seller1", { stripeChargesEnabled: true }));
});

test("users: signing up can't pre-fill Stripe status, but a normal signup works", async () => {
  await reset();

  ok(await as("newSeller").create("users/newSeller", { role: "seller", fullName: "New", email: "n@x.com" }));

  for (const [field, value] of PROTECTED) {
    denied(
      await as(`forger_${field}`).create(`users/forger_${field}`, { role: "seller", [field]: value }),
      `signup with ${field} should be denied`
    );
  }

  denied(await as("wannabeAdmin").create("users/wannabeAdmin", { role: "admin" }));
});

// ---------------------------------------------------------- sellerOrders
async function seedSubOrder(overrides = {}) {
  await seedPeople();
  await seed("sellerOrders/c1_seller1", {
    checkoutId: "c1",
    buyerId: "buyer1",
    sellerId: "seller1",
    productIds: ["p1", "p2"],
    fulfillmentStatus: "paid",
    commissionRate: 0.07,
    commissionAmountCents: 700,
    sellerProceedsCents: 9300,
    trackingNumber: null,
    ...overrides,
  });
}

test("sellerOrders: buyer, owning seller and admin can read; everyone else can't", async () => {
  await reset(); await seedSubOrder();

  ok(await as("buyer1").get("sellerOrders/c1_seller1"));
  ok(await as("seller1").get("sellerOrders/c1_seller1"));
  ok(await as("admin1").get("sellerOrders/c1_seller1"));
  denied(await as("buyer2").get("sellerOrders/c1_seller1"));
  denied(await as("seller2").get("sellerOrders/c1_seller1"));
  denied(await as(null).get("sellerOrders/c1_seller1"));
});

test("sellerOrders: queries scoped to your own id work; unscoped listing doesn't", async () => {
  await reset(); await seedSubOrder();

  ok(await as("buyer1").query("sellerOrders", "buyerId", "buyer1"));
  ok(await as("seller1").query("sellerOrders", "sellerId", "seller1"));
  denied(await as("buyer1").query("sellerOrders", "buyerId", "buyer2"));
  denied(await as("seller2").listAll("sellerOrders"));
});

test("sellerOrders: clients can never create or delete one", async () => {
  await reset(); await seedSubOrder();

  denied(await as("buyer1").create("sellerOrders/forged", {
    buyerId: "buyer1", sellerId: "seller1", fulfillmentStatus: "delivered", productIds: ["p1"],
  }));
  denied(await as("seller1").create("sellerOrders/forged2", { buyerId: "buyer1", sellerId: "seller1" }));

  denied(await as("seller1").delete("sellerOrders/c1_seller1"));
  denied(await as("buyer1").delete("sellerOrders/c1_seller1"));
});

test("sellerOrders: the owning seller can mark shipped, then delivered, and add tracking", async () => {
  await reset(); await seedSubOrder();

  ok(await as("seller1").update("sellerOrders/c1_seller1", { fulfillmentStatus: "shipped", shippedAt: new Date(), trackingNumber: "1Z999" }));
  ok(await as("seller1").update("sellerOrders/c1_seller1", { trackingNumber: "1Z999-fixed" }));
  ok(await as("seller1").update("sellerOrders/c1_seller1", { fulfillmentStatus: "delivered", deliveredAt: new Date() }));
});

test("sellerOrders: a seller can NOT touch money, Stripe, refund or payout fields", async () => {
  await reset(); await seedSubOrder();

  const forbidden = [
    { commissionAmountCents: 0 },
    { commissionRate: 0 },
    { sellerProceedsCents: 999999 },
    { transferStatus: "transferred" },
    { stripeTransferId: "tr_fake" },
    { refundStatus: "none" },
    { payoutStatus: "paid" },
    { buyerId: "seller1" },
    { productIds: ["anything"] },
  ];

  for (const change of forbidden) {
    denied(
      await as("seller1").update("sellerOrders/c1_seller1", { fulfillmentStatus: "shipped", ...change }),
      `should not allow changing ${Object.keys(change)[0]}`
    );
    denied(await as("seller1").update("sellerOrders/c1_seller1", change), `should not allow changing ${Object.keys(change)[0]} alone`);
  }
});

test("sellerOrders: status can only move to shipped/delivered, never back to paid or to junk", async () => {
  await reset(); await seedSubOrder({ fulfillmentStatus: "shipped" });

  denied(await as("seller1").update("sellerOrders/c1_seller1", { fulfillmentStatus: "paid" }));
  denied(await as("seller1").update("sellerOrders/c1_seller1", { fulfillmentStatus: "refunded" }));
});

test("sellerOrders: tracking can't be edited before the order has shipped", async () => {
  await reset(); await seedSubOrder({ fulfillmentStatus: "paid" });
  denied(await as("seller1").update("sellerOrders/c1_seller1", { trackingNumber: "early" }));
});

test("sellerOrders: the buyer and other sellers can't update it", async () => {
  await reset(); await seedSubOrder();

  denied(await as("buyer1").update("sellerOrders/c1_seller1", { fulfillmentStatus: "delivered", deliveredAt: new Date() }));
  denied(await as("seller2").update("sellerOrders/c1_seller1", { fulfillmentStatus: "shipped", shippedAt: new Date() }));
  denied(await as("admin1").update("sellerOrders/c1_seller1", { fulfillmentStatus: "shipped", shippedAt: new Date() }));
});

// ---------------------------------------------------------- checkoutOrders
test("checkoutOrders: only the buyer or an admin can read; nobody can write", async () => {
  await reset(); await seedPeople();
  await seed("checkoutOrders/c1", { buyerId: "buyer1", totalAmountCents: 2178 });

  ok(await as("buyer1").get("checkoutOrders/c1"));
  ok(await as("admin1").get("checkoutOrders/c1"));
  denied(await as("buyer2").get("checkoutOrders/c1"));
  denied(await as("seller1").get("checkoutOrders/c1"));

  denied(await as("buyer1").update("checkoutOrders/c1", { totalAmountCents: 1 }));
  denied(await as("buyer1").create("checkoutOrders/c2", { buyerId: "buyer1" }));
  denied(await as("buyer1").delete("checkoutOrders/c1"));
});

// ------------------------------------------------ server-only collections
test("config, pendingOrders, stripeWebhookEvents: closed to every client, even admins", async () => {
  await reset(); await seedPeople();

  for (const path of ["config/platformSettings", "pendingOrders/c1", "stripeWebhookEvents/evt_1", "counters/orders"]) {
    await seed(path, { taxLiability: "platform", buyerId: "buyer1" });

    for (const uid of ["buyer1", "seller1", "admin1", null]) {
      denied(await as(uid).get(path), `${uid} should not read ${path}`);
      denied(await as(uid).update(path, { taxLiability: "connectedAccount" }), `${uid} should not write ${path}`);
    }
  }
});

test("config: no client can flip the tax-liability setting or create the doc", async () => {
  await reset(); await seedPeople();

  denied(await as("admin1").create("config/platformSettings", { taxLiability: "platform" }));
  denied(await as("seller1").create("config/platformSettings", { taxLiability: "platform" }));
});

// ---------------------------------------------------------------- reviews
async function seedReviewFixtures() {
  await seedPeople();
  await seed("orders/legacyDelivered", { userId: "buyer1", sellerId: "seller1", productId: "p1", status: "delivered" });
  await seed("orders/legacyPaid", { userId: "buyer1", sellerId: "seller1", productId: "p1", status: "paid" });
  await seed("sellerOrders/subDelivered", { buyerId: "buyer1", sellerId: "seller1", productIds: ["p1", "p2"], fulfillmentStatus: "delivered" });
  await seed("sellerOrders/subShipped", { buyerId: "buyer1", sellerId: "seller1", productIds: ["p1"], fulfillmentStatus: "shipped" });
}

const review = (uid, orderId, productId) =>
  as(uid).create(`reviews/r_${uid}_${orderId}_${productId}`, {
    buyerId: uid, orderId, productId, rating: 5, comment: "great",
  });

test("reviews: allowed for a delivered legacy order (unchanged behaviour)", async () => {
  await reset(); await seedReviewFixtures();

  ok(await review("buyer1", "legacyDelivered", "p1"));
  denied(await review("buyer1", "legacyPaid", "p1"));
  denied(await review("buyer1", "legacyDelivered", "p2"));
});

test("reviews: allowed for any product in a delivered sub-order", async () => {
  await reset(); await seedReviewFixtures();

  ok(await review("buyer1", "subDelivered", "p1"));
  ok(await review("buyer1", "subDelivered", "p2"));
});

test("reviews: denied for a sub-order that isn't delivered, or a product that wasn't in it", async () => {
  await reset(); await seedReviewFixtures();

  denied(await review("buyer1", "subShipped", "p1"));
  denied(await review("buyer1", "subDelivered", "p3"));
});

test("reviews: denied for someone else's order, and for orders that don't exist", async () => {
  await reset(); await seedReviewFixtures();

  denied(await review("buyer2", "subDelivered", "p1"));
  denied(await review("buyer2", "legacyDelivered", "p1"));
  denied(await review("buyer1", "doesNotExist", "p1"));
});

test("reviews: a buyer can't post as someone else", async () => {
  await reset(); await seedReviewFixtures();

  const res = await as("buyer2").create("reviews/spoof", {
    buyerId: "buyer1", orderId: "subDelivered", productId: "p1", rating: 5, comment: "x",
  });
  denied(res);
});

// -------------------------------------------------- legacy orders unchanged
test("legacy orders: existing read/update rules still hold", async () => {
  await reset(); await seedPeople();
  await seed("orders/o1", { userId: "buyer1", sellerId: "seller1", productId: "p1", status: "paid", price: 6 });

  ok(await as("buyer1").get("orders/o1"));
  ok(await as("seller1").get("orders/o1"));
  denied(await as("buyer2").get("orders/o1"));
  ok(await as("seller1").update("orders/o1", { status: "shipped", shippedAt: new Date() }));
  denied(await as("seller1").update("orders/o1", { price: 0, status: "shipped" }));
  denied(await as("buyer1").create("orders/forged", { userId: "buyer1", status: "delivered" }));
});

// ---------------------------------------------------------- returns
const RETURN_FIELDS = {
  sellerOrderId: "c1_seller1", checkoutId: "c1", buyerId: "buyer1", sellerId: "seller1",
  status: "requested", reason: "too_big",
};

test("returns: the buyer, the order's seller and an admin can read; nobody else can", async () => {
  await reset(); await seedPeople();
  await seed("returns/r1", RETURN_FIELDS);

  ok(await as("buyer1").get("returns/r1"));
  ok(await as("seller1").get("returns/r1"));
  ok(await as("admin1").get("returns/r1"));
  denied(await as("buyer2").get("returns/r1"));
  denied(await as("seller2").get("returns/r1"));
  denied(await as(null).get("returns/r1"));
});

test("returns: scoped queries work, unscoped listing doesn't", async () => {
  await reset(); await seedPeople();
  await seed("returns/r1", RETURN_FIELDS);

  ok(await as("buyer1").query("returns", "buyerId", "buyer1"));
  ok(await as("seller1").query("returns", "sellerId", "seller1"));
  ok(await as("admin1").listAll("returns"));
  denied(await as("buyer2").query("returns", "buyerId", "buyer1"));
  denied(await as("buyer1").listAll("returns"));
});

test("returns: NOBODY can write one from a client -- not the buyer, the seller or an admin", async () => {
  await reset(); await seedPeople();
  await seed("returns/r1", RETURN_FIELDS);

  for (const uid of ["buyer1", "seller1", "admin1", "buyer2"]) {
    denied(await as(uid).create("returns/forged", { ...RETURN_FIELDS, status: "refunded" }), `${uid} create`);
    denied(await as(uid).update("returns/r1", { status: "approved" }), `${uid} update`);
    denied(await as(uid).update("returns/r1", { plan: { buyerRefundCents: 999999 } }), `${uid} plan`);
    denied(await as(uid).delete("returns/r1"), `${uid} delete`);
  }
});

test("sellerOrders: the seller can save a return address while shipping, and nothing return- or refund-related", async () => {
  await reset(); await seedSubOrder();

  ok(await as("seller1").update("sellerOrders/c1_seller1", {
    fulfillmentStatus: "shipped", shippedAt: new Date(), trackingNumber: "1Z999",
    returnAddress: { fullName: "Shop A", line1: "1 Main St", city: "Sioux City", state: "IA", zip: "51106", country: "US" },
  }));

  const forbidden = [
    { activeReturnId: "r1" }, { returnStatus: "refunded" }, { refundedAmountCents: 999999 },
    { shippedAtServer: new Date() }, { deliveredAtServer: new Date("2020-01-01") },
    { returnAddress: "not a map" },
  ];

  for (const change of forbidden) {
    denied(
      await as("seller1").update("sellerOrders/c1_seller1", { fulfillmentStatus: "delivered", ...change }),
      `should not allow ${Object.keys(change)[0]}`
    );
  }
});

test("sellerOrders: a cancelled or returned order can't be moved back to shipped/delivered by the seller", async () => {
  await reset(); await seedSubOrder({ fulfillmentStatus: "cancelled" });
  denied(await as("seller1").update("sellerOrders/c1_seller1", { fulfillmentStatus: "shipped", shippedAt: new Date() }));

  await reset(); await seedSubOrder({ fulfillmentStatus: "returned" });
  denied(await as("seller1").update("sellerOrders/c1_seller1", { fulfillmentStatus: "delivered", deliveredAt: new Date() }));
});

// ---------------------------------------------------------- publicConfig
test("publicConfig: anyone can read the return policy; nobody can change it from a client", async () => {
  await reset(); await seedPeople();
  await seed("publicConfig/returnPolicy", { returnWindowDays: 7 });

  for (const uid of ["buyer1", "seller1", "admin1", null]) {
    ok(await as(uid).get("publicConfig/returnPolicy"), `${uid} read`);
    denied(await as(uid).update("publicConfig/returnPolicy", { returnWindowDays: 3650 }), `${uid} update`);
    denied(await as(uid).create("publicConfig/other", { x: 1 }), `${uid} create`);
    denied(await as(uid).delete("publicConfig/returnPolicy"), `${uid} delete`);
  }
});


// ---------------------------------------------------------- accountRecovery
test("accountRecovery: only the owner can read their own record; nobody can list or write", async () => {
  await reset(); await seedPeople();
  await seed("accountRecovery/seller1", { phone: "+17125550123" });
  await seed("accountRecovery/seller2", { phone: "+17125550999" });

  ok(await as("seller1").get("accountRecovery/seller1"));
  denied(await as("seller2").get("accountRecovery/seller1"));
  denied(await as("buyer1").get("accountRecovery/seller1"));
  denied(await as("admin1").get("accountRecovery/seller1"));
  denied(await as(null).get("accountRecovery/seller1"));

  denied(await as("seller1").listAll("accountRecovery"));
  denied(await as("admin1").listAll("accountRecovery"));

  for (const uid of ["seller1", "seller2", "admin1"]) {
    denied(await as(uid).update("accountRecovery/seller1", { phone: "+10000000000" }), `${uid} update`);
    denied(await as(uid).create("accountRecovery/new", { phone: "+10000000000" }), `${uid} create`);
    denied(await as(uid).delete("accountRecovery/seller1"), `${uid} delete`);
  }
});


// ------------------------------------------------------------- sellerPlans
test("sellerPlans: only the owner can read their plan; nobody can write or list", async () => {
  await reset(); await seedPeople();
  await seed("sellerPlans/seller1", { plan: "pro", status: "active" });

  ok(await as("seller1").get("sellerPlans/seller1"));
  denied(await as("seller2").get("sellerPlans/seller1"));
  denied(await as("buyer1").get("sellerPlans/seller1"));
  denied(await as("admin1").get("sellerPlans/seller1"));
  denied(await as(null).get("sellerPlans/seller1"));
  denied(await as("seller1").listAll("sellerPlans"));

  for (const uid of ["seller1", "seller2", "admin1"]) {
    denied(await as(uid).update("sellerPlans/seller1", { plan: "unlimited" }), `${uid} update`);
    denied(await as(uid).create("sellerPlans/new", { plan: "unlimited", status: "active" }), `${uid} create`);
    denied(await as(uid).delete("sellerPlans/seller1"), `${uid} delete`);
  }
});

test("planNotices: nobody on a client can touch them", async () => {
  await reset(); await seedPeople();
  await seed("planNotices/seller1_60", { sentAt: new Date() });

  for (const uid of ["seller1", "admin1"]) {
    denied(await as(uid).get("planNotices/seller1_60"), `${uid} get`);
    denied(await as(uid).create("planNotices/x", { a: 1 }), `${uid} create`);
  }
});

// ------------------------------------------------- products: plan limit flags
test("products: a seller can't create a listing that is pre-flagged, or promoted", async () => {
  await reset(); await seedPeople();

  ok(await as("seller1").create("products/ok1", { sellerId: "seller1", name: "Mug", price: 5, quantity: 3 }));
  denied(await as("seller1").create("products/bad1", { sellerId: "seller1", name: "Mug", hiddenByPlan: false }));
  denied(await as("seller1").create("products/bad2", { sellerId: "seller1", name: "Mug", promotedUntil: new Date("2099-01-01") }));
  denied(await as("seller2").create("products/bad3", { sellerId: "seller1", name: "Mug" })); // not their own
});

test("products: a seller can edit their listing but not hiddenByPlan / promotedUntil", async () => {
  await reset(); await seedPeople();
  await seed("products/p1", { sellerId: "seller1", name: "Mug", price: 5, quantity: 3, hiddenByPlan: true });

  ok(await as("seller1").update("products/p1", { price: 6, quantity: 9 }));
  denied(await as("seller1").update("products/p1", { hiddenByPlan: false }), "unhide");
  denied(await as("seller1").update("products/p1", { promotedUntil: new Date("2099-01-01") }), "promote");
  denied(await as("seller1").update("products/p1", { price: 7, hiddenByPlan: false }), "smuggled");
  denied(await as("seller2").update("products/p1", { price: 1 }), "someone else's");
});


// ------------------------------------------------------------- promotions
test("promotions: records, free-promotion usage and reminders are server-only", async () => {
  await reset(); await seedPeople();
  await seed("promotions/cs_test_1", { sellerId: "seller1", productId: "p1" });
  await seed("promotionUsage/seller1_2026-11", { used: 1 });
  await seed("promotionNotices/p1_123", { sentAt: new Date() });

  for (const path of ["promotions/cs_test_1", "promotionUsage/seller1_2026-11", "promotionNotices/p1_123"]) {
    for (const uid of ["seller1", "seller2", "admin1"]) {
      denied(await as(uid).get(path), `${uid} get ${path}`);
      denied(await as(uid).update(path, { used: 0 }), `${uid} update ${path}`);
      denied(await as(uid).delete(path), `${uid} delete ${path}`);
    }
    denied(await as("seller1").create(path.split("/")[0] + "/new", { used: 0 }), `create in ${path}`);
  }
});

test("products: a seller can't give their own listing a promotion", async () => {
  await reset(); await seedPeople();
  await seed("products/p1", { sellerId: "seller1", name: "Mug", price: 5, quantity: 3 });

  denied(await as("seller1").update("products/p1", { promotedUntil: new Date("2099-01-01") }), "promote own listing");
  denied(await as("seller1").update("products/p1", { price: 6, promotedUntil: new Date("2099-01-01") }), "smuggled in an edit");
  ok(await as("seller1").update("products/p1", { price: 6 }));
});

// ---------------------------------------------------------------- insights
test("insights: subscriptions, AI usage and saved summaries are server-only", async () => {
  await reset(); await seedPeople();
  await seed("sellerInsights/seller1", { tier: "pro", status: "active" });
  await seed("insightsUsage/seller1_2026-11", { used: 1 });
  await seed("insightsReports/seller1", { text: "private summary" });

  for (const path of ["sellerInsights/seller1", "insightsUsage/seller1_2026-11", "insightsReports/seller1"]) {
    for (const uid of ["seller1", "seller2", "admin1"]) {
      denied(await as(uid).get(path), `${uid} get ${path}`);
      denied(await as(uid).update(path, { tier: "pro", used: 0 }), `${uid} update ${path}`);
      denied(await as(uid).delete(path), `${uid} delete ${path}`);
    }
    denied(await as("seller1").create(path.split("/")[0] + "/new", { tier: "pro" }), `create in ${path}`);
  }
});

// ---------------------------------------------------------- partner banners
test("partner banners: the public part is readable by anyone and writable by no client; everything private is server-only", async () => {
  await reset(); await seedPeople();
  await seed("partnerSpots/spot0000000000000001", { advertiserName: "Acme", linkUrl: "https://acme.example.com/", status: "active" });
  await seed("partnerSpotsPrivate/spot0000000000000001", { advertiserEmail: "owner@acme.example.com", priceCents: 15000 });
  await seed("partnerStats/spot0000000000000001_20261110", { views: 3 });
  await seed("partnerLimits/abc", { count: 1 });

  // Public document: anyone can read (the homepage is public).
  for (const uid of [null, "buyer1", "seller1", "admin1"]) ok(await as(uid).get("partnerSpots/spot0000000000000001"), `${uid} read`);

  // ...but nobody writes it from a browser, not even an admin or the advertiser.
  for (const uid of [null, "buyer1", "seller1", "admin1"]) {
    denied(await as(uid).update("partnerSpots/spot0000000000000001", { status: "paused" }), `${uid} update`);
    denied(await as(uid).delete("partnerSpots/spot0000000000000001"), `${uid} delete`);
    denied(await as(uid).create("partnerSpots/new0000000000000001", { advertiserName: "x" }), `${uid} create`);
  }

  for (const path of ["partnerSpotsPrivate/spot0000000000000001", "partnerStats/spot0000000000000001_20261110", "partnerLimits/abc"]) {
    for (const uid of [null, "buyer1", "seller1", "admin1"]) {
      denied(await as(uid).get(path), `${uid} get ${path}`);
      denied(await as(uid).update(path, { views: 99 }), `${uid} update ${path}`);
    }
  }
});
