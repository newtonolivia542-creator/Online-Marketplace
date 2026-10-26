// Runs the real partners.js against the Firestore emulator:
//
//   npm run test:plans

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.GCLOUD_PROJECT = "demo-lesovia";

admin.initializeApp({ projectId: "demo-lesovia" });

const partners = require("./partners");
const pm = require("./partnerMath");

const db = admin.firestore();
const BUCKET = "bucket.test";
const ID = "spot0000000000000001";

async function wipe() {
  for (const name of ["partnerSpots", "partnerSpotsPrivate", "partnerStats", "partnerLimits"]) {
    const snap = await db.collection(name).get();

    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

const good = (over = {}) => ({
  id: ID,
  advertiserName: "Acme Hardware",
  linkUrl: "https://acme.example.com/sale",
  placements: ["home", "buyer"],
  startDate: "2026-11-10",
  endDate: "2026-12-10",
  status: "active",
  imageUrl: pm.imageUrlFor(BUCKET, ID, "image-1.png"),
  advertiserEmail: "owner@acme.example.com",
  priceCents: 15000,
  notes: "check",
  ...over,
});

const MID = pm.startOfDay("2026-11-20");

test("saving a spot writes the public part and the private part separately", async () => {
  await wipe();

  await partners.saveSpot({ body: good(), bucket: BUCKET, nowMs: 1000 });

  const pub = (await db.collection("partnerSpots").doc(ID).get()).data();
  const priv = (await db.collection("partnerSpotsPrivate").doc(ID).get()).data();

  assert.equal(pub.advertiserName, "Acme Hardware");
  assert.equal(pub.startsAtMs, pm.startOfDay("2026-11-10"));
  assert.equal(pub.createdAtMs, 1000);
  assert.equal(pub.advertiserEmail, undefined);
  assert.equal(pub.priceCents, undefined);
  assert.equal(priv.advertiserEmail, "owner@acme.example.com");
  assert.equal(priv.priceCents, 15000);
});

test("editing keeps the created time and the invoice details", async () => {
  await wipe();

  await partners.saveSpot({ body: good(), bucket: BUCKET, nowMs: 1000 });
  await db.collection("partnerSpotsPrivate").doc(ID).set({ invoiceId: "in_1", invoiceStatus: "open" }, { merge: true });

  await partners.saveSpot({ body: good({ status: "paused", notes: "changed" }), bucket: BUCKET, nowMs: 2000 });

  const pub = (await db.collection("partnerSpots").doc(ID).get()).data();
  const priv = (await db.collection("partnerSpotsPrivate").doc(ID).get()).data();

  assert.equal(pub.status, "paused");
  assert.equal(pub.createdAtMs, 1000);
  assert.equal(pub.updatedAtMs, 2000);
  assert.equal(priv.invoiceId, "in_1");
  assert.equal(priv.notes, "changed");
});

test("a bad spot is refused and nothing is written", async () => {
  await wipe();

  await assert.rejects(partners.saveSpot({ body: good({ linkUrl: "http://acme.example.com" }), bucket: BUCKET }), /https/);
  await assert.rejects(partners.saveSpot({ body: good({ imageUrl: "https://evil.example.com/pixel.gif" }), bucket: BUCKET }), /image first/);
  await assert.rejects(partners.saveSpot({ body: good({ id: "bad/id" }), bucket: BUCKET }), /valid banner id/);
  await assert.rejects(partners.saveSpot({ body: good({ id: "x" }), bucket: BUCKET }), /valid banner id/);

  assert.equal((await db.collection("partnerSpots").get()).size, 0);
});

test("counting: only a live spot counts, once per visit up to the per-minute limit, and stats add up", async () => {
  await wipe();
  await partners.saveSpot({ body: good(), bucket: BUCKET, nowMs: 1000 });

  // not live yet (before the start date) or already ended -> not counted
  assert.equal((await partners.recordEvent({ id: ID, type: "view", visitor: "1.1.1.1", nowMs: pm.startOfDay("2026-11-01") })).counted, false);
  assert.equal((await partners.recordEvent({ id: ID, type: "view", visitor: "1.1.1.1", nowMs: pm.endOfDay("2026-12-11") })).counted, false);

  // live: counted
  assert.equal((await partners.recordEvent({ id: ID, type: "view", visitor: "1.1.1.1", nowMs: MID })).counted, true);
  assert.equal((await partners.recordEvent({ id: ID, type: "click", visitor: "1.1.1.1", nowMs: MID })).counted, true);
  assert.equal((await partners.recordEvent({ id: ID, type: "view", visitor: "2.2.2.2", nowMs: MID })).counted, true);

  // junk is quietly ignored
  assert.equal((await partners.recordEvent({ id: ID, type: "purchase", visitor: "1.1.1.1", nowMs: MID })).counted, false);
  assert.equal((await partners.recordEvent({ id: "nope", type: "view", visitor: "1.1.1.1", nowMs: MID })).counted, false);
  assert.equal((await partners.recordEvent({ id: "spot0000000000000999", type: "view", visitor: "1.1.1.1", nowMs: MID })).counted, false);

  const [spot] = await partners.listSpots(MID);

  assert.equal(spot.views, 2);
  assert.equal(spot.clicks, 1);
  assert.equal(spot.ctrPercent, 50);
  assert.equal(spot.state, "live");
});

test("counting: one address can't inflate the numbers; the limit resets after a minute", async () => {
  await wipe();
  await partners.saveSpot({ body: good(), bucket: BUCKET, nowMs: 1000 });

  let counted = 0;

  for (let i = 0; i < 25; i++) {
    if ((await partners.recordEvent({ id: ID, type: "view", visitor: "9.9.9.9", nowMs: MID + i })).counted) counted += 1;
  }

  assert.equal(counted, 10);

  assert.equal((await partners.recordEvent({ id: ID, type: "view", visitor: "9.9.9.9", nowMs: MID + 61000 })).counted, true, "a new minute starts fresh");
  assert.equal((await partners.recordEvent({ id: ID, type: "view", visitor: "8.8.8.8", nowMs: MID })).counted, true, "other visitors are unaffected");
});

test("a paused spot isn't counted", async () => {
  await wipe();
  await partners.saveSpot({ body: good({ status: "paused" }), bucket: BUCKET, nowMs: 1000 });

  assert.equal((await partners.recordEvent({ id: ID, type: "view", visitor: "1.1.1.1", nowMs: MID })).counted, false);
});

test("listing: the admin sees private details, state, last-7-day counts and the invoice", async () => {
  await wipe();
  await partners.saveSpot({ body: good(), bucket: BUCKET, nowMs: 1000 });
  await partners.recordEvent({ id: ID, type: "view", visitor: "1.1.1.1", nowMs: MID });
  await db.collection("partnerSpotsPrivate").doc(ID).set({ invoiceId: "in_1", invoiceUrl: "https://invoice.example/in_1", invoiceStatus: "open", invoiceSentAtMs: 5 }, { merge: true });

  const [spot] = await partners.listSpots(MID);

  assert.equal(spot.advertiserEmail, "owner@acme.example.com");
  assert.equal(spot.priceCents, 15000);
  assert.equal(spot.recentViews, 1);
  assert.deepEqual(spot.invoice, { id: "in_1", url: "https://invoice.example/in_1", status: "open", sentAtMs: 5 });

  assert.equal((await partners.listSpots(pm.startOfDay("2026-11-01")))[0].state, "scheduled");
  assert.equal((await partners.listSpots(pm.endOfDay("2026-12-11")))[0].state, "ended");
});

const fakeBucket = () => {
  const saved = [];

  return {
    name: BUCKET,
    saved,
    file: (path) => ({ save: async (buffer, options) => saved.push({ path, size: buffer.length, options }) }),
  };
};

const png = (size = 100) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size)]);

test("image upload: a real PNG is stored under partners/{id}/ and its URL comes back", async () => {
  const bucket = fakeBucket();
  const out = await partners.storeImage({ id: ID, contentType: "image/png", base64: png().toString("base64"), bucketHandle: bucket });

  assert.equal(bucket.saved.length, 1);
  assert.match(bucket.saved[0].path, /^partners\/spot0000000000000001\/image-[0-9a-f]{12}\.png$/);
  assert.equal(bucket.saved[0].options.contentType, "image/png");
  assert.equal(pm.isOwnImage(BUCKET, ID)(out.imageUrl), true);
});

test("image upload: wrong types, fake files, empty and oversized files are refused", async () => {
  const bucket = fakeBucket();
  const tryIt = (contentType, buffer) => partners.storeImage({ id: ID, contentType, base64: buffer.toString("base64"), bucketHandle: bucket });

  await assert.rejects(tryIt("image/gif", png()), /PNG, JPEG or WebP/);
  await assert.rejects(tryIt("text/html", Buffer.from("<script>alert(1)</script>")), /PNG, JPEG or WebP/);
  await assert.rejects(tryIt("image/png", Buffer.from("<html>pretending to be a png</html>")), /isn't really a PNG/);
  await assert.rejects(tryIt("image/jpeg", png()), /isn't really a JPG/);
  await assert.rejects(tryIt("image/png", Buffer.alloc(0)), /Choose an image/);
  await assert.rejects(tryIt("image/png", png(1600000)), /under 1.5 MB/);
  await assert.rejects(partners.storeImage({ id: "bad/../id", contentType: "image/png", base64: png().toString("base64"), bucketHandle: bucket }), /valid banner id/);

  assert.equal(bucket.saved.length, 0);

  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50)]);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(20)]);

  await tryIt("image/jpeg", jpeg);
  await tryIt("image/webp", webp);
  assert.equal(bucket.saved.length, 2);
});

const fakeStripe = () => {
  const calls = [];

  return {
    calls,
    customers: { create: async (args) => { calls.push(["customer", args]); return { id: "cus_p1" }; } },
    invoices: {
      create: async (args) => { calls.push(["invoice", args]); return { id: "in_p1" }; },
      finalizeInvoice: async (id) => { calls.push(["finalize", id]); return { id }; },
      sendInvoice: async (id) => { calls.push(["send", id]); return { id, status: "open", hosted_invoice_url: "https://invoice.example/in_p1" }; },
      retrieve: async (id) => ({ id, status: "paid", hosted_invoice_url: "https://invoice.example/in_p1" }),
    },
    invoiceItems: { create: async (args) => { calls.push(["item", args]); return { id: "ii_1" }; } },
  };
};

test("invoice: sends a Stripe invoice for the spot's price to the advertiser, once", async () => {
  await wipe();
  await partners.saveSpot({ body: good(), bucket: BUCKET, nowMs: 1000 });

  const stripe = fakeStripe();
  const out = await partners.sendInvoice(stripe, ID);

  assert.deepEqual(out, { invoiceUrl: "https://invoice.example/in_p1", status: "open" });
  assert.deepEqual(stripe.calls.map((c) => c[0]), ["customer", "invoice", "item", "finalize", "send"]);
  assert.equal(stripe.calls[0][1].email, "owner@acme.example.com");
  assert.equal(stripe.calls[1][1].collection_method, "send_invoice");
  assert.equal(stripe.calls[2][1].amount, 15000);
  assert.equal(stripe.calls[2][1].invoice, "in_p1");

  const priv = (await db.collection("partnerSpotsPrivate").doc(ID).get()).data();

  assert.equal(priv.invoiceId, "in_p1");
  assert.equal(priv.invoiceStatus, "open");
  assert.equal(priv.stripeCustomerId, "cus_p1");

  await assert.rejects(partners.sendInvoice(fakeStripe(), ID), /already sent/);
});

test("invoice: needs an email and a price; checking payment records paid", async () => {
  await wipe();

  await partners.saveSpot({ body: good({ advertiserEmail: "" }), bucket: BUCKET, nowMs: 1000 });
  await assert.rejects(partners.sendInvoice(fakeStripe(), ID), /advertiser's email/);

  await partners.saveSpot({ body: good({ priceCents: 0 }), bucket: BUCKET, nowMs: 1000 });
  await db.collection("partnerSpotsPrivate").doc(ID).set({ advertiserEmail: "owner@acme.example.com" }, { merge: true });
  await assert.rejects(partners.sendInvoice(fakeStripe(), ID), /Set a price/);

  await assert.rejects(partners.checkInvoice(fakeStripe(), ID), /No invoice/);

  await db.collection("partnerSpotsPrivate").doc(ID).set({ invoiceId: "in_p1", invoiceStatus: "open" }, { merge: true });

  assert.deepEqual(await partners.checkInvoice(fakeStripe(), ID), { status: "paid" });

  const priv = (await db.collection("partnerSpotsPrivate").doc(ID).get()).data();

  assert.equal(priv.invoiceStatus, "paid");
  assert.ok(priv.paidAtMs > 0);
});

test("deleting removes both parts and the images, but keeps the stats", async () => {
  await wipe();
  await partners.saveSpot({ body: good(), bucket: BUCKET, nowMs: 1000 });
  await partners.recordEvent({ id: ID, type: "view", visitor: "1.1.1.1", nowMs: MID });

  const removed = [];

  await partners.deleteSpot({ id: ID, bucketHandle: { deleteFiles: async (options) => removed.push(options.prefix) } });

  assert.equal((await db.collection("partnerSpots").doc(ID).get()).exists, false);
  assert.equal((await db.collection("partnerSpotsPrivate").doc(ID).get()).exists, false);
  assert.deepEqual(removed, [`partners/${ID}/`]);
  assert.equal((await db.collection("partnerStats").get()).size, 1);
});
