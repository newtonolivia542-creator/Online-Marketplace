// Promoted listings, seller side: the Promote / Renew buttons on the dashboard's
// listing cards, and the return from Stripe checkout. The server decides
// whether a listing can be promoted and what it costs; this only asks and shows.
//
// Wires itself only if the current page has the seller's listings, so it is safe
// to load on every page (app.js imports it).

import { plansApi } from "./plans.js";
import { planDateText } from "./helpers.js";

function notice(text, isError = false) {
  const box = document.getElementById("promoNotice");

  if (!box) return;

  box.textContent = text;
  box.className = `promo-notice ${isError ? "plan-error" : "plan-ok"}`;
  box.style.display = "block";
  box.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

const priceText = (cents) => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

async function promote(button) {
  const productId = button.dataset.promote;
  const name = button.dataset.name || "this listing";
  const label = button.textContent;

  button.disabled = true;
  button.textContent = "One moment...";

  try {
    const status = await plansApi("promotionStatus");

    if (status.allowanceLeft > 0) {
      const use = confirm(
        `Promote "${name}" for ${status.days} days using one of your ${status.allowanceLeft} free promotion${status.allowanceLeft === 1 ? "" : "s"} this month?`
      );

      if (!use) return;

      const result = await plansApi("promoteListing", { productId, useAllowance: true });

      notice(`"${name}" is promoted until ${planDateText(new Date(result.until).toISOString())}.`);
      return;
    }

    const pay = confirm(
      `Promote "${name}" for ${status.days} days for ${priceText(status.priceCents)}?\n\nIt will be shown higher in the shop, marked Sponsored. You'll pay securely on Stripe.`
    );

    if (!pay) return;

    const { url } = await plansApi("promoteListing", { productId });

    window.location.href = url;
  } catch (err) {
    notice(err.message, true);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// Landing back from Stripe: ask the server to confirm the payment and start the
// promotion (the webhook normally does it first; this makes sure).
async function handleReturn() {
  const params = new URLSearchParams(window.location.search);
  const result = params.get("promo");

  if (!result) return;

  window.history.replaceState({}, "", window.location.pathname);

  if (result === "cancelled") {
    notice("Checkout was cancelled. You haven't been charged.");
    return;
  }

  const sessionId = params.get("session_id");

  if (result !== "success" || !sessionId) return;

  notice("Thank you! Starting your promotion...");

  try {
    const { until } = await plansApi("syncPromotion", { sessionId });

    notice(`Your listing is promoted until ${planDateText(new Date(until).toISOString())}.`);
  } catch (err) {
    notice(`${err.message} If you were charged, tap the Promote button again or email support@lesovia.com.`, true);
  }
}

function init() {
  const listings = document.getElementById("sellerProducts");

  if (!listings) return;

  listings.addEventListener("click", (event) => {
    const button = event.target.closest("[data-promote]");

    if (button) promote(button);
  });

  // Needs the signed-in seller, so wait for Firebase to restore the session.
  import("./firebase.js").then(({ auth }) => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      if (!user) return;

      unsubscribe();
      handleReturn();
    });
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
