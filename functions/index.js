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
exports.aiSearchProducts = onRequest(
  {
    secrets: ["OPENAI_API_KEY"],
    cors: true,
  },

  async (req, res) => {

    try {

      const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });

     const { search } = req.body;

    if (!search) {
      return res.status(400).send({
        error: "Search text is required."
      });
    }

    logger.info("AI Search:", search);

    const response = await client.responses.create({
      model: "gpt-5.5",
      input: `
    You are an AI shopping assistant for Lesovia.

    A customer entered the following search:

    "${search}"

    Extract the customer's shopping intent.

    Return ONLY valid JSON.

    Use this format:

    {
      "name": "",
      "category": "",
      "brand": "",
      "colors": [],
      "condition": "",
      "minPrice": null,
      "maxPrice": null,
      "keywords": []
    }

    Do not include explanations.
    Do not include markdown.
    Do not include anything except JSON.
    `
    });

    logger.info(response.output_text);

    //res.send({
     // filters: response.output_text
   //});

    const filters = JSON.parse(response.output_text);
//temporary replacing//
   // let query = db.collection("products");
    //const snapshot = await db.collection("products").get();
    const snapshot = await db.collection("products")
      .where("category", "==", "fashion")
      .get();
        logger.info("Number of products:", snapshot.size);

    const products = [];

    snapshot.forEach((doc) => {
      products.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    logger.info(products);

    res.send({
      products
    })

    // Filter by category
    /*if (filters.category) {
      query = query.where("category", "==", filters.category.toLowerCase());
    }

    // Filter by maximum price
    if (filters.maxPrice !== null) {
      query = query.where("price", "<=", filters.maxPrice);
    }

    const snapshot = await query.get();

    const products = [];

    snapshot.forEach((doc) => {
      products.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    res.send({
      filters,
      products,
    });*/

    } catch (error) {

      logger.error(error);

      res.status(500).send({
        error: error.message
      });

    }

  }
);

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

        const resend = new Resend(process.env.RESEND_API_KEY);

        const { email, uid, fullName } = req.body;

       /* if (!email || !uid) {
          return res.status(400).send({
            error: "Missing email or uid."
          });
        }*/
      if (!email) {
        return res.status(400).send({
          error: "Email is required."
        });
      }

      const verificationLink =
        await admin.auth().generateEmailVerificationLink(email, {
          url: process.env.APP_URL,
          handleCodeInApp: false,
        });

        const emailResult = await resend.emails.send({

          from: "Lesovia <no-reply@lesovia.com>",

          to: email,

          subject: "Verify your Lesovia account",

          html: `

      <div style="font-family:Arial;padding:30px;max-width:600px;margin:auto;">

      <h1>Welcome to Lesovia!</h1>

      <p>Hello ${fullName || ""},</p>

      <p>
        Thank you for creating your Lesovia account.
      </p>

      <p>
        Please verify your email address before logging in.
      </p>

      <p style="margin:40px 0;">

      <a
      href="${verificationLink}"
      style="
        background:#1a73e8;
        color:white;
        padding:15px 30px;
        text-decoration:none;
        border-radius:6px;
        font-weight:bold;
      ">
        Verify My Email
      </a>

      </p>

      <p>
        If the button doesn't work, copy this link:
      </p>

      <p>

      ${verificationLink}

      </p>

      <hr>

      <p style="color:#777;">
      © 2026 Lesovia
      </p>

      </div>

          `,

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
      const resend = new Resend(process.env.RESEND_API_KEY);

      const { email } = req.body;

      if (!email) {
        return res.status(400).send({
          error: "Email is required.",
        });
      }

      const resetLink = await admin.auth().generatePasswordResetLink(email, {
        url: process.env.APP_URL,
      });

      const emailResult = await resend.emails.send({
        from: "Lesovia <no-reply@lesovia.com>",
        to: email,
        subject: "Reset your Lesovia password",

        html: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:30px;">

<h1 style="color:#0b7a3d;">Reset Your Password</h1>

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
background:#0b7a3d;
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

<hr>

<p style="color:#777;">
© 2026 Lesovia
</p>

</div>
`,
      });

      logger.info("Password reset email:", emailResult);

      res.send({
        success: true,
        message: "Password reset email sent.",
      });
    } catch (error) {
      logger.error(error);

      res.status(500).send({
        error: error.message,
      });
    }
  }
);