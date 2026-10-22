// Returns & cancellations: the buyer- and seller-facing UI, and shipping
// (which also collects the return address a return will need later).
//
// Split out of app.js verbatim, section by section -- nothing here was
// rewritten, only relocated and given explicit imports/exports in place of
// bare references to code that used to sit in the same file.
//
// Two bits of state are genuinely shared with the order-list code that still
// lives in app.js (it reads them when building each sub-order's card, and
// writes them after loading the buyer's/seller's orders):
//   - subOrderCache: a Map, mutated in place (`.set()`/`.get()`) from both
//     files, so exporting the Map itself is enough -- no reassignment ever
//     happens to the binding.
//   - returnsState.{buyerReturns,sellerReturns}: these WERE reassigned
//     wholesale (`buyerReturns = await fetchReturnsMap(...)`), which an
//     imported binding can't be (imports are read-only in the importing
//     module). Wrapping both in one exported object sidesteps that --
//     app.js reassigns the object's properties instead of the import itself.
//
// refreshBuyerOrders/refreshSellerOrders import loadMyOrders/loadSellerOrders
// back from app.js, which imports things from this file too -- a circular
// import. That's safe here specifically because both are `function`
// declarations (hoisted, fully defined before either module's other code
// runs) and are only ever CALLED later, from inside a click handler, well
// after both modules have finished loading.

import {
  doc,
  getDoc,
  getDocs,
  collection,
  addDoc,
  query,
  where,
  updateDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

import { auth, db } from "./firebase.js";
import { escapeHtml, formatCents, describeProducts, deliveryAddressHtml } from "./helpers.js";
import { loadMyOrders, loadSellerOrders } from "./app.js";

// Calling getStorage() again here returns the SAME cached instance app.js's
// own getStorage() call already created -- the Firebase SDK registers one
// Storage service per app, not one per call site.
const storage = getStorage();

/* ================= RETURNS & CANCELLATIONS: what buyers and sellers see ================= */
// The numbers below only decide what to SHOW (a button, a date). The server
// enforces the real rules and answers with a clear message if it disagrees.
// They start as the defaults and are replaced by publicConfig/returnPolicy (the
// same document the server reads) when the orders load.
export const returnPolicyUi = {
  returnWindowDays: 7,
  minDaysAfterShipBeforeWindow: 5,
  cancelUnshippedAfterDays: 14
};
const DAY_MS = 24 * 60 * 60 * 1000;

const RETURN_REASONS = {
  damaged: "Item or package arrived damaged / broken",
  wrong_item: "I received a different item than I ordered",
  not_as_described: "Not as described in the listing",
  too_big: "Too big",
  too_small: "Too small",
  not_liked: "I don't like how it looks",
  other: "Something else"
};

// Reasons that need at least one photo as evidence.
const RETURN_PHOTO_REASONS = ["damaged", "wrong_item", "not_as_described"];

function msOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  return null;
}

const formatDay = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

// The last moment a buyer may start a return. Uses the delivery/shipping times
// the SERVER stamped (never the seller-typed ones, unless an older order has
// nothing else), and never counts from before returnPolicyUi.minDaysAfterShipBeforeWindow.
function returnWindowEndsMs(subOrder) {
  const delivered = msOf(subOrder.deliveredAtServer) ?? msOf(subOrder.deliveredAt);
  const shipped = msOf(subOrder.shippedAtServer) ?? msOf(subOrder.shippedAt);

  if (delivered === null) return null;

  const start = Math.max(delivered, shipped !== null ? shipped + returnPolicyUi.minDaysAfterShipBeforeWindow * DAY_MS : delivered);

  return start + returnPolicyUi.returnWindowDays * DAY_MS;
}

function returnItemsHtml(ret) {
  return (ret.items || [])
    .map((item) => `${escapeHtml(item.name)} &times; ${escapeHtml(item.quantity)}`)
    .join(", ");
}

function returnPhotosHtml(ret) {
  return (ret.photos || [])
    .map((photo) => `
      <a href="${escapeHtml(photo.url)}" target="_blank" rel="noopener">
        <img src="${escapeHtml(photo.url)}" alt="Return photo" style="width:64px;height:64px;object-fit:cover;border-radius:6px;margin:0 6px 6px 0;">
      </a>`)
    .join("");
}

// Why it's being returned, in the buyer's own words, with their photos.
function returnDetailsHtml(ret) {
  if (ret.kind === "cancellation") {
    return `<p><small>${escapeHtml(ret.reasonLabel || "Order cancelled")}</small></p>`;
  }

  return `
    <p><small>
      <strong>Returning:</strong> ${returnItemsHtml(ret)}<br>
      <strong>Reason:</strong> ${escapeHtml(ret.reasonLabel || ret.reason)}<br>
      ${ret.description ? `<strong>Buyer's note:</strong> ${escapeHtml(ret.description)}` : ""}
    </small></p>
    ${returnPhotosHtml(ret) ? `<div>${returnPhotosHtml(ret)}</div>` : ""}
  `;
}

// What comes back to the buyer, and what doesn't.
function refundBreakdownHtml(plan) {
  if (!plan) return "";

  if (plan.mode === "full") {
    return `<p><small>Full refund: <strong>${formatCents(plan.buyerRefundCents)}</strong>.</small></p>`;
  }

  return `
    <p><small>
      Refund: <strong>${formatCents(plan.buyerRefundCents)}</strong> of the ${formatCents(plan.grossCents)} paid for these items.<br>
      Not refunded: Lesovia's service fee (${formatCents(plan.commissionKeptCents)}) and the payment processing fee (${formatCents(plan.stripeFeeWithheldCents)}).
    </small></p>
  `;
}

function returnActionButton(label, handler, id, extraClass = "") {
  return `<button type="button" class="rt-btn ${extraClass}" onclick="${handler}('${escapeHtml(id)}')">${escapeHtml(label)}</button>`;
}

// The buyer's return / cancel section under one sub-order.
export function buyerReturnHtml(id, subOrder, ret, nowMs = Date.now()) {
  const wrap = (inner) => `<div class="rt-box">${inner}</div>`;

  if (ret) {
    const rid = ret.id;
    const cancelled = ret.kind === "cancellation";
    let body = "";

    switch (ret.status) {
      case "requested":
        body = `<p><strong>Return requested.</strong> Waiting for the seller to respond${ret.sellerRespondByMs ? ` (by ${formatDay(ret.sellerRespondByMs)}; after that, Lesovia decides)` : ""}.</p>
          ${returnActionButton("Cancel request", "cancelReturnRequest", rid, "rt-secondary")}`;
        break;

      case "approved":
        body = `<p><strong>Return approved.</strong> Send it back${ret.shipDeadlineMs ? ` by <strong>${formatDay(ret.shipDeadlineMs)}</strong>` : ""}, then add your tracking number. You pay the return shipping.</p>
          ${deliveryAddressHtml(subOrder.returnAddress, "Send it to:", false) ||
            "<p><small>The seller didn't share a return address. Please contact them through Messages before sending anything.</small></p>"}
          ${returnActionButton("Add tracking number", "addReturnTracking", rid)}
          ${returnActionButton("Cancel request", "cancelReturnRequest", rid, "rt-secondary")}`;
        break;

      case "declined":
        body = `<p><strong>Return declined.</strong> ${ret.decisionNote ? `Reason: ${escapeHtml(ret.decisionNote)}` : ""}</p>
          ${ret.declinedBy === "seller" ? returnActionButton("Ask Lesovia to review", "escalateReturnRequest", rid) : ""}`;
        break;

      case "escalated":
        body = `<p><strong>Lesovia is reviewing your return.</strong> We'll notify you as soon as there's a decision.</p>`;
        break;

      case "shipped_back":
        body = `<p><strong>On its way back.</strong> ${ret.returnTracking ? `${escapeHtml(ret.returnTracking.carrier)} ${escapeHtml(ret.returnTracking.trackingNumber)}. ` : ""}Your refund is sent as soon as the seller confirms it arrived.</p>`;
        break;

      case "problem_reported":
        body = `<p><strong>Lesovia is checking on your returned package.</strong> We'll be in touch.</p>`;
        break;

      case "queued":
      case "refunding":
      case "refund_failed":
        body = `<p><strong>Your refund is being processed.</strong>${ret.status === "refund_failed" ? " It's taking longer than usual; Lesovia is looking into it." : ""}</p>`;
        break;

      case "refunded":
        body = `<p><strong>${cancelled ? "Order cancelled and refunded" : "Refunded"}: ${formatCents(ret.plan.buyerRefundCents)}.</strong>
            Your bank usually shows it within 5 to 10 business days.</p>
          ${refundBreakdownHtml(ret.plan)}`;
        break;

      case "rejected":
        body = `<p><strong>Closed without a refund.</strong> ${ret.decisionNote ? escapeHtml(ret.decisionNote) : ""}</p>`;
        break;

      default:
        return "";
    }

    return wrap(`<h4>${cancelled ? "Cancellation" : "Return"}</h4>${body}${returnDetailsHtml(ret)}`);
  }

  if (subOrder.fulfillmentStatus === "delivered") {
    const endsMs = returnWindowEndsMs(subOrder);

    if (endsMs === null) return "";

    if (nowMs <= endsMs) {
      return wrap(`
        <p>Not right? You can return this until <strong>${formatDay(endsMs)}</strong>.</p>
        ${returnActionButton("Return items", "openReturnModal", id, "rt-secondary")}
      `);
    }

    return wrap(`<p><small>The ${returnPolicyUi.returnWindowDays}-day return period for this order ended on ${formatDay(endsMs)}.</small></p>`);
  }

  if (subOrder.fulfillmentStatus === "paid") {
    const createdMs = msOf(subOrder.createdAt);

    if (createdMs === null) return "";

    const availableMs = createdMs + returnPolicyUi.cancelUnshippedAfterDays * DAY_MS;

    if (nowMs >= availableMs) {
      return wrap(`
        <p>The seller hasn't shipped this order in ${returnPolicyUi.cancelUnshippedAfterDays} days. You can cancel it for a full refund.</p>
        ${returnActionButton("Cancel order", "cancelUnshipped", id, "rt-danger")}
      `);
    }

    return wrap(`<p><small>If the seller still hasn't shipped this by ${formatDay(availableMs)}, you'll be able to cancel it for a full refund.</small></p>`);
  }

  return "";
}

// Where the refund money came from, in the seller's terms (mirrors
// sellerRefundSource in functions/returnMath.js, which words the notification).
function sellerRefundSourceText(subOrder, ret) {
  const plan = ret.plan;
  const refund = formatCents(plan.buyerRefundCents);

  if (subOrder.chargeType === "direct") {
    const base = `${refund} was refunded to the buyer from your Stripe balance.`;

    if (plan.mode === "full") {
      return plan.commissionShareCents > 0
        ? `${base} Lesovia returned its ${formatCents(plan.commissionShareCents)} commission to you; Stripe's processing fee isn't returned.`
        : `${base} Stripe's processing fee isn't returned.`;
    }

    return `${base} Lesovia's commission and Stripe's processing fee were kept out of the refund, so you're left even on this sale.`;
  }

  const reversed = (ret.refund && ret.refund.reversedCents) || 0;

  return reversed > 0
    ? `Lesovia refunded the buyer ${refund} and took back the ${formatCents(reversed)} it had sent you for this order.`
    : `Lesovia refunded the buyer ${refund} from its own balance; nothing was taken back from you.`;
}

// The seller's view of a return on one of their sub-orders.
export function sellerReturnHtml(id, subOrder, ret) {
  if (!ret) return "";

  const rid = ret.id;
  const cancelled = ret.kind === "cancellation";
  let body = "";

  switch (ret.status) {
    case "requested":
      body = `<p><strong>The buyer wants to return this.</strong> ${ret.sellerRespondByMs ? `Please respond by ${formatDay(ret.sellerRespondByMs)}; after that Lesovia decides.` : ""}</p>
        ${refundBreakdownHtml(ret.plan)}
        ${returnActionButton("Approve return", "approveReturn", rid)}
        ${returnActionButton("Decline", "declineReturn", rid, "rt-danger")}`;
      break;

    case "approved":
      body = `<p><strong>Return approved.</strong> Waiting for the buyer to send it back${ret.shipDeadlineMs ? ` (they have until ${formatDay(ret.shipDeadlineMs)})` : ""}.</p>`;
      break;

    case "declined":
      body = `<p><strong>You declined this return.</strong> The buyer can ask Lesovia to review it.</p>`;
      break;

    case "escalated":
    case "problem_reported":
      body = `<p><strong>Lesovia is reviewing this return.</strong> You don't need to do anything.</p>`;
      break;

    case "shipped_back":
      body = `<p><strong>The buyer sent it back.</strong> ${ret.returnTracking ? `${escapeHtml(ret.returnTracking.carrier)} ${escapeHtml(ret.returnTracking.trackingNumber)}.` : ""}
          When it arrives, confirm it to send the buyer's refund${ret.receiptDeadlineMs ? ` (please do so by ${formatDay(ret.receiptDeadlineMs)})` : ""}.</p>
        ${refundBreakdownHtml(ret.plan)}
        ${returnActionButton("I received it - send the refund", "confirmReturnReceivedUi", rid)}
        ${returnActionButton("Report a problem", "reportReturnProblemUi", rid, "rt-danger")}`;
      break;

    case "queued":
    case "refunding":
      body = `<p><strong>Refund being sent.</strong></p>`;
      break;

    case "refund_failed":
      body = `<p><strong>The refund couldn't be sent.</strong> Lesovia has been notified and will sort it out.</p>`;
      break;

    case "refunded":
      body = `<p><strong>${cancelled ? "Order cancelled" : "Return completed"}.</strong> ${escapeHtml(sellerRefundSourceText(subOrder, ret))}</p>`;
      break;

    case "rejected":
      body = `<p><strong>Closed by Lesovia without a refund.</strong></p>`;
      break;

    default:
      return "";
  }

  return `<div class="rt-box"><h4>${cancelled ? "Cancellation" : "Return"}</h4>${body}${returnDetailsHtml(ret)}</div>`;
}

// ================= SHIP / DELIVER / TRACKING (shared with app.js) =================
// Each of these applies either to an older per-product order (the default) or,
// when kind === "sub", to one seller's sub-order of a newer checkout. The two
// differ in where they live, what their status field is called, who the buyer
// is, and which order the buyer's notification should open. Used both here
// (shipSubOrder) and from app.js's markShipped/markDelivered/editTrackingNumber.
export function orderTarget(orderId, kind) {
  const isSub = kind === "sub";

  return {
    isSub,
    ref: doc(db, isSub ? "sellerOrders" : "orders", orderId),
    statusField: isSub ? "fulfillmentStatus" : "status"
  };
}

export async function productNameForNotification(order, isSub) {
  if (isSub) return describeProducts(order.products);

  const productSnap = await getDoc(doc(db, "products", order.productId));

  return productSnap.exists() ? productSnap.data().name : "Unknown Product";
}

export function notifyBuyerOfOrder(order, isSub, orderId, notification) {
  return addDoc(collection(db, "notifications"), {
    userId: isSub ? order.buyerId : order.userId,
    ...notification,
    link: `order.html?orderId=${isSub ? order.checkoutId : orderId}`,
    read: false,
    createdAt: serverTimestamp()
  });
}

/* ================= RETURNS & CANCELLATIONS: forms and actions ================= */
const FUNCTIONS_BASE = "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/";

// Every return action goes through a Cloud Function, which decides whether it's
// allowed and moves the money -- the browser never writes a return itself.
async function returnsApi(name, body) {
  const user = auth.currentUser;

  if (!user) throw new Error("Please sign in first.");

  const response = await fetch(FUNCTIONS_BASE + name, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await user.getIdToken()}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");

  return data;
}

// The sub-orders on the page, so a button only needs to carry an id. Written
// by app.js's appendBuyerSubOrder as each order card is built, read here.
export const subOrderCache = new Map();

// Pulls the policy numbers the server enforces, so the dates and buttons shown
// here match it. A missing document or an odd value just leaves the defaults.
async function loadReturnPolicyUi() {
  try {
    const snap = await getDoc(doc(db, "publicConfig", "returnPolicy"));

    if (!snap.exists()) return;

    for (const key of Object.keys(returnPolicyUi)) {
      const value = snap.data()[key];

      if (Number.isFinite(value) && value >= 0) returnPolicyUi[key] = value;
    }
  } catch (err) {
    console.error("Could not load the return policy:", err);
  }
}

export async function fetchReturnsMap(field) {
  const map = new Map();

  // The return panels on the order cards use these styles, not just the dialogs.
  injectReturnStyles();
  await loadReturnPolicyUi();

  if (!auth.currentUser) return map;

  try {
    const snapshot = await getDocs(query(collection(db, "returns"), where(field, "==", auth.currentUser.uid)));

    // Newest first; a withdrawn or lapsed request doesn't count as "the" return.
    const list = snapshot.docs
      .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
      .sort((a, b) => (b.requestedMs || 0) - (a.requestedMs || 0));

    for (const ret of list) {
      if (!map.has(ret.sellerOrderId) && !["cancelled", "expired"].includes(ret.status)) {
        map.set(ret.sellerOrderId, ret);
      }
    }
  } catch (err) {
    console.error("Could not load returns:", err);
  }

  return map;
}

// buyerReturns/sellerReturns are reassigned wholesale by app.js after each
// load (`returnsState.buyerReturns = await fetchReturnsMap(...)`) -- wrapped
// in one object because an imported binding can't itself be reassigned from
// the importing module, only its properties can.
export const returnsState = { buyerReturns: new Map(), sellerReturns: new Map() };

// ---- a tiny DOM builder (text is always set as text, never as HTML) ----
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "style") node.style.cssText = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value);
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return node;
}

function injectReturnStyles() {
  if (document.getElementById("returnUiStyles")) return;

  const style = document.createElement("style");
  style.id = "returnUiStyles";
  style.textContent = `
    .rt-box { margin:12px 0; padding:12px 14px; border:1px solid var(--lv-line,#E2E8E4); border-radius:10px; background:var(--lv-canvas,#F6F8F6); max-width:640px; }
    .rt-box h4 { margin:0 0 6px; }
    /* :is(...) button.rt-btn outranks page-level rules like button[onclick]. */
    :is(.rt-box, .rt-modal) button.rt-btn { margin:4px 6px 4px 0; padding:8px 14px; border-radius:8px; border:1px solid transparent; cursor:pointer; font:inherit; background:var(--lv-green,#0B7A3D); color:#fff; }
    :is(.rt-box, .rt-modal) button.rt-btn:hover { background:var(--lv-green-deep,#086030); }
    :is(.rt-box, .rt-modal) button.rt-btn.rt-secondary { background:#fff; color:inherit; border-color:var(--lv-line,#CBD5CE); }
    :is(.rt-box, .rt-modal) button.rt-btn.rt-secondary:hover { background:var(--lv-canvas,#F6F8F6); }
    :is(.rt-box, .rt-modal) button.rt-btn.rt-danger { background:#fff; color:var(--lv-danger,#C6362E); border-color:var(--lv-danger,#C6362E); }
    :is(.rt-box, .rt-modal) button.rt-btn.rt-danger:hover { background:var(--lv-danger-mist,#FBE9E8); }
    :is(.rt-box, .rt-modal) button.rt-btn[disabled] { opacity:.6; cursor:default; }
    .rt-overlay { position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:10000; display:flex; align-items:flex-start; justify-content:center; overflow:auto; padding:24px 12px; }
    .rt-modal { background:#fff; color:#1b1b1b; border-radius:12px; width:100%; max-width:560px; padding:20px 22px; box-shadow:0 12px 40px rgba(0,0,0,.25); }
    .rt-modal h3 { margin:0 0 6px; }
    .rt-field { margin:12px 0; }
    .rt-field label { display:block; font-weight:600; margin-bottom:4px; }
    .rt-field input[type=text], .rt-field select, .rt-field textarea { width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #cbd5ce; border-radius:8px; font:inherit; }
    .rt-field textarea { min-height:90px; }
    .rt-help { font-size:13px; color:#5b6b62; margin:4px 0 0; }
    .rt-error { color:var(--lv-danger,#C6362E); font-size:14px; margin:8px 0 0; min-height:1em; }
    .rt-notice { background:#fff8e6; border:1px solid #f0d58a; border-radius:8px; padding:10px 12px; font-size:14px; margin:12px 0; }
    .rt-actions { margin-top:16px; display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap; }
    .rt-item { display:flex; align-items:center; gap:8px; margin:6px 0; }
    .rt-item select { width:auto; }
  `;
  document.head.appendChild(style);
}

// Shows `build(box, close)` in a centred dialog. Returns a function that closes it.
function openModal(build) {
  injectReturnStyles();

  const box = el("div", { class: "rt-modal", role: "dialog", "aria-modal": "true" });
  const overlay = el("div", { class: "rt-overlay" }, box);
  const close = () => overlay.remove();

  build(box, close);
  document.body.appendChild(overlay);

  return close;
}

// A simple form in a dialog. Resolves with { fieldName: value } or null if cancelled.
function openFormModal({ title, intro, fields, submitLabel = "Submit", cancelLabel = "Cancel" }) {
  return new Promise((resolve) => {
    openModal((box, close) => {
      const inputs = {};
      const error = el("p", { class: "rt-error" });

      const finish = (value) => { close(); resolve(value); };

      const fieldNodes = fields.map((field) => {
        let input;

        if (field.type === "textarea") {
          input = el("textarea", { maxlength: field.maxLength || 500, placeholder: field.placeholder || "" });
        } else if (field.type === "select") {
          input = el("select", {}, field.options.map(([value, label]) => el("option", { value }, label)));
        } else {
          input = el("input", { type: "text", maxlength: field.maxLength || 200, placeholder: field.placeholder || "" });
        }

        if (field.value) input.value = field.value;

        inputs[field.name] = input;

        return el("div", { class: "rt-field" },
          el("label", {}, field.label + (field.required ? " *" : "")),
          input,
          field.help ? el("p", { class: "rt-help" }, field.help) : null
        );
      });

      box.append(
        el("h3", {}, title),
        intro ? el("p", {}, intro) : null,
        ...fieldNodes,
        error,
        el("div", { class: "rt-actions" },
          el("button", { type: "button", class: "rt-btn rt-secondary", onclick: () => finish(null) }, cancelLabel),
          el("button", {
            type: "button",
            class: "rt-btn",
            onclick: () => {
              const values = {};

              for (const field of fields) {
                values[field.name] = inputs[field.name].value.trim();

                if (field.required && !values[field.name]) {
                  error.textContent = `Please fill in: ${field.label}.`;
                  inputs[field.name].focus();
                  return;
                }
              }

              finish(values);
            }
          }, submitLabel)
        )
      );

      const first = fields.length ? inputs[fields[0].name] : null;
      if (first) setTimeout(() => first.focus(), 0);
    });
  });
}

// Runs an action, shows any error as an alert, then refreshes the list.
async function runReturnAction(action, refresh, successMessage) {
  try {
    const result = await action();

    if (successMessage) alert(typeof successMessage === "function" ? successMessage(result) : successMessage);

    await refresh();
  } catch (err) {
    alert(err.message);
  }
}

const refreshBuyerOrders = () => loadMyOrders();
// Each of these is a no-op on a page that doesn't have its list, so one
// refresh covers both the Orders page and the Returns & Refunds page.
const refreshSellerOrders = async () => {
  await loadSellerOrders();
  await loadSellerReturnsPage();
};

// ---------------- buyer ----------------
window.openReturnModal = async (sellerOrderId) => {
  const subOrder = subOrderCache.get(sellerOrderId);

  if (!subOrder) {
    alert("Please refresh the page and try again.");
    return;
  }

  const lines = subOrder.products || [];
  const returnId = (window.crypto && crypto.randomUUID && crypto.randomUUID()) || `${auth.currentUser.uid}-${Date.now()}`;

  const itemRows = lines.map((line, lineIndex) => {
    const check = el("input", { type: "checkbox", checked: true });
    const qty = el("select", {}, Array.from({ length: line.quantity }, (_, i) => el("option", { value: i + 1 }, i + 1)));
    qty.value = String(line.quantity);
    return { line, lineIndex, check, qty };
  });

  const reason = el("select", {}, [
    el("option", { value: "" }, "Choose a reason..."),
    ...Object.entries(RETURN_REASONS).map(([value, label]) => el("option", { value }, label))
  ]);
  const description = el("textarea", { maxlength: 1000, placeholder: "Tell the seller what's wrong (for example: too big, arrived broken, not the item I ordered)." });
  const photosInput = el("input", { type: "file", accept: "image/*", multiple: true });
  const photoHelp = el("p", { class: "rt-help" }, "Up to 5 photos, each under 5 MB.");
  const summary = el("div", { class: "rt-notice" }, "Choose the items you're returning to see what would be refunded.");
  const agree = el("input", { type: "checkbox" });
  const error = el("p", { class: "rt-error" });
  const submit = el("button", { type: "button", class: "rt-btn" }, "Send return request");

  const selectedItems = () =>
    itemRows.filter((row) => row.check.checked).map((row) => ({ lineIndex: row.lineIndex, quantity: Number(row.qty.value) }));

  let previewTimer = null;
  let previewSeq = 0;

  const refreshPreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const items = selectedItems();
      const seq = ++previewSeq;

      if (items.length === 0) {
        summary.textContent = "Choose at least one item to return.";
        return;
      }

      summary.textContent = "Working out your refund...";

      try {
        const data = await returnsApi("previewReturn", { sellerOrderId, reason: reason.value || "other", items });

        if (seq !== previewSeq) return;

        const plan = data.plan;

        summary.replaceChildren(
          el("p", { style: "margin:0 0 6px" }, el("strong", {}, `You would be refunded ${formatCents(plan.buyerRefundCents)}`), ` of the ${formatCents(plan.grossCents)} you paid for these items${plan.shippingRefundCents ? " (including shipping)" : ""}.`),
          plan.mode === "standard"
            ? el("p", { style: "margin:0 0 6px" }, `Not refunded: Lesovia's service fee (${formatCents(plan.commissionKeptCents)}) and the payment processing fee (${formatCents(plan.stripeFeeWithheldCents)}).`)
            : null,
          el("p", { style: "margin:0" }, `You pay the return shipping. The seller reviews your request first. Once approved, you have ${data.returnShipDays} days to send it back, and your refund is sent when the seller confirms it arrived.`)
        );
      } catch (err) {
        if (seq === previewSeq) summary.textContent = err.message;
      }
    }, 250);
  };

  for (const row of itemRows) {
    row.check.addEventListener("change", refreshPreview);
    row.qty.addEventListener("change", refreshPreview);
  }
  reason.addEventListener("change", () => {
    photoHelp.textContent = RETURN_PHOTO_REASONS.includes(reason.value)
      ? "A photo is required for this reason (up to 5 photos, each under 5 MB)."
      : "Up to 5 photos, each under 5 MB.";
    refreshPreview();
  });

  openModal((box, close) => {
    box.append(
      el("h3", {}, `Return items from order ${subOrder.orderNumber || ""}`),
      el("div", { class: "rt-field" }, el("label", {}, "What are you returning?"),
        ...itemRows.map((row) => el("div", { class: "rt-item" }, row.check,
          el("span", {}, row.line.name + (row.line.color || row.line.size ? ` (${[row.line.color, row.line.size].filter(Boolean).join(", ")})` : "")),
          row.line.quantity > 1 ? row.qty : null))),
      el("div", { class: "rt-field" }, el("label", {}, "Reason *"), reason),
      el("div", { class: "rt-field" }, el("label", {}, "Tell us more *"), description),
      el("div", { class: "rt-field" }, el("label", {}, "Photos"), photosInput, photoHelp),
      summary,
      el("div", { class: "rt-field" }, el("label", { style: "font-weight:400;display:flex;gap:8px;align-items:flex-start;" }, agree,
        el("span", {}, "I understand that Lesovia's service fee and the payment processing fee are not refunded, that I pay for return shipping, and that my refund is sent once the seller confirms the item arrived."))),
      error,
      el("div", { class: "rt-actions" },
        el("button", { type: "button", class: "rt-btn rt-secondary", onclick: close }, "Close"),
        submit
      )
    );

    submit.addEventListener("click", async () => {
      error.textContent = "";

      const items = selectedItems();
      const files = [...photosInput.files];

      if (items.length === 0) return (error.textContent = "Choose at least one item to return.");
      if (!reason.value) return (error.textContent = "Please choose a reason.");
      if (description.value.trim().length < 10) return (error.textContent = "Please describe the problem (at least 10 characters).");
      if (files.length > 5) return (error.textContent = "You can attach up to 5 photos.");
      if (RETURN_PHOTO_REASONS.includes(reason.value) && files.length === 0) return (error.textContent = "Please attach at least one photo showing the problem.");
      if (files.some((file) => !file.type.startsWith("image/"))) return (error.textContent = "Photos must be image files.");
      if (files.some((file) => file.size >= 5 * 1024 * 1024)) return (error.textContent = "Each photo must be under 5 MB.");
      if (!agree.checked) return (error.textContent = "Please confirm you understand what is and isn't refunded.");

      submit.disabled = true;
      submit.textContent = "Sending...";

      try {
        const uid = auth.currentUser.uid;
        const photos = [];

        for (let i = 0; i < files.length; i++) {
          const safeName = files[i].name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-60);
          const path = `returnPhotos/${uid}/${subOrder.sellerId}/${returnId}/${i + 1}-${safeName}`;
          const photoRef = ref(storage, path);

          await uploadBytes(photoRef, files[i], { contentType: files[i].type });
          photos.push({ path, url: await getDownloadURL(photoRef) });
        }

        await returnsApi("requestReturn", {
          returnId,
          sellerOrderId,
          reason: reason.value,
          description: description.value.trim(),
          items,
          photos,
          acknowledgedFees: true
        });

        close();
        alert("Return requested. The seller will review it, and you'll be notified of their decision.");
        await refreshBuyerOrders();
      } catch (err) {
        error.textContent = err.message;
        submit.disabled = false;
        submit.textContent = "Send return request";
      }
    });
  });

  refreshPreview();
};

window.addReturnTracking = async (returnId) => {
  const values = await openFormModal({
    title: "Add your return tracking",
    intro: "Enter the carrier and the tracking number from your shipping receipt.",
    fields: [
      { name: "carrier", label: "Carrier", required: true, placeholder: "USPS, UPS, FedEx...", maxLength: 60 },
      { name: "trackingNumber", label: "Tracking number", required: true, maxLength: 80 }
    ],
    submitLabel: "Save tracking"
  });

  if (!values) return;

  await runReturnAction(
    () => returnsApi("submitReturnTracking", { returnId, ...values }),
    refreshBuyerOrders,
    "Thanks! The seller has been notified. Your refund is sent once they confirm the package arrived."
  );
};

window.cancelReturnRequest = async (returnId) => {
  if (!confirm("Withdraw this return request?")) return;

  await runReturnAction(() => returnsApi("cancelReturn", { returnId }), refreshBuyerOrders);
};

window.escalateReturnRequest = async (returnId) => {
  const values = await openFormModal({
    title: "Ask Lesovia to review",
    intro: "Tell us why you think this return should be approved. A Lesovia admin will make the final decision.",
    fields: [{ name: "note", label: "Your message", type: "textarea", maxLength: 500 }],
    submitLabel: "Ask for a review"
  });

  if (!values) return;

  await runReturnAction(
    () => returnsApi("escalateReturn", { returnId, note: values.note }),
    refreshBuyerOrders,
    "Thanks. Lesovia will review your return and notify you."
  );
};

window.cancelUnshipped = async (sellerOrderId) => {
  const subOrder = subOrderCache.get(sellerOrderId);
  const amount = subOrder ? formatCents(subOrder.buyerTotalCents) : "the full amount";

  if (!confirm(`Cancel this order? The seller hasn't shipped it, and you'll be refunded ${amount} in full. Banks usually show it within 5 to 10 business days.`)) return;

  await runReturnAction(
    () => returnsApi("cancelUnshippedOrder", { sellerOrderId }),
    refreshBuyerOrders,
    "Your order was cancelled and refunded."
  );
};

// ---------------- seller ----------------
window.approveReturn = async (returnId) => {
  if (!confirm("Approve this return? The buyer will send the items back, and their refund is sent once you confirm they arrived.")) return;

  await runReturnAction(() => returnsApi("decideReturn", { returnId, decision: "approve" }), refreshSellerOrders, "Return approved. The buyer has been notified.");
};

window.declineReturn = async (returnId) => {
  const values = await openFormModal({
    title: "Decline this return",
    intro: "The buyer will see your reason and can ask Lesovia to review your decision.",
    fields: [{ name: "note", label: "Reason", type: "textarea", required: true, maxLength: 500 }],
    submitLabel: "Decline return"
  });

  if (!values) return;

  await runReturnAction(() => returnsApi("decideReturn", { returnId, decision: "decline", note: values.note }), refreshSellerOrders, "Return declined.");
};

window.confirmReturnReceivedUi = async (returnId) => {
  const ret = [...returnsState.sellerReturns.values()].find((r) => r.id === returnId);
  const amount = ret && ret.plan ? formatCents(ret.plan.buyerRefundCents) : "the refund";

  if (!confirm(`Confirm the package arrived? ${amount} will be refunded to the buyer right away. This can't be undone.`)) return;

  await runReturnAction(
    () => returnsApi("confirmReturnReceived", { returnId }),
    refreshSellerOrders,
    (result) => result.status === "refunded"
      ? "Done. The buyer has been refunded."
      : "The refund couldn't be sent right now. Lesovia has been notified and will follow up."
  );
};

window.reportReturnProblemUi = async (returnId) => {
  const values = await openFormModal({
    title: "Report a problem with the returned package",
    intro: "Lesovia will review this and decide. Describe what you found (for example, the box was empty or the item is damaged).",
    fields: [{ name: "note", label: "What's wrong?", type: "textarea", required: true, maxLength: 500 }],
    submitLabel: "Report problem"
  });

  if (!values) return;

  await runReturnAction(
    () => returnsApi("reportReturnProblem", { returnId, note: values.note }),
    refreshSellerOrders,
    "Thanks. Lesovia will review it and be in touch."
  );
};

// Shipping a sub-order also asks where a return should be sent, so the buyer
// has it if they ever need it. The last address used is remembered in this
// browser only (never in the database, where other users could read it).
const RETURN_ADDRESS_KEY = () => `lesovia.returnAddress.${auth.currentUser.uid}`;

function savedReturnAddress() {
  try {
    return JSON.parse(localStorage.getItem(RETURN_ADDRESS_KEY()) || "null") || {};
  } catch (err) {
    return {};
  }
}

export async function shipSubOrder(orderId) {
  const { ref: orderRef } = orderTarget(orderId, "sub");
  const orderSnap = await getDoc(orderRef);

  if (!orderSnap.exists()) {
    alert("Order not found.");
    return;
  }

  const order = orderSnap.data();
  const saved = savedReturnAddress();

  const values = await openFormModal({
    title: "Ship this order",
    intro: "Add the tracking number if you have it. Also tell us where a buyer should send a return; only this buyer will see it. A business or PO box address works.",
    fields: [
      { name: "trackingNumber", label: "Tracking number (optional)", maxLength: 80 },
      { name: "fullName", label: "Return address: name or business", required: true, value: saved.fullName, maxLength: 100 },
      { name: "line1", label: "Address line 1", required: true, value: saved.line1 },
      { name: "line2", label: "Address line 2", value: saved.line2 },
      { name: "city", label: "City", required: true, value: saved.city, maxLength: 100 },
      { name: "state", label: "State", required: true, value: saved.state, maxLength: 100 },
      { name: "zip", label: "ZIP code", required: true, value: saved.zip, maxLength: 20 },
      { name: "country", label: "Country", required: true, value: saved.country || "United States", maxLength: 100 }
    ],
    submitLabel: "Mark as shipped"
  });

  if (!values) return;

  const { trackingNumber, ...returnAddress } = values;

  try {
    localStorage.setItem(RETURN_ADDRESS_KEY(), JSON.stringify(returnAddress));
  } catch (err) { /* private browsing: just don't remember it */ }

  try {
    await updateDoc(orderRef, {
      fulfillmentStatus: "shipped",
      shippedAt: new Date(),
      trackingNumber: trackingNumber || null,
      returnAddress
    });

    await notifyBuyerOfOrder(order, true, orderId, {
      type: "shipped",
      title: "Order Shipped",
      message: `Your order for "${describeProducts(order.products)}" has been shipped.`
    });

    alert("Order marked as shipped");
    loadSellerOrders();
  } catch (err) {
    alert("Failed to update order: " + err.message);
  }
}

// ================= SELLER: RETURNS & REFUNDS PAGE (seller-returns.html) =================
// Every return and cancellation on this seller's orders, newest first, grouped
// by whether it's waiting on them. Each card is the same panel the seller sees
// on their Orders page (approve / decline / confirm receipt all work from here
// too), plus a link back to the order itself.
const RETURN_GROUPS = [
  ["Needs your action", ["requested", "shipped_back"]],
  ["In progress", ["approved", "declined", "escalated", "problem_reported", "queued", "refunding", "refund_failed"]],
  ["Finished", ["refunded", "rejected", "cancelled", "expired"]]
];

const QUIET_STATUS_TEXT = {
  cancelled: "The buyer withdrew this return request.",
  expired: "The buyer didn't send the item back in time, so this return was closed."
};

export async function loadSellerReturnsPage() {
  const container = document.getElementById("sellerReturnsList");

  if (!container || !auth.currentUser) return;

  injectReturnStyles();
  await loadReturnPolicyUi();

  try {
    const snapshot = await getDocs(query(collection(db, "returns"), where("sellerId", "==", auth.currentUser.uid)));

    const list = snapshot.docs
      .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
      .sort((a, b) => (b.requestedMs || 0) - (a.requestedMs || 0));

    // "I received it" looks its return up here by id.
    returnsState.sellerReturns = new Map(list.map((ret) => [ret.id, ret]));

    if (list.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-glyph">&#8617;</div>
          <div><strong>No returns or cancellations yet.</strong></div>
          <div style="font-size:13px; margin-top:4px;">If a buyer returns an item or cancels an order you haven't shipped, it will show up here.</div>
        </div>`;
      return;
    }

    const orderCache = new Map();
    const buyerCache = new Map();

    const orderOf = async (id) => {
      if (!orderCache.has(id)) {
        const snap = await getDoc(doc(db, "sellerOrders", id));
        orderCache.set(id, snap.exists() ? snap.data() : {});
      }
      return orderCache.get(id);
    };

    const buyerNameOf = async (uid) => {
      if (!buyerCache.has(uid)) {
        const snap = await getDoc(doc(db, "users", uid));
        const data = snap.exists() ? snap.data() : {};
        buyerCache.set(uid, data.fullName || data.name || "Buyer");
      }
      return buyerCache.get(uid);
    };

    let html = "";

    for (const [title, statuses] of RETURN_GROUPS) {
      const group = list.filter((ret) => statuses.includes(ret.status));

      html += `<h3 style="margin-top:28px;">${escapeHtml(title)} (${group.length})</h3>`;

      if (group.length === 0) {
        html += `<p style="color:var(--lv-slate,#5B6B62);">Nothing here.</p>`;
        continue;
      }

      for (const ret of group) {
        const subOrder = await orderOf(ret.sellerOrderId);
        const buyerName = await buyerNameOf(ret.buyerId);
        const cancellation = ret.kind === "cancellation";
        const items = (ret.items || []).map((item) => `${escapeHtml(item.name)} &times; ${escapeHtml(item.quantity)}`).join(", ");
        const quiet = QUIET_STATUS_TEXT[ret.status];

        html += `
          <div class="seller-return-card" style="margin:14px 0;">
            <p style="margin:0;">
              <strong>${cancellation ? "Cancellation" : "Return"} &middot; order ${escapeHtml(ret.orderNumber)}</strong>
              &middot; <a href="seller-orders.html?orderId=${encodeURIComponent(ret.sellerOrderId)}">View order</a>
            </p>
            <p style="margin:2px 0 0;"><small style="color:var(--lv-slate,#5B6B62);">
              ${items} &middot; Buyer: ${escapeHtml(buyerName)} &middot; Requested ${ret.requestedMs ? escapeHtml(new Date(ret.requestedMs).toLocaleDateString()) : "N/A"}
            </small></p>
            ${quiet
              ? `<div class="rt-box"><p>${escapeHtml(quiet)}</p>${returnDetailsHtml(ret)}</div>`
              : sellerReturnHtml(ret.sellerOrderId, subOrder, ret)}
          </div>`;
      }
    }

    container.innerHTML = html;
  } catch (err) {
    console.error("Could not load returns:", err);

    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-glyph">&#128246;</div>
        <div><strong>Couldn't load your returns.</strong></div>
        <div style="font-size:13px; margin-top:4px;">This usually means a weak connection. Check it and try again.</div>
        <button type="button" style="margin-top:10px;" onclick="retrySellerReturns()">Retry</button>
      </div>`;
  }
}

window.retrySellerReturns = () => loadSellerReturnsPage();
