// Promoted listings. Pure functions only (no Firebase, Stripe or clock of their
// own) so the rules can be tested exactly -- promotions.js does the reading,
// writing and paying around them.
//
// The rules (decided with the owner):
//   * A promotion is per LISTING, $5 for 30 days, one-time (not a subscription),
//     and any seller can buy one -- no plan needed.
//   * It can be renewed once it is within RENEW_WINDOW_DAYS of ending (or has
//     ended), so promotions can't be stacked months ahead. A renewal adds its
//     days to whatever is left, so renewing early loses nothing.
//   * Plans can include free promotions each calendar month (US Central).
//   * Only live listings can be promoted: the seller's own, in stock, and not
//     hidden by their plan limit.

const DAY_MS = 86400000;

const DEFAULTS = {
  priceCents: 500,
  days: 30,
  renewWindowDays: 7,
  allowancePerMonth: { free: 0, plus: 0, pro: 1, unlimited: 3 },
};

const isPositiveInt = (value) => Number.isInteger(value) && value > 0;
const isCount = (value) => Number.isInteger(value) && value >= 0;

// A missing document, or a field of the wrong type, falls back to the default
// for just that field.
function resolveConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const given = cfg.allowancePerMonth && typeof cfg.allowancePerMonth === "object" ? cfg.allowancePerMonth : {};

  const allowancePerMonth = {};

  for (const plan of Object.keys(DEFAULTS.allowancePerMonth)) {
    allowancePerMonth[plan] = isCount(given[plan]) ? given[plan] : DEFAULTS.allowancePerMonth[plan];
  }

  return {
    priceCents: isPositiveInt(cfg.priceCents) ? cfg.priceCents : DEFAULTS.priceCents,
    days: isPositiveInt(cfg.days) ? cfg.days : DEFAULTS.days,
    renewWindowDays: isCount(cfg.renewWindowDays) ? cfg.renewWindowDays : DEFAULTS.renewWindowDays,
    allowancePerMonth,
  };
}

// A Firestore Timestamp, {seconds}, a Date or a number, as milliseconds (0 if none).
function untilMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000;

  const parsed = new Date(value).getTime();

  return Number.isFinite(parsed) ? parsed : 0;
}

const isPromoted = (untilMs, nowMs) => untilMs > nowMs;

// Returns an error message if this listing can't be promoted right now, else null.
function eligibleListing(product, sellerId) {
  if (!product) return "That listing doesn't exist.";
  if (product.sellerId !== sellerId) return "You can only promote your own listings.";
  if (product.quantity !== undefined && product.quantity !== null && Number(product.quantity) <= 0) {
    return "Sold-out listings can't be promoted.";
  }
  if (product.hiddenByPlan === true) return "Hidden listings can't be promoted. Make it live first.";

  return null;
}

// Returns an error message if the listing is already promoted with more than
// the renew window left, else null.
function canPromote(untilMs, nowMs, cfg) {
  const remaining = untilMs - nowMs;

  if (remaining > cfg.renewWindowDays * DAY_MS) {
    const daysLeft = Math.ceil(remaining / DAY_MS);

    return `This listing is already promoted (${daysLeft} day${daysLeft === 1 ? "" : "s"} left). You can renew it in the last ${cfg.renewWindowDays} days.`;
  }

  return null;
}

// When the promotion now ends: the days are added to whatever is left.
function newUntil(untilMs, nowMs, days) {
  return Math.max(untilMs, nowMs) + days * DAY_MS;
}

// "2026-10" for the calendar month in US Central, which is where the allowance resets.
function monthKey(nowMs) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit" })
    .formatToParts(new Date(nowMs))
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});

  return `${parts.year}-${parts.month}`;
}

// Free promotions a seller on this plan still has this month.
function allowanceLeft(plan, used, cfg) {
  const total = cfg.allowancePerMonth[plan] ?? 0;

  return Math.max(0, total - (Number(used) || 0));
}

module.exports = {
  DAY_MS,
  DEFAULTS,
  resolveConfig,
  untilMillis,
  isPromoted,
  eligibleListing,
  canPromote,
  newUntil,
  monthKey,
  allowanceLeft,
};
