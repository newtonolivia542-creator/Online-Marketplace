// Partner banners (paid advertising sold directly to businesses). Pure functions
// only -- no Firebase, Stripe or clock of their own -- so the rules can be tested
// exactly; partners.js does the reading, writing, uploading and invoicing.
//
// Naming: everything is called "partner" on purpose. Ad blockers hide page
// elements and block requests whose names contain words like ad, banner, sponsor
// or promo, which would hide the very thing an advertiser paid for. The visible
// label buyers read is still "Advertisement".
//
// The rules (decided with the owner):
//   * A spot is an image + an https link, shown on chosen placements between two
//     dates (US Central, both days included), unless paused.
//   * Placements are the public homepage, the buyer dashboard and the seller
//     dashboard, in any combination (an advertiser can buy one, two or all three).
//     Never checkout, the cart, or any other seller page.
//   * Only images Lesovia itself stored for that spot are shown (no third-party
//     image URLs, no tracking pixels).

const PLACEMENTS = ["home", "buyer", "seller"];
const STATUSES = ["active", "paused"];

const DAY_MS = 86400000;
const MAX_DAYS = 366;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Milliseconds for a wall-clock moment in US Central ("2026-11-01" at 00:00:00).
// Works across the daylight-saving change by correcting for the zone's offset at
// that moment.
function centralMs(dateStr, hour = 0, minute = 0, second = 0, millisecond = 0) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);

  const offsetAt = (instant) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(instant)).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});

    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(instant / 1000) * 1000;
  };

  let result = guess - offsetAt(guess);

  // Re-check once: the offset can differ right at the daylight-saving boundary.
  result = guess - offsetAt(result);

  return result;
}

const startOfDay = (dateStr) => centralMs(dateStr, 0, 0, 0, 0);
const endOfDay = (dateStr) => centralMs(dateStr, 23, 59, 59, 999);

function isRealDate(dateStr) {
  if (typeof dateStr !== "string" || !DATE_ONLY.test(dateStr)) return false;

  const [year, month, day] = dateStr.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));

  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

// An https link with a real host, no credentials in it, not too long. Returns the
// cleaned URL string, or null.
function cleanLink(value) {
  if (typeof value !== "string" || value.length > 500) return null;

  let url;

  try {
    url = new URL(value.trim());
  } catch (error) {
    return null;
  }

  if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) return null;

  return url.toString();
}

const looksLikeEmail = (value) => typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 200;

// Checks what the admin typed. Returns { error } or { value } (cleaned). `imageOk`
// is decided by the caller (it knows which image URLs Lesovia itself stored).
function validateSpot(input, imageOk) {
  const i = input && typeof input === "object" ? input : {};

  const advertiserName = typeof i.advertiserName === "string" ? i.advertiserName.trim() : "";

  if (!advertiserName || advertiserName.length > 80) return { error: "Enter the advertiser's name (up to 80 characters)." };

  const linkUrl = cleanLink(i.linkUrl);

  if (!linkUrl) return { error: "The link must be a full https:// web address." };

  const placements = Array.isArray(i.placements) ? [...new Set(i.placements)] : [];

  if (placements.length === 0 || !placements.every((p) => PLACEMENTS.includes(p))) return { error: "Choose where it should show." };

  if (!isRealDate(i.startDate) || !isRealDate(i.endDate)) return { error: "Choose a start date and an end date." };

  const startsAtMs = startOfDay(i.startDate);
  const endsAtMs = endOfDay(i.endDate);

  if (endsAtMs < startsAtMs) return { error: "The end date can't be before the start date." };
  if ((endsAtMs - startsAtMs) / DAY_MS > MAX_DAYS) return { error: "A banner can run for at most a year at a time." };

  if (!STATUSES.includes(i.status)) return { error: "Choose Active or Paused." };

  if (!imageOk(i.imageUrl)) return { error: "Upload the banner image first." };

  const advertiserEmail = i.advertiserEmail ? String(i.advertiserEmail).trim() : "";

  if (advertiserEmail && !looksLikeEmail(advertiserEmail)) return { error: "That advertiser email doesn't look right." };

  const priceCents = i.priceCents === undefined || i.priceCents === null || i.priceCents === "" ? 0 : Number(i.priceCents);

  if (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 1000000) return { error: "The price must be a whole number of cents, up to $10,000." };

  const notes = typeof i.notes === "string" ? i.notes.trim().slice(0, 500) : "";

  return {
    value: {
      publicDoc: { advertiserName, linkUrl, placements, startsAtMs, endsAtMs, status: i.status, imageUrl: i.imageUrl, startDate: i.startDate, endDate: i.endDate },
      privateDoc: { advertiserEmail, priceCents, notes },
    },
  };
}

// 'paused' | 'scheduled' | 'live' | 'ended'
function spotState(spot, nowMs) {
  if (spot.status !== "active") return "paused";
  if (nowMs < spot.startsAtMs) return "scheduled";
  if (nowMs > spot.endsAtMs) return "ended";

  return "live";
}

// The spot to show in a placement right now: one at random among those live
// there. `rand` is injectable (0 <= rand < 1) so tests are exact.
function pickSpot(spots, placement, nowMs, rand = Math.random()) {
  const live = spots
    .filter((spot) => Array.isArray(spot.placements) && spot.placements.includes(placement) && spotState(spot, nowMs) === "live")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (live.length === 0) return null;

  return live[Math.min(live.length - 1, Math.floor(rand * live.length))];
}

// Click-through rate as a percent with one decimal ("2.5"), or null with no views.
function ctrPercent(views, clicks) {
  if (!views) return null;

  return Math.round((clicks / views) * 1000) / 10;
}

// Which images may be shown: only ones stored for THIS spot under partners/{id}/.
function imageUrlFor(bucketName, id, fileName) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(`partners/${id}/${fileName}`)}?alt=media`;
}

const isOwnImage = (bucketName, id) => (url) =>
  typeof url === "string" && url.startsWith(`https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(`partners/${id}/`)}`) && url.endsWith("?alt=media");

const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const MAX_IMAGE_BYTES = 1500000;

const SPOT_ID = /^[A-Za-z0-9_-]{16,64}$/;

module.exports = {
  PLACEMENTS,
  STATUSES,
  DAY_MS,
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  SPOT_ID,
  centralMs,
  startOfDay,
  endOfDay,
  isRealDate,
  cleanLink,
  validateSpot,
  spotState,
  pickSpot,
  ctrPercent,
  imageUrlFor,
  isOwnImage,
};
