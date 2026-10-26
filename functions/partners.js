// Partner banners: advertising sold directly to businesses. An admin creates a
// spot (image, link, dates, where it shows, price), can send the advertiser a
// Stripe invoice, and sees views and clicks. Buyers see the live spot on the
// homepage and the buyer dashboard, labeled "Advertisement". The rules and math
// are in partnerMath.js.
//
// What lives where:
//   partnerSpots/{id}         the public part: image, link, dates, placements,
//                             status. Anyone may read it (the pages that show it
//                             are public); only Cloud Functions write it.
//   partnerSpotsPrivate/{id}  advertiser email, price, notes, invoice details.
//                             Server only.
//   partnerStats/{id}_{day}   views and clicks per day. Server only.
//   partnerLimits/{hash}      rate-limit counters for the public view/click calls.
//   Storage partners/{id}/    the images, written only by these functions.
//
// Everything is called "partner" because ad blockers hide and block anything with
// ad / banner / sponsor in its name -- see partnerMath.js.

const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");

const plans = require("./plans");
const pm = require("./partnerMath");

const { PlanError, stripeClient } = plans;

const db = () => admin.firestore();
const serverTime = () => admin.firestore.FieldValue.serverTimestamp();

// ------------------------------------------------------------------ plumbing

async function authenticateAdmin(req) {
  const match = (req.headers.authorization || "").match(/^Bearer (.+)$/);

  if (!match) throw new PlanError("Authentication required.", 401);

  let decoded;

  try {
    decoded = await admin.auth().verifyIdToken(match[1]);
  } catch (error) {
    throw new PlanError("Authentication required.", 401);
  }

  const snap = await db().collection("users").doc(decoded.uid).get();

  if (!snap.exists || snap.data().role !== "admin") throw new PlanError("Admins only.", 403);

  return { uid: decoded.uid };
}

function adminEndpoint(options, handler) {
  return onRequest({ cors: true, ...options }, async (req, res) => {
    try {
      const adminUser = await authenticateAdmin(req);

      res.send(await handler({ admin: adminUser, body: req.body || {} }));
    } catch (error) {
      if (error instanceof PlanError) return res.status(error.status).send({ error: error.message });

      logger.error(error);
      res.status(500).send({ error: "Something went wrong. Please try again." });
    }
  });
}

const bucketName = () => admin.storage().bucket().name;

const dayKey = (nowMs) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(nowMs))
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});

  return `${parts.year}${parts.month}${parts.day}`;
};

const checkId = (id) => {
  if (typeof id !== "string" || !pm.SPOT_ID.test(id)) throw new PlanError("That isn't a valid banner id.");

  return id;
};

// ------------------------------------------------------------------- saving

// Creates or updates a spot (public and private parts together).
async function saveSpot({ body, bucket = bucketName(), nowMs = Date.now() }) {
  const id = checkId(body.id);
  const checked = pm.validateSpot(body, pm.isOwnImage(bucket, id));

  if (checked.error) throw new PlanError(checked.error);

  const publicRef = db().collection("partnerSpots").doc(id);
  const privateRef = db().collection("partnerSpotsPrivate").doc(id);

  await db().runTransaction(async (tx) => {
    const existing = await tx.get(publicRef);

    tx.set(publicRef, { ...checked.value.publicDoc, createdAtMs: existing.exists ? existing.data().createdAtMs : nowMs, updatedAtMs: nowMs });
    tx.set(privateRef, { ...checked.value.privateDoc, updatedAtMs: nowMs }, { merge: true }); // keeps invoice fields
  });

  return { id };
}

async function deleteSpot({ id, bucketHandle }) {
  checkId(id);

  await db().collection("partnerSpots").doc(id).delete();
  await db().collection("partnerSpotsPrivate").doc(id).delete();

  // Best effort: remove the stored images. Stats are kept for the records.
  if (bucketHandle) {
    try {
      await bucketHandle.deleteFiles({ prefix: `partners/${id}/` });
    } catch (error) {
      logger.warn(`Couldn't remove images for partner spot ${id}:`, error.message);
    }
  }

  return { deleted: true };
}

// Stores an uploaded image for a spot and returns the URL the page will show. Only
// real PNG, JPEG or WebP files up to 1.5MB are accepted -- the file's own first
// bytes are checked, not just what the browser said it was.
const MAGIC = {
  "image/png": (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/jpeg": (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/webp": (b) => b.length > 12 && b.slice(0, 4).toString("latin1") === "RIFF" && b.slice(8, 12).toString("latin1") === "WEBP",
};

async function storeImage({ id, contentType, base64, bucketHandle }) {
  checkId(id);

  const extension = pm.IMAGE_TYPES[contentType];

  if (!extension) throw new PlanError("Use a PNG, JPEG or WebP image.");
  if (typeof base64 !== "string" || !base64) throw new PlanError("Choose an image first.");

  const buffer = Buffer.from(base64, "base64");

  if (buffer.length === 0 || buffer.length > pm.MAX_IMAGE_BYTES) throw new PlanError("The image must be under 1.5 MB. Try saving it at 1200 x 300 pixels.");
  if (!MAGIC[contentType](buffer)) throw new PlanError("That file isn't really a " + extension.toUpperCase() + " image.");

  const fileName = `image-${crypto.randomBytes(6).toString("hex")}.${extension}`;

  await bucketHandle.file(`partners/${id}/${fileName}`).save(buffer, {
    contentType,
    resumable: false,
    metadata: { cacheControl: "public, max-age=31536000" },
  });

  return { imageUrl: pm.imageUrlFor(bucketHandle.name, id, fileName) };
}

// ------------------------------------------------------------------- listing

// Everything the admin page shows: each spot with its private details, its state
// right now, and its views and clicks.
async function listSpots(nowMs = Date.now()) {
  const [publicSnap, privateSnap, statsSnap] = await Promise.all([
    db().collection("partnerSpots").get(),
    db().collection("partnerSpotsPrivate").get(),
    db().collection("partnerStats").get(),
  ]);

  const privateById = new Map(privateSnap.docs.map((d) => [d.id, d.data()]));
  const totals = new Map();
  const recentFrom = dayKey(nowMs - 6 * pm.DAY_MS);

  for (const doc of statsSnap.docs) {
    const stat = doc.data();
    const current = totals.get(stat.spotId) || { views: 0, clicks: 0, recentViews: 0, recentClicks: 0 };

    current.views += stat.views || 0;
    current.clicks += stat.clicks || 0;

    if (stat.day >= recentFrom) {
      current.recentViews += stat.views || 0;
      current.recentClicks += stat.clicks || 0;
    }

    totals.set(stat.spotId, current);
  }

  return publicSnap.docs
    .map((doc) => {
      const spot = { id: doc.id, ...doc.data() };
      const priv = privateById.get(doc.id) || {};
      const stats = totals.get(doc.id) || { views: 0, clicks: 0, recentViews: 0, recentClicks: 0 };

      return {
        ...spot,
        advertiserEmail: priv.advertiserEmail || "",
        priceCents: priv.priceCents || 0,
        notes: priv.notes || "",
        invoice: priv.invoiceId ? { id: priv.invoiceId, url: priv.invoiceUrl || null, status: priv.invoiceStatus || "open", sentAtMs: priv.invoiceSentAtMs || null } : null,
        state: pm.spotState(spot, nowMs),
        views: stats.views,
        clicks: stats.clicks,
        ctrPercent: pm.ctrPercent(stats.views, stats.clicks),
        recentViews: stats.recentViews,
        recentClicks: stats.recentClicks,
      };
    })
    .sort((a, b) => b.startsAtMs - a.startsAtMs || (a.id < b.id ? -1 : 1));
}

// ------------------------------------------------------------------ counting

// The limits on the public view/click calls, per visitor address and spot: a
// handful a minute is plenty for a real person.
const LIMITS = { view: 10, click: 10 };
const WINDOW_MS = 60 * 1000;

// Counts one view or click. Called by anyone (the pages are public), so it never
// trusts the caller: the spot must exist and be live right now, and each visitor
// address is limited. Always answers the same way, so it can't be probed.
async function recordEvent({ id, type, visitor, nowMs = Date.now() }) {
  if (typeof id !== "string" || !pm.SPOT_ID.test(id) || !["view", "click"].includes(type)) return { counted: false };

  const key = crypto.createHash("sha256").update(`${visitor}|${id}|${type}`).digest("hex").slice(0, 40);
  const limitRef = db().collection("partnerLimits").doc(key);
  const spotRef = db().collection("partnerSpots").doc(id);
  const statRef = db().collection("partnerStats").doc(`${id}_${dayKey(nowMs)}`);

  return db().runTransaction(async (tx) => {
    const [limit, spotSnap] = await Promise.all([tx.get(limitRef), tx.get(spotRef)]);

    if (!spotSnap.exists || pm.spotState(spotSnap.data(), nowMs) !== "live") return { counted: false };

    const fresh = limit.exists && nowMs - limit.data().windowStartMs < WINDOW_MS;
    const count = fresh ? limit.data().count : 0;

    if (count >= LIMITS[type]) return { counted: false };

    tx.set(limitRef, { count: count + 1, windowStartMs: fresh ? limit.data().windowStartMs : nowMs });
    tx.set(statRef, { spotId: id, day: dayKey(nowMs), [`${type}s`]: admin.firestore.FieldValue.increment(1) }, { merge: true });

    return { counted: true };
  });
}

// --------------------------------------------------------------------- invoices

// Creates a Stripe invoice for the spot's price and emails it to the advertiser.
// Stripe sends the email and hosts the page where they pay.
async function sendInvoice(stripe, id) {
  checkId(id);

  const publicSnap = await db().collection("partnerSpots").doc(id).get();
  const privateRef = db().collection("partnerSpotsPrivate").doc(id);
  const priv = (await privateRef.get()).data() || {};

  if (!publicSnap.exists) throw new PlanError("That banner doesn't exist.");
  if (!priv.advertiserEmail) throw new PlanError("Add the advertiser's email first.");
  if (!(priv.priceCents > 0)) throw new PlanError("Set a price first.");
  if (priv.invoiceId && ["open", "paid"].includes(priv.invoiceStatus)) throw new PlanError("An invoice was already sent for this banner.");

  const spot = publicSnap.data();

  const customerId = priv.stripeCustomerId
    || (await stripe.customers.create({ email: priv.advertiserEmail, name: spot.advertiserName, metadata: { kind: "partner", spotId: id } })).id;

  const invoice = await stripe.invoices.create({
    customer: customerId,
    collection_method: "send_invoice",
    days_until_due: 14,
    auto_advance: false,
    description: `Lesovia partner banner for ${spot.advertiserName}, ${spot.startDate} to ${spot.endDate}`,
    metadata: { kind: "partner", spotId: id },
  });

  await stripe.invoiceItems.create({
    customer: customerId,
    invoice: invoice.id,
    amount: priv.priceCents,
    currency: "usd",
    description: `Partner banner, ${spot.startDate} to ${spot.endDate}`,
  });

  await stripe.invoices.finalizeInvoice(invoice.id);
  const sent = await stripe.invoices.sendInvoice(invoice.id);

  await privateRef.set(
    { stripeCustomerId: customerId, invoiceId: invoice.id, invoiceUrl: sent.hosted_invoice_url || null, invoiceStatus: sent.status || "open", invoiceSentAtMs: Date.now() },
    { merge: true }
  );

  return { invoiceUrl: sent.hosted_invoice_url || null, status: sent.status || "open" };
}

// Asks Stripe whether the advertiser has paid, and records it.
async function checkInvoice(stripe, id) {
  checkId(id);

  const privateRef = db().collection("partnerSpotsPrivate").doc(id);
  const priv = (await privateRef.get()).data() || {};

  if (!priv.invoiceId) throw new PlanError("No invoice has been sent for this banner.");

  const invoice = await stripe.invoices.retrieve(priv.invoiceId);

  await privateRef.set({ invoiceStatus: invoice.status, invoiceUrl: invoice.hosted_invoice_url || priv.invoiceUrl || null, ...(invoice.status === "paid" ? { paidAtMs: Date.now() } : {}) }, { merge: true });

  return { status: invoice.status };
}

// ------------------------------------------------------------------ endpoints

const withStripe = { secrets: ["STRIPE_SECRET_KEY"] };

const savePartnerSpot = adminEndpoint({}, ({ body }) => saveSpot({ body }));
const deletePartnerSpot = adminEndpoint({}, ({ body }) => deleteSpot({ id: body.id, bucketHandle: admin.storage().bucket() }));
const listPartnerSpots = adminEndpoint({}, async () => ({ spots: await listSpots() }));
const uploadPartnerImage = adminEndpoint({}, ({ body }) =>
  storeImage({ id: body.id, contentType: body.contentType, base64: body.dataBase64, bucketHandle: admin.storage().bucket() })
);
const sendPartnerInvoice = adminEndpoint(withStripe, ({ body }) => sendInvoice(stripeClient(), body.id));
const checkPartnerInvoice = adminEndpoint(withStripe, ({ body }) => checkInvoice(stripeClient(), body.id));

// Public: a page shows a live spot (view) or a visitor clicks it (click).
const partnerEvent = onRequest({ cors: true }, async (req, res) => {
  try {
    const forwarded = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
    const body = req.body && typeof req.body === "object" ? req.body : {};

    await recordEvent({ id: body.id, type: body.type, visitor: forwarded });
  } catch (error) {
    logger.error(error);
  }

  res.status(204).send("");
});

module.exports = {
  saveSpot,
  deleteSpot,
  storeImage,
  listSpots,
  recordEvent,
  sendInvoice,
  checkInvoice,
  savePartnerSpot,
  deletePartnerSpot,
  listPartnerSpots,
  uploadPartnerImage,
  sendPartnerInvoice,
  checkPartnerInvoice,
  partnerEvent,
};
