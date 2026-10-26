const test = require("node:test");
const assert = require("node:assert/strict");

const pm = require("./promoMath");

const cfg = pm.resolveConfig(null);
const NOW = Date.parse("2026-11-10T15:00:00Z");
const DAY = pm.DAY_MS;

test("config: $5 for 30 days, renew in the last 7, allowances by plan; bad fields fall back one at a time", () => {
  assert.equal(cfg.priceCents, 500);
  assert.equal(cfg.days, 30);
  assert.equal(cfg.renewWindowDays, 7);
  assert.deepEqual(cfg.allowancePerMonth, { free: 0, plus: 0, pro: 1, unlimited: 3 });

  const odd = pm.resolveConfig({ priceCents: "five", days: 14, renewWindowDays: -2, allowancePerMonth: { pro: 2, unlimited: "lots", free: 1.5 } });

  assert.equal(odd.priceCents, 500);
  assert.equal(odd.days, 14);
  assert.equal(odd.renewWindowDays, 7);
  assert.deepEqual(odd.allowancePerMonth, { free: 0, plus: 0, pro: 2, unlimited: 3 });
});

test("untilMillis reads a Timestamp, {seconds}, a Date, a number, or nothing", () => {
  assert.equal(pm.untilMillis(null), 0);
  assert.equal(pm.untilMillis(undefined), 0);
  assert.equal(pm.untilMillis({ toMillis: () => 5 }), 5);
  assert.equal(pm.untilMillis({ seconds: 7 }), 7000);
  assert.equal(pm.untilMillis(new Date(9000)), 9000);
  assert.equal(pm.untilMillis(12345), 12345);
  assert.equal(pm.untilMillis("garbage"), 0);
});

test("isPromoted: only while the end time is in the future", () => {
  assert.equal(pm.isPromoted(NOW + 1, NOW), true);
  assert.equal(pm.isPromoted(NOW, NOW), false);
  assert.equal(pm.isPromoted(0, NOW), false);
});

test("eligibleListing: own, in stock, not hidden", () => {
  const ok = { sellerId: "s1", quantity: 3 };

  assert.equal(pm.eligibleListing(ok, "s1"), null);
  assert.equal(pm.eligibleListing({ sellerId: "s1" }, "s1"), null, "no quantity field counts as in stock");
  assert.match(pm.eligibleListing(ok, "s2"), /your own/);
  assert.match(pm.eligibleListing({ ...ok, quantity: 0 }, "s1"), /Sold-out/);
  assert.match(pm.eligibleListing({ ...ok, hiddenByPlan: true }, "s1"), /Hidden/);
  assert.match(pm.eligibleListing(null, "s1"), /doesn't exist/);
});

test("canPromote: new or ended, or in the last 7 days, yes; further out, no", () => {
  assert.equal(pm.canPromote(0, NOW, cfg), null);
  assert.equal(pm.canPromote(NOW - DAY, NOW, cfg), null, "ended yesterday");
  assert.equal(pm.canPromote(NOW + 7 * DAY, NOW, cfg), null, "exactly 7 days left");
  assert.match(pm.canPromote(NOW + 7 * DAY + 1, NOW, cfg), /already promoted \(8 days left\)/);
  assert.match(pm.canPromote(NOW + 29 * DAY, NOW, cfg), /29 days left/);
});

test("newUntil: starts now if not running, otherwise adds to what is left", () => {
  assert.equal(pm.newUntil(0, NOW, 30), NOW + 30 * DAY);
  assert.equal(pm.newUntil(NOW - 5 * DAY, NOW, 30), NOW + 30 * DAY, "ended -> starts from now");
  assert.equal(pm.newUntil(NOW + 3 * DAY, NOW, 30), NOW + 33 * DAY, "renewing early loses nothing");
});

test("monthKey: the calendar month in US Central, so the allowance resets at Central midnight", () => {
  assert.equal(pm.monthKey(Date.parse("2026-11-10T15:00:00Z")), "2026-11");
});

test("monthKey: the boundary falls at midnight Central", () => {
  // Dec 1 00:00 CST (UTC-6 in winter) is 06:00Z.
  assert.equal(pm.monthKey(Date.parse("2026-12-01T05:59:00Z")), "2026-11");
  assert.equal(pm.monthKey(Date.parse("2026-12-01T06:00:00Z")), "2026-12");
});

test("allowanceLeft: per plan, never negative", () => {
  assert.equal(pm.allowanceLeft("free", 0, cfg), 0);
  assert.equal(pm.allowanceLeft("plus", 0, cfg), 0);
  assert.equal(pm.allowanceLeft("pro", 0, cfg), 1);
  assert.equal(pm.allowanceLeft("pro", 1, cfg), 0);
  assert.equal(pm.allowanceLeft("pro", 5, cfg), 0);
  assert.equal(pm.allowanceLeft("unlimited", 1, cfg), 2);
  assert.equal(pm.allowanceLeft("mystery", 0, cfg), 0);
});
