// Pure money/shipping helpers for checkout. No Firebase or Stripe imports on
// purpose, so the math can be unit-tested on its own (see paymentMath.test.js).

const SINGLE_SELLER_COMMISSION_RATE = 0.07;
const MULTI_SELLER_COMMISSION_RATE = 0.1;

// A problem with what the buyer asked for (empty cart, seller not onboarded,
// unavailable shipping option...) -- safe to show to the buyer as-is.
class CheckoutError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// One seller in the cart -> Direct Charge on their connected account at 7%.
// Two or more -> Separate Charges and Transfers on the platform at 10% per
// seller. Derived only from the seller IDs found on the products themselves.
function resolveChargeType(distinctSellerCount) {
  if (distinctSellerCount === 1) {
    return { chargeType: "direct", commissionRate: SINGLE_SELLER_COMMISSION_RATE };
  }

  return { chargeType: "separate", commissionRate: MULTI_SELLER_COMMISSION_RATE };
}

function isCents(value) {
  return Number.isInteger(value) && value >= 0;
}

// `config` is users/{sellerId}.shipping. `requestedMethod` is the buyer's
// choice ("standard" | "express"); the price always comes from the seller's
// own config, never from the client.
function resolveShipping(config, requestedMethod) {
  const method = requestedMethod || "standard";

  if (method !== "standard" && method !== "express") {
    throw new CheckoutError("Invalid shipping option.");
  }

  if (!config || typeof config !== "object") {
    throw new CheckoutError("This seller hasn't set up shipping yet.");
  }

  if (method === "express") {
    if (config.expressEnabled !== true || !isCents(config.expressRateCents)) {
      throw new CheckoutError("Express shipping isn't available from this seller.");
    }

    return { shippingMethod: "express", shippingCents: config.expressRateCents };
  }

  if (config.freeShipping === true) {
    return { shippingMethod: "free", shippingCents: 0 };
  }

  if (!isCents(config.flatRateCents)) {
    throw new CheckoutError("This seller hasn't set up shipping yet.");
  }

  return { shippingMethod: "flat", shippingCents: config.flatRateCents };
}

// Commission is a share of the product subtotal only -- never shipping or
// tax. Tax is a pass-through: charged to the buyer, not part of the seller's
// proceeds or Lesovia's commission.
function computeSellerBreakdown({ productSubtotalCents, shippingCents, taxCents, commissionRate }) {
  const commissionBasisPoints = Math.round(commissionRate * 10000);
  const commissionAmountCents = Math.round((productSubtotalCents * commissionBasisPoints) / 10000);

  return {
    productSubtotalCents,
    shippingCents,
    taxCents,
    commissionRate,
    commissionAmountCents,
    sellerProceedsCents: productSubtotalCents - commissionAmountCents + shippingCents,
    buyerTotalCents: productSubtotalCents + shippingCents + taxCents,
  };
}

module.exports = {
  CheckoutError,
  SINGLE_SELLER_COMMISSION_RATE,
  MULTI_SELLER_COMMISSION_RATE,
  resolveChargeType,
  resolveShipping,
  computeSellerBreakdown,
};
