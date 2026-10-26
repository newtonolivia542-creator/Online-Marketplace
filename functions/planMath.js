// Seller plans and the live-listing limit. Pure functions only (no Firebase, no
// Stripe, no clock of their own) so the rules can be tested exactly -- plans.js
// does the reading, writing and billing around them.
//
// The rules (decided with the owner):
//   * Every seller may keep FREE_LIMIT_DURING_FREE_YEAR live listings until the
//     free-year end date (one date for all sellers), and FREE_LIMIT_AFTER live
//     listings from then on. Nobody is ever locked out of the free allowance.
//   * Paid plans are defined by TOTAL live listings (not "extra"), so the free
//     allowance dropping from 15 to 10 never changes what a paid plan allows.
//   * Only in-stock listings count. Sold-out ones are free.
//   * Over the limit, listings are HIDDEN (hiddenByPlan), never deleted. They
//     come back automatically when the limit rises or room appears.

// Nov 1, 2027, midnight US Central (daylight time still applies that day).
const DEFAULTS = {
  freeYearEndsAt: "2027-11-01T00:00:00-05:00",
  freeLimitDuringFreeYear: 15,
  freeLimitAfter: 10,
  tiers: {
    plus: { name: "Plus", maxItems: 35, priceCents: 2000 },
    pro: { name: "Pro", maxItems: 50, priceCents: 3500 },
    unlimited: { name: "Unlimited", maxItems: null, priceCents: 5000 },
  },
};

// Plan names a seller can hold, cheapest first.
const PLAN_ORDER = ["free", "plus", "pro", "unlimited"];

// Subscription states that still give the paid allowance. past_due stays paid
// while Stripe retries the card (turn "cancel after retries fail" on in the
// Stripe billing settings -- then the subscription ends and the seller drops
// to free through the normal path).
const PAID_STATUSES = new Set(["active", "trialing", "past_due"]);

const isPositiveInt = (value) => Number.isInteger(value) && value > 0;

// A missing document, or a field of the wrong type, falls back to the default
// for just that field -- the same forgiving shape as the return policy config.
function resolveConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};

  const ends = Date.parse(cfg.freeYearEndsAt);

  const tiers = {};

  for (const key of Object.keys(DEFAULTS.tiers)) {
    const base = DEFAULTS.tiers[key];
    const given = cfg.tiers && typeof cfg.tiers === "object" ? cfg.tiers[key] : null;
    const merged = { ...base };

    if (given && typeof given === "object") {
      if (typeof given.name === "string" && given.name.trim()) merged.name = given.name.trim();
      if (given.maxItems === null || isPositiveInt(given.maxItems)) merged.maxItems = given.maxItems;
      if (isPositiveInt(given.priceCents)) merged.priceCents = given.priceCents;
    }

    tiers[key] = merged;
  }

  return {
    freeYearEndsAt: Number.isFinite(ends) ? new Date(ends).toISOString() : new Date(Date.parse(DEFAULTS.freeYearEndsAt)).toISOString(),
    freeLimitDuringFreeYear: isPositiveInt(cfg.freeLimitDuringFreeYear) ? cfg.freeLimitDuringFreeYear : DEFAULTS.freeLimitDuringFreeYear,
    freeLimitAfter: isPositiveInt(cfg.freeLimitAfter) ? cfg.freeLimitAfter : DEFAULTS.freeLimitAfter,
    tiers,
  };
}

// The plan a seller currently gets the benefits of. `planDoc` is
// sellerPlans/{uid} (or null for a seller who never subscribed).
function effectivePlan(planDoc) {
  if (!planDoc || !PAID_STATUSES.has(planDoc.status)) return "free";

  return PLAN_ORDER.includes(planDoc.plan) && planDoc.plan !== "free" ? planDoc.plan : "free";
}

function freeLimit(cfg, nowMs) {
  return nowMs < Date.parse(cfg.freeYearEndsAt) ? cfg.freeLimitDuringFreeYear : cfg.freeLimitAfter;
}

// Number of live listings the seller may have, or Infinity.
function limitFor(plan, cfg, nowMs) {
  const free = freeLimit(cfg, nowMs);

  if (plan === "free" || !cfg.tiers[plan]) return free;

  const max = cfg.tiers[plan].maxItems;

  return max === null ? Infinity : Math.max(max, free);
}

// An in-stock listing: the only kind that counts toward the limit.
const inStock = (product) => product.quantity === undefined || product.quantity === null || Number(product.quantity) > 0;

function millis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000;

  const parsed = new Date(value).getTime();

  return Number.isFinite(parsed) ? parsed : 0;
}

// products: [{ id, quantity, hiddenByPlan, createdAt }]. Returns which ids to
// hide and which to show again so that exactly min(limit, in-stock count) are
// visible. Over the limit the NEWEST listings are hidden first; when there is
// room again the OLDEST hidden ones return first. Ties break on id so two
// runs always agree.
function planVisibility(products, limit) {
  const byAge = (a, b) => millis(a.createdAt) - millis(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const candidates = products.filter(inStock);
  const visible = candidates.filter((p) => !p.hiddenByPlan).sort(byAge);
  const hidden = candidates.filter((p) => p.hiddenByPlan).sort(byAge);

  if (visible.length > limit) {
    return { hide: visible.slice(limit).map((p) => p.id), show: [] };
  }

  const room = limit - visible.length;

  return { hide: [], show: hidden.slice(0, room).map((p) => p.id) };
}

// The seller picks which listings stay visible. Returns an error message, or
// null if the choice is valid: every id must be one of their in-stock
// listings, no duplicates, and no more than the limit.
function validateChoice(chosenIds, products, limit) {
  if (!Array.isArray(chosenIds)) return "Choose which listings to keep live.";

  const unique = new Set(chosenIds);

  if (unique.size !== chosenIds.length) return "A listing was chosen twice.";

  const valid = new Set(products.filter(inStock).map((p) => p.id));

  for (const id of unique) {
    if (!valid.has(id)) return "One of the chosen listings isn't one of your in-stock listings.";
  }

  if (unique.size > limit) return `Your plan allows ${limit} live listings; you chose ${unique.size}.`;

  return null;
}

// Apply a (validated) choice: everything chosen is visible, every other
// in-stock listing is hidden. Returns the ids to hide and to show.
function applyChoice(chosenIds, products) {
  const chosen = new Set(chosenIds);
  const candidates = products.filter(inStock);

  return {
    hide: candidates.filter((p) => !chosen.has(p.id) && !p.hiddenByPlan).map((p) => p.id),
    show: candidates.filter((p) => chosen.has(p.id) && p.hiddenByPlan).map((p) => p.id),
  };
}

// Moving to a plan with a lower limit is blocked until the seller is under it,
// so nothing is hidden behind their back. Returns an error message or null.
function downgradeError(visibleCount, newPlan, cfg, nowMs) {
  const newLimit = limitFor(newPlan, cfg, nowMs);

  if (visibleCount <= newLimit) return null;

  return `That plan allows ${newLimit} live listings and you have ${visibleCount}. Hide or remove ${visibleCount - newLimit} first.`;
}

const ranked = (plan) => PLAN_ORDER.indexOf(plan);

// What a seller sees on the plan page.
function planStatus({ planDoc, products, cfg, nowMs }) {
  const plan = effectivePlan(planDoc);
  const limit = limitFor(plan, cfg, nowMs);
  const candidates = products.filter(inStock);
  const visible = candidates.filter((p) => !p.hiddenByPlan).length;

  return {
    plan,
    limit: Number.isFinite(limit) ? limit : null,
    liveCount: visible,
    hiddenCount: candidates.length - visible,
    freeLimitNow: freeLimit(cfg, nowMs),
    freeLimitAfter: cfg.freeLimitAfter,
    freeYearEndsAt: cfg.freeYearEndsAt,
    inFreeYear: nowMs < Date.parse(cfg.freeYearEndsAt),
  };
}

// Days until the free allowance changes, for the 60/30/7-day heads-up emails.
// Returns null once it has passed.
function daysUntilFreeYearEnds(cfg, nowMs) {
  const ms = Date.parse(cfg.freeYearEndsAt) - nowMs;

  return ms > 0 ? Math.ceil(ms / 86400000) : null;
}

module.exports = {
  DEFAULTS,
  PLAN_ORDER,
  PAID_STATUSES,
  resolveConfig,
  effectivePlan,
  limitFor,
  freeLimit,
  inStock,
  planVisibility,
  validateChoice,
  applyChoice,
  downgradeError,
  planStatus,
  daysUntilFreeYearEnds,
  ranked,
};
