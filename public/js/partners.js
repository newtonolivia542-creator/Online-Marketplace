// Partner banners, display side: shows the live advertisement in a placement slot
// and counts views and clicks. A slot only exists on the public homepage, the buyer
// dashboard and the seller dashboard -- never checkout, the cart, or any other page.
//
// Names here avoid words ad blockers act on (ad, banner, sponsor, promo): the
// slot, label and image classes all say "partner". The visible label is still
// "Advertisement", because buyers should always be able to tell.
//
// Wires itself only if the page has a slot, so it is safe to load everywhere.

import { db } from "./firebase.js";
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { pickPartnerSpot, safePartnerLink } from "./helpers.js";

const FUNCTIONS_BASE = "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/";

// Tell the server a spot was seen or clicked. Fire and forget; a failure is ignored.
function count(id, type) {
  try {
    fetch(`${FUNCTIONS_BASE}partnerEvent`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, type })
    }).catch(() => {});
  } catch (err) { /* counting is best effort */ }
}

// Count a view, and a click, once per browser session per spot, so refreshing or
// clicking again doesn't inflate the numbers (and the click rate can't pass 100%).
function firstThisSession(id, type) {
  try {
    const key = `lv-${type}-${id}`;

    if (sessionStorage.getItem(key)) return false;

    sessionStorage.setItem(key, "1");
  } catch (err) { /* private mode: count it */ }

  return true;
}

function render(slot, spot) {
  const link = safePartnerLink(spot.linkUrl);

  if (!link || typeof spot.imageUrl !== "string" || !spot.imageUrl.startsWith("https://")) return;

  const a = document.createElement("a");

  a.className = "lv-partner-link";
  a.href = link;
  a.target = "_blank";
  a.rel = "noopener noreferrer sponsored";
  a.setAttribute("aria-label", `Advertisement: ${spot.advertiserName || "partner"}`);

  const label = document.createElement("span");

  label.className = "lv-partner-label";
  label.textContent = "Advertisement";

  const img = document.createElement("img");

  img.className = "lv-partner-img";
  img.src = spot.imageUrl;
  img.alt = spot.advertiserName || "";
  img.loading = "lazy";

  a.append(label, img);
  a.addEventListener("click", () => {
    if (firstThisSession(spot.id, "click")) count(spot.id, "click");
  });

  slot.replaceChildren(a);
  slot.classList.add("lv-partner-live");

  if (firstThisSession(spot.id, "view")) count(spot.id, "view");
}

async function init() {
  const slots = [...document.querySelectorAll("[data-partner-slot]")];

  if (slots.length === 0) return;

  let spots;

  try {
    const snap = await getDocs(query(collection(db, "partnerSpots"), where("status", "==", "active")));

    spots = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (err) {
    return; // no advertisement is better than a broken page
  }

  for (const slot of slots) {
    const spot = pickPartnerSpot(spots, slot.dataset.partnerSlot);

    if (spot) render(slot, spot);
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
