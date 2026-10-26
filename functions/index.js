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
const {
  CheckoutError,
  resolveChargeType,
  resolveShipping,
  computeSellerBreakdown,
} = require("./paymentMath");
const {
  aggregateQuantities,
  findInsufficientStock,
  describePurchase,
  buildSellerOrder,
  buildCheckoutOrder,
} = require("./orderDocs");
const {
  computeOnboardingStatus,
  planRefundUpdate,
  disputePatch,
  describeDispute,
  transferReversalPatch,
  TRANSFER_SETTLED,
} = require("./webhookPatches");

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

// =================================
// TAX LIABILITY CONFIGURATION (Stage 7 lands the real Stripe Tax call)
// =================================
// Whether Lesovia or the seller is the legally liable party for sales tax
// has NOT been decided -- that's a question for a licensed U.S. sales-tax
// professional, not an assumption this code gets to make. Until an
// operator explicitly sets config/platformSettings.taxLiability (never a
// client -- see firestore.rules), every checkout collects exactly $0 tax.
// Thrown when checkout is attempted in live mode before that
// configuration has been made -- a real customer must never be charged
// $0 tax just because the legal question hasn't been resolved yet.
class TaxLiabilityUnresolvedError extends Error {
  constructor() {
    super("Tax liability is not yet configured; checkout is blocked in live mode until it is.");
  }
}

const VALID_TAX_LIABILITIES = ["platform", "connectedAccount"];

// True only when STRIPE_SECRET_KEY is a live key. This is the one signal
// that actually determines whether real money can move -- never trust a
// client-supplied or environment-flag notion of "production" for a
// decision this consequential.
function isLiveMode() {
  return Boolean(process.env.STRIPE_SECRET_KEY) && process.env.STRIPE_SECRET_KEY.startsWith("sk_live_");
}

// Reads the platform's tax-liability configuration via the Admin SDK (see
// the Admin-only config/{configId} rule). A missing document, a missing
// field, or any value other than the two valid ones is always treated as
// "not_yet_determined" -- the safe default is to block/zero, never to
// assume a liable party.
async function getTaxLiability() {
  const snap = await db.collection("config").doc("platformSettings").get();
  const value = snap.exists ? snap.data().taxLiability : null;
  return VALID_TAX_LIABILITIES.includes(value) ? value : "not_yet_determined";
}

// The one safety gate: in live mode, an unresolved tax liability fails
// checkout closed instead of silently charging a real customer $0 tax. In
// test mode, $0 tax is allowed so the payment architecture can be built
// and verified before the legal question is settled. Both isLiveMode()
// and getTaxLiability() are server-derived only, so no client-supplied
// value can influence this check.
function assertTaxLiabilityAllowsCheckout(taxLiability) {
  if (isLiveMode() && taxLiability === "not_yet_determined") {
    throw new TaxLiabilityUnresolvedError();
  }
}

// Stage 7 will replace this body with a real stripe.tax.calculations.create
// call, using a Stripe-Account context chosen by `taxLiability`. Kept as
// its own function now, and always returning zero, so tax is tracked as
// an isolated line item (never folded into product subtotal, commission,
// or shipping) from the very first checkout this system processes.
async function calculateTax({ taxLiability }) {
  if (taxLiability !== "platform" && taxLiability !== "connectedAccount") {
    return { taxCents: 0, taxCalculationId: null };
  }

  // Not implemented until Stage 7 -- taxLiability can't legally be set to
  // "platform"/"connectedAccount" yet, so this branch is unreachable today.
  return { taxCents: 0, taxCalculationId: null };
}

// What the buyer is allowed to see of the per-seller breakdown: what they're
// paying for, never Lesovia's commission or the seller's proceeds.
function toBuyerBreakdown(sellers) {
  return (sellers || []).map((seller) => ({
    sellerId: seller.sellerId,
    storeName: seller.storeName,
    productSubtotalCents: seller.productSubtotalCents,
    shippingCents: seller.shippingCents,
    shippingMethod: seller.shippingMethod,
    taxCents: seller.taxCents,
    buyerTotalCents: seller.buyerTotalCents,
  }));
}

// Trims and length-caps a delivery address the client sent along with
// verifyPayment. This is shape validation, not fraud prevention -- a buyer
// lying about their own shipping address only hurts themselves -- so an
// incomplete address is stored as-is (missing fields just come through
// empty) rather than failing the request. Failing here would leave an
// already-paid order stuck with no way to complete it, which is worse than
// an order the seller has to follow up on for a missing address.
function sanitizeDeliveryAddress(raw) {
  if (!raw || typeof raw !== "object") return null;

  const field = (value, maxLen) =>
    typeof value === "string" ? value.trim().slice(0, maxLen) : "";

  const address = {
    fullName: field(raw.fullName, 100),
    line1: field(raw.line1, 200),
    line2: field(raw.line2, 200),
    city: field(raw.city, 100),
    state: field(raw.state, 100),
    zip: field(raw.zip, 20),
    country: field(raw.country, 100),
    phone: field(raw.phone, 30),
  };

  // Every field came through empty -- treat it the same as "no address
  // sent" rather than storing an all-blank object.
  const hasAnyContent = Object.values(address).some((v) => v.length > 0);

  return hasAnyContent ? address : null;
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
// Computes everything the buyer will be charged from Firestore data -- never
// from the client -- and creates the matching Stripe PaymentIntent:
//   * ONE seller in the cart   -> Direct Charge on that seller's
//     connected account, with Lesovia's 7% as the application fee.
//   * TWO+ sellers in the cart -> a single charge on Lesovia's own platform
//     account (Separate Charges and Transfers); verifyPayment later sends each
//     seller their share, after Lesovia's 10% commission.
// The charge type is derived here from the sellers on the products themselves.
// Nothing about it, the commission, the shipping price, or the tax is ever
// read from the request body.
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

      const { checkoutId, items, cartItemIds, shippingSelections } = req.body || {};

      if (!checkoutId || typeof checkoutId !== "string") {
        return res.status(400).send({ error: "Missing checkoutId." });
      }

      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).send({ error: "Cart is empty." });
      }

      const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
      const pendingOrderRef = db.collection("pendingOrders").doc(checkoutId);

      // Retry of an in-flight checkout with the same checkoutId -- return the
      // existing PaymentIntent instead of creating a second one. A Direct
      // Charge PaymentIntent lives on the seller's account, so it has to be
      // looked up there.
      const existingSnap = await pendingOrderRef.get();

      if (existingSnap.exists && existingSnap.data().status === "pending_payment") {
        const existing = existingSnap.data();

        const existingIntent = await stripe.paymentIntents.retrieve(
          existing.stripePaymentIntentId,
          {},
          existing.stripeAccountId ? { stripeAccount: existing.stripeAccountId } : undefined
        );

        return res.send({
          orderId: checkoutId,
          clientSecret: existingIntent.client_secret,
          amount: existing.amount,
          stripeAccountId: existing.stripeAccountId || null,
          sellers: toBuyerBreakdown(existing.sellers),
        });
      }

      // In live mode, an unresolved tax-liability setting must stop checkout
      // here rather than charge a real customer $0 tax.
      const taxLiability = await getTaxLiability();
      assertTaxLiabilityAllowsCheckout(taxLiability);

      const shippingChoiceBySeller = new Map();

      if (Array.isArray(shippingSelections)) {
        for (const selection of shippingSelections) {
          if (selection && typeof selection.sellerId === "string" && typeof selection.method === "string") {
            shippingChoiceBySeller.set(selection.sellerId, selection.method);
          }
        }
      }

      const lineItems = [];

      for (const rawItem of items) {
        const productId = rawItem && rawItem.productId;
        const quantity = Number(rawItem && rawItem.quantity);

        if (!productId || !Number.isInteger(quantity) || quantity < 1) {
          throw new CheckoutError("Invalid item in cart.");
        }

        const productSnap = await db.collection("products").doc(productId).get();

        if (!productSnap.exists) {
          throw new CheckoutError(`Product ${productId} no longer exists.`);
        }

        const product = productSnap.data();

        // Over the seller's plan limit: hidden from buyers, so not for sale either.
        if (product.hiddenByPlan === true) {
          throw new CheckoutError(`"${product.name}" is no longer available.`);
        }

        const availableQuantity = product.quantity ?? 0;

        if (availableQuantity < quantity) {
          throw new CheckoutError(
            `Not enough stock for "${product.name}". Only ${availableQuantity} left.`
          );
        }

        const unitPriceCents = Math.round(Number(product.price) * 100);

        if (!Number.isFinite(unitPriceCents) || unitPriceCents <= 0) {
          throw new CheckoutError(`Invalid price for "${product.name}".`);
        }

        if (!product.sellerId || typeof product.sellerId !== "string") {
          throw new CheckoutError(`"${product.name}" has no seller.`);
        }

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

      const sellerIds = [...new Set(lineItems.map((item) => item.sellerId))];
      const { chargeType, commissionRate } = resolveChargeType(sellerIds.length);

      const sellers = [];

      for (const sellerId of sellerIds) {
        const sellerSnap = await db.collection("users").doc(sellerId).get();
        const seller = sellerSnap.exists ? sellerSnap.data() : null;

        if (!seller || seller.role !== "seller") {
          throw new CheckoutError("A seller in your cart is no longer available.");
        }

        const storeName = seller.storeName || "A seller";

        // The seller must be able to actually receive money before a buyer
        // is allowed to pay for their products.
        if (!seller.stripeAccountId || seller.stripeChargesEnabled !== true) {
          throw new CheckoutError(`${storeName} isn't set up to receive payments yet.`);
        }

        const productSubtotalCents = lineItems
          .filter((item) => item.sellerId === sellerId)
          .reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);

        const shipping = resolveShipping(seller.shipping, shippingChoiceBySeller.get(sellerId));
        const tax = await calculateTax({ taxLiability });

        sellers.push({
          sellerId,
          stripeAccountId: seller.stripeAccountId,
          storeName,
          ...shipping,
          taxCalculationId: tax.taxCalculationId,
          ...computeSellerBreakdown({
            productSubtotalCents,
            shippingCents: shipping.shippingCents,
            taxCents: tax.taxCents,
            commissionRate,
          }),
        });
      }

      const amount = sellers.reduce((sum, seller) => sum + seller.buyerTotalCents, 0);

      if (amount <= 0) {
        throw new CheckoutError("Order total must be greater than zero.");
      }

      const metadata = { orderId: checkoutId, buyerId, chargeType };

      let paymentIntent;
      let stripeAccountId = null;

      if (chargeType === "direct") {
        const [seller] = sellers;
        stripeAccountId = seller.stripeAccountId;

        paymentIntent = await stripe.paymentIntents.create(
          {
            amount,
            currency: "usd",
            metadata,
            ...(seller.commissionAmountCents > 0
              ? { application_fee_amount: seller.commissionAmountCents }
              : {}),
          },
          {
            stripeAccount: stripeAccountId,
            idempotencyKey: `pi_create_${checkoutId}`,
          }
        );
      } else {
        paymentIntent = await stripe.paymentIntents.create(
          {
            amount,
            currency: "usd",
            metadata,
            transfer_group: checkoutId,
          },
          {
            idempotencyKey: `pi_create_${checkoutId}`,
          }
        );
      }

      await pendingOrderRef.set({
        buyerId,
        items: lineItems,
        sellers,
        amount,
        currency: "usd",
        chargeType,
        commissionRate,
        stripeAccountId,
        taxLiabilityAtPurchase: taxLiability,
        cartItemIds: Array.isArray(cartItemIds) ? cartItemIds : [],
        stripePaymentIntentId: paymentIntent.id,
        status: "pending_payment",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.send({
        orderId: checkoutId,
        clientSecret: paymentIntent.client_secret,
        amount,
        stripeAccountId,
        sellers: toBuyerBreakdown(sellers),
      });

    } catch (error) {

      if (error instanceof CheckoutError) {
        return res.status(error.status).send({ error: error.message });
      }

      // The real reason is for the logs only -- a buyer just needs to know
      // checkout isn't available right now.
      if (error instanceof TaxLiabilityUnresolvedError) {
        logger.error(error.message);
        return res.status(503).send({ error: "Checkout is temporarily unavailable. Please try again later." });
      }

      logger.error(error);

      res.status(500).send({ error: error.message });

    }

  }
);

// =================================
// PAY EACH SELLER (multi-seller checkouts)
// =================================
// A multi-seller checkout is one charge on Lesovia's own account, so each
// seller's share (product subtotal - Lesovia's 10% + their shipping, never tax)
// has to be sent on to them as a Transfer. Direct Charges never come through
// here -- Stripe already split those when the buyer paid.
//
// Safe to run more than once for the same order: a seller who's already been
// paid is skipped, and a failed transfer is retried on the next call. It never
// throws -- by now the buyer has paid and the order exists, so a seller who
// can't be paid yet (e.g. their account was restricted in the meantime) is
// recorded as "failed" for follow-up rather than failing the buyer's request.
async function settleSellerTransfers(stripe, orderId, pendingOrder) {
  if (pendingOrder.chargeType !== "separate") return;

  for (const sellerOrderId of pendingOrder.sellerOrderIds || []) {
    const ref = db.collection("sellerOrders").doc(sellerOrderId);
    const snap = await ref.get();
    const sellerOrder = snap.exists ? snap.data() : null;

    if (!sellerOrder || TRANSFER_SETTLED.includes(sellerOrder.transferStatus)) continue;

    const attempt = (sellerOrder.transferAttempts || 0) + 1;

    try {
      // An earlier attempt may have reached Stripe and then died before it was
      // recorded here -- adopt that transfer rather than paying the seller twice.
      const sent = await stripe.transfers.list({
        transfer_group: orderId,
        destination: sellerOrder.stripeAccountId,
        limit: 20,
      });

      let transfer = sent.data.find(
        (t) => t.metadata && t.metadata.sellerOrderId === sellerOrderId
      );

      if (!transfer) {
        transfer = await stripe.transfers.create(
          {
            amount: sellerOrder.sellerProceedsCents,
            currency: "usd",
            destination: sellerOrder.stripeAccountId,
            transfer_group: orderId,
            // Ties the transfer to this specific charge so the money can move
            // before the charge itself has settled into the available balance.
            source_transaction: sellerOrder.stripeChargeId,
            metadata: { checkoutId: orderId, sellerId: sellerOrder.sellerId, sellerOrderId },
          },
          { idempotencyKey: `transfer_${sellerOrderId}_${attempt}` }
        );
      }

      await ref.update({
        stripeTransferId: transfer.id,
        transferStatus: "transferred",
        transferAttempts: attempt,
        transferError: null,
        transferredAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    } catch (error) {
      logger.error(`Transfer for ${sellerOrderId} failed:`, error);

      await ref
        .update({
          transferStatus: "failed",
          transferAttempts: attempt,
          transferError: String(error.message).slice(0, 300),
        })
        .catch((updateError) => logger.error("Could not record transfer failure:", updateError));
    }
  }
}

// =================================
// FINALIZE A PAID CHECKOUT (shared by verifyPayment and the Stripe webhooks)
// =================================
// The ONLY place an order is ever marked "paid". Re-checks the payment with
// Stripe directly (never trusts the client's local confirmCardPayment result,
// and never trusts a webhook payload either -- the PaymentIntent is always
// re-fetched), then atomically creates the parent order and one sub-order per
// seller, decrements inventory, and notifies buyer + sellers. For a
// multi-seller checkout it then sends each seller their Transfer.
//
// Called from two places that race each other on purpose: the buyer's browser
// (verifyPayment, moments after paying) and Stripe itself (the
// payment_intent.succeeded webhook), so an order is created even if the buyer
// closes the tab first. Idempotent -- whichever arrives second sees the
// checkout already completed and only makes sure every seller was paid.
//
// Returns the JSON body verifyPayment sends back to the buyer.
async function finalizePendingOrder(stripe, orderId, pendingOrder, deliveryAddress) {
  const pendingOrderRef = db.collection("pendingOrders").doc(orderId);

  // The buyer's own request carries the address; a webhook has only the one
  // saved before they paid (see saveCheckoutAddress).
  const address = deliveryAddress || pendingOrder.deliveryAddress || null;

  // Already finalized -- don't reprocess it, but do make sure every seller
  // of a multi-seller order has actually been paid.
  if (pendingOrder.status === "completed") {
    // If a webhook created the order before the buyer's request (with its
    // address) arrived, the address is filled in now.
    if (deliveryAddress) {
      await backfillDeliveryAddress(orderId, pendingOrder, deliveryAddress);
    }

    await settleSellerTransfers(stripe, orderId, pendingOrder);

    return {
      success: true,
      orderIds: pendingOrder.orderIds || [],
      sellerOrderIds: pendingOrder.sellerOrderIds || [],
    };
  }

  if (pendingOrder.status === "failed") {
    return { success: false, status: pendingOrder.failureReason || "failed" };
  }

  // A checkout that was started before the Connect checkout existed has no
  // seller breakdown to fulfill from. Never leave its buyer charged for
  // an order that can't be created.
  if (!pendingOrder.chargeType || !Array.isArray(pendingOrder.sellers)) {
    const legacyIntent = await stripe.paymentIntents.retrieve(pendingOrder.stripePaymentIntentId);

    if (legacyIntent.status === "succeeded") {
      await stripe.refunds.create(
        { payment_intent: legacyIntent.id },
        { idempotencyKey: `refund_${orderId}` }
      );
    }

    await pendingOrderRef.update({
      status: "failed",
      failureReason: "checkout_restarted_after_update",
    });

    return { success: false, status: "checkout_restarted_after_update" };
  }

  // A Direct Charge lives on the seller's connected account, so that's
  // where it has to be looked up (and refunded, if it comes to that).
  const stripeOptions = pendingOrder.stripeAccountId
    ? { stripeAccount: pendingOrder.stripeAccountId }
    : undefined;

  const paymentIntent = await stripe.paymentIntents.retrieve(
    pendingOrder.stripePaymentIntentId,
    {},
    stripeOptions
  );

  if (
    paymentIntent.status !== "succeeded" ||
    paymentIntent.amount !== pendingOrder.amount
  ) {
    await pendingOrderRef.update({
      status: "failed",
      failureReason: paymentIntent.status,
    });

    return { success: false, status: paymentIntent.status };
  }

  let result;

  try {

    result = await db.runTransaction(async (tx) => {

      // Re-read inside the transaction in case a concurrent call for the same
      // order (the browser and the webhook) is racing this one.
      const freshSnap = await tx.get(pendingOrderRef);
      const freshPending = freshSnap.data();

      if (freshPending.status === "completed") {
        return {
          orderIds: freshPending.orderIds || [],
          sellerOrderIds: freshPending.sellerOrderIds || [],
        };
      }

      const needed = aggregateQuantities(freshPending.items);
      const productIds = [...needed.keys()];
      const productRefs = productIds.map((id) => db.collection("products").doc(id));

      // Firestore transactions require every read before any write, so the
      // order-number counter is read here alongside the product stock,
      // even though it's only written at the end.
      const counterRef = db.collection("counters").doc("orders");

      const [productSnaps, counterSnap] = await Promise.all([
        Promise.all(productRefs.map((ref) => tx.get(ref))),
        tx.get(counterRef),
      ]);

      const productsById = new Map();
      const stockById = new Map();

      productSnaps.forEach((snap, index) => {
        const data = snap.exists ? snap.data() : {};
        productsById.set(productIds[index], data);
        stockById.set(productIds[index], snap.exists ? (data.quantity ?? 0) : 0);
      });

      // Re-validate stock is still available right before committing the
      // sale -- it may have changed since the PaymentIntent was created.
      const shortProductId = findInsufficientStock(needed, stockById);

      if (shortProductId) {
        throw new InsufficientStockError(shortProductId);
      }

      const nextOrderNumber = (counterSnap.exists ? (counterSnap.data().count || 0) : 0) + 1;
      const orderNumber = `LSV-${String(nextOrderNumber).padStart(6, "0")}`;
      const createdAt = admin.firestore.FieldValue.serverTimestamp();

      const sellerOrderIds = [];

      freshPending.sellers.forEach((seller, index) => {
        const sellerOrderId = `${orderId}_${seller.sellerId}`;
        sellerOrderIds.push(sellerOrderId);

        const sellerOrder = buildSellerOrder({
          checkoutId: orderId,
          buyerId: freshPending.buyerId,
          seller,
          items: freshPending.items,
          productsById,
          orderNumber: `${orderNumber}-${index + 1}`,
          deliveryAddress: address,
          paymentIntent,
          chargeType: freshPending.chargeType,
          taxLiabilityAtPurchase: freshPending.taxLiabilityAtPurchase || "not_yet_determined",
          createdAt,
        });

        tx.set(db.collection("sellerOrders").doc(sellerOrderId), sellerOrder);

        tx.set(db.collection("notifications").doc(), {
          userId: seller.sellerId,
          type: "new_order",
          title: "New Order Received",
          message: `${describePurchase(sellerOrder.products)} was purchased.`,
          link: `seller-orders.html?orderId=${sellerOrderId}`,
          read: false,
          createdAt,
        });
      });

      tx.set(
        db.collection("checkoutOrders").doc(orderId),
        buildCheckoutOrder({
          checkoutId: orderId,
          pending: freshPending,
          orderNumber,
          deliveryAddress: address,
          sellerOrderIds,
          paymentIntent,
          createdAt,
        })
      );

      tx.set(db.collection("notifications").doc(), {
        userId: freshPending.buyerId,
        type: "order_placed",
        title: "Order Confirmed",
        message: "Your order has been placed successfully.",
        link: `order.html?orderId=${orderId}`,
        read: false,
        createdAt,
      });

      productIds.forEach((productId, index) => {
        const product = productsById.get(productId);
        const newQuantity = stockById.get(productId) - needed.get(productId);

        tx.update(productRefs[index], { quantity: newQuantity });

        if (newQuantity <= 5 && newQuantity > 0) {
          tx.set(db.collection("notifications").doc(), {
            userId: product.sellerId,
            type: "low_stock",
            title: "Low Inventory",
            message: `Only ${newQuantity} ${product.name} left in stock.`,
            link: `seller dashboard.html?highlightProduct=${productId}`,
            read: false,
            createdAt,
          });
        }
      });

      (freshPending.cartItemIds || []).forEach((cartItemId) => {
        tx.delete(db.collection("carts").doc(cartItemId));
      });

      tx.set(counterRef, { count: nextOrderNumber }, { merge: true });

      tx.update(pendingOrderRef, {
        status: "completed",
        orderIds: [orderId],
        sellerOrderIds,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return { orderIds: [orderId], sellerOrderIds };
    });

  } catch (err) {

    if (err instanceof InsufficientStockError) {

      // Payment succeeded but stock ran out before we could fulfill it --
      // refund instead of overselling. A Direct Charge also gives back
      // Lesovia's application fee.
      await stripe.refunds.create(
        {
          payment_intent: pendingOrder.stripePaymentIntentId,
          ...(pendingOrder.chargeType === "direct" ? { refund_application_fee: true } : {}),
        },
        { ...stripeOptions, idempotencyKey: `refund_${orderId}` }
      );

      await pendingOrderRef.update({
        status: "failed",
        failureReason: "insufficient_stock_refunded",
      });

      return { success: false, status: "insufficient_stock_refunded" };
    }

    throw err;
  }

  await settleSellerTransfers(stripe, orderId, {
    chargeType: pendingOrder.chargeType,
    sellerOrderIds: result.sellerOrderIds,
  });

  return { success: true, orderIds: result.orderIds, sellerOrderIds: result.sellerOrderIds };
}

// The address is normally saved before the buyer pays. If the order was
// created without one (a webhook got there first and none had been saved),
// the buyer's own verifyPayment call supplies it -- never overwriting an
// address that's already on the order.
async function backfillDeliveryAddress(orderId, pendingOrder, deliveryAddress) {
  const checkoutRef = db.collection("checkoutOrders").doc(orderId);
  const checkoutSnap = await checkoutRef.get();

  if (!checkoutSnap.exists || checkoutSnap.data().deliveryAddress) return;

  await checkoutRef.update({ deliveryAddress });

  for (const sellerOrderId of pendingOrder.sellerOrderIds || []) {
    const ref = db.collection("sellerOrders").doc(sellerOrderId);
    const snap = await ref.get();

    if (snap.exists && !snap.data().deliveryAddress) {
      await ref.update({ deliveryAddress });
    }
  }
}

// =================================
// SAVE THE DELIVERY ADDRESS BEFORE PAYING
// =================================
// The buyer types their address in the checkout modal, after the
// PaymentIntent already exists. Saving it on the pending checkout before the
// card is charged means an order created by the webhook (buyer closed the
// tab) still knows where to ship. Required fields are enforced here, before
// any money moves -- same rule the checkout form applies.
exports.saveCheckoutAddress = onRequest(
  {
    cors: true
  },

  async (req, res) => {

    try {

      const buyerId = await getUidFromRequest(req);

      if (!buyerId) {
        return res.status(401).send({ error: "Authentication required." });
      }

      const { orderId, deliveryAddress: rawDeliveryAddress } = req.body || {};

      if (!orderId || typeof orderId !== "string") {
        return res.status(400).send({ error: "Missing orderId." });
      }

      const address = sanitizeDeliveryAddress(rawDeliveryAddress);

      if (!address || !address.fullName || !address.line1 || !address.city ||
          !address.state || !address.zip || !address.country) {
        return res.status(400).send({ error: "Please fill in your full name, address, city, state, ZIP, and country." });
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

      if (pendingOrder.status !== "pending_payment") {
        return res.status(409).send({ error: "This checkout is no longer open." });
      }

      await pendingOrderRef.update({ deliveryAddress: address });

      res.send({ saved: true });

    } catch (error) {

      logger.error(error);

      res.status(500).send({ error: error.message });

    }

  }
);

// =================================
// VERIFY PAYMENT (called by the buyer's browser right after paying)
// =================================
// Authenticates the buyer, then hands off to finalizePendingOrder. The
// Stripe webhooks call the same function, so it doesn't matter which one
// gets there first.
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

      const { orderId, deliveryAddress: rawDeliveryAddress } = req.body || {};

      if (!orderId || typeof orderId !== "string") {
        return res.status(400).send({ error: "Missing orderId." });
      }

      const deliveryAddress = sanitizeDeliveryAddress(rawDeliveryAddress);

      const pendingOrderRef = db.collection("pendingOrders").doc(orderId);
      const pendingSnap = await pendingOrderRef.get();

      if (!pendingSnap.exists) {
        return res.status(404).send({ error: "Order not found." });
      }

      const pendingOrder = pendingSnap.data();

      if (pendingOrder.buyerId !== buyerId) {
        return res.status(403).send({ error: "This order does not belong to you." });
      }

      const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

      const outcome = await finalizePendingOrder(stripe, orderId, pendingOrder, deliveryAddress);

      res.send(outcome);

    } catch (error) {

      logger.error(error);

      res.status(500).send({ error: error.message });

    }

  }
);

// =================================
// STRIPE CONNECT: SELLER ONBOARDING
// =================================
// Creates (once) a Stripe connected account for the calling seller and
// returns a Stripe-hosted onboarding link. The account is always created
// for, and the link always scoped to, the authenticated caller's own uid
// -- never a sellerId supplied by the client. Safe to call again for a
// seller who already has an account (e.g. to resume/continue onboarding);
// it reuses their existing stripeAccountId instead of creating a second one.
exports.createConnectOnboardingLink = onRequest(
  {
    secrets: ["STRIPE_SECRET_KEY", "APP_URL"],
    cors: true,
  },

  async (req, res) => {

    try {

      const decoded = await getDecodedTokenFromRequest(req);

      if (!decoded) {
        return res.status(401).send({ error: "Authentication required." });
      }

      const userRef = db.collection("users").doc(decoded.uid);
      const userSnap = await userRef.get();

      if (!userSnap.exists) {
        return res.status(404).send({ error: "User profile not found." });
      }

      const userData = userSnap.data();

      if (userData.role !== "seller") {
        return res.status(403).send({ error: "Only sellers can connect a payout account." });
      }

      const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

      let stripeAccountId = userData.stripeAccountId;

      if (!stripeAccountId) {
        // Created with controller settings rather than type: "express" --
        // Stripe no longer allows Direct Charges on legacy Express accounts
        // for new platforms, and rejects the Express dashboard unless the
        // platform itself collects fees and carries losses. Stripe billing
        // the seller for its own processing fees (fees.payer: "account") is
        // only available with the full Stripe Dashboard, so that is what
        // sellers get. Stripe still hosts the onboarding. These settings
        // can't be changed later, only replaced with a new account.
        const account = await stripe.accounts.create({
          controller: {
            stripe_dashboard: { type: "full" },
            fees: { payer: "account" },
            losses: { payments: "stripe" },
            requirement_collection: "stripe",
          },
          email: decoded.email,
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
        });

        stripeAccountId = account.id;

        await userRef.set(
          {
            stripeAccountId,
            stripeChargesEnabled: false,
            stripePayoutsEnabled: false,
            stripeDetailsSubmitted: false,
            stripeOnboardingStatus: "pending",
          },
          { merge: true }
        );
      }

      const origin = new URL(process.env.APP_URL).origin;

      const accountLink = await stripe.accountLinks.create({
        account: stripeAccountId,
        refresh_url: `${origin}/seller-profile.html?stripeOnboarding=refresh`,
        return_url: `${origin}/seller-profile.html?stripeOnboarding=return`,
        type: "account_onboarding",
      });

      res.send({ url: accountLink.url });

    } catch (error) {

      logger.error(error);

      res.status(500).send({ error: error.message });

    }

  }
);

// =================================
// STRIPE WEBHOOKS
// =================================
// Stripe calls these directly, independent of any buyer's browser. There are
// TWO endpoints because Stripe delivers two genuinely separate event streams
// (docs.stripe.com/connect/webhooks), each with its own signing secret:
//
//   stripeWebhookConnect  -- "Connected accounts" scope. Events that happen ON a
//     seller's account: their onboarding status (account.updated), and every
//     single-seller Direct Charge (payment, refund, dispute) plus their payouts.
//     Each carries a top-level `account` naming the seller's account.
//   stripeWebhookPlatform -- "Your account" scope. Events on Lesovia's own
//     account: multi-seller charges, and the Transfers to sellers.
//
// Both run the same handlers below. Nothing is trusted from an event's
// payload beyond identifying what it's about -- money state is re-fetched
// from Stripe (finalizePendingOrder) or is an absolute value that's safe to
// replay. The redirect a seller's browser follows back from onboarding, and
// the buyer's browser after paying, are never the only proof of anything.
async function notifyUser(userId, { type, title, message, link }) {
  await db.collection("notifications").doc().set({
    userId,
    type,
    title,
    message,
    link,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function sellerOrdersForCharge(chargeId) {
  if (!chargeId) return [];

  const snap = await db.collection("sellerOrders").where("stripeChargeId", "==", chargeId).get();

  return snap.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
}

const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;

async function handleAccountUpdated(event) {
  const account = event.data.object;

  const usersSnap = await db
    .collection("users")
    .where("stripeAccountId", "==", account.id)
    .limit(1)
    .get();

  if (usersSnap.empty) {
    logger.error(`account.updated for unknown connected account: ${account.id}`);
    return;
  }

  await usersSnap.docs[0].ref.set(
    {
      stripeChargesEnabled: Boolean(account.charges_enabled),
      stripePayoutsEnabled: Boolean(account.payouts_enabled),
      stripeDetailsSubmitted: Boolean(account.details_submitted),
      stripeOnboardingStatus: computeOnboardingStatus(account),
    },
    { merge: true }
  );
}

// The payment went through at Stripe. If the buyer's browser already told us,
// this just re-checks the sellers were paid; if not (they closed the tab), this
// is what creates the order.
async function handlePaymentSucceeded(stripe, event) {
  const paymentIntent = event.data.object;
  const orderId = paymentIntent.metadata && paymentIntent.metadata.orderId;

  if (!orderId) return; // not a Lesovia checkout

  const pendingSnap = await db.collection("pendingOrders").doc(orderId).get();

  if (!pendingSnap.exists) {
    logger.error(`payment_intent.succeeded for unknown checkout ${orderId} (${paymentIntent.id})`);
    return;
  }

  const pending = pendingSnap.data();

  if (pending.stripePaymentIntentId !== paymentIntent.id) {
    logger.error(`payment_intent.succeeded ${paymentIntent.id} doesn't match checkout ${orderId}`);
    return;
  }

  // A Direct Charge's events arrive through the seller's account, a platform
  // charge's through Lesovia's own -- anything else doesn't belong to this checkout.
  if ((event.account || null) !== (pending.stripeAccountId || null)) {
    logger.error(`payment_intent.succeeded for ${orderId} came from an unexpected account: ${event.account || "platform"}`);
    return;
  }

  const outcome = await finalizePendingOrder(stripe, orderId, pending, null);

  if (!outcome.success) {
    logger.error(`Checkout ${orderId} was paid but could not be completed: ${outcome.status}`);
  }
}

async function handleChargeRefunded(event) {
  const charge = event.data.object;
  const sellerOrders = await sellerOrdersForCharge(charge.id);

  // No sub-orders: a refund we issued ourselves before an order existed (e.g.
  // the last item sold out) -- nothing to update.
  if (sellerOrders.length === 0) return;

  const plan = planRefundUpdate(charge, sellerOrders);
  const checkoutRef = db.collection("checkoutOrders").doc(sellerOrders[0].data.checkoutId);
  const checkoutSnap = await checkoutRef.get();
  const alreadyRefunded = checkoutSnap.exists ? checkoutSnap.data().refundedAmountCents || 0 : 0;

  // Refunds only ever grow, so a late-arriving older event must not shrink
  // what's recorded.
  if (plan.checkout.refundedAmountCents < alreadyRefunded) return;

  if (checkoutSnap.exists) {
    await checkoutRef.update(plan.checkout);
  }

  for (const { id, patch } of plan.sellers) {
    const before = sellerOrders.find((order) => order.id === id).data;

    await db.collection("sellerOrders").doc(id).update(patch);

    if (patch.refundedAmountCents > (before.refundedAmountCents || 0)) {
      await notifyUser(before.sellerId, {
        type: "refund",
        title: "Order Refunded",
        message: `${dollars(patch.refundedAmountCents)} of order ${before.orderNumber} was refunded to the buyer.`,
        link: `seller-orders.html?orderId=${id}`,
      });
    }
  }

  if (plan.checkout.refundedAmountCents > alreadyRefunded) {
    await notifyUser(sellerOrders[0].data.buyerId, {
      type: "refund",
      title: "Refund Issued",
      message: `A refund of ${dollars(plan.checkout.refundedAmountCents - alreadyRefunded)} was issued for your order.`,
      link: `order.html?orderId=${sellerOrders[0].data.checkoutId}`,
    });
  }
}

async function handleDispute(event) {
  const dispute = event.data.object;
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge && dispute.charge.id;
  const sellerOrders = await sellerOrdersForCharge(chargeId);

  if (sellerOrders.length === 0) return;

  const patch = { ...disputePatch(dispute), disputeEventAt: event.created };

  for (const { id, data } of sellerOrders) {
    // Events can arrive out of order; never let an older one overwrite a newer.
    if (data.disputeEventAt && data.disputeEventAt > event.created) continue;

    await db.collection("sellerOrders").doc(id).update(patch);

    if (event.type === "charge.dispute.created") {
      await notifyUser(data.sellerId, {
        type: "dispute",
        title: "Payment Dispute",
        message: `Order ${data.orderNumber}: ${describeDispute(dispute.status)}.`,
        link: `seller-orders.html?orderId=${id}`,
      });
    }
  }
}

// We create the transfers ourselves, so this only matters when one is reversed
// (a refund, or Stripe/us clawing the money back).
async function handleTransferReversed(event) {
  const transfer = event.data.object;
  const sellerOrderId = transfer.metadata && transfer.metadata.sellerOrderId;

  if (!sellerOrderId) return;

  const ref = db.collection("sellerOrders").doc(sellerOrderId);
  const snap = await ref.get();

  if (!snap.exists) return;

  const patch = transferReversalPatch(transfer);
  const before = snap.data();

  if (before.transferStatus === patch.transferStatus && before.transferReversedCents === patch.transferReversedCents) {
    return;
  }

  await ref.update(patch);

  await notifyUser(before.sellerId, {
    type: "transfer_reversed",
    title: "Payment Reversed",
    message: `${dollars(patch.transferReversedCents)} of the payment for order ${before.orderNumber} was reversed.`,
    link: `seller-orders.html?orderId=${sellerOrderId}`,
  });
}

// A payout to a seller's bank failed. Successful payouts need nothing here --
// the seller's own Stripe Dashboard is the record of those.
async function handlePayoutFailed(event) {
  if (!event.account) return; // Lesovia's own payout, not a seller's

  const usersSnap = await db
    .collection("users")
    .where("stripeAccountId", "==", event.account)
    .limit(1)
    .get();

  if (usersSnap.empty) return;

  const payout = event.data.object;
  const reason = payout.failure_message ? ` Stripe says: ${String(payout.failure_message).slice(0, 200)}` : "";

  await notifyUser(usersSnap.docs[0].id, {
    type: "payout_failed",
    title: "Payout Failed",
    message: `A payout of ${dollars(payout.amount)} to your bank account didn't go through.${reason}`,
    link: "seller-profile.html",
  });
}

async function handleStripeEvent(stripe, event) {
  switch (event.type) {
    case "account.updated":
      return handleAccountUpdated(event);

    case "payment_intent.succeeded":
      return handlePaymentSucceeded(stripe, event);

    case "charge.refunded":
      return handleChargeRefunded(event);

    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
      return handleDispute(event);

    case "transfer.reversed":
      return handleTransferReversed(event);

    case "payout.failed":
      return handlePayoutFailed(event);

    // Seller plan subscriptions (billed on Lesovia's own account).
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "invoice.payment_failed":
      // Listing-plan and Insights subscriptions share these events; each handler
      // ignores the other's (by its subscription metadata).
      await plans.handlePlanEvent(stripe, event);
      return insights.handleInsightsEvent(stripe, event);

    // A seller paid for a promoted listing.
    case "checkout.session.completed":
      return promotions.handleCheckoutCompleted(stripe, event);

    // Every other event type is acknowledged and logged (below) with no
    // handler, so Stripe doesn't redeliver it forever.
    default:
      return;
  }
}

async function processStripeWebhook(req, res, { secret, scope }) {
  let event;
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      req.headers["stripe-signature"],
      secret
    );
  } catch (error) {
    logger.error(`${scope} webhook signature verification failed:`, error);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  // Idempotent -- Stripe can and does redeliver the same event more than
  // once. The handlers themselves are also safe to replay, so two deliveries
  // racing each other can't do harm either.
  const eventRef = db.collection("stripeWebhookEvents").doc(event.id);
  const eventSnap = await eventRef.get();

  if (eventSnap.exists) {
    return res.status(200).send({ received: true, duplicate: true });
  }

  try {

    await handleStripeEvent(stripe, event);

    await eventRef.set({
      type: event.type,
      scope,
      account: event.account || null,
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).send({ received: true });

  } catch (error) {

    // Not recorded as processed and answered with a 500, so Stripe retries.
    logger.error(`Error handling ${scope} webhook event ${event.type}:`, error);
    res.status(500).send({ error: error.message });

  }
}

exports.stripeWebhookConnect = onRequest(
  {
    secrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET_CONNECT"],
  },

  (req, res) =>
    processStripeWebhook(req, res, {
      secret: process.env.STRIPE_WEBHOOK_SECRET_CONNECT,
      scope: "connectedAccount",
    })
);

exports.stripeWebhookPlatform = onRequest(
  {
    secrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET_PLATFORM"],
  },

  (req, res) =>
    processStripeWebhook(req, res, {
      secret: process.env.STRIPE_WEBHOOK_SECRET_PLATFORM,
      scope: "platform",
    })
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

        // Hidden by the seller's plan limit: not for sale.
        if (product.hiddenByPlan === true) return;

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
// =================================
// RETURNS AND CANCELLATIONS
// =================================
// Endpoints, the refund itself and the daily deadline sweep live in
// returns.js (rules and money math in returnMath.js).
const returns = require("./returns");
const plans = require("./plans");
const promotions = require("./promotions");
const insights = require("./insights");
const partners = require("./partners");

exports.previewReturn = returns.previewReturn;
exports.requestReturn = returns.requestReturn;
exports.decideReturn = returns.decideReturn;
exports.escalateReturn = returns.escalateReturn;
exports.cancelReturn = returns.cancelReturn;
exports.submitReturnTracking = returns.submitReturnTracking;
exports.confirmReturnReceived = returns.confirmReturnReceived;
exports.reportReturnProblem = returns.reportReturnProblem;
exports.adminResolveReturn = returns.adminResolveReturn;
exports.cancelUnshippedOrder = returns.cancelUnshippedOrder;
exports.stampShipmentTimes = returns.stampShipmentTimes;
exports.sweepReturnDeadlines = returns.sweepReturnDeadlines;

// =================================
// SELLER PLANS (live-listing limit + subscriptions)
// =================================
// Rules in planMath.js, Firestore/Stripe work in plans.js. The Stripe
// subscription events reach it through handleStripeEvent above.
exports.getPlanStatus = plans.status;
exports.choosePlan = plans.choosePlan;
exports.setPlanCancel = plans.setCancel;
exports.planBillingPortal = plans.billingPortal;
exports.syncPlan = plans.syncPlan;
exports.chooseLiveListings = plans.chooseLive;
exports.reconcileOnProductWrite = plans.reconcileOnProductWrite;
exports.sweepListingLimits = plans.sweepListingLimits;

// =================================
// PROMOTED LISTINGS
// =================================
// Rules in promoMath.js, payment and activation in promotions.js. A paid
// promotion is applied from checkout.session.completed (handleStripeEvent
// above) and, as a safety net, when the seller returns from checkout.
exports.promotionStatus = promotions.promotionStatus;
exports.promoteListing = promotions.promoteListing;
exports.syncPromotion = promotions.syncPromotion;
exports.sweepPromotionReminders = promotions.sweepPromotionReminders;

// =================================
// SELLER INSIGHTS (paid business numbers + AI summary)
// =================================
// Math and tier rules in insightsMath.js, data/billing/AI in insights.js. The
// subscription events arrive through handleStripeEvent above.
exports.insightsStatus = insights.insightsStatus;
exports.getInsights = insights.getInsights;
exports.chooseInsights = insights.chooseInsights;
exports.setInsightsCancel = insights.setInsightsCancel;
exports.syncInsights = insights.syncInsights;
exports.insightsSummary = insights.insightsSummary;

// =================================
// PARTNER BANNERS (advertising sold directly to businesses)
// =================================
// Rules in partnerMath.js, admin tools / uploads / invoices / counting in
// partners.js. Named "partner" throughout so ad blockers leave it alone.
exports.savePartnerSpot = partners.savePartnerSpot;
exports.deletePartnerSpot = partners.deletePartnerSpot;
exports.listPartnerSpots = partners.listPartnerSpots;
exports.uploadPartnerImage = partners.uploadPartnerImage;
exports.sendPartnerInvoice = partners.sendPartnerInvoice;
exports.checkPartnerInvoice = partners.checkPartnerInvoice;
exports.partnerEvent = partners.partnerEvent;

// =================================
// ACCOUNT RECOVERY BY PHONE
// =================================
// A seller can keep a phone number on file for ONE purpose: resetting their
// password when they can't use their email. It is not a way to sign in.
//
// How that is kept true:
//   * The number is NOT linked to the person's Firebase Auth account (a linked
//     number would work as a login). It is verified with a texted code, then
//     kept in a private server-only record, accountRecovery/{uid}.
//   * The texted code is checked here, from the verified token Firebase issues
//     for it, never from anything the browser merely claims.
//   * Resetting a password signs out every existing session, and the account's
//     email is told.
//   * It can NOT change the account's email -- a stolen phone number must not
//     be able to redirect every future alert. Email is changed from a signed-in
//     session with the current password, confirmed through a link (below).
const PHONE_E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sha = (value) => require("crypto").createHash("sha256").update(String(value)).digest("hex").slice(0, 32);

// At most `max` hits per `windowSeconds` for a key. Counts every call, so
// repeating a request never gets cheaper.
async function hitRateLimit(key, max, windowSeconds) {
  const ref = db.collection("emailRateLimits").doc(key);
  const nowMs = Date.now();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const fresh = !data.windowStartMs || nowMs - data.windowStartMs > windowSeconds * 1000;
    const count = fresh ? 1 : (data.count || 0) + 1;

    tx.set(ref, { count, windowStartMs: fresh ? nowMs : data.windowStartMs });

    return count > max;
  });
}

const callerOf = (req) => sha(String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "unknown");

// The sensitive actions below need a sign-in from the last 15 minutes.
const isRecentLogin = (decoded, seconds = 15 * 60) =>
  Boolean(decoded.auth_time) && Date.now() / 1000 - decoded.auth_time < seconds;

// Verifies the token Firebase issued for a texted code (sign-in with a phone
// number on a throwaway session). Null if it isn't a fresh phone sign-in.
async function verifiedPhoneToken(phoneIdToken, maxAgeSeconds = 5 * 60) {
  if (typeof phoneIdToken !== "string" || !phoneIdToken) return null;

  try {
    const decoded = await admin.auth().verifyIdToken(phoneIdToken);

    const byPhone = decoded.firebase && decoded.firebase.sign_in_provider === "phone" && PHONE_E164.test(decoded.phone_number || "");
    const fresh = decoded.auth_time && Date.now() / 1000 - decoded.auth_time < maxAgeSeconds;

    return byPhone && fresh ? decoded : null;
  } catch (error) {
    return null;
  }
}

// Verifying a number creates an empty phone-only account in Firebase. Remove it
// -- but only when it truly is empty: never an account with an email or a
// Lesovia profile (that would be someone's real account).
async function removeStrayPhoneUser(phoneUid, keepUid) {
  if (!phoneUid || phoneUid === keepUid) return;

  try {
    const [record, profile] = await Promise.all([
      admin.auth().getUser(phoneUid),
      db.collection("users").doc(phoneUid).get(),
    ]);

    if (!record.email && !profile.exists) await admin.auth().deleteUser(phoneUid);
  } catch (error) {
    logger.error("Could not remove the temporary phone account:", error);
  }
}

// Best effort: a mail problem never undoes or blocks the action itself.
async function sendSecurityEmail(to, subject, bodyHtml) {
  if (!to) return;

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);

    await resend.emails.send({
      from: "Lesovia <no-reply@lesovia.com>",
      to,
      subject,
      html: brandedEmailShell(`
        <h1 style="font-family:Georgia,'Times New Roman',serif;color:#14231B;margin-top:0;">${subject}</h1>
        ${bodyHtml}
        <p style="color:#5B6B62;">${new Date().toUTCString()}</p>
        <p>If this wasn't you, email <a href="mailto:support@lesovia.com">support@lesovia.com</a> right away.</p>
      `),
    });
  } catch (error) {
    logger.error("Could not send a security email:", error);
  }
}

const lastFourOf = (phone) => String(phone || "").replace(/\D/g, "").slice(-4);

// ---- add / remove the recovery number (signed in, fresh login) ----
exports.saveRecoveryPhone = onRequest(
  { secrets: ["RESEND_API_KEY"], cors: true },

  async (req, res) => {
    try {
      const decoded = await getDecodedTokenFromRequest(req);

      if (!decoded) return res.status(401).send({ error: "Authentication required." });

      if (!isRecentLogin(decoded)) {
        return res.status(403).send({ error: "Please sign in again first.", code: "recent-login" });
      }

      const profile = await db.collection("users").doc(decoded.uid).get();

      if (!profile.exists) return res.status(403).send({ error: "Account not found." });

      const phoneToken = await verifiedPhoneToken(req.body && req.body.phoneIdToken);

      if (!phoneToken) {
        return res.status(400).send({ error: "That code has expired. Please request a new one." });
      }

      // A number that signs into some real account stays with that account.
      if (phoneToken.uid !== decoded.uid) {
        const [record, owner] = await Promise.all([
          admin.auth().getUser(phoneToken.uid),
          db.collection("users").doc(phoneToken.uid).get(),
        ]);

        if (record.email || owner.exists) {
          return res.status(409).send({ error: "That phone number is already used by another account." });
        }
      }

      const phone = phoneToken.phone_number;

      await db.collection("accountRecovery").doc(decoded.uid).set(
        { phone, addedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );

      await removeStrayPhoneUser(phoneToken.uid, decoded.uid);

      const account = await admin.auth().getUser(decoded.uid);

      await sendSecurityEmail(
        account.email,
        "A recovery phone number was added",
        `<p>A recovery phone number ending in <strong>${lastFourOf(phone)}</strong> was added to your Lesovia account. It can be used to reset your password if you can't use your email. It can't be used to sign in.</p>`
      );

      res.send({ saved: true });
    } catch (error) {
      logger.error(error);
      res.status(500).send({ error: "Could not save that number right now." });
    }
  }
);

exports.removeRecoveryPhone = onRequest(
  { secrets: ["RESEND_API_KEY"], cors: true },

  async (req, res) => {
    try {
      const decoded = await getDecodedTokenFromRequest(req);

      if (!decoded) return res.status(401).send({ error: "Authentication required." });

      if (!isRecentLogin(decoded)) {
        return res.status(403).send({ error: "Please sign in again first.", code: "recent-login" });
      }

      const ref = db.collection("accountRecovery").doc(decoded.uid);
      const existing = await ref.get();

      if (existing.exists) {
        const lastFour = lastFourOf(existing.data().phone);

        await ref.delete();

        const account = await admin.auth().getUser(decoded.uid);

        await sendSecurityEmail(
          account.email,
          "Your recovery phone number was removed",
          `<p>The recovery phone number ending in <strong>${lastFour}</strong> was removed from your Lesovia account.</p>`
        );
      }

      res.send({ removed: true });
    } catch (error) {
      logger.error(error);
      res.status(500).send({ error: "Could not remove that number right now." });
    }
  }
);

// ---- the recovery itself (signed out) ----

// Looks up the account for an email and returns it only if it is active and has
// exactly this recovery number on file.
async function accountWithRecoveryPhone(email, phone) {
  let account;

  try {
    account = await admin.auth().getUserByEmail(email);
  } catch (error) {
    if (error.code === "auth/user-not-found") return null;
    throw error;
  }

  const [profile, recovery] = await Promise.all([
    db.collection("users").doc(account.uid).get(),
    db.collection("accountRecovery").doc(account.uid).get(),
  ]);

  if (!profile.exists || profile.data().status === "banned") return null;
  if (!recovery.exists || recovery.data().phone !== phone) return null;

  return { account, recovery };
}

// Step 1: is there an account with this email AND this recovery number? A code
// is only ever texted when both match, so the page can't be used to text
// strangers. Rate limited per caller, per email and per number.
exports.checkRecoveryPhone = onRequest(
  { cors: true },

  async (req, res) => {
    try {
      const email = String((req.body && req.body.email) || "").trim().toLowerCase();
      const phone = req.body && req.body.phone;

      if (!EMAIL_SHAPE.test(email) || typeof phone !== "string" || !PHONE_E164.test(phone)) {
        return res.status(400).send({ error: "Enter your account email and a valid phone number." });
      }

      const limited =
        (await hitRateLimit(`recoveryIp_${callerOf(req)}`, 10, 10 * 60)) ||
        (await hitRateLimit(`recoveryEmail_${sha(email)}`, 5, 60 * 60)) ||
        (await hitRateLimit(`recoveryPhone_${sha(phone)}`, 5, 60 * 60));

      if (limited) {
        return res.status(429).send({ error: "Too many attempts. Please wait a while and try again." });
      }

      res.send({ match: Boolean(await accountWithRecoveryPhone(email, phone)) });
    } catch (error) {
      logger.error(error);
      res.status(500).send({ error: "Could not check those details right now." });
    }
  }
);

// Step 2: the texted code was confirmed (the browser holds the token Firebase
// issued for it) -- set the new password.
exports.recoverPasswordWithPhone = onRequest(
  { secrets: ["RESEND_API_KEY"], cors: true },

  async (req, res) => {
    try {
      const email = String((req.body && req.body.email) || "").trim().toLowerCase();
      const newPassword = req.body && req.body.newPassword;

      if (!EMAIL_SHAPE.test(email) || typeof newPassword !== "string") {
        return res.status(400).send({ error: "Something is missing. Please start again." });
      }

      if (newPassword.length < 8 || newPassword.length > 128) {
        return res.status(400).send({ error: "Choose a password between 8 and 128 characters." });
      }

      const limited =
        (await hitRateLimit(`recoverIp_${callerOf(req)}`, 10, 10 * 60)) ||
        (await hitRateLimit(`recoverEmail_${sha(email)}`, 5, 60 * 60));

      if (limited) {
        return res.status(429).send({ error: "Too many attempts. Please wait a while and try again." });
      }

      const phoneToken = await verifiedPhoneToken(req.body.phoneIdToken);

      if (!phoneToken) {
        return res.status(400).send({ error: "That code has expired. Please start again." });
      }

      const found = await accountWithRecoveryPhone(email, phoneToken.phone_number);

      if (!found) {
        return res.status(400).send({ error: "Those details don't match a recovery phone on file." });
      }

      // One texted code can set one password. It can't be replayed.
      if (phoneToken.auth_time <= (found.recovery.data().lastRecoveryAuthTime || 0)) {
        return res.status(400).send({ error: "That code was already used. Please start again." });
      }

      const uid = found.account.uid;

      await admin.auth().updateUser(uid, { password: newPassword });
      await admin.auth().revokeRefreshTokens(uid); // signs out every existing session

      await db.collection("accountRecovery").doc(uid).set({ lastRecoveryAuthTime: phoneToken.auth_time }, { merge: true });

      await removeStrayPhoneUser(phoneToken.uid, uid);

      await sendSecurityEmail(
        found.account.email,
        "Your password was changed",
        `<p>The password on your Lesovia account was just changed using your recovery phone number (ending in <strong>${lastFourOf(phoneToken.phone_number)}</strong>). Everywhere you were signed in has been signed out.</p>`
      );

      res.send({ ok: true });
    } catch (error) {
      logger.error(error);
      res.status(500).send({ error: "Could not reset the password right now." });
    }
  }
);

// ---- changing the email (signed in, current password re-entered) ----
// The new address only takes effect when its owner clicks the confirmation
// link, and the OLD address is told a change was asked for.
exports.startEmailChange = onRequest(
  { secrets: ["RESEND_API_KEY", "APP_URL"], cors: true },

  async (req, res) => {
    try {
      const decoded = await getDecodedTokenFromRequest(req);

      if (!decoded) return res.status(401).send({ error: "Authentication required." });

      // The browser re-asks for the password first; this makes sure it did.
      if (!isRecentLogin(decoded, 5 * 60)) {
        return res.status(403).send({ error: "Please confirm your password again.", code: "recent-login" });
      }

      const newEmail = String((req.body && req.body.newEmail) || "").trim().toLowerCase();

      if (!EMAIL_SHAPE.test(newEmail)) {
        return res.status(400).send({ error: "Enter a valid email address." });
      }

      if (await hitRateLimit(`emailChange_${decoded.uid}`, 3, 60 * 60)) {
        return res.status(429).send({ error: "Too many attempts. Please wait a while and try again." });
      }

      const account = await admin.auth().getUser(decoded.uid);

      if (!account.email) return res.status(400).send({ error: "This account has no email to change." });

      if (newEmail === String(account.email).toLowerCase()) {
        return res.status(400).send({ error: "That is already your email address." });
      }

      try {
        await admin.auth().getUserByEmail(newEmail);
        return res.status(409).send({ error: "That email address is already used by another account." });
      } catch (error) {
        if (error.code !== "auth/user-not-found") throw error;
      }

      const link = await admin.auth().generateVerifyAndChangeEmailLink(account.email, newEmail, {
        url: process.env.APP_URL,
        handleCodeInApp: false,
      });

      const resend = new Resend(process.env.RESEND_API_KEY);

      await resend.emails.send({
        from: "Lesovia <no-reply@lesovia.com>",
        to: newEmail,
        subject: "Confirm your new Lesovia email address",
        html: brandedEmailShell(`
          <h1 style="font-family:Georgia,'Times New Roman',serif;color:#14231B;margin-top:0;">Confirm your new email</h1>
          <p>Someone asked to use this address for a Lesovia account. If that was you, confirm it:</p>
          <p style="margin:32px 0;text-align:center;">
            <a href="${link}" style="background:#0B7A3D;color:#ffffff;padding:15px 30px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;">Confirm new email</a>
          </p>
          <p style="word-break:break-all;color:#5B6B62;">${link}</p>
          <p>If you didn't ask for this, ignore this email and nothing will change.</p>
        `),
      });

      const [first, domain] = newEmail.split("@");

      await sendSecurityEmail(
        account.email,
        "A change of email address was requested",
        `<p>A request was made to change the email address on your Lesovia account to <strong>${first.slice(0, 1)}***@${domain}</strong>. Nothing changes until that new address confirms.</p>`
      );

      res.send({ sent: true });
    } catch (error) {
      logger.error(error);
      res.status(500).send({ error: "Could not start the email change right now." });
    }
  }
);
