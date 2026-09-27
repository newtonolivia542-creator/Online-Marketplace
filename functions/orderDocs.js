// Pure builders for the documents verifyPayment writes once a payment is
// confirmed. No Firebase or Stripe imports, so they can be unit-tested.

// Total units wanted per product. The same product can be on more than one
// cart line (different color/size), and stock has to be checked and reduced
// against the combined amount, not line by line.
function aggregateQuantities(items) {
  const totals = new Map();

  for (const item of items) {
    totals.set(item.productId, (totals.get(item.productId) || 0) + item.quantity);
  }

  return totals;
}

// The first product that doesn't have enough stock for what was bought, or
// null if everything is available.
function findInsufficientStock(neededByProduct, stockByProduct) {
  for (const [productId, needed] of neededByProduct) {
    if ((stockByProduct.get(productId) ?? 0) < needed) return productId;
  }

  return null;
}

// "Sticker" / "Sticker and 2 more items" -- for notification text.
function describePurchase(products) {
  const [first, ...rest] = products;

  if (!first) return "Items";

  return rest.length === 0
    ? first.name
    : `${first.name} and ${rest.length} more ${rest.length === 1 ? "item" : "items"}`;
}

function chargeIdOf(paymentIntent) {
  const latest = paymentIntent && paymentIntent.latest_charge;

  if (!latest) return null;

  return typeof latest === "string" ? latest : latest.id || null;
}

// One seller's slice of a checkout. Every money figure was computed and
// frozen by createPaymentIntent and is copied over unchanged -- commission
// rate and amount are stored so later rate changes never alter this order.
// Product name/image/description are snapshotted here because an order is a
// historical record and must survive the seller editing or deleting the
// listing.
function buildSellerOrder({
  checkoutId,
  buyerId,
  seller,
  items,
  productsById,
  orderNumber,
  deliveryAddress,
  paymentIntent,
  chargeType,
  taxLiabilityAtPurchase,
  createdAt,
}) {
  const products = items
    .filter((item) => item.sellerId === seller.sellerId)
    .map((item) => {
      const product = productsById.get(item.productId) || {};

      return {
        productId: item.productId,
        name: product.name || item.name || "Product",
        image: (product.images && product.images[0]) || product.imageURL || null,
        description: product.description || null,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        color: item.color,
        size: item.size,
      };
    });

  return {
    checkoutId,
    buyerId,
    sellerId: seller.sellerId,
    storeName: seller.storeName || null,
    orderNumber,
    products,
    // Flat list of product IDs so Firestore rules (which can't look inside an
    // array of objects) can check that a product was part of this order.
    productIds: [...new Set(products.map((product) => product.productId))],

    productSubtotalCents: seller.productSubtotalCents,
    shippingCents: seller.shippingCents,
    shippingMethod: seller.shippingMethod,
    taxCents: seller.taxCents,
    taxCalculationId: seller.taxCalculationId ?? null,
    taxLiabilityAtPurchase,
    commissionRate: seller.commissionRate,
    commissionAmountCents: seller.commissionAmountCents,
    sellerProceedsCents: seller.sellerProceedsCents,
    buyerTotalCents: seller.buyerTotalCents,

    chargeType,
    stripeAccountId: seller.stripeAccountId,
    stripePaymentIntentId: paymentIntent.id,
    stripeChargeId: chargeIdOf(paymentIntent),
    stripeTransferId: null,
    transferStatus: chargeType === "separate" ? "pending" : null,
    transferAttempts: 0,

    fulfillmentStatus: "paid",
    refundStatus: null,
    refundedAmountCents: 0,
    disputeStatus: null,
    payoutStatus: null,
    trackingNumber: null,
    shippedAt: null,
    deliveredAt: null,

    deliveryAddress,
    createdAt,
  };
}

// The one buyer-facing order for the whole checkout.
function buildCheckoutOrder({
  checkoutId,
  pending,
  orderNumber,
  deliveryAddress,
  sellerOrderIds,
  paymentIntent,
  createdAt,
}) {
  return {
    buyerId: pending.buyerId,
    orderNumber,
    status: "paid",
    totalAmountCents: pending.amount,
    currency: pending.currency,
    chargeType: pending.chargeType,
    stripePaymentIntentId: paymentIntent.id,
    stripeAccountId: pending.stripeAccountId || null,
    deliveryAddress,
    sellerOrderIds,
    createdAt,
  };
}

module.exports = {
  aggregateQuantities,
  findInsufficientStock,
  describePurchase,
  chargeIdOf,
  buildSellerOrder,
  buildCheckoutOrder,
};
