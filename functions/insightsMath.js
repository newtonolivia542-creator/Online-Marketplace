// Seller Insights: the business numbers a seller sees (sales by month, best and
// slow sellers, low stock, price check against similar listings, customer
// interest) and which tier they need. Pure functions only -- no Firebase,
// Stripe, OpenAI or clock of their own -- so every figure can be tested exactly.
// insights.js does the reading, billing and AI around them.
//
// Tiers (decided with the owner; a Premier tier comes after launch):
//   plus  $5.99/mo  sales and stock numbers, from the seller's own orders
//   pro   $9.99/mo  plus price check, customer interest and the AI summary
// A listing plan can include a tier (Pro and Unlimited include Insights Pro);
// a seller gets the higher of what they bought and what their plan includes.

const promo = require("./promoMath");
const planMath = require("./planMath");

const DAY_MS = 86400000;

const DEFAULTS = {
  tiers: {
    plus: { name: "Insights Plus", priceCents: 599 },
    pro: { name: "Insights Pro", priceCents: 999 },
  },
  // What each listing plan includes.
  bundled: { free: "none", plus: "none", pro: "pro", unlimited: "pro" },
  aiSummariesPerMonth: 4,
};

const TIER_ORDER = ["none", "plus", "pro"];

const isPositiveInt = (value) => Number.isInteger(value) && value > 0;

function resolveConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const tiers = {};

  for (const key of Object.keys(DEFAULTS.tiers)) {
    const given = cfg.tiers && typeof cfg.tiers === "object" ? cfg.tiers[key] : null;
    const merged = { ...DEFAULTS.tiers[key] };

    if (given && typeof given === "object") {
      if (typeof given.name === "string" && given.name.trim()) merged.name = given.name.trim();
      if (isPositiveInt(given.priceCents)) merged.priceCents = given.priceCents;
    }

    tiers[key] = merged;
  }

  const bundled = { ...DEFAULTS.bundled };

  if (cfg.bundled && typeof cfg.bundled === "object") {
    for (const plan of Object.keys(bundled)) {
      if (TIER_ORDER.includes(cfg.bundled[plan])) bundled[plan] = cfg.bundled[plan];
    }
  }

  return {
    tiers,
    bundled,
    aiSummariesPerMonth: Number.isInteger(cfg.aiSummariesPerMonth) && cfg.aiSummariesPerMonth >= 0 ? cfg.aiSummariesPerMonth : DEFAULTS.aiSummariesPerMonth,
  };
}

// The tier a seller bought, if the subscription is still paid (past_due counts
// while Stripe retries the card, same as listing plans).
function purchasedTier(insightsDoc) {
  if (!insightsDoc || !planMath.PAID_STATUSES.has(insightsDoc.status)) return "none";

  return TIER_ORDER.includes(insightsDoc.tier) && insightsDoc.tier !== "none" ? insightsDoc.tier : "none";
}

// The higher of what they bought and what their listing plan includes.
function effectiveTier(insightsDoc, listingPlan, cfg) {
  const bought = purchasedTier(insightsDoc);
  const included = cfg.bundled[listingPlan] || "none";

  return TIER_ORDER.indexOf(bought) >= TIER_ORDER.indexOf(included) ? bought : included;
}

const hasTier = (tier, needed) => TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(needed);

// ----------------------------------------------------------------- sales

const millis = (value) => promo.untilMillis(value);

// A sale that still counts: not cancelled, returned or fully refunded.
function countsAsSale(order) {
  return !["cancelled", "returned"].includes(order.fulfillmentStatus) && order.refundStatus !== "refunded";
}

const lineUnits = (line) => Number(line.quantity) || 0;
const lineRevenue = (line) => (Number(line.unitPriceCents) || 0) * lineUnits(line);

// "Nov 2026" for a "2026-11" key.
function monthLabel(key) {
  const [year, month] = key.split("-").map(Number);

  return new Date(Date.UTC(year, month - 1, 15)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

// The last `months` calendar months in US Central, oldest first, zero-filled.
function salesByMonth(orders, nowMs, months = 6) {
  const keys = [];

  // Step back 28 days at a time from the middle of this month is unreliable, so
  // walk month by month from the current month key.
  let [year, month] = promo.monthKey(nowMs).split("-").map(Number);

  for (let i = 0; i < months; i++) {
    keys.unshift(`${year}-${String(month).padStart(2, "0")}`);
    month -= 1;

    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }

  const byMonth = new Map(keys.map((key) => [key, { month: key, label: monthLabel(key), units: 0, revenueCents: 0, orders: 0 }]));

  for (const order of orders) {
    if (!countsAsSale(order)) continue;

    const bucket = byMonth.get(promo.monthKey(millis(order.createdAt)));

    if (!bucket) continue;

    bucket.orders += 1;

    for (const line of order.products || []) {
      bucket.units += lineUnits(line);
      bucket.revenueCents += lineRevenue(line);
    }
  }

  return keys.map((key) => byMonth.get(key));
}

// Units and revenue per product over a window (or all time with days = null).
function productSales(orders, nowMs, days = null) {
  const since = days === null ? 0 : nowMs - days * DAY_MS;
  const sales = new Map();

  for (const order of orders) {
    if (!countsAsSale(order) || millis(order.createdAt) < since) continue;

    for (const line of order.products || []) {
      const current = sales.get(line.productId) || { units: 0, revenueCents: 0 };

      current.units += lineUnits(line);
      current.revenueCents += lineRevenue(line);
      sales.set(line.productId, current);
    }
  }

  return sales;
}

const inStock = (product) => product.quantity === undefined || product.quantity === null || Number(product.quantity) > 0;
const isLive = (product) => inStock(product) && product.hiddenByPlan !== true;

// Best sellers, slow movers and low stock, from the last `days` days.
//   bestSellers: top 5 by units sold
//   slowMovers : live listings listed for at least 14 days with no sales
//   lowStock   : selling listings with 5 or fewer left, soonest to run out first
function performance(products, orders, nowMs, days = 30) {
  const recent = productSales(orders, nowMs, days);
  const nameOf = (product) => product.name || "Untitled";

  const bestSellers = products
    .filter((p) => (recent.get(p.id) || {}).units > 0)
    .map((p) => ({ productId: p.id, name: nameOf(p), units: recent.get(p.id).units, revenueCents: recent.get(p.id).revenueCents }))
    .sort((a, b) => b.units - a.units || b.revenueCents - a.revenueCents || (a.productId < b.productId ? -1 : 1))
    .slice(0, 5);

  const slowMovers = products
    .filter((p) => isLive(p) && !(recent.get(p.id) || {}).units && nowMs - millis(p.createdAt) >= 14 * DAY_MS)
    .map((p) => ({ productId: p.id, name: nameOf(p), quantity: p.quantity ?? null, daysListed: Math.floor((nowMs - millis(p.createdAt)) / DAY_MS) }))
    .sort((a, b) => b.daysListed - a.daysListed || (a.productId < b.productId ? -1 : 1))
    .slice(0, 8);

  const lowStock = products
    .filter((p) => isLive(p) && p.quantity !== undefined && p.quantity !== null && Number(p.quantity) <= 5 && (recent.get(p.id) || {}).units > 0)
    .map((p) => {
      const perDay = recent.get(p.id).units / days;

      return { productId: p.id, name: nameOf(p), quantity: Number(p.quantity), daysLeft: Math.max(0, Math.floor(Number(p.quantity) / perDay)) };
    })
    .sort((a, b) => a.daysLeft - b.daysLeft || (a.productId < b.productId ? -1 : 1));

  return { days, bestSellers, slowMovers, lowStock };
}

// This month against last month.
function monthOverMonth(months) {
  const [last, current] = [months[months.length - 2], months[months.length - 1]];

  const change = (now, before) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);

  return {
    thisMonth: current,
    lastMonth: last || null,
    unitsChangePct: last ? change(current.units, last.units) : null,
    revenueChangePct: last ? change(current.revenueCents, last.revenueCents) : null,
  };
}

// ------------------------------------------------------------ price check

const median = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const MIN_COMPARABLE = 3;

// Each of the seller's listings against the middle price of similar listings from
// OTHER sellers in the same category. Only shown with at least 3 comparables, and
// only the median and a count are returned -- never another seller's listing.
//   marketProducts: [{ id, sellerId, category, price, quantity, hiddenByPlan }]
function priceCheck(sellerId, sellerProducts, marketProducts) {
  const byCategory = new Map();

  for (const product of marketProducts) {
    if (product.sellerId === sellerId || !isLive(product) || !(Number(product.price) > 0) || !product.category) continue;

    const key = String(product.category).toLowerCase();

    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(Number(product.price));
  }

  return sellerProducts
    .filter((p) => isLive(p) && Number(p.price) > 0 && p.category)
    .map((p) => {
      const comps = byCategory.get(String(p.category).toLowerCase()) || [];
      const base = { productId: p.id, name: p.name || "Untitled", price: Number(p.price), category: p.category };

      if (comps.length < MIN_COMPARABLE) return { ...base, position: "not_enough_data", comparable: comps.length };

      const mid = median(comps);
      const diffPct = Math.round(((base.price - mid) / mid) * 100);

      return { ...base, comparable: comps.length, median: Math.round(mid * 100) / 100, diffPct, position: diffPct <= -15 ? "below" : diffPct >= 15 ? "above" : "in_line" };
    })
    .sort((a, b) => Math.abs(b.diffPct || 0) - Math.abs(a.diffPct || 0) || (a.productId < b.productId ? -1 : 1));
}

// -------------------------------------------------------- customer interest

// What buyers are asking about and saying: messages TO the seller per listing in
// the last `days` days, and review count and average per listing.
function interest(products, messages, reviews, sellerId, nowMs, days = 30) {
  const since = nowMs - days * DAY_MS;
  const asked = new Map();
  const rated = new Map();

  for (const message of messages) {
    if (message.senderId === sellerId || millis(message.createdAt) < since || !message.productId) continue;

    asked.set(message.productId, (asked.get(message.productId) || 0) + 1);
  }

  for (const review of reviews) {
    if (!review.productId) continue;

    const current = rated.get(review.productId) || { count: 0, total: 0 };

    current.count += 1;
    current.total += Number(review.rating) || 0;
    rated.set(review.productId, current);
  }

  return products
    .map((p) => {
      const r = rated.get(p.id);

      return {
        productId: p.id,
        name: p.name || "Untitled",
        questions: asked.get(p.id) || 0,
        reviews: r ? r.count : 0,
        averageRating: r && r.count ? Math.round((r.total / r.count) * 10) / 10 : null,
      };
    })
    .filter((row) => row.questions > 0 || row.reviews > 0)
    .sort((a, b) => b.questions - a.questions || b.reviews - a.reviews || (a.productId < b.productId ? -1 : 1))
    .slice(0, 8);
}

// ------------------------------------------------------------- AI summary

// The compact, buyer-free facts handed to the AI. Nothing personal: no buyer
// names, addresses or order numbers -- only totals and listing names.
function summaryFacts(insights) {
  return {
    salesByMonth: insights.salesByMonth.map((m) => ({ month: m.label, units: m.units, revenue: Math.round(m.revenueCents) / 100, orders: m.orders })),
    bestSellers: insights.performance.bestSellers.map((p) => ({ name: p.name, units: p.units })),
    slowMovers: insights.performance.slowMovers.map((p) => ({ name: p.name, daysListed: p.daysListed })),
    lowStock: insights.performance.lowStock.map((p) => ({ name: p.name, left: p.quantity, daysLeft: p.daysLeft })),
    pricing: (insights.priceCheck || []).filter((p) => p.position !== "not_enough_data").map((p) => ({ name: p.name, price: p.price, marketMedian: p.median, position: p.position })),
    customerInterest: (insights.interest || []).map((p) => ({ name: p.name, questions: p.questions, reviews: p.reviews, averageRating: p.averageRating })),
  };
}

function summaryPrompt(facts) {
  return `You are a friendly, practical business coach for a small online seller on Lesovia, a marketplace.

Here are the seller's numbers (JSON). Use ONLY these numbers; do not invent any.

${JSON.stringify(facts)}

Write a short summary for the seller:
- One sentence on how sales are going compared with last month.
- 3 to 5 specific, actionable suggestions, each one line (what to do and why), such as restocking a low item, rethinking the price of a listing that is far above or below similar listings, or giving attention to a listing nobody is buying.
- Plain, encouraging language. No more than 160 words. No markdown headings.
If there isn't enough data for something, say so briefly instead of guessing.`;
}

module.exports = {
  DEFAULTS,
  TIER_ORDER,
  resolveConfig,
  purchasedTier,
  effectiveTier,
  hasTier,
  countsAsSale,
  salesByMonth,
  productSales,
  isLive,
  performance,
  monthOverMonth,
  priceCheck,
  interest,
  summaryFacts,
  summaryPrompt,
  MIN_COMPARABLE,
};
