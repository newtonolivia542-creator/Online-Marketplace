// Pure formatting helpers used across checkout, orders, and returns. Nothing
// here touches Firestore, Auth, or the DOM's document/window globals -- every
// function only reads its own arguments and returns a value or a string, so
// none of it needs a shared-state import from app.js.

// Several render functions build HTML with `innerHTML +=` and drop
// user-supplied text straight in (this codebase does this already for
// things like color/size). Anything typed by ONE user that gets displayed
// to a DIFFERENT user -- a delivery address shown to the seller, for
// example -- must go through this first, or a buyer could type something
// like <img src=x onerror=...> as their name and have it execute in the
// seller's browser.
export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function timestampToDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate();
  if (typeof ts.seconds === "number") return new Date(ts.seconds * 1000);
  return new Date(ts);
}

export function orderTimeMs(data) {
  const date = data ? timestampToDate(data.createdAt) : null;
  return date ? date.getTime() : 0;
}

export function describeProducts(products) {
  const [first, ...rest] = products || [];

  if (!first) return "Items";

  return rest.length === 0
    ? first.name
    : `${first.name} and ${rest.length} more ${rest.length === 1 ? "item" : "items"}`;
}

export function shippingLineHtml(subOrder) {
  const kind = subOrder.shippingMethod === "express" ? " (express)" : "";

  return `Shipping${kind}: ${subOrder.shippingCents === 0 ? "Free" : formatCents(subOrder.shippingCents)}`;
}

export function deliveryAddressHtml(addr, heading, showPhone) {
  if (!addr) return "";

  return `
    <p><strong>${heading}</strong><br>
      ${escapeHtml(addr.fullName)}<br>
      ${escapeHtml(addr.line1)}${addr.line2 ? `<br>${escapeHtml(addr.line2)}` : ""}<br>
      ${escapeHtml(addr.city)}, ${escapeHtml(addr.state)} ${escapeHtml(addr.zip)}<br>
      ${escapeHtml(addr.country)}${showPhone && addr.phone ? `<br>Phone: ${escapeHtml(addr.phone)}` : ""}
    </p>
  `;
}

// Single-seller (direct charge) orders: Stripe bills its processing fee to the
// seller's own account, so the amount shown is before that fee. Multi-seller
// orders are paid by Lesovia, so nothing is deducted there.
export function earningsFeeNote(subOrder) {
  return subOrder.chargeType === "direct" ? " (before Stripe processing fees)" : "";
}

// Dispute state (from Stripe's dispute webhooks) on the seller's order card.
export const DISPUTE_TEXT = {
  warning_needs_response: "the buyer's bank has raised an inquiry",
  warning_under_review: "an inquiry from the buyer's bank is under review",
  warning_closed: "an inquiry from the buyer's bank was closed",
  needs_response: "the buyer's bank disputed this payment",
  under_review: "the buyer's bank disputed this payment; it is under review",
  won: "the buyer's bank disputed this payment; resolved in your favor",
  lost: "the buyer's bank disputed this payment; not resolved in your favor",
  charge_refunded: "the payment was refunded, so the dispute was closed"
};

export function disputeLineHtml(subOrder) {
  if (!subOrder.disputeStatus) return "";

  const text = DISPUTE_TEXT[subOrder.disputeStatus] || "the buyer's bank disputed this payment";

  return `<p style="color:#b00020;"><strong>Payment dispute:</strong> ${escapeHtml(text)}.</p>`;
}

export function payoutLine(subOrder) {
  if (subOrder.chargeType === "direct") return "Paid to your Stripe balance at checkout";

  if (subOrder.transferStatus === "transferred") return "Sent to your Stripe balance";

  if (subOrder.transferStatus === "failed") return "Transfer to your Stripe balance hasn't gone through yet";

  if (subOrder.transferStatus === "reversed") return "This payment was reversed";

  if (subOrder.transferStatus === "partially_reversed") return "Part of this payment was reversed";

  return "Being sent to your Stripe balance";
}

// ---- page access (which role each page needs) ----
// Every page that requires a specific role to view at all -- not just the
// three main dashboards. Matched against the DECODED pathname (see
// decodeURIComponent below) -- filenames with spaces like "seller
// dashboard.html" are served as "%20" in location.pathname, which would
// never match a literal-space key otherwise.
export const PAGE_ROLE = {
  "buyer dashboard.html": "buyer",
  "cart.html": "buyer",
  "messages.html": "buyer",
  "order.html": "buyer",
  "buyer-notifications.html": "buyer",
  "reviews.html": "buyer",
  "seller dashboard.html": "seller",
  "seller-upload.html": "seller",
  "seller-orders.html": "seller",
  "seller-messages.html": "seller",
  "seller-profile.html": "seller",
  "seller-history.html": "seller",
  "seller-returns.html": "seller",
  "seller-plan.html": "seller",
  "seller-notifications.html": "seller",
  "seller-reviews.html": "seller"
};

export function requiredRoleForPage(path) {
 
  const pages = Object.keys(PAGE_ROLE).sort((a, b) => b.length - a.length);

  for (const page of pages) {
    if (path.includes(page)) return PAGE_ROLE[page];
  }

  return null;
}

export function homeForRole(role) {
  if (role === "seller") return "seller dashboard.html";
  if (role === "admin") return "admin.html";
  return "buyer dashboard.html";
}

// ---- phone numbers (sign-in / recovery) ----

// Turns what a person typed into E.164 (+17125550123), or null if it can't be
// a real number. A bare 10-digit number is assumed to be US/Canada.
export function normalizePhone(input) {
  if (typeof input !== "string") return null;

  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");

  if (!digits) return null;

  let e164;

  if (trimmed.startsWith("+")) e164 = `+${digits}`;
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
  else return null;

  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

// Never show a whole number back on screen -- just enough to recognise it.
export function maskPhone(e164) {
  const digits = String(e164 || "").replace(/\D/g, "");

  return digits.length >= 4 ? `ending in ${digits.slice(-4)}` : "";
}

// Firebase's error codes, in words a seller can act on.
export function phoneAuthErrorMessage(err) {
  const code = err && err.code;

  const messages = {
    "auth/invalid-phone-number": "That phone number doesn't look right. Include the area code.",
    "auth/missing-phone-number": "Enter your phone number first.",
    "auth/too-many-requests": "Too many attempts. Please wait a few minutes and try again.",
    "auth/quota-exceeded": "We can't send text messages right now. Please try again later, or email support@lesovia.com.",
    "auth/invalid-verification-code": "That code isn't right. Check it and try again.",
    "auth/missing-verification-code": "Enter the code we texted you.",
    "auth/code-expired": "That code has expired. Request a new one.",
    "auth/credential-already-in-use": "That phone number is already used by another Lesovia account.",
    "auth/account-exists-with-different-credential": "That phone number is already used by another Lesovia account.",
    "auth/provider-already-linked": "A phone number is already added to your account.",
    "auth/requires-recent-login": "For your security, please log out, log back in, and try again.",
    "auth/network-request-failed": "Couldn't reach the server. Check your connection and try again.",
    "auth/captcha-check-failed": "We couldn't confirm you're not a robot. Reload the page and try again.",
    "auth/operation-not-allowed": "Phone sign-in isn't available yet. Please email support@lesovia.com.",
    "auth/weak-password": "Choose a longer password (at least 8 characters).",
    "auth/user-disabled": "This account has been disabled. Please email support@lesovia.com."
  };

  return messages[code] || "Something went wrong. Please try again.";
}


// ---- seller plans ----

// "$20" / "$19.99" for a price in cents.
export function planPrice(cents) {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

// "15 live listings" / "Unlimited listings" for a limit (null = unlimited).
export function listingLimitText(limit) {
  if (limit === null || limit === undefined) return "Unlimited listings";

  return `${limit} live listing${limit === 1 ? "" : "s"}`;
}

// "Nov 1, 2027" in US Central, which is where the free-year change happens.
export function planDateText(iso) {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
}


// ---- promoted listings ----

// A listing is promoted while its promotedUntil (set only by Cloud Functions,
// after payment) is in the future.
export function isPromotedProduct(product, nowMs = Date.now()) {
  const until = timestampToDate(product && product.promotedUntil);

  return !!until && until.getTime() > nowMs;
}

// What the seller's dashboard card should offer for one listing.
//   promoted : currently running
//   untilMs  : when it ends (0 if never promoted)
//   canPromote: a Promote / Renew button makes sense (a live, in-stock listing
//               that isn't promoted, or is in the last renewWindowDays)
export function promotionState(product, nowMs = Date.now(), renewWindowDays = 7) {
  const until = timestampToDate(product && product.promotedUntil);
  const untilMs = until ? until.getTime() : 0;
  const promoted = untilMs > nowMs;
  const inStock = product.quantity === undefined || product.quantity === null || Number(product.quantity) > 0;
  const live = product.hiddenByPlan !== true && inStock;

  return {
    promoted,
    untilMs,
    canPromote: live && (!promoted || untilMs - nowMs <= renewWindowDays * 86400000),
  };
}

// Orders a list of listings for buyers: promoted ones are lifted into every 4th
// spot (positions 1, 5, 9, ...), so promotion never fills more than about a
// quarter of a page, and everything else keeps its order. `seed` rotates which
// promoted listings get the spots when there are more than fit.
export function arrangeListings(products, nowMs = Date.now(), seed = 0) {
  const list = Array.isArray(products) ? products : [];
  const promoted = list.filter((product) => isPromotedProduct(product, nowMs));

  if (promoted.length === 0) return list;

  const start = ((seed % promoted.length) + promoted.length) % promoted.length;
  const rotated = [...promoted.slice(start), ...promoted.slice(0, start)];
  const boosted = rotated.slice(0, Math.ceil(list.length / 4));
  const boostedSet = new Set(boosted);
  const rest = list.filter((product) => !boostedSet.has(product));

  const out = [];
  let nextBoosted = 0;
  let nextRest = 0;

  for (let i = 0; i < list.length; i++) {
    if (i % 4 === 0 && nextBoosted < boosted.length) out.push(boosted[nextBoosted++]);
    else out.push(rest[nextRest++]);
  }

  return out;
}
