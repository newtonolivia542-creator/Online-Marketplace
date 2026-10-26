// Seller Insights: the business-numbers page (seller-insights.html) and the
// dashboard tile. The server decides which tier a seller has and what they may
// see; this only shows it and starts a purchase.
//
// Each piece wires itself only if the current page has its elements, so this
// module is safe to load on every page (app.js imports it).

import { plansApi } from "./plans.js";
import { escapeHtml, formatCents, planDateText, planPrice, percentChangeText, pricePositionText } from "./helpers.js";

const TIER_NAME = { none: "No subscription", plus: "Insights Plus", pro: "Insights Pro" };

const PLUS_FEATURES = [
  "Sales and revenue by month",
  "Your best sellers and slow movers",
  "Low-stock warnings before you run out"
];

const PRO_FEATURES = [
  "Everything in Insights Plus",
  "Price check against similar listings",
  "What buyers are asking about and saying",
  "An AI summary with specific tips"
];

/* ================= dashboard tile ================= */
export async function loadInsightsSummary() {
  const tile = document.getElementById("insightsTileSummary");

  if (!tile) return;

  try {
    const status = await plansApi("insightsStatus");

    tile.textContent = status.tier === "none" ? "See how your store is doing" : TIER_NAME[status.tier];
  } catch (err) {
    tile.textContent = "";
  }
}

/* ================= the page ================= */
const list = (items) => `<ul class="insight-features">${items.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul>`;

function pitchHtml(status) {
  const card = (key, features) => {
    const tier = status.tiers[key];
    const isCurrent = status.bought === key;

    return `
      <div class="plan-card${isCurrent ? " current" : ""}">
        <h3>${escapeHtml(tier.name)}</h3>
        <p class="plan-price">${planPrice(tier.priceCents)}<span>/month</span></p>
        ${list(features)}
        <button type="button" data-insights-tier="${key}" ${isCurrent ? "disabled" : ""}>${isCurrent ? "Your plan" : `Choose ${escapeHtml(tier.name)}`}</button>
      </div>`;
  };

  return `<div class="plan-grid">${card("plus", PLUS_FEATURES)}${card("pro", PRO_FEATURES)}</div>
    <p class="insight-note">Cancel any time. Your numbers come only from your own store. Price checks use the typical price of similar listings and never show another seller's listing.</p>`;
}

function statCard(label, value, sub = "") {
  return `<div class="insight-stat"><span class="insight-stat-label">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${sub ? `<span class="insight-stat-sub">${escapeHtml(sub)}</span>` : ""}</div>`;
}

function monthBars(months) {
  const max = Math.max(1, ...months.map((m) => m.revenueCents));

  return `<ol class="bar-chart">${months.map((m) => `
    <li>
      <span class="bar-label">${escapeHtml(m.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.round((m.revenueCents / max) * 100)}%"></span></span>
      <span class="bar-value">${escapeHtml(formatCents(m.revenueCents))} <small>(${m.units} sold)</small></span>
    </li>`).join("")}</ol>`;
}

function table(headers, rows, emptyText) {
  if (rows.length === 0) return `<p class="insight-empty">${escapeHtml(emptyText)}</p>`;

  return `<div class="insight-table-wrap"><table class="insight-table">
    <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((cells) => `<tr>${cells.map((cell, i) => `<td data-label="${escapeHtml(headers[i])}">${cell}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
}

const positionBadge = (row) => {
  const label = escapeHtml(pricePositionText(row));
  const kind = row.position === "above" ? "above" : row.position === "below" ? "below" : row.position === "in_line" ? "ok" : "none";

  return `<span class="pos-badge pos-${kind}">${label}</span>`;
};

function numbersHtml(status, data) {
  const { salesByMonth, monthOverMonth, performance } = data;
  const isPro = status.tier === "pro";
  const now = monthOverMonth.thisMonth;

  let html = `
    <section>
      <h2>This month</h2>
      <div class="insight-stats">
        ${statCard("Units sold", String(now.units), percentChangeText(monthOverMonth.unitsChangePct))}
        ${statCard("Sales", formatCents(now.revenueCents), percentChangeText(monthOverMonth.revenueChangePct))}
        ${statCard("Orders", String(now.orders))}
        ${statCard("Live listings", String(data.liveListings))}
      </div>
    </section>

    <section>
      <h2>Sales by month</h2>
      <p>Money from items sold (not counting shipping or tax). Cancelled and refunded orders are left out.</p>
      ${monthBars(salesByMonth)}
    </section>

    <section>
      <h2>Best sellers <small>(last ${performance.days} days)</small></h2>
      ${table(["Listing", "Sold", "Sales"], performance.bestSellers.map((p) => [escapeHtml(p.name), String(p.units), escapeHtml(formatCents(p.revenueCents))]), "No sales in the last 30 days yet.")}
    </section>

    <section>
      <h2>Running low</h2>
      ${table(["Listing", "Left", "At this pace"], performance.lowStock.map((p) => [escapeHtml(p.name), String(p.quantity), p.daysLeft === 0 ? "Less than a day" : `about ${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"}`]), "Nothing is running low.")}
    </section>

    <section>
      <h2>Not selling yet</h2>
      <p>Live listings, at least 2 weeks old, with no sales in the last ${performance.days} days. A new photo, a clearer description or a fresh price can help.</p>
      ${table(["Listing", "Listed for", "In stock"], performance.slowMovers.map((p) => [escapeHtml(p.name), `${p.daysListed} days`, p.quantity === null ? "-" : String(p.quantity)]), "Everything live has sold recently.")}
    </section>`;

  if (isPro) {
    html += `
    <section>
      <h2>Price check</h2>
      <p>Your price compared with the typical price of similar listings from other sellers in the same category.</p>
      ${table(["Listing", "Your price", "Typical price", "How it compares"], data.priceCheck.map((row) => [
        escapeHtml(row.name),
        `$${escapeHtml(row.price)}`,
        row.median === undefined ? "-" : `$${escapeHtml(row.median)}`,
        positionBadge(row)
      ]), "Add a category to your listings to see a price check.")}
    </section>

    <section>
      <h2>What buyers are saying</h2>
      <p>Questions buyers sent you about a listing in the last 30 days, and its reviews.</p>
      ${table(["Listing", "Questions", "Reviews", "Rating"], data.interest.map((row) => [escapeHtml(row.name), String(row.questions), String(row.reviews), row.averageRating === null ? "-" : `${escapeHtml(row.averageRating)} ⭐`]), "No buyer questions or reviews yet.")}
    </section>

    <section>
      <h2>AI summary</h2>
      <p>A short, plain-English read of your numbers with a few specific tips. You have <strong id="insightsSummaryLeft">${status.aiSummariesLeft}</strong> of ${status.aiSummariesPerMonth} this month.</p>
      <button id="insightsSummaryBtn" type="button" ${status.aiSummariesLeft === 0 ? "disabled" : ""}>Write my summary</button>
      <div id="insightsSummaryText" class="insight-summary" style="display:none;"></div>
    </section>`;
  } else {
    html += `
    <section>
      <h2>Want more?</h2>
      <p>Insights Pro adds a price check, what buyers are asking about, and an AI summary with tips.</p>
      <button type="button" data-insights-tier="pro">Choose Insights Pro, ${planPrice(status.tiers.pro.priceCents)}/month</button>
    </section>`;
  }

  return html;
}

function manageHtml(status) {
  const sub = status.subscription;
  const live = sub && ["active", "trialing", "past_due"].includes(sub.status);

  if (status.includedByPlan) {
    return `<p><strong>${escapeHtml(TIER_NAME[status.tier])}</strong> is included with your listing plan.</p>`;
  }

  if (!live) return "";

  const renews = sub.currentPeriodEnd ? planDateText(new Date(sub.currentPeriodEnd).toISOString()) : "";

  return `
    <p><strong>${escapeHtml(TIER_NAME[sub.tier])}</strong> ${sub.cancelAtPeriodEnd ? `ends on <strong>${escapeHtml(renews)}</strong>. You keep it until then.` : `renews on <strong>${escapeHtml(renews)}</strong>.`}</p>
    ${sub.cancelAtPeriodEnd ? '<button id="insightsKeepBtn" type="button">Keep it</button>' : '<button id="insightsCancelBtn" type="button" class="btn btn-secondary">Cancel</button>'}
    <button id="insightsBillingBtn" type="button" class="btn btn-secondary">Card &amp; invoices</button>`;
}

function message(text, isError = false) {
  const box = document.getElementById("insightsMessage");

  if (!box) return;

  box.textContent = text;
  box.className = isError ? "plan-error" : "plan-ok";
}

async function render() {
  const head = document.getElementById("insightsHead");
  const body = document.getElementById("insightsBody");
  const result = await plansApi("getInsights");

  if (result.locked) {
    head.innerHTML = `<p>See how your store is doing: sales by month, best sellers, what's running low, and more. Choose a plan to unlock it.</p>${pitchHtml(result)}`;
    body.innerHTML = "";
    return result;
  }

  head.innerHTML = `<p class="plan-usage-text">${escapeHtml(TIER_NAME[result.tier])}</p>${manageHtml(result)}`;
  body.innerHTML = numbersHtml(result, result.insights);

  return result;
}

export async function loadInsightsPage() {
  const page = document.getElementById("insightsPage");

  if (!page) return;

  const params = new URLSearchParams(window.location.search);

  if (params.get("checkout") === "success") {
    message("Thank you! Unlocking your Insights...");

    try { await plansApi("syncInsights"); } catch (err) { /* the page still loads whatever is recorded */ }

    window.history.replaceState({}, "", window.location.pathname);
  } else if (params.get("checkout") === "cancelled") {
    message("Checkout was cancelled. You haven't been charged.");
    window.history.replaceState({}, "", window.location.pathname);
  }

  try {
    const result = await render();

    if (params.get("checkout") === "success" && !result.locked) message("Thank you! Your Insights are unlocked.");
  } catch (err) {
    document.getElementById("insightsHead").innerHTML = `<p class="plan-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  page.addEventListener("click", async (event) => {
    const button = event.target.closest("button");

    if (!button) return;

    const label = button.textContent;
    const run = async (work) => {
      button.disabled = true;

      try {
        await work();
      } catch (err) {
        message(err.message, true);
      } finally {
        button.disabled = false;
        button.textContent = label;
      }
    };

    if (button.dataset.insightsTier) {
      await run(async () => {
        const result = await plansApi("chooseInsights", { tier: button.dataset.insightsTier });

        if (result.url) {
          window.location.href = result.url;
          return;
        }

        await render();
        message("Your subscription was updated.");
      });
    } else if (button.id === "insightsCancelBtn") {
      if (!confirm("Cancel Insights? You keep it until the end of the period you've paid for.")) return;

      await run(async () => { await plansApi("setInsightsCancel", { cancel: true }); await render(); });
    } else if (button.id === "insightsKeepBtn") {
      await run(async () => { await plansApi("setInsightsCancel", { cancel: false }); await render(); });
    } else if (button.id === "insightsBillingBtn") {
      await run(async () => { const { url } = await plansApi("planBillingPortal"); window.location.href = url; });
    } else if (button.id === "insightsSyncBtn") {
      await run(async () => { await plansApi("syncInsights"); await render(); message("Up to date."); });
    } else if (button.id === "insightsSummaryBtn") {
      button.textContent = "Writing...";

      await run(async () => {
        const result = await plansApi("insightsSummary");
        const box = document.getElementById("insightsSummaryText");

        box.textContent = result.text;
        box.style.display = "block";
        document.getElementById("insightsSummaryLeft").textContent = String(result.aiSummariesLeft);

        if (result.aiSummariesLeft === 0) button.disabled = true;
      });
    }
  });
}
