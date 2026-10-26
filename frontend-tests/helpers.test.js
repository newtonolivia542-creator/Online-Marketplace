// Tests for the pure helpers in public/js/helpers.js (the browser code
// imports these as an ES module, so they're loaded the same way here).
//
//   npm run test:frontend

const test = require("node:test");
const assert = require("node:assert/strict");

let h;
test.before(async () => {
  h = await import("../public/js/helpers.js");
});

test("normalizePhone: US numbers in any common format become E.164", () => {
  for (const typed of ["(712) 555-0123", "712-555-0123", "712.555.0123", "7125550123", " 712 555 0123 ", "1 712 555 0123", "17125550123", "+1 (712) 555-0123", "+17125550123"]) {
    assert.equal(h.normalizePhone(typed), "+17125550123", typed);
  }
});

test("normalizePhone: international numbers need their + and country code", () => {
  assert.equal(h.normalizePhone("+231 77 123 4567"), "+231771234567");
  assert.equal(h.normalizePhone("+44 7911 123456"), "+447911123456");
  assert.equal(h.normalizePhone("231771234567"), null, "no + and not a US length -> refused, not guessed");
});

test("normalizePhone: junk and wrong lengths are refused", () => {
  for (const bad of ["", "   ", "abc", "12345", "712555012", "+0123456789", "+1", "+1234567890123456789", null, undefined, 7125550123, {}]) {
    assert.equal(h.normalizePhone(bad), null, String(bad));
  }
});

test("maskPhone: shows only the last four digits, never the whole number", () => {
  assert.equal(h.maskPhone("+17125550123"), "ending in 0123");
  assert.doesNotMatch(h.maskPhone("+17125550123"), /712|555/);
  assert.equal(h.maskPhone(""), "");
  assert.equal(h.maskPhone(null), "");
  assert.equal(h.maskPhone("+12"), "");
});

test("phoneAuthErrorMessage: known Firebase codes become plain advice; unknown ones get a safe default", () => {
  assert.match(h.phoneAuthErrorMessage({ code: "auth/invalid-verification-code" }), /isn't right/);
  assert.match(h.phoneAuthErrorMessage({ code: "auth/too-many-requests" }), /wait a few minutes/);
  assert.match(h.phoneAuthErrorMessage({ code: "auth/credential-already-in-use" }), /already used by another/);
  assert.match(h.phoneAuthErrorMessage({ code: "auth/requires-recent-login" }), /log back in/);
  assert.match(h.phoneAuthErrorMessage({ code: "auth/quota-exceeded" }), /support@lesovia\.com/);
  assert.equal(h.phoneAuthErrorMessage({ code: "auth/who-knows" }), "Something went wrong. Please try again.");
  assert.equal(h.phoneAuthErrorMessage(null), "Something went wrong. Please try again.");
  assert.equal(h.phoneAuthErrorMessage(new Error("raw internal text")), "Something went wrong. Please try again.", "raw error text is never shown to a user");
});

test("page access: every seller page needs a seller, every buyer page a buyer, longest name wins", () => {
  assert.equal(h.requiredRoleForPage("/seller-returns.html"), "seller");
  assert.equal(h.requiredRoleForPage("/seller dashboard.html"), "seller");
  assert.equal(h.requiredRoleForPage("/seller-messages.html"), "seller", "not mistaken for the buyer's messages.html");
  assert.equal(h.requiredRoleForPage("/seller-reviews.html"), "seller", "not mistaken for the buyer's reviews.html");
  assert.equal(h.requiredRoleForPage("/messages.html"), "buyer");
  assert.equal(h.requiredRoleForPage("/order.html"), "buyer");
  assert.equal(h.requiredRoleForPage("/login.html"), null);
  assert.equal(h.requiredRoleForPage("/contact.html"), null);
  assert.equal(h.homeForRole("seller"), "seller dashboard.html");
  assert.equal(h.homeForRole("admin"), "admin.html");
  assert.equal(h.homeForRole("buyer"), "buyer dashboard.html");
});

test("seller plans: the plan page needs a seller; prices, limits and dates read plainly", () => {
  assert.equal(h.requiredRoleForPage("/seller-plan.html"), "seller");

  assert.equal(h.planPrice(2000), "$20");
  assert.equal(h.planPrice(3500), "$35");
  assert.equal(h.planPrice(1999), "$19.99");

  assert.equal(h.listingLimitText(15), "15 live listings");
  assert.equal(h.listingLimitText(1), "1 live listing");
  assert.equal(h.listingLimitText(null), "Unlimited listings");

  assert.equal(h.planDateText("2027-11-01T05:00:00.000Z"), "Nov 1, 2027", "Nov 1 in Central, not Oct 31");
  assert.equal(h.planDateText("nonsense"), "");
});


test("promoted listings: isPromotedProduct and promotionState", () => {
  const NOW = Date.parse("2026-11-10T12:00:00Z");
  const DAY = 86400000;
  const until = (days) => new Date(NOW + days * DAY);

  assert.equal(h.isPromotedProduct({ promotedUntil: until(3) }, NOW), true);
  assert.equal(h.isPromotedProduct({ promotedUntil: until(-1) }, NOW), false);
  assert.equal(h.isPromotedProduct({}, NOW), false);
  assert.equal(h.isPromotedProduct({ promotedUntil: { seconds: (NOW + DAY) / 1000 } }, NOW), true, "a Firestore Timestamp shape");
  assert.equal(h.isPromotedProduct(null, NOW), false);

  assert.deepEqual(h.promotionState({ quantity: 3 }, NOW), { promoted: false, untilMs: 0, canPromote: true });
  assert.equal(h.promotionState({ quantity: 3, promotedUntil: until(20) }, NOW).canPromote, false, "20 days left: too early to renew");
  assert.equal(h.promotionState({ quantity: 3, promotedUntil: until(20) }, NOW).promoted, true);
  assert.equal(h.promotionState({ quantity: 3, promotedUntil: until(7) }, NOW).canPromote, true, "renewable in the last 7 days");
  assert.equal(h.promotionState({ quantity: 3, promotedUntil: until(-2) }, NOW).canPromote, true, "ended");
  assert.equal(h.promotionState({ quantity: 0 }, NOW).canPromote, false, "sold out");
  assert.equal(h.promotionState({ quantity: 3, hiddenByPlan: true }, NOW).canPromote, false, "hidden");
});

test("promoted listings: arrangeListings lifts at most one in four, keeps everything else in order", () => {
  const NOW = Date.parse("2026-11-10T12:00:00Z");
  const future = new Date(NOW + 86400000);
  const item = (id, promoted = false) => ({ id, ...(promoted ? { promotedUntil: future } : {}) });
  const ids = (list) => list.map((p) => p.id).join(" ");

  // Nothing promoted: untouched (same array).
  const plain = ["a", "b", "c", "d", "e"].map((id) => item(id));
  assert.equal(h.arrangeListings(plain, NOW), plain);

  // One promoted at the back goes to the top; the others keep their order.
  const one = ["a", "b", "c", "d", "e", "f"].map((id) => item(id, id === "f"));
  assert.equal(ids(h.arrangeListings(one, NOW)), "f a b c d e");

  // 8 listings, 5 promoted: only ceil(8/4)=2 get the boosted spots (1st and 5th), the rest stay where they were.
  const many = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => item(id, ["b", "c", "e", "g", "h"].includes(id)));
  const arranged = h.arrangeListings(many, NOW, 0);

  assert.equal(arranged.length, 8);
  assert.equal(new Set(arranged.map((p) => p.id)).size, 8, "nothing lost or duplicated");
  assert.equal(arranged[0].id, "b");
  assert.equal(arranged[4].id, "c");
  assert.equal(ids(arranged.filter((_, i) => i % 4 !== 0)), "a d e f g h".split(" ").filter((id) => !["b", "c"].includes(id)).join(" ") || "", "non-boosted keep their relative order");

  // The seed rotates which promoted listings win the spots.
  assert.notEqual(h.arrangeListings(many, NOW, 0)[0].id, h.arrangeListings(many, NOW, 1)[0].id);

  // Empty and bad input are safe.
  assert.deepEqual(h.arrangeListings([], NOW), []);
  assert.deepEqual(h.arrangeListings(null, NOW), []);
});
