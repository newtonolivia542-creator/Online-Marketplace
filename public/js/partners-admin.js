// Admin page for partner banners (admin-partners.html): create and edit a banner,
// upload its image, pause or delete it, send the advertiser a Stripe invoice, and
// see views and clicks. Every action goes through a Cloud Function that checks the
// caller is an admin; the page itself is only reachable by one (admin.js).

import { auth } from "./firebase.js";
import { escapeHtml, planDateText } from "./helpers.js";

const FUNCTIONS_BASE = "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/";

const form = document.getElementById("partnerForm");

if (form) init();

async function api(name, body = {}) {
  const user = auth.currentUser;

  if (!user) throw new Error("Please sign in again.");

  const response = await fetch(FUNCTIONS_BASE + name, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await user.getIdToken()}` },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");

  return data;
}

const money = (cents) => `$${(cents / 100).toFixed(2)}`;

const STATE_TEXT = { live: "Live now", scheduled: "Scheduled", ended: "Ended", paused: "Paused" };
const PLACEMENT_TEXT = { home: "Homepage", buyer: "Buyer dashboard", seller: "Seller dashboard" };

function init() {
  const el = (id) => document.getElementById(id);

  // The id is made here so the image can be uploaded before the banner is saved.
  let spotId = newId();
  let imageUrl = "";
  let spots = [];

  function newId() {
    return crypto.randomUUID().replace(/-/g, "");
  }

  function say(id, text, isError = false) {
    const box = el(id);

    box.textContent = text;
    box.className = `partner-message ${isError ? "partner-error" : "partner-ok"}`;
  }

  function resetForm() {
    form.reset();
    spotId = newId();
    imageUrl = "";
    el("partnerFormTitle").textContent = "New banner";
    el("partnerCancelBtn").style.display = "none";
    el("partnerImagePreview").style.display = "none";
    el("partnerImageNote").textContent = "";
    say("partnerFormMessage", "");
  }

  function fill(spot) {
    spotId = spot.id;
    imageUrl = spot.imageUrl;

    el("partnerName").value = spot.advertiserName;
    el("partnerLink").value = spot.linkUrl;
    el("partnerStart").value = spot.startDate;
    el("partnerEnd").value = spot.endDate;
    el("partnerStatus").value = spot.status;
    el("partnerEmail").value = spot.advertiserEmail || "";
    el("partnerPrice").value = spot.priceCents ? (spot.priceCents / 100).toFixed(2) : "";
    el("partnerNotes").value = spot.notes || "";

    form.querySelectorAll('input[name="placement"]').forEach((box) => { box.checked = spot.placements.includes(box.value); });

    el("partnerImagePreview").src = imageUrl;
    el("partnerImagePreview").style.display = "block";
    el("partnerImageNote").textContent = "Current image. Choose a file only if you want to replace it.";
    el("partnerFormTitle").textContent = `Edit: ${spot.advertiserName}`;
    el("partnerCancelBtn").style.display = "inline-flex";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const bodyFromForm = (overrides = {}) => ({
    id: spotId,
    advertiserName: el("partnerName").value,
    linkUrl: el("partnerLink").value,
    imageUrl,
    placements: [...form.querySelectorAll('input[name="placement"]:checked')].map((box) => box.value),
    startDate: el("partnerStart").value,
    endDate: el("partnerEnd").value,
    status: el("partnerStatus").value,
    advertiserEmail: el("partnerEmail").value,
    priceCents: el("partnerPrice").value === "" ? 0 : Math.round(Number(el("partnerPrice").value) * 100),
    notes: el("partnerNotes").value,
    ...overrides
  });

  /* ----- image upload ----- */
  el("partnerImageFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];

    if (!file) return;

    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      say("partnerFormMessage", "Use a PNG, JPEG or WebP image.", true);
      event.target.value = "";
      return;
    }

    if (file.size > 1500000) {
      say("partnerFormMessage", "That image is over 1.5 MB. Save it smaller (1200 x 300 pixels is plenty).", true);
      event.target.value = "";
      return;
    }

    el("partnerImageNote").textContent = "Uploading...";

    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Couldn't read that file."));
        reader.readAsDataURL(file);
      });

      const result = await api("uploadPartnerImage", { id: spotId, contentType: file.type, dataBase64: String(dataUrl).split(",")[1] });

      imageUrl = result.imageUrl;
      el("partnerImagePreview").src = imageUrl;
      el("partnerImagePreview").style.display = "block";
      el("partnerImageNote").textContent = "Image uploaded.";
      say("partnerFormMessage", "");
    } catch (err) {
      el("partnerImageNote").textContent = "";
      say("partnerFormMessage", err.message, true);
    }
  });

  /* ----- save ----- */
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    el("partnerSaveBtn").disabled = true;

    try {
      await api("savePartnerSpot", bodyFromForm());
      say("partnerListMessage", "Saved.");
      resetForm();
      await load();
    } catch (err) {
      say("partnerFormMessage", err.message, true);
    } finally {
      el("partnerSaveBtn").disabled = false;
    }
  });

  el("partnerCancelBtn").addEventListener("click", resetForm);

  /* ----- the list ----- */
  const dateOf = (isoDate) => planDateText(new Date(`${isoDate}T12:00:00-06:00`).toISOString());

  function invoiceHtml(spot) {
    if (!spot.invoice) {
      return spot.advertiserEmail && spot.priceCents > 0
        ? `<button type="button" class="btn btn-secondary" data-act="invoice" data-id="${escapeHtml(spot.id)}">Send invoice (${money(spot.priceCents)})</button>`
        : `<span class="partner-muted">Add an email and price to send an invoice.</span>`;
    }

    const status = spot.invoice.status;

    return `<span class="partner-chip partner-chip-${status === "paid" ? "live" : "scheduled"}">Invoice ${escapeHtml(status)}</span>
      ${spot.invoice.url ? `<a href="${escapeHtml(spot.invoice.url)}" target="_blank" rel="noopener noreferrer">View invoice</a>` : ""}
      ${status !== "paid" ? `<button type="button" class="btn btn-secondary" data-act="check" data-id="${escapeHtml(spot.id)}">Check payment</button>` : ""}`;
  }

  function render() {
    const list = el("partnerList");

    if (spots.length === 0) {
      list.innerHTML = "<p>No banners yet. Create your first one above.</p>";
      return;
    }

    list.innerHTML = spots.map((spot) => `
      <div class="partner-card">
        <img class="partner-thumb" src="${escapeHtml(spot.imageUrl)}" alt="">
        <div class="partner-card-body">
          <div class="partner-card-top">
            <strong>${escapeHtml(spot.advertiserName)}</strong>
            <span class="partner-chip partner-chip-${spot.state}">${STATE_TEXT[spot.state]}</span>
          </div>
          <p class="partner-muted">${escapeHtml(dateOf(spot.startDate))} to ${escapeHtml(dateOf(spot.endDate))} &middot; ${spot.placements.map((p) => escapeHtml(PLACEMENT_TEXT[p] || p)).join(", ")}${spot.priceCents ? ` &middot; ${money(spot.priceCents)}` : ""}</p>
          <p><strong>${spot.views}</strong> views &middot; <strong>${spot.clicks}</strong> clicks${spot.ctrPercent === null ? "" : ` (${spot.ctrPercent}%)`} <span class="partner-muted">&middot; last 7 days: ${spot.recentViews} views, ${spot.recentClicks} clicks</span></p>
          <p class="partner-invoice">${invoiceHtml(spot)}</p>
          <div class="partner-actions">
            <button type="button" class="btn btn-secondary" data-act="edit" data-id="${escapeHtml(spot.id)}">Edit</button>
            <button type="button" class="btn btn-secondary" data-act="toggle" data-id="${escapeHtml(spot.id)}">${spot.status === "active" ? "Pause" : "Resume"}</button>
            <button type="button" class="btn btn-danger" data-act="delete" data-id="${escapeHtml(spot.id)}">Delete</button>
          </div>
        </div>
      </div>`).join("");
  }

  async function load() {
    try {
      spots = (await api("listPartnerSpots")).spots;
      render();
    } catch (err) {
      el("partnerList").innerHTML = `<p class="partner-error">${escapeHtml(err.message)}</p>`;
    }
  }

  el("partnerList").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-act]");

    if (!button) return;

    const spot = spots.find((s) => s.id === button.dataset.id);

    if (!spot) return;

    const act = button.dataset.act;

    if (act === "edit") return fill(spot);

    button.disabled = true;

    try {
      if (act === "toggle") {
        await api("savePartnerSpot", { ...spot, status: spot.status === "active" ? "paused" : "active" });
      } else if (act === "delete") {
        if (!confirm(`Delete the banner for ${spot.advertiserName}? Its images are removed. Past view and click counts are kept.`)) return;

        await api("deletePartnerSpot", { id: spot.id });
      } else if (act === "invoice") {
        if (!confirm(`Email ${spot.advertiserEmail} an invoice for ${money(spot.priceCents)}?`)) return;

        await api("sendPartnerInvoice", { id: spot.id });
        say("partnerListMessage", "Invoice sent. Stripe emailed it to the advertiser.");
      } else if (act === "check") {
        const { status } = await api("checkPartnerInvoice", { id: spot.id });

        say("partnerListMessage", status === "paid" ? "Paid. Thank you!" : `The invoice is ${status}.`);
      }

      await load();
    } catch (err) {
      say("partnerListMessage", err.message, true);
    } finally {
      button.disabled = false;
    }
  });

  // Wait for the signed-in admin before the first load.
  const stop = auth.onAuthStateChanged((user) => {
    if (!user) return;

    stop();
    load();
  });
}
