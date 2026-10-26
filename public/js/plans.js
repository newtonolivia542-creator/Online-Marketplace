// Seller plans: the plan page (seller-plan.html), the usage line on the seller
// dashboard, and the "do you have room for another listing?" check before an
// upload. The limit itself is enforced on the server (functions/plans.js);
// everything here only shows it and starts a purchase.
//
// Each piece wires itself only if the current page has its elements, so this
// module is safe to load on every page (app.js imports it).

import { auth } from "./firebase.js";
import { escapeHtml, planPrice, listingLimitText, planDateText } from "./helpers.js";

const FUNCTIONS_BASE = "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/";

export async function plansApi(name, body = {}) {
  const user = auth.currentUser;

  if (!user) throw new Error("Please sign in first.");

  const response = await fetch(FUNCTIONS_BASE + name, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await user.getIdToken()}` },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");

  return data;
}

const PLAN_LABEL = { free: "Free", plus: "Plus", pro: "Pro", unlimited: "Unlimited" };
const PLAN_ORDER = ["free", "plus", "pro", "unlimited"];

function usageText(plan) {
  const limit = plan.limit === null ? "unlimited" : plan.limit;

  return `${plan.liveCount} of ${limit} live listing${plan.limit === 1 ? "" : "s"} used`;
}

/* ================= dashboard: "My Plan" tile ================= */
export async function loadPlanSummary() {
  const tile = document.getElementById("planTileSummary");

  if (!tile) return;

  try {
    const plan = await plansApi("getPlanStatus");

    tile.textContent = `${PLAN_LABEL[plan.plan]} plan · ${usageText(plan)}`;
  } catch (err) {
    tile.textContent = "";
  }
}

/* ================= before uploading a new listing ================= */
// Resolves true if the seller may add one more. If they're at their limit it
// explains why and offers the plan page. A failure to ask (offline, say) lets
// the upload go ahead; the server still enforces the limit.
export async function sellerHasRoomForListing() {
  let plan;

  try {
    plan = await plansApi("getPlanStatus");
  } catch (err) {
    return true;
  }

  if (plan.canAddMore) return true;

  const go = confirm(
    `You've reached your limit of ${listingLimitText(plan.limit)} on the ${PLAN_LABEL[plan.plan]} plan.\n\n` +
    "Choose a plan to list more, or hide an existing listing to make room.\n\nOpen the plans page now?"
  );

  if (go) window.location.href = "seller-plan.html";

  return false;
}

/* ================= the plan page ================= */
let planState = null;

function renderCurrent(plan) {
  const box = document.getElementById("planCurrent");
  const sub = plan.subscription;
  const pct = plan.limit === null ? 0 : Math.min(100, Math.round((plan.liveCount / plan.limit) * 100));

  let freeNote = "";

  if (plan.plan === "free") {
    freeNote = plan.inFreeYear
      ? `<p>Free sellers can keep <strong>${plan.freeLimitNow} live listings</strong> until ${escapeHtml(planDateText(plan.freeYearEndsAt))}. After that, free sellers can keep <strong>${plan.freeLimitAfter}</strong>.</p>`
      : `<p>Free sellers can keep <strong>${plan.freeLimitNow} live listings</strong>.</p>`;
  }

  let billing = "";

  if (sub && ["active", "trialing", "past_due"].includes(sub.status)) {
    const renews = sub.currentPeriodEnd ? planDateText(new Date(sub.currentPeriodEnd).toISOString()) : "";

    billing = sub.cancelAtPeriodEnd
      ? `<p>Your plan ends on <strong>${escapeHtml(renews)}</strong>. You keep it until then.</p>
         <button id="planKeepBtn" type="button">Keep my plan</button>`
      : `<p>${sub.status === "past_due" ? "<strong>Your last payment didn't go through.</strong> Update your card to keep your plan. " : ""}Renews on <strong>${escapeHtml(renews)}</strong>.</p>
         <button id="planCancelBtn" type="button" class="btn btn-secondary">Cancel my plan</button>`;

    billing += ` <button id="planBillingBtn" type="button" class="btn btn-secondary">Card &amp; invoices</button>`;
  }

  box.innerHTML = `
    <h3>${escapeHtml(PLAN_LABEL[plan.plan])} plan</h3>
    <p class="plan-usage-text">${escapeHtml(usageText(plan))}</p>
    ${plan.limit === null ? "" : `<div class="plan-bar" role="progressbar" aria-valuenow="${plan.liveCount}" aria-valuemin="0" aria-valuemax="${plan.limit}"><div class="plan-bar-fill${pct >= 100 ? " full" : ""}" style="width:${pct}%"></div></div>`}
    ${plan.hiddenCount > 0 ? `<p class="plan-warning">🔒 ${plan.hiddenCount} of your listings ${plan.hiddenCount === 1 ? "is" : "are"} hidden from buyers because you're over your limit. Nothing was deleted.</p>` : ""}
    ${freeNote}
    ${billing}
    <p id="planMessage" role="status"></p>
  `;
}

function renderChoices(plan) {
  const box = document.getElementById("planChoices");
  const currentIndex = PLAN_ORDER.indexOf(plan.plan);

  box.innerHTML = ["plus", "pro", "unlimited"].map((key) => {
    const tier = plan.tiers[key];
    const isCurrent = plan.plan === key;
    const isLower = PLAN_ORDER.indexOf(key) < currentIndex;

    return `
      <div class="plan-card${isCurrent ? " current" : ""}">
        <h3>${escapeHtml(tier.name)}</h3>
        <p class="plan-price">${planPrice(tier.priceCents)}<span>/month</span></p>
        <p>${tier.maxItems === null ? "Unlimited live listings" : `Up to ${tier.maxItems} live listings`}</p>
        <button type="button" data-plan="${key}" ${isCurrent ? "disabled" : ""}>
          ${isCurrent ? "Your plan" : isLower ? `Switch to ${escapeHtml(tier.name)}` : `Choose ${escapeHtml(tier.name)}`}
        </button>
      </div>`;
  }).join("");
}

function renderListings(plan) {
  const section = document.getElementById("planListingsSection");
  const list = document.getElementById("planListings");

  // Only worth showing when the seller actually has to choose.
  const overflow = plan.limit !== null && plan.listings.length > plan.limit;

  section.style.display = overflow ? "block" : "none";

  if (!overflow) return;

  list.innerHTML = plan.listings.map((item) => `
    <label class="plan-listing">
      <input type="checkbox" value="${escapeHtml(item.id)}" ${item.hidden ? "" : "checked"}>
      <span>${escapeHtml(item.name)}${item.price !== undefined ? ` <small>($${escapeHtml(item.price)})</small>` : ""}${item.hidden ? ' <em class="plan-hidden-tag">hidden</em>' : ""}</span>
    </label>`).join("");

  const counter = document.getElementById("planChosenCount");
  const save = document.getElementById("planSaveChoiceBtn");

  const update = () => {
    const n = list.querySelectorAll("input:checked").length;

    counter.textContent = `${n} of ${plan.limit} chosen`;
    counter.classList.toggle("over", n > plan.limit);
    save.disabled = n > plan.limit;
  };

  list.onchange = update;
  update();
}

function showMessage(text, isError = false) {
  const box = document.getElementById("planMessage") || document.getElementById("planPageMessage");

  if (!box) return;

  box.textContent = text;
  box.className = isError ? "plan-error" : "plan-ok";
}

async function refreshPlanPage() {
  planState = await plansApi("getPlanStatus");

  renderCurrent(planState);
  renderChoices(planState);
  renderListings(planState);
}

async function withButton(button, work) {
  const label = button.textContent;

  button.disabled = true;

  try {
    await work();
  } catch (err) {
    showMessage(err.message, true);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

export async function loadPlanPage() {
  if (!document.getElementById("planPage")) return;

  const params = new URLSearchParams(window.location.search);

  if (params.get("checkout") === "success") {
    document.getElementById("planPageMessage").textContent = "Thank you! Activating your plan...";
    document.getElementById("planPageMessage").className = "plan-ok";

    // Ask Stripe directly instead of waiting for its message to reach us.
    try { await plansApi("syncPlan"); } catch (err) { /* the polling below still has a go */ }
  } else if (params.get("checkout") === "cancelled") {
    document.getElementById("planPageMessage").textContent = "Checkout was cancelled. You haven't been charged.";
  }

  try {
    await refreshPlanPage();

    // Right after paying, the plan can take a moment to arrive from Stripe.
    if (params.get("checkout") === "success" && planState.plan === "free") {
      for (let i = 0; i < 6 && planState.plan === "free"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await refreshPlanPage();
      }
    }

    if (params.get("checkout") === "success") {
      const note = document.getElementById("planPageMessage");

      note.textContent = planState.plan === "free"
        ? "Your payment went through, but your plan hasn't shown up yet. Tap \"Refresh my plan\" below in a moment."
        : "Thank you! Your plan is active.";
    }
  } catch (err) {
    document.getElementById("planCurrent").innerHTML = `<p class="plan-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  document.getElementById("planPage").addEventListener("click", async (event) => {
    const button = event.target.closest("button");

    if (!button) return;

    if (button.dataset.plan) {
      await withButton(button, async () => {
        const result = await plansApi("choosePlan", { plan: button.dataset.plan });

        if (result.url) {
          window.location.href = result.url;
          return;
        }

        showMessage("Your plan was updated.");
        await refreshPlanPage();
      });
    } else if (button.id === "planCancelBtn") {
      if (!confirm("Cancel your plan? You keep it until the end of the period you've paid for. After that, listings over the free allowance are hidden (not deleted).")) return;

      await withButton(button, async () => {
        await plansApi("setPlanCancel", { cancel: true });
        await refreshPlanPage();
      });
    } else if (button.id === "planKeepBtn") {
      await withButton(button, async () => {
        await plansApi("setPlanCancel", { cancel: false });
        await refreshPlanPage();
      });
    } else if (button.id === "planBillingBtn") {
      await withButton(button, async () => {
        const { url } = await plansApi("planBillingPortal");

        window.location.href = url;
      });
    } else if (button.id === "planSyncBtn") {
      await withButton(button, async () => {
        await plansApi("syncPlan");
        await refreshPlanPage();
        showMessage("Your plan is up to date.");
      });
    } else if (button.id === "planSaveChoiceBtn") {
      const ids = [...document.querySelectorAll("#planListings input:checked")].map((box) => box.value);

      await withButton(button, async () => {
        await plansApi("chooseLiveListings", { productIds: ids });
        showMessage("Saved. Those listings are live; the rest are hidden, not deleted.");
        await refreshPlanPage();
      });
    }
  });
}
