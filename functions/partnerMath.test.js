const test = require("node:test");
const assert = require("node:assert/strict");

const pm = require("./partnerMath");

const ID = "abcdefghijklmnop1234";
const imageOk = pm.isOwnImage("bucket.test", ID);
const good = () => ({
  advertiserName: "  Acme Hardware  ",
  linkUrl: "https://acme.example.com/sale?utm=lesovia",
  placements: ["home", "buyer", "home", "seller"],
  startDate: "2026-11-10",
  endDate: "2026-12-10",
  status: "active",
  imageUrl: pm.imageUrlFor("bucket.test", ID, "image.png"),
  advertiserEmail: "owner@acme.example.com",
  priceCents: 15000,
  notes: "paid by check",
});

test("centralMs: a day starts and ends at midnight Central, across the daylight-saving change", () => {
  // Clocks fall back on Nov 1 2026 at 2am: that day starts on CDT (UTC-5) and ends on CST (UTC-6).
  assert.equal(new Date(pm.startOfDay("2026-11-01")).toISOString(), "2026-11-01T05:00:00.000Z");
  assert.equal(new Date(pm.endOfDay("2026-11-01")).toISOString(), "2026-11-02T05:59:59.999Z");
  assert.equal(new Date(pm.startOfDay("2026-11-10")).toISOString(), "2026-11-10T06:00:00.000Z");
  assert.equal(new Date(pm.endOfDay("2026-12-31")).toISOString(), "2027-01-01T05:59:59.999Z");
  // After the change it is CST all winter; clocks spring forward on Mar 14 2027.
  assert.equal(new Date(pm.startOfDay("2026-11-08")).toISOString(), "2026-11-08T06:00:00.000Z");
  assert.equal(new Date(pm.startOfDay("2027-03-14")).toISOString(), "2027-03-14T06:00:00.000Z");
  assert.equal(new Date(pm.startOfDay("2027-03-15")).toISOString(), "2027-03-15T05:00:00.000Z");
});

test("isRealDate: only real YYYY-MM-DD dates", () => {
  assert.equal(pm.isRealDate("2026-11-10"), true);
  assert.equal(pm.isRealDate("2028-02-29"), true);
  assert.equal(pm.isRealDate("2027-02-29"), false);
  assert.equal(pm.isRealDate("2026-13-01"), false);
  assert.equal(pm.isRealDate("11/10/2026"), false);
  assert.equal(pm.isRealDate(""), false);
  assert.equal(pm.isRealDate(null), false);
});

test("cleanLink: https only, a real host, no credentials, not huge", () => {
  assert.equal(pm.cleanLink("https://acme.example.com/sale?x=1"), "https://acme.example.com/sale?x=1");
  assert.equal(pm.cleanLink("  https://acme.example.com  "), "https://acme.example.com/");
  for (const bad of ["http://acme.example.com", "javascript:alert(1)", "data:text/html,hi", "//acme.example.com", "https://user:pw@acme.example.com", "https://localhost", "acme.com", "", null, 5, `https://a.com/${"x".repeat(600)}`]) {
    assert.equal(pm.cleanLink(bad), null, String(bad));
  }
});

test("validateSpot: a good spot is cleaned and split into public and private parts", () => {
  const out = pm.validateSpot(good(), imageOk);

  assert.equal(out.error, undefined);
  assert.equal(out.value.publicDoc.advertiserName, "Acme Hardware");
  assert.deepEqual(out.value.publicDoc.placements, ["home", "buyer", "seller"]);
  assert.equal(out.value.publicDoc.startsAtMs, pm.startOfDay("2026-11-10"));
  assert.equal(out.value.publicDoc.endsAtMs, pm.endOfDay("2026-12-10"));
  assert.deepEqual(out.value.privateDoc, { advertiserEmail: "owner@acme.example.com", priceCents: 15000, notes: "paid by check" });
  assert.equal("advertiserEmail" in out.value.publicDoc, false, "private details never go in the public document");
  assert.equal("priceCents" in out.value.publicDoc, false);
});

test("validateSpot: every kind of bad input gets a plain message", () => {
  const check = (patch, pattern) => {
    const out = pm.validateSpot({ ...good(), ...patch }, imageOk);

    assert.match(out.error || "", pattern, JSON.stringify(patch));
  };

  check({ advertiserName: "  " }, /advertiser's name/);
  check({ advertiserName: "x".repeat(81) }, /advertiser's name/);
  check({ linkUrl: "http://acme.com" }, /https/);
  check({ placements: [] }, /where/);
  check({ placements: ["checkout"] }, /where/);
  check({ placements: ["cart"] }, /where/);
  check({ placements: ["seller-orders"] }, /where/);
  check({ placements: "home" }, /where/);
  check({ startDate: "soon" }, /start date/);
  check({ endDate: "2026-11-09" }, /before the start/);
  check({ endDate: "2028-12-10" }, /at most a year/);
  check({ status: "deleted" }, /Active or Paused/);
  check({ imageUrl: "https://evil.example.com/pixel.gif" }, /image first/);
  check({ imageUrl: pm.imageUrlFor("bucket.test", "someone-elses-id-0000", "image.png") }, /image first/);
  check({ advertiserEmail: "not an email" }, /email/);
  check({ priceCents: -5 }, /price/);
  check({ priceCents: 12.5 }, /price/);
  check({ priceCents: 99999999 }, /price/);
});

test("validateSpot: email, price and notes are optional", () => {
  const out = pm.validateSpot({ ...good(), advertiserEmail: "", priceCents: "", notes: undefined }, imageOk);

  assert.deepEqual(out.value.privateDoc, { advertiserEmail: "", priceCents: 0, notes: "" });
});

test("spotState: paused, scheduled, live, ended (both end days included)", () => {
  const spot = { status: "active", startsAtMs: pm.startOfDay("2026-11-10"), endsAtMs: pm.endOfDay("2026-12-10"), placements: ["home"], id: "a" };

  assert.equal(pm.spotState({ ...spot, status: "paused" }, spot.startsAtMs), "paused");
  assert.equal(pm.spotState(spot, spot.startsAtMs - 1), "scheduled");
  assert.equal(pm.spotState(spot, spot.startsAtMs), "live");
  assert.equal(pm.spotState(spot, spot.endsAtMs), "live", "the last day is included");
  assert.equal(pm.spotState(spot, spot.endsAtMs + 1), "ended");
});

test("pickSpot: only live spots in that placement; random among several; none -> null", () => {
  const NOW = pm.startOfDay("2026-11-20");
  const mk = (id, extra = {}) => ({ id, status: "active", startsAtMs: NOW - 1000, endsAtMs: NOW + 1000, placements: ["home"], ...extra });
  const spots = [
    mk("b"), mk("a"), mk("c", { placements: ["buyer"] }), mk("d", { status: "paused" }), mk("e", { endsAtMs: NOW - 1 }), mk("f", { startsAtMs: NOW + 1 }),
  ];

  assert.equal(pm.pickSpot(spots, "home", NOW, 0).id, "a");
  assert.equal(pm.pickSpot(spots, "home", NOW, 0.99).id, "b");
  assert.equal(pm.pickSpot(spots, "buyer", NOW, 0.5).id, "c");
  assert.equal(pm.pickSpot(spots, "checkout", NOW, 0.5), null);
  assert.equal(pm.pickSpot([mk("s", { placements: ["seller"] })], "seller", NOW, 0.5).id, "s");
  assert.equal(pm.pickSpot([mk("s", { placements: ["seller"] })], "buyer", NOW, 0.5), null, "a seller-only banner never shows to buyers");
  assert.equal(pm.pickSpot([], "home", NOW), null);
});

test("ctrPercent: one decimal, null with no views", () => {
  assert.equal(pm.ctrPercent(200, 5), 2.5);
  assert.equal(pm.ctrPercent(3, 1), 33.3);
  assert.equal(pm.ctrPercent(0, 0), null);
  assert.equal(pm.ctrPercent(10, 0), 0);
});

test("images: only ones stored for that spot under partners/{id}/ are accepted", () => {
  const url = pm.imageUrlFor("bucket.test", ID, "image.png");

  assert.equal(url, "https://firebasestorage.googleapis.com/v0/b/bucket.test/o/partners%2Fabcdefghijklmnop1234%2Fimage.png?alt=media");
  assert.equal(pm.isOwnImage("bucket.test", ID)(url), true);
  assert.equal(pm.isOwnImage("other.bucket", ID)(url), false);
  assert.equal(pm.isOwnImage("bucket.test", "zzzzzzzzzzzzzzzzzzzz")(url), false);
  assert.equal(pm.isOwnImage("bucket.test", ID)(`${url}&token=1`), false);
  assert.equal(pm.isOwnImage("bucket.test", ID)(null), false);
});

test("spot ids and image types", () => {
  assert.equal(pm.SPOT_ID.test(ID), true);
  assert.equal(pm.SPOT_ID.test("short"), false);
  assert.equal(pm.SPOT_ID.test("has/slash/in/it/xxxxxxxxxx"), false);
  assert.deepEqual(Object.keys(pm.IMAGE_TYPES), ["image/png", "image/jpeg", "image/webp"]);
});
