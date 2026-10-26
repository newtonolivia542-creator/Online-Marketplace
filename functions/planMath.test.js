const test = require("node:test");
const assert = require("node:assert/strict");

const pm = require("./planMath");

const cfg = pm.resolveConfig(null);
const BEFORE = Date.parse("2026-12-01T12:00:00Z");
const AFTER = Date.parse("2027-11-01T06:00:00Z"); // 01:00 Central on Nov 1, 2027
const LAST_MINUTE = Date.parse("2027-11-01T04:59:00Z"); // 23:59 Central on Oct 31

const product = (id, extra = {}) => ({ id, quantity: 3, createdAt: Date.parse("2026-11-01T00:00:00Z") + Number(id.replace(/\D/g, "") || 0), ...extra });
const many = (n) => Array.from({ length: n }, (_, i) => product(`p${String(i + 1).padStart(3, "0")}`));

test("config: defaults, and bad fields fall back one at a time", () => {
  assert.equal(cfg.freeLimitDuringFreeYear, 15);
  assert.equal(cfg.freeLimitAfter, 10);
  assert.equal(cfg.tiers.plus.maxItems, 35);
  assert.equal(cfg.tiers.plus.priceCents, 2000);
  assert.equal(cfg.tiers.unlimited.maxItems, null);
  assert.equal(cfg.tiers.unlimited.priceCents, 5000);
  assert.equal(cfg.tiers.pro.priceCents, 3500);

  const odd = pm.resolveConfig({ freeLimitAfter: "ten", freeLimitDuringFreeYear: 20, freeYearEndsAt: "not a date", tiers: { pro: { priceCents: 4000, maxItems: -1 } } });

  assert.equal(odd.freeLimitAfter, 10);
  assert.equal(odd.freeLimitDuringFreeYear, 20);
  assert.equal(odd.freeYearEndsAt, "2027-11-01T05:00:00.000Z");
  assert.equal(odd.tiers.pro.priceCents, 4000);
  assert.equal(odd.tiers.pro.maxItems, 50);
});

test("free allowance: 15 until Nov 1 2027 (Central), then 10 for everyone", () => {
  assert.equal(pm.limitFor("free", cfg, BEFORE), 15);
  assert.equal(pm.limitFor("free", cfg, LAST_MINUTE), 15);
  assert.equal(pm.limitFor("free", cfg, AFTER), 10);
});

test("paid plans are totals, so the free drop never changes them", () => {
  for (const when of [BEFORE, AFTER]) {
    assert.equal(pm.limitFor("plus", cfg, when), 35);
    assert.equal(pm.limitFor("pro", cfg, when), 50);
    assert.equal(pm.limitFor("unlimited", cfg, when), Infinity);
  }
});

test("a paid plan is never worth less than the free allowance", () => {
  const tiny = pm.resolveConfig({ tiers: { plus: { maxItems: 5 } } });

  assert.equal(pm.limitFor("plus", tiny, BEFORE), 15);
});

test("effectivePlan: paid while active, trialing or past_due; free otherwise", () => {
  assert.equal(pm.effectivePlan(null), "free");
  assert.equal(pm.effectivePlan({ plan: "pro", status: "active" }), "pro");
  assert.equal(pm.effectivePlan({ plan: "pro", status: "trialing" }), "pro");
  assert.equal(pm.effectivePlan({ plan: "pro", status: "past_due" }), "pro");
  assert.equal(pm.effectivePlan({ plan: "pro", status: "canceled" }), "free");
  assert.equal(pm.effectivePlan({ plan: "pro", status: "unpaid" }), "free");
  assert.equal(pm.effectivePlan({ plan: "pro", status: "incomplete" }), "free");
  assert.equal(pm.effectivePlan({ plan: "platinum", status: "active" }), "free");
});

test("visibility: within the limit nothing changes", () => {
  assert.deepEqual(pm.planVisibility(many(15), 15), { hide: [], show: [] });
  assert.deepEqual(pm.planVisibility([], 10), { hide: [], show: [] });
});

test("visibility: over the limit hides the NEWEST, keeps the oldest", () => {
  const out = pm.planVisibility(many(15), 10);

  assert.deepEqual(out.hide, ["p011", "p012", "p013", "p014", "p015"]);
  assert.deepEqual(out.show, []);
});

test("visibility: sold-out listings don't count and are never hidden by the plan", () => {
  const items = [...many(10), product("p900", { quantity: 0 }), product("p901", { quantity: 0 })];

  assert.deepEqual(pm.planVisibility(items, 10), { hide: [], show: [] });
});

test("visibility: room appearing brings the OLDEST hidden listings back first", () => {
  const items = many(12).map((p, i) => ({ ...p, hiddenByPlan: i >= 8 })); // 8 visible, 4 hidden

  assert.deepEqual(pm.planVisibility(items, 10), { hide: [], show: ["p009", "p010"] });
  assert.deepEqual(pm.planVisibility(items, Infinity).show, ["p009", "p010", "p011", "p012"]);
});

test("visibility: hiding a sold-out listing's flag is left alone", () => {
  const items = [...many(3), product("p800", { quantity: 0, hiddenByPlan: true })];

  assert.deepEqual(pm.planVisibility(items, 10), { hide: [], show: [] });
});

test("visibility: a listing with no createdAt counts as oldest; ties break on id", () => {
  const items = [
    { id: "b", quantity: 1, createdAt: null },
    { id: "a", quantity: 1, createdAt: null },
    { id: "c", quantity: 1, createdAt: { toMillis: () => 5 } },
  ];

  assert.deepEqual(pm.planVisibility(items, 2).hide, ["c"]);
});

test("visibility: createdAt may be a Firestore Timestamp, {seconds} or a Date", () => {
  const items = [
    { id: "x1", quantity: 1, createdAt: { seconds: 300 } },
    { id: "x2", quantity: 1, createdAt: new Date(100 * 1000) },
    { id: "x3", quantity: 1, createdAt: { toMillis: () => 200 * 1000 } },
  ];

  assert.deepEqual(pm.planVisibility(items, 1).hide, ["x3", "x1"]);
});

test("choice: validates ownership, duplicates and the limit", () => {
  const items = [...many(12), product("p900", { quantity: 0 })];

  assert.equal(pm.validateChoice(["p001", "p002"], items, 10), null);
  assert.match(pm.validateChoice("p001", items, 10), /Choose/);
  assert.match(pm.validateChoice(["p001", "p001"], items, 10), /twice/);
  assert.match(pm.validateChoice(["nope"], items, 10), /isn't one of your/);
  assert.match(pm.validateChoice(["p900"], items, 10), /isn't one of your/); // sold out
  assert.match(pm.validateChoice(many(11).map((p) => p.id), items, 10), /allows 10/);
});

test("choice: applying it shows what was picked and hides the rest", () => {
  const items = many(5).map((p, i) => ({ ...p, hiddenByPlan: i >= 3 })); // p001-3 visible, p004-5 hidden

  const out = pm.applyChoice(["p001", "p004", "p005"], items);

  assert.deepEqual(out.hide.sort(), ["p002", "p003"]);
  assert.deepEqual(out.show.sort(), ["p004", "p005"]);
});

test("downgrade: blocked until under the lower limit, with a clear count", () => {
  assert.equal(pm.downgradeError(30, "plus", cfg, BEFORE), null);
  assert.equal(pm.downgradeError(35, "plus", cfg, BEFORE), null);
  assert.match(pm.downgradeError(40, "plus", cfg, BEFORE), /allows 35 .* you have 40\. Hide or remove 5/);
  assert.match(pm.downgradeError(12, "free", cfg, AFTER), /allows 10 .* Hide or remove 2/);
  assert.equal(pm.downgradeError(500, "unlimited", cfg, BEFORE), null);
});

test("status summary for the plan page", () => {
  const products = [...many(12).map((p, i) => ({ ...p, hiddenByPlan: i >= 10 })), product("p900", { quantity: 0 })];

  assert.deepEqual(pm.planStatus({ planDoc: null, products, cfg, nowMs: AFTER }), {
    plan: "free",
    limit: 10,
    liveCount: 10,
    hiddenCount: 2,
    freeLimitNow: 10,
    freeLimitAfter: 10,
    freeYearEndsAt: "2027-11-01T05:00:00.000Z",
    inFreeYear: false,
  });

  const unlimited = pm.planStatus({ planDoc: { plan: "unlimited", status: "active" }, products, cfg, nowMs: BEFORE });

  assert.equal(unlimited.limit, null);
  assert.equal(unlimited.inFreeYear, true);
});

test("days until the free year ends", () => {
  assert.equal(pm.daysUntilFreeYearEnds(cfg, Date.parse("2027-09-02T05:00:00Z")), 60);
  assert.equal(pm.daysUntilFreeYearEnds(cfg, Date.parse("2027-10-02T05:00:00Z")), 30);
  assert.equal(pm.daysUntilFreeYearEnds(cfg, Date.parse("2027-10-25T05:00:00Z")), 7);
  assert.equal(pm.daysUntilFreeYearEnds(cfg, AFTER), null);
});
