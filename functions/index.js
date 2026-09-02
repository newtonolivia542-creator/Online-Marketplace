/* 
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

const Stripe = require("stripe");

exports.createPaymentIntent = onRequest(
  {
    secrets: ["STRIPE_SECRET_KEY"],
  },

  async (req, res) => {

    try {

      const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

      const paymentIntent = await stripe.paymentIntents.create({
        amount: 5000,
        currency: "usd",
      });

      res.send({
        clientSecret: paymentIntent.client_secret,
      });

    } catch (error) {

      logger.error(error);

      res.status(500).send(error.message);

    }

  }
);
*/
const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");

const Stripe = require("stripe");
const OpenAI = require("openai").default;
const admin = require("firebase-admin");
const { Resend } = require("resend");

admin.initializeApp();

const db = admin.firestore();

// Thrown when stock disappears between PaymentIntent creation and
// verification (e.g. another buyer bought the last unit in between).
class InsufficientStockError extends Error {
  constructor(productId) {
    super(`Insufficient stock for product ${productId} at fulfillment time.`);
    this.productId = productId;
  }
}

// Resolves the calling buyer's uid from a Firebase Auth ID token sent as
// "Authorization: Bearer <token>". Never trust a buyerId supplied in the body.
async function getUidFromRequest(req) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer (.+)$/);

  if (!match) return null;

  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    return decoded.uid;
  } catch (error) {
    logger.error("Failed to verify ID token:", error);
    return null;
  }
}

// Same as getUidFromRequest but returns the full decoded token -- used
// where the caller's own verified email is needed (never the email a
// client claims in the request body).
async function getDecodedTokenFromRequest(req) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer (.+)$/);

  if (!match) return null;

  try {
    return await admin.auth().verifyIdToken(match[1]);
  } catch (error) {
    logger.error("Failed to verify ID token:", error);
    return null;
  }
}

// Per-email cooldown so one address can't be spammed with repeated
// verification/reset emails. Checked BEFORE anything looks up whether the
// account is real, so the cooldown itself never becomes a second way to
// tell real emails from fake ones.
async function isUnderEmailCooldown(purpose, email, cooldownSeconds) {
  const key = `${purpose}_${email.trim().toLowerCase()}`;
  const ref = db.collection("emailRateLimits").doc(key);
  const snap = await ref.get();

  const now = Date.now();

  if (snap.exists) {
    const lastSentAt = snap.data().lastSentAt?.toMillis?.() ?? 0;
    if (now - lastSentAt < cooldownSeconds * 1000) {
      return true;
    }
  }

  await ref.set({ lastSentAt: admin.firestore.FieldValue.serverTimestamp() });
  return false;
}

// =================================
// CREATE PAYMENT INTENT (CART / BUY NOW)
// =================================
// Computes the order total from Firestore product data -- never from the
// client -- validates stock, and creates a matching Stripe TEST PaymentIntent.
exports.createPaymentIntent = onRequest(
  {
    secrets: ["STRIPE_SECRET_KEY"],
    cors: true
  },

  async (req, res) => {

    try {

      const buyerId = await getUidFromRequest(req);

      if (!buyerId) {
        return res.status(401).send({ error: "Authentication required." });
      }

      const { checkoutId, items, cartItemIds } = req.body || {};

      if (!checkoutId || typeof checkoutId !== "string") {
        return res.status(400).send({ error: "Missing checkoutId." });
      }

      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).send({ error: "Cart is empty." });
      }

      const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
      const pendingOrderRef = db.collection("pendingOrders").doc(checkoutId);

      // Retry of an in-flight checkout with the same checkoutId -- return the
      // existing PaymentIntent instead of creating a second one.
      const existingSnap = await pendingOrderRef.get();

      if (existingSnap.exists && existingSnap.data().status === "pending_payment") {
        const existing = existingSnap.data();
        const existingIntent = await stripe.paymentIntents.retrieve(
          existing.stripePaymentIntentId
        );

        return res.send({
          orderId: checkoutId,
          clientSecret: existingIntent.client_secret,
          amount: existing.amount,
        });
      }

      const lineItems = [];
      let amount = 0;

      for (const rawItem of items) {
        const productId = rawItem && rawItem.productId;
        const quantity = Number(rawItem && rawItem.quantity);

        if (!productId || !Number.isInteger(quantity) || quantity < 1) {
          return res.status(400).send({ error: "Invalid item in cart." });
        }

        const productSnap = await db.collection("products").doc(productId).get();

        if (!productSnap.exists) {
          return res
            .status(400)
            .send({ error: `Product ${productId} no longer exists.` });
        }

        const product = productSnap.data();
        const availableQuantity = product.quantity ?? 0;

        if (availableQuantity < quantity) {
          return res.status(400).send({
            error: `Not enough stock for "${product.name}". Only ${availableQuantity} left.`,
          });
        }

        const unitPriceCents = Math.round(Number(product.price) * 100);

        if (!Number.isFinite(unitPriceCents) || unitPriceCents <= 0) {
          return res
            .status(400)
            .send({ error: `Invalid price for "${product.name}".` });
        }

        amount += unitPriceCents * quantity;

        lineItems.push({
          productId,
          sellerId: product.sellerId,
          name: product.name || "Product",
          quantity,
          color: (rawItem && rawItem.color) || null,
          size: (rawItem && rawItem.size) || null,
          unitPriceCents,
        });
      }

      if (amount <= 0) {
        return res.status(400).send({ error: "Order total must be greater than zero." });
      }

      const paymentIntent = await stripe.paymentIntents.create(
        {
          amount,
          currency: "usd",
          metadata: {
            orderId: checkoutId,
            buyerId,
          },
        },
        {
          idempotencyKey: `pi_create_${checkoutId}`,
        }
      );

      await pendingOrderRef.set({
        buyerId,
        items: lineItems,
        amount,
        currency: "usd",
        cartItemIds: Array.isArray(cartItemIds) ? cartItemIds : [],
        stripePaymentIntentId: paymentIntent.id,
        status: "pending_payment",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.send({
        orderId: checkoutId,
        clientSecret: paymentIntent.client_secret,
        amount,
      });

    } catch (error) {

      logger.error(error);

      res.status(500).send({ error: error.message });

    }

  }
);

// =================================
// VERIFY PAYMENT AND FINALIZE ORDER
// =================================
// The ONLY place an order is ever marked "paid". Re-checks the payment with
// Stripe directly (never trusts the client's local confirmCardPayment result),
// then atomically creates the order(s), decrements inventory, and notifies
// buyer + seller. Idempotent: safe to call more than once for the same order.
exports.verifyPayment = onRequest(
  {
    secrets: ["STRIPE_SECRET_KEY"],
    cors: true
  },

  async (req, res) => {

    try {

      const buyerId = await getUidFromRequest(req);

      if (!buyerId) {
        return res.status(401).send({ error: "Authentication required." });
      }

      const { orderId } = req.body || {};

      if (!orderId || typeof orderId !== "string") {
        return res.status(400).send({ error: "Missing orderId." });
      }

      const pendingOrderRef = db.collection("pendingOrders").doc(orderId);
      const pendingSnap = await pendingOrderRef.get();

      if (!pendingSnap.exists) {
        return res.status(404).send({ error: "Order not found." });
      }

      const pendingOrder = pendingSnap.data();

      if (pendingOrder.buyerId !== buyerId) {
        return res.status(403).send({ error: "This order does not belong to you." });
      }

      // Already finalized -- return the same result, do not reprocess.
      if (pendingOrder.status === "completed") {
        return res.send({ success: true, orderIds: pendingOrder.orderIds || [] });
      }

      if (pendingOrder.status === "failed") {
        return res.send({ success: false, status: pendingOrder.failureReason || "failed" });
      }

      const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
      const paymentIntent = await stripe.paymentIntents.retrieve(
        pendingOrder.stripePaymentIntentId
      );

      if (
        paymentIntent.status !== "succeeded" ||
        paymentIntent.amount !== pendingOrder.amount
      ) {
        await pendingOrderRef.update({
          status: "failed",
          failureReason: paymentIntent.status,
        });

        return res.send({ success: false, status: paymentIntent.status });
      }

      let orderIds;

      try {

        orderIds = await db.runTransaction(async (tx) => {

          // Re-read inside the transaction in case a concurrent verifyPayment
          // call for the same order is racing this one.
          const freshSnap = await tx.get(pendingOrderRef);
          const freshPending = freshSnap.data();

          if (freshPending.status === "completed") {
            return freshPending.orderIds || [];
          }

          const productRefs = freshPending.items.map((item) =>
            db.collection("products").doc(item.productId)
          );

          const productSnaps = await Promise.all(
            productRefs.map((ref) => tx.get(ref))
          );

          // Re-validate stock is still available right before committing the
          // sale -- it may have changed since the PaymentIntent was created.
          for (let i = 0; i < freshPending.items.length; i++) {
            const item = freshPending.items[i];
            const snap = productSnaps[i];
            const available = snap.exists ? (snap.data().quantity ?? 0) : 0;

            if (available < item.quantity) {
              throw new InsufficientStockError(item.productId);
            }
          }

          const newOrderIds = [];

          for (let i = 0; i < freshPending.items.length; i++) {
            const item = freshPending.items[i];
            const product = productSnaps[i].data();
            const orderRef = db.collection("orders").doc(`${orderId}_${item.productId}`);

            newOrderIds.push(orderRef.id);

            tx.set(orderRef, {
              productId: item.productId,
              sellerId: item.sellerId,
              userId: freshPending.buyerId,
              quantity: item.quantity,
              color: item.color,
              size: item.size,
              price: item.unitPriceCents / 100,
              status: "paid",
              stripePaymentIntentId: freshPending.stripePaymentIntentId,
              checkoutId: orderId,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            const newQuantity = product.quantity - item.quantity;

            tx.update(productRefs[i], { quantity: newQuantity });

            tx.set(db.collection("notifications").doc(), {
              userId: item.sellerId,
              type: "new_order",
              title: "New Order Received",
              message: `${product.name} was purchased.`,
              link: `seller-orders.html?orderId=${orderRef.id}`,
              read: false,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            tx.set(db.collection("notifications").doc(), {
              userId: freshPending.buyerId,
              type: "order_placed",
              title: "Order Confirmed",
              message: `Your order for "${product.name}" has been placed successfully.`,
              link: `order.html?orderId=${orderRef.id}`,
              read: false,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            if (newQuantity <= 5 && newQuantity > 0) {
              tx.set(db.collection("notifications").doc(), {
                userId: item.sellerId,
                type: "low_stock",
                title: "Low Inventory",
                message: `Only ${newQuantity} ${product.name} left in stock.`,
                link: `seller dashboard.html?highlightProduct=${item.productId}`,
                read: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
          }

          (freshPending.cartItemIds || []).forEach((cartItemId) => {
            tx.delete(db.collection("carts").doc(cartItemId));
          });

          tx.update(pendingOrderRef, {
            status: "completed",
            orderIds: newOrderIds,
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          return newOrderIds;
        });

      } catch (err) {

        if (err instanceof InsufficientStockError) {

          // Payment succeeded but stock ran out before we could fulfill it --
          // refund the TEST charge instead of overselling.
          await stripe.refunds.create({
            payment_intent: pendingOrder.stripePaymentIntentId,
          });

          await pendingOrderRef.update({
            status: "failed",
            failureReason: "insufficient_stock_refunded",
          });

          return res.send({ success: false, status: "insufficient_stock_refunded" });
        }

        throw err;
      }

      res.send({ success: true, orderIds });

    } catch (error) {

      logger.error(error);

      res.status(500).send({ error: error.message });

    }

  }
);

exports.generateProductDescription = onRequest(
  {
    secrets: ["OPENAI_API_KEY"],
    cors: true,
  },

  async (req, res) => {
    try {
      const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });

      const {
        productName,
        brand,
        color,
        size,
        category,
        condition,
        price
    } = req.body;

      if (!productName || !category || !condition || !price) {
        return res.status(400).send({
          error: "Missing required product information.",
        });
      }

      logger.info("Generating AI description for:", productName);

      const response = await client.responses.create({
        model: "gpt-5.5",
        input: `
You are an expert e-commerce copywriter.

Write a professional marketplace product description.

Product Name: ${productName}
Brand: ${brand}
Color: ${color}
Size: ${size}
Category: ${category}
Condition: ${condition}
Price: ${price}

Requirements:
- 10–30 words only.
- Keep it concise and easy to read.
- Professional and friendly tone.
- Mention the condition naturally.
- Do not invent features.
- Focus on helping buyers understand the product quickly.
`,
      });

      res.send({
        description: response.output_text,
      });

    } catch (error) {

      logger.error(error);

      res.status(500).send({
        error: error.message,
      });

    }
  }
);

   //AI SEARCH FUNCTION//
// Real category list the storefront's category dropdown actually uses --
// telling the model this is the closed set it must choose from (or null)
// makes the hard category filter below reliable instead of guessing.
const KNOWN_PRODUCT_CATEGORIES = [
  "fashion",
  "electronics",
  "food",
  "home",
  "cosmetics",
  "plants",
];

exports.aiSearchProducts = onRequest(
  {
    secrets: ["OPENAI_API_KEY"],
    cors: true,
  },

  async (req, res) => {

    try {

      const { search } = req.body || {};

      if (!search || !String(search).trim()) {
        return res.status(400).send({
          error: "Search text is required."
        });
      }

      logger.info("AI Search:", search);

      const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });

      const response = await client.responses.create({
        model: "gpt-5.5",
        input: `
You are a shopping-intent extractor for the Lesovia marketplace.

Customer search: "${search}"

Extract the customer's shopping intent as JSON with EXACTLY these keys:

{
  "category": one of [${KNOWN_PRODUCT_CATEGORIES.map((c) => `"${c}"`).join(", ")}], or null if it doesn't clearly match one,
  "brand": string or null,
  "colors": array of color words mentioned (lowercase), or [],
  "condition": "new", "used", or null,
  "minPrice": number or null,
  "maxPrice": number or null,
  "keywords": array of important descriptive words from the search (lowercase)
}

Return ONLY valid JSON. No explanations, no markdown.
`,
      });

      logger.info("AI raw output:", response.output_text);

      let filters;

      try {
        filters = JSON.parse(response.output_text);
      } catch (parseError) {
        // Don't fail the whole search just because the model didn't return
        // clean JSON -- fall back to a keyword-only search using the raw
        // query instead of erroring out on the buyer.
        logger.error("Failed to parse AI filters, falling back to keyword-only search:", parseError);
        filters = {
          category: null,
          brand: null,
          colors: [],
          condition: null,
          minPrice: null,
          maxPrice: null,
          keywords: [],
        };
      }

      const category = KNOWN_PRODUCT_CATEGORIES.includes(
        String(filters.category || "").toLowerCase()
      )
        ? String(filters.category).toLowerCase()
        : null;

      // The catalog is read in full and filtered/ranked here rather than
      // with Firestore where() clauses -- price range + category together
      // would need a composite index, and there's no reasonable way to do
      // fuzzy keyword/brand/color matching in Firestore at all. At this
      // catalog's size, one read is cheap; this also matches how the rest
      // of the storefront already reads "products".
      const snapshot = await db.collection("products").get();

      const keywordTerms = [
        ...(Array.isArray(filters.keywords) ? filters.keywords : []),
        ...(filters.brand ? [filters.brand] : []),
        ...(Array.isArray(filters.colors) ? filters.colors : []),
        ...String(search).toLowerCase().split(/\s+/),
      ]
        .map((term) => String(term).toLowerCase().trim())
        .filter(Boolean);

      const matches = [];

      snapshot.forEach((doc) => {
        const product = doc.data();

        // Hard filters -- only applied when the model was confident enough
        // to name an exact known category or a price bound.
        if (category && String(product.category || "").toLowerCase() !== category) {
          return;
        }

        if (filters.minPrice != null && Number(product.price) < Number(filters.minPrice)) {
          return;
        }

        if (filters.maxPrice != null && Number(product.price) > Number(filters.maxPrice)) {
          return;
        }

        // Out of stock -- same rule the storefront's own product grid uses.
        if (product.quantity !== undefined && product.quantity <= 0) {
          return;
        }

        // Soft ranking -- how much of the extracted/raw search text shows
        // up in this product's own name/description/brand/category/colors.
        const haystack = [
          product.name,
          product.description,
          product.brand,
          product.category,
          ...(Array.isArray(product.colors) ? product.colors : []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        let score = 0;
        for (const term of keywordTerms) {
          if (term && haystack.includes(term)) score++;
        }

        matches.push({ id: doc.id, ...product, _score: score });
      });

      matches.sort((a, b) => b._score - a._score);

      const products = matches.map(({ _score, ...rest }) => rest);

      logger.info(`AI search matched ${products.length} product(s) for filters:`, {
        ...filters,
        category,
      });

      res.send({
        products,
        filters: { ...filters, category },
      });

    } catch (error) {

      logger.error(error);

      res.status(500).send({
        error: error.message
      });

    }

  }
);

// =================================
// BRANDED EMAIL SHELL
// =================================
// Shared header/footer wrapper so every transactional email looks like it
// came from the same product, not a bare unstyled system message. Built
// with inline styles throughout, since email clients strip <style> blocks
// and external stylesheets. The header includes both the mark image and
// the text wordmark -- most clients (Gmail, Outlook) block remote images
// by default until the user clicks "show images", so the text keeps the
// brand visible even before that happens; the image just adds to it once
// images load.
function brandedEmailShell(bodyHtml) {
  return `
<div style="background:#F6F8F6;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:auto;background:#FFFFFF;border-radius:10px;overflow:hidden;border:1px solid #E2E8E4;">

    <div style="background:#14231B;padding:24px 30px;">
      <img
        src="https://lesovia.com/images/lesovia-touch-icon.png"
        width="32"
        height="32"
        alt="Lesovia"
        style="display:inline-block;vertical-align:middle;margin-right:10px;border:0;"
      >
      <span style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:bold;color:#FFFFFF;letter-spacing:0.5px;vertical-align:middle;">
        Lesovia
      </span>
    </div>

    <div style="padding:30px;color:#14231B;line-height:1.5;">
      ${bodyHtml}
    </div>

    <div style="padding:20px 30px;border-top:1px solid #E2E8E4;">
      <p style="color:#8A968F;font-size:12px;margin:0;">
        © 2026 Lesovia. All Rights Reserved.
      </p>
    </div>

  </div>
</div>
  `;
}

// =================================
// REAL EMAIL VERIFICATION FUNCTION
// =================================

  exports.sendVerificationEmail = onRequest(
    {
      secrets: ["RESEND_API_KEY", "APP_URL"],
      cors: true,
    },

    async (req, res) => {

      try {

        // Only ever called right after the caller signs in (fresh
        // registration, or a login attempt with an unverified email) --
        // a valid session always exists at that point. Requiring it here
        // means this can only ever send a verification email to the
        // caller's OWN account, never an arbitrary address someone else
        // supplies in the request body.
        const decoded = await getDecodedTokenFromRequest(req);

        if (!decoded || !decoded.email) {
          return res.status(401).send({ error: "Authentication required." });
        }

        const email = decoded.email;
        const { fullName } = req.body || {};

        if (await isUnderEmailCooldown("verify", email, 60)) {
          return res.status(429).send({
            error: "Please wait a moment before requesting another verification email.",
          });
        }

        const resend = new Resend(process.env.RESEND_API_KEY);

      const verificationLink =
        await admin.auth().generateEmailVerificationLink(email, {
          url: process.env.APP_URL,
          handleCodeInApp: false,
        });

        const emailResult = await resend.emails.send({

          from: "Lesovia <no-reply@lesovia.com>",

          to: email,

          subject: "Verify your Lesovia account",

          html: brandedEmailShell(`
      <h1 style="font-family:Georgia,'Times New Roman',serif;color:#14231B;margin-top:0;">Welcome to Lesovia!</h1>

      <p>Hello ${fullName || ""},</p>

      <p>
        Thank you for creating your Lesovia account.
      </p>

      <p>
        Please verify your email address before logging in.
      </p>

      <p style="margin:40px 0;text-align:center;">

      <a
      href="${verificationLink}"
      style="
        background:#0B7A3D;
        color:#ffffff;
        padding:15px 30px;
        text-decoration:none;
        border-radius:6px;
        font-weight:bold;
        display:inline-block;
      ">
        Verify My Email
      </a>

      </p>

      <p>
        If the button doesn't work, copy this link:
      </p>

      <p style="word-break:break-all;color:#5B6B62;">
      ${verificationLink}
      </p>
          `),

        });
        logger.info("Resend response:", emailResult);

        res.send({

          success: true,

          message: "Verification email sent."

        });

      }

      catch (error) {

        logger.error(error);

        res.status(500).send({

          error: error.message

        });

      }

    }

  );


  // ===========================
// CUSTOM PASSWORD RESET EMAIL
// ===========================

exports.sendPasswordResetEmail = onRequest(
  {
    secrets: ["RESEND_API_KEY", "APP_URL"],
    cors: true,
  },
  async (req, res) => {
    try {
      const { email } = req.body || {};

      if (!email) {
        return res.status(400).send({
          error: "Email is required.",
        });
      }

      const genericResponse = {
        success: true,
        message: "If an account exists for that email, a password reset link has been sent.",
      };

      // Checked before Firebase Auth is ever consulted, so the cooldown
      // response is identical whether or not the account exists.
      if (await isUnderEmailCooldown("reset", email, 60)) {
        return res.send(genericResponse);
      }

      // Whatever happens below -- real account, unknown email, malformed
      // address, a Resend failure -- the caller always gets the same
      // response. Distinguishing these here is exactly what would let an
      // attacker enumerate which emails have accounts.
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);

        const resetLink = await admin.auth().generatePasswordResetLink(email, {
          url: process.env.APP_URL,
        });

        const emailResult = await resend.emails.send({
          from: "Lesovia <no-reply@lesovia.com>",
          to: email,
          subject: "Reset your Lesovia password",

          html: brandedEmailShell(`
<h1 style="font-family:Georgia,'Times New Roman',serif;color:#14231B;margin-top:0;">Reset Your Password</h1>

<p>Hello,</p>

<p>
We received a request to reset the password for your Lesovia account.
</p>

<p>
If you requested this change, click the button below.
</p>

<p style="margin:40px 0;text-align:center;">

<a
href="${resetLink}"
style="
background:#0B7A3D;
color:#ffffff;
padding:15px 30px;
text-decoration:none;
border-radius:6px;
font-weight:bold;
display:inline-block;
">
Reset Password
</a>

</p>

<p>
If you didn't request a password reset, you can safely ignore this email.
Your password will remain unchanged.
</p>
`),
        });

        logger.info("Password reset email:", emailResult);

      } catch (innerError) {
        // Most commonly auth/user-not-found -- log it for you, never
        // reveal it to the caller.
        logger.info(
          "Password reset requested for an email that doesn't map to a real account (or send failed):",
          innerError.message
        );
      }

      res.send(genericResponse);

    } catch (error) {
      logger.error(error);

      res.status(500).send({
        error: error.message,
      });
    }
  }
);

// =================================
// EMAIL COPY OF EVERY IN-APP NOTIFICATION
// =================================
// Every notification -- new order, shipped, delivered, new message, low
// stock, a review -- is written the same way, to the same "notifications"
// collection, for both buyers and sellers. Rather than adding an email send
// at each of those call sites (and forgetting the next one someone adds),
// this fires once for every notification document as it's created and
// mails a copy to whoever it's for, with a link straight back to the page
// the in-app notification itself would have opened.
exports.sendNotificationEmail = onDocumentCreated(
  {
    document: "notifications/{notificationId}",
    secrets: ["RESEND_API_KEY", "APP_URL"],
  },
  async (event) => {
    try {
      const notification = event.data && event.data.data();

      if (!notification || !notification.userId) {
        return;
      }

      const userSnap = await db.collection("users").doc(notification.userId).get();

      if (!userSnap.exists) {
        return;
      }

      const userData = userSnap.data();

      if (!userData.email) {
        return;
      }

      const resend = new Resend(process.env.RESEND_API_KEY);

      // APP_URL is set to the login page (the right continue-URL for the
      // verify/reset emails above), not the bare origin -- take just the
      // protocol+host out of it rather than gluing this link onto the end
      // of "/login.html", which produced "/login.html/seller-orders.html".
      let origin = "";
      try {
        origin = new URL(process.env.APP_URL).origin;
      } catch (_) {
        logger.error("APP_URL is not a valid URL:", process.env.APP_URL);
      }

      const targetUrl = notification.link
        ? `${origin}/${notification.link}`
        : origin;

      const emailResult = await resend.emails.send({
        from: "Lesovia <no-reply@lesovia.com>",
        to: userData.email,
        subject: notification.title || "New notification from Lesovia",
        html: brandedEmailShell(`
      <h1 style="font-family:Georgia,'Times New Roman',serif;color:#14231B;margin-top:0;">${notification.title || "New notification"}</h1>

      <p>Hello ${userData.fullName || ""},</p>

      <p>${notification.message || ""}</p>

      <p style="margin:40px 0;text-align:center;">

      <a
      href="${targetUrl}"
      style="
        background:#0B7A3D;
        color:#ffffff;
        padding:15px 30px;
        text-decoration:none;
        border-radius:6px;
        font-weight:bold;
        display:inline-block;
      ">
        View in Lesovia
      </a>

      </p>

      <p style="color:#5B6B62;font-size:13px;">
      If you weren't expecting this, you can safely ignore this email.
      </p>
        `),
      });

      logger.info("Notification email sent:", emailResult);

    } catch (error) {
      // A failed email should never be treated as a failed notification --
      // the in-app notification already exists and this is best-effort on
      // top of it, so log and move on rather than throwing.
      logger.error("Failed to send notification email:", error);
    }
  }
);