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
