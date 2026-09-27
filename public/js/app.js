//temporary//
console.log("app.js loaded!");

//import { sendPasswordResetEmail } from
//"https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { auth, db } from "./firebase.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import {
  createUserWithEmailAndPassword,
  //sendEmailVerification,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  doc,
  setDoc,
  getDoc,
  collection,
  addDoc,
  query,
  where,
  or,
  getDocs,
  deleteDoc,
  updateDoc,
  onSnapshot,
  orderBy,
  serverTimestamp,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

let allProducts = [];
let allSellers = [];
let editingProductId = null;

// True if "Generate with AI" successfully filled the description box during
// the CURRENT upload/edit session. Used to record descriptionGeneratedByAI
// on the product -- resets on submit and on entering/leaving edit mode.
let aiGeneratedThisSession = false;

const functions = getFunctions();
//const storage = getStorage();

// Several render functions build HTML with `innerHTML +=` and drop
// user-supplied text straight in (this codebase does this already for
// things like color/size). Anything typed by ONE user that gets displayed
// to a DIFFERENT user -- a delivery address shown to the seller, for
// example -- must go through this first, or a buyer could type something
// like <img src=x onerror=...> as their name and have it execute in the
// seller's browser.
function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// When the browser restores a page from its back/forward cache (bfcache)
// -- e.g. clicking Back after navigating to another page -- it resumes the
// page exactly as frozen the moment you left, including any images or
// Firestore data that were still mid-load. Those in-flight loads don't
// reliably resume, which is why a page can look stuck after Back but works
// fine after a manual reload. Force that same fresh reload automatically
// instead of leaving the buyer/seller looking at a stalled page.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    window.location.reload();
  }
});

/* ================= REGISTER ================= */
const registerForm = document.getElementById("registerForm");
if (registerForm) {
  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fullName =
      document.getElementById("fullName").value;
    const email = document.getElementById("email").value;
    const password = document.getElementById("password").value;
    const role = document.getElementById("role").value;

    try {
      const userCred = await createUserWithEmailAndPassword(auth, email, password);

      // The function only trusts its OWN verified read of who's calling it
      // (via this token), never an email/uid the client claims -- so it has
      // to be sent here.
      const verifyIdToken = await userCred.user.getIdToken();

      const response = await fetch(
        "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/sendVerificationEmail",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${verifyIdToken}`,
          },
          body: JSON.stringify({
            fullName: fullName,
          }),
        }
      );
      //await sendEmailVerification(userCred.user);
      await setDoc(doc(db, "users", userCred.user.uid), {
        fullName,
        email,
        role,
        createdAt: new Date(), // account creation date
        lastLogin: new Date(),  // first login = signup
        status: "active"
      });

      await signOut(auth);

      alert(
      "Welcome to Lesovia!\n\nWe've sent a verification email to your inbox.\n\nPlease verify your email before logging in."
      );

      window.location.href = "login.html";
      /*if (role === "seller") {
        window.location.href = "seller dashboard.html";
      } else if (role === "buyer") {
        window.location.href = "buyer dashboard.html";
      } else if (role === "admin") {
        window.location.href = "admin.html";
      }*/

    } catch (err) {
      alert(err.message);
    }
  });
}

/* ================= LOGIN ================= */
const loginForm = document.getElementById("loginForm");
if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("email").value;
    const password = document.getElementById("password").value;

    try {
      const userCred = await signInWithEmailAndPassword(auth, email, password);      

     /* await userCred.user.reload();
      if (!userCred.user.emailVerified) {

        alert(
          "Your email address has not been verified.\n\nPlease check your Gmail spam and click the verification link before logging in."
      );
    
        await signOut(auth);
    
        return;
    }*/
    await userCred.user.reload();

    if (!userCred.user.emailVerified) {

        // Automatically send another verification email. The function
        // trusts only its own verified read of who's calling it (via this
        // token), not an email the client claims.
        const verifyIdToken = await userCred.user.getIdToken();

        const response = await fetch(
            "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/sendVerificationEmail",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${verifyIdToken}`,
                },
                body: JSON.stringify({
                    fullName: ""
                }),
            }
        );

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || "Unable to send verification email.");
        }

        await signOut(auth);

        alert(
    `Your email address has not been verified.

    We've automatically sent a new verification email to:

    ${userCred.user.email}

    Please check your inbox and click the verification link before logging in.`
        );

        return;
    }
      const userDoc = await getDoc(doc(db, "users", userCred.user.uid));

      if (userDoc.exists() && userDoc.data().status === "banned") {
        alert("Your account has been banned.");
        await signOut(auth);
        return;
      }
      await updateDoc(doc(db, "users", userCred.user.uid), {
        lastLogin: new Date()
      });

      if (userDoc.exists()) {
        const role = userDoc.data().role;

        // If we got here via the page-role gate redirecting an unauthenticated
        // visitor (e.g. clicking a notification-email link while signed out),
        // send them back to that exact page instead of just their dashboard --
        // but only if it's actually a page their role is allowed on.
        const redirectParam =
          new URLSearchParams(window.location.search).get("redirect");

        const redirectTarget =
          redirectParam ? decodeURIComponent(redirectParam) : null;

        if (redirectTarget && requiredRoleForPage(redirectTarget) === role) {
          window.location.href = redirectTarget;
        } else {
          window.location.href = homeForRole(role);
        }
      }
    } catch (err) {
      alert(err.message);
    }
  });
}

/* ================= AUTH STATE ================= */
const params = new URLSearchParams(window.location.search);

const conversationId =
    params.get("conversationId");

console.log("Conversation from URL:", conversationId);

// Every page that requires a specific role to view at all -- not just the
// three main dashboards. Matched against the DECODED pathname (see
// decodeURIComponent below) -- filenames with spaces like "seller
// dashboard.html" are served as "%20" in location.pathname, which would
// never match a literal-space key otherwise.
const PAGE_ROLE = {
  "buyer dashboard.html": "buyer",
  "cart.html": "buyer",
  "messages.html": "buyer",
  "order.html": "buyer",
  "buyer-notifications.html": "buyer",
  "reviews.html": "buyer",
  "seller dashboard.html": "seller",
  "seller-upload.html": "seller",
  "seller-orders.html": "seller",
  "seller-messages.html": "seller",
  "seller-profile.html": "seller",
  "seller-history.html": "seller",
  "seller-notifications.html": "seller",
  "seller-reviews.html": "seller"
  // admin.html isn't listed here -- it doesn't load app.js at all, only
  // admin.js, which has its own equivalent guard (see admin.js).
};

function requiredRoleForPage(path) {
  // Check longest page name first -- e.g. "seller-messages.html" must be
  // matched before the shorter "messages.html", since the former contains
  // the latter as a substring. Without this, sellers visiting
  // seller-messages.html or seller-reviews.html were told they needed to
  // be a buyer and got bounced back to their own dashboard.
  const pages = Object.keys(PAGE_ROLE).sort((a, b) => b.length - a.length);

  for (const page of pages) {
    if (path.includes(page)) return PAGE_ROLE[page];
  }

  return null;
}

function homeForRole(role) {
  if (role === "seller") return "seller dashboard.html";
  if (role === "admin") return "admin.html";
  return "buyer dashboard.html";
}

// These pages start hidden (see the inline <style> in each one's <head>)
// specifically so there's no flash of dashboard content before this check
// runs. This is a front-door/UX measure only -- the real protection against
// someone bypassing it is that Firestore/Storage rules require the matching
// role server-side regardless of what this page shows.
function revealPage() {
  if (document.body) document.body.style.visibility = "visible";
}

onAuthStateChanged(auth, async (user) => {
  // pathname comes back URL-encoded for filenames with spaces (e.g.
  // "/seller%20dashboard.html"), which would silently fail to match
  // PAGE_ROLE's literal-space keys -- decode before matching.
  const currentPage = decodeURIComponent(window.location.pathname);
  const requiredRole = requiredRoleForPage(currentPage);

  if (user) {
    const userDoc = await getDoc(doc(db, "users", user.uid));

    if (!userDoc.exists()) {
      if (requiredRole) {
        const redirectTarget = encodeURIComponent(currentPage + window.location.search);
        window.location.href = `login.html?redirect=${redirectTarget}`;
      }
      return;
    }

    const role = userDoc.data().role;
//looking for user without a fullname//
    const userData = userDoc.data();

    // PAGE PROTECTION -- wrong role (or logged in but this page needs a
    // role) gets sent to their own home page.
    if (requiredRole && role !== requiredRole) {
      window.location.href = homeForRole(role);
      return;
    }

    // First-time seller setup redirect has to happen BEFORE revealPage(),
    // otherwise the real seller page flashes before bouncing to the
    // profile-setup page.
    if (role === "seller" &&
        !userData.storeName &&
        !currentPage.includes("seller-profile.html")) {

      window.location.href = "seller-profile.html";
      return;
    }

    revealPage();

    if (!userData.fullName) {

      const fullName =
        prompt("Please enter your full name");

      if (fullName) {

        await updateDoc(
          doc(db, "users", user.uid),
          {
            fullName: fullName
          }
        );

        userData.fullName = fullName;

      }

    }

    //  UI
    const welcome = document.getElementById("welcome");
    if (welcome) welcome.innerText = `Welcome, ${userData.fullName || user.email}`;

    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) logoutBtn.style.display = "block";

    // 🚀 LOAD FEATURES
    if (role === "buyer") {
      loadProducts();
      loadMyOrders();
      loadCart();
      loadBuyerMessages();
      loadNotificationBadge();
    }

    if (role === "seller") {
      loadSellerProducts();
      loadSellerOrders();
      loadSoldProducts();
      loadSellerMessages();
      loadStoreProfile();
      //loadNotifications();
      loadNotificationBadge();
    }

  } else {
    //  NOT LOGGED IN
    if (requiredRole) {
      const redirectTarget = encodeURIComponent(currentPage + window.location.search);
      window.location.href = `login.html?redirect=${redirectTarget}`;
      return;
    }

    revealPage();
  }
});



/* ================= PRODUCT UPLOAD (SELLER) ================= */

const storage = getStorage();

const productForm = document.getElementById("productForm");

if (productForm) {
  productForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    try {

      console.log("Submitting product...");
  
      // all your existing upload code here
  
    } catch (err) {
  
      console.error(err);
      alert(err.message);
  
    }

    const fileInput = document.getElementById("pImage");
    const files = fileInput.files;

    let imageURLs = [];

    // Upload new images if selected
    if (files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        // Path includes the uploader's uid so Storage rules can restrict
        // writes to the seller who owns them.
        const storageRef = ref(
          storage,
          `products/${auth.currentUser.uid}/${Date.now()}_${i}_${file.name}`
        );
        await uploadBytes(storageRef, file);

        const url = await getDownloadURL(storageRef);
        imageURLs.push(url);
      }
    }

    // If editing and no new images → keep old ones
    if (editingProductId && imageURLs.length === 0) {
      const docSnap = await getDoc(doc(db, "products", editingProductId));
      const data = docSnap.data();

      imageURLs = data.images || (data.imageURL ? [data.imageURL] : []);
    }

    // If new product and no image → block
    if (!editingProductId && imageURLs.length === 0) {
      alert("Please upload at least one image");
      return;
    }

    const selectedColors = Array.from(
      document.getElementById("pColors").selectedOptions
    ).map(option => option.value);
    
    const selectedSizes = Array.from(
      document.getElementById("pSizes").selectedOptions
    ).map(option => option.value);

    const productData = {
      name: document.getElementById("pName").value.trim(),
    
      brand: document.getElementById("pBrand").value.trim(),
    
      price: Number(document.getElementById("pPrice").value),
    
      quantity: Number(document.getElementById("quantity").value),
    
      description: document.getElementById("pDesc").value.trim(),
    
      images: imageURLs,
    
      sellerId: auth.currentUser.uid,
    
      category: document.getElementById("pCategory").value,
    
      condition: document.getElementById("pCondition").value,
    
      colors: selectedColors,
    
      sizes: selectedSizes,
    
      createdAt: new Date()
    };

    // UPDATE PRODUCT
    if (editingProductId) {

      // originalQuantity is never touched on edit -- it records what was
      // uploaded at creation time, not the current stock level. Only
      // include descriptionGeneratedByAI if AI was actually used in THIS
      // edit -- otherwise leave whatever value (or absence of one) the
      // product already had untouched.
      const updatePayload = { ...productData };

      if (aiGeneratedThisSession) {
        updatePayload.descriptionGeneratedByAI = true;
      }

      await updateDoc(doc(db, "products", editingProductId), updatePayload);

      alert("Product updated!");
      editingProductId = null;
      aiGeneratedThisSession = false;

      document.querySelector("#productForm button").innerText = "Post to Marketplace";
    }

    // ADD NEW PRODUCT
    else {
      await addDoc(collection(db, "products"), {
        ...productData,
        originalQuantity: productData.quantity,
        descriptionGeneratedByAI: aiGeneratedThisSession
      });

      alert("Product posted!");
      aiGeneratedThisSession = false;
    }

    productForm.reset();
  });
}


//AI Generated Function For S up//

const generateBtn = document.getElementById("generateAI");

if (generateBtn) {

    generateBtn.addEventListener("click", async () => {

        const productName = document.getElementById("pName").value.trim();
        const category = document.getElementById("pCategory").value;
        const price = document.getElementById("pPrice").value;
        const descriptionBox = document.getElementById("pDesc");

        if (!productName) {
            alert("Please enter a product name first.");
            return;
        }

        generateBtn.disabled = true;
        generateBtn.innerText = "Generating...";

    /*    try {

            const response = await fetch(
                "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/generateProductDescription",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        productName,
                        category,
                        condition: "New",
                        price
                    })
                }
            );

            //const data = await response.json();
            if (!response.ok) {
              const error = await response.json();
              console.error(error);
              alert(error.error || "AI generation failed.");
              return;
          }
          
          const data = await response.json();

            descriptionBox.value = data.description;

        } catch (err) {

            console.error(err);
            alert("Failed to generate description.");

        }*/
            try {
              const response = await fetch(
                  "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/generateProductDescription",
                  {
                      method: "POST",
                      headers: {
                          "Content-Type": "application/json"
                      },
                      body: JSON.stringify({
                          productName,
                          category,
                          condition: "New",
                          price
                      })
                  }
              );
          
              const data = await response.json();
          
              if (!response.ok) {
                  console.error(data);
                  alert(data.error || "AI generation failed.");
              } else {
                  descriptionBox.value = data.description;
                  aiGeneratedThisSession = true;
              }
          
          } catch (err) {
              console.error(err);
              alert("Failed to generate description.");
          } finally {
              generateBtn.disabled = false;
              generateBtn.innerText = "✨ Generate with AI";
          }

        generateBtn.disabled = false;
        generateBtn.innerText = "✨ Generate with AI";

    });

}

/* ==========FUNCTION FOR SCRIPE ==================*/

/*const stripe = Stripe("pk_test_51TZMZKJP6GbymKnndtGlf6eMNL3TgXgtA5nlZB6i3noPpqmC7dwXnWHbSDMQCuNbhlgSDy6sdzUHCmqKDZGE60sf008lPcapEf");

const elements = stripe.elements();

const card = elements.create("card");*/

const STRIPE_PUBLISHABLE_KEY =
  "pk_test_51TZMZKJP6GbymKnndtGlf6eMNL3TgXgtA5nlZB6i3noPpqmC7dwXnWHbSDMQCuNbhlgSDy6sdzUHCmqKDZGE60sf008lPcapEf";

let stripe = null;
let elements = null;
let card = null;

if (typeof Stripe !== "undefined") {
  stripe = Stripe(STRIPE_PUBLISHABLE_KEY);

  elements = stripe.elements();
  card = elements.create("card");
}
//OFC//
let selectedProduct = null;

const createPaymentIntentURL =
  "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/createPaymentIntent";

const saveCheckoutAddressURL =
  "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/saveCheckoutAddress";

const verifyPaymentURL =
  "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/verifyPayment";

const createConnectOnboardingLinkURL =
  "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/createConnectOnboardingLink";

/* ================= SHARED CHECKOUT (BUY NOW + CART) =================
   The server (createPaymentIntent / verifyPayment) is the only thing that
   ever decides the real total or marks an order "paid". This code just
   asks the server to start a checkout, collects the card, and asks the
   server to verify the result -- it never writes orders/inventory itself. */

let currentOrderId = null;
let currentClientSecret = null;
let currentCheckoutMode = null; // "buyNow" | "cart"

// Which Stripe instance + card field the current checkout is paid with. A
// single-seller order is a Direct Charge on that seller's connected account,
// so it has to be confirmed by a Stripe.js instance scoped to that account
// (and a card field created from it); everything else uses the platform's.
let activeStripe = stripe;
let activeCard = card;

function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function resetCheckoutPaymentMethod() {
  if (activeCard && activeCard !== card) {
    activeCard.destroy();
    card.mount("#card-element");
  }

  activeStripe = stripe;
  activeCard = card;
}

function useCardFor(stripeAccountId) {
  resetCheckoutPaymentMethod();

  if (!stripeAccountId) return;

  activeStripe = Stripe(STRIPE_PUBLISHABLE_KEY, { stripeAccount: stripeAccountId });
  activeCard = activeStripe.elements().create("card");

  card.unmount();
  activeCard.mount("#card-element");
}

function shippingOptionsFor(shipping) {
  if (!shipping) return [];

  const isCents = (value) => Number.isInteger(value) && value >= 0;
  const options = [];

  if (shipping.freeShipping === true) {
    options.push({ method: "standard", label: "Standard shipping", cents: 0 });
  } else if (isCents(shipping.flatRateCents)) {
    options.push({ method: "standard", label: "Standard shipping", cents: shipping.flatRateCents });
  }

  if (shipping.expressEnabled === true && isCents(shipping.expressRateCents)) {
    options.push({ method: "express", label: "Express shipping", cents: shipping.expressRateCents });
  }

  return options;
}

// Groups what's being bought by seller and asks the buyer to pick a shipping
// option for each. Purely presentational: the prices shown come from each
// seller's own saved shipping settings, but the server recomputes the real
// shipping cost itself and only trusts the method name chosen here.
// Resolves to [{ sellerId, method }], or null if the buyer cancels.
async function chooseShipping(items) {
  const groups = new Map();

  for (const item of items) {
    const productSnap = await getDoc(doc(db, "products", item.productId));

    // A product that's gone is reported by the server with a proper message.
    if (!productSnap.exists()) continue;

    const product = productSnap.data();

    if (!groups.has(product.sellerId)) {
      groups.set(product.sellerId, { sellerId: product.sellerId, lines: [] });
    }

    groups.get(product.sellerId).lines.push(`${product.name} \u00d7 ${item.quantity}`);
  }

  const sellers = [];

  for (const group of groups.values()) {
    const sellerSnap = await getDoc(doc(db, "users", group.sellerId));
    const seller = sellerSnap.exists() ? sellerSnap.data() : {};

    sellers.push({
      ...group,
      storeName: seller.storeName || "Seller",
      options: shippingOptionsFor(seller.shipping)
    });
  }

  if (sellers.length === 0) return [];

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:2000;overflow:auto;";

    const panel = document.createElement("div");
    panel.style.cssText =
      "background:#fff;color:#111;max-width:440px;margin:60px auto;padding:20px;border-radius:10px;";

    const heading = document.createElement("h2");
    heading.textContent = "Choose shipping";
    panel.appendChild(heading);

    let blocked = false;

    sellers.forEach((seller, index) => {
      const box = document.createElement("fieldset");
      box.style.cssText = "margin:0 0 14px;padding:10px;";

      const legend = document.createElement("legend");
      legend.textContent = seller.storeName;
      box.appendChild(legend);

      const list = document.createElement("p");
      list.style.cssText = "margin:0 0 8px;font-size:14px;";
      list.textContent = seller.lines.join(", ");
      box.appendChild(list);

      if (seller.options.length === 0) {
        blocked = true;

        const note = document.createElement("p");
        note.style.color = "#b00020";
        note.textContent =
          "This seller hasn't set up shipping yet, so their items can't be purchased right now.";
        box.appendChild(note);
      }

      seller.options.forEach((option, optionIndex) => {
        const label = document.createElement("label");
        label.style.cssText = "display:block;margin-bottom:4px;";

        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = `shipping_${index}`;
        radio.value = option.method;
        radio.checked = optionIndex === 0;

        label.appendChild(radio);
        label.appendChild(
          document.createTextNode(
            ` ${option.label} \u2014 ${option.cents === 0 ? "Free" : formatCents(option.cents)}`
          )
        );

        box.appendChild(label);
      });

      panel.appendChild(box);
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.marginRight = "10px";

    const continueBtn = document.createElement("button");
    continueBtn.type = "button";
    continueBtn.textContent = "Continue to payment";
    continueBtn.disabled = blocked;

    cancelBtn.addEventListener("click", () => {
      overlay.remove();
      resolve(null);
    });

    continueBtn.addEventListener("click", () => {
      const selections = sellers.map((seller, index) => {
        const chosen = panel.querySelector(`input[name="shipping_${index}"]:checked`);
        return { sellerId: seller.sellerId, method: chosen ? chosen.value : "standard" };
      });

      overlay.remove();
      resolve(selections);
    });

    panel.appendChild(cancelBtn);
    panel.appendChild(continueBtn);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  });
}

// Shows the buyer exactly what they're about to pay, per seller. Amounts come
// straight from the server's response.
function renderCheckoutSummary(data) {
  const box = document.getElementById("checkoutSummary");
  if (!box) return;

  box.textContent = "";

  const title = document.createElement("h3");
  title.style.cssText = "margin:0 0 10px;font-size:16px;";
  title.textContent = "Order Summary";
  box.appendChild(title);

  (data.sellers || []).forEach((seller) => {
    const line = document.createElement("p");
    line.style.cssText = "margin:0 0 6px;font-size:14px;";

    let text =
      `${seller.storeName}: items ${formatCents(seller.productSubtotalCents)}` +
      ` + shipping ${seller.shippingCents === 0 ? "free" : formatCents(seller.shippingCents)}`;

    if (seller.taxCents > 0) text += ` + tax ${formatCents(seller.taxCents)}`;

    line.textContent = text;
    box.appendChild(line);
  });

  const total = document.createElement("p");
  total.style.cssText = "margin:8px 0 0;font-weight:bold;";
  total.textContent = `Total: ${formatCents(data.amount)}`;
  box.appendChild(total);
}

async function startCheckout(items, cartItemIds, mode) {
  const user = auth.currentUser;

  if (!user) {
    alert("Please login first");
    return;
  }

  if (!stripe || !card) {
    alert("Payment is not available on this page.");
    return;
  }

  if (currentOrderId) {
    alert("A checkout is already in progress. Finish or cancel it first.");
    return;
  }

  try {
    const shippingSelections = await chooseShipping(items);

    if (!shippingSelections) return; // buyer cancelled

    const idToken = await user.getIdToken();

    const checkoutId =
      (window.crypto && crypto.randomUUID && crypto.randomUUID()) ||
      `${user.uid}_${Date.now()}`;

    const response = await fetch(createPaymentIntentURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`
      },
      body: JSON.stringify({
        checkoutId,
        items,
        cartItemIds,
        shippingSelections
      })
    });

    const data = await response.json();

    if (!response.ok) {
      alert(data.error || "Unable to start checkout.");
      return;
    }

    currentOrderId = data.orderId;
    currentClientSecret = data.clientSecret;
    currentCheckoutMode = mode;

    useCardFor(data.stripeAccountId);
    renderCheckoutSummary(data);

    const modal = document.getElementById("checkoutModal");
    const paymentMessage = document.getElementById("payment-message");

    if (paymentMessage) paymentMessage.textContent = "";
    if (modal) modal.style.display = "block";

    // Prefill from the buyer's saved address, if they have one -- they only
    // need to type it once; editing it here updates that saved default when
    // they pay (see the payBtn handler).
    if (document.getElementById("deliveryAddressSection")) {
      try {
        const userSnap = await getDoc(doc(db, "users", user.uid));
        fillDeliveryAddressForm(userSnap.exists() ? userSnap.data().defaultAddress : null);
      } catch (addressErr) {
        console.error("Could not load saved address:", addressErr);
      }
    }

  } catch (err) {
    console.error(err);
    alert("Unable to start checkout: " + err.message);
  }
}


/* =================LOAD CATEGORIES ON BUYER DASHBOARD =========*/

const categoryFilter = document.getElementById("categoryFilter");

if (categoryFilter) {
  categoryFilter.addEventListener("change", () => {
    const selected = categoryFilter.value;

    if (selected === "all") {
      displayProducts(allProducts);
    } else {
      const filtered = allProducts.filter(p => p.category === selected);
      displayProducts(filtered);
    }
  });
}

/* ================= STRIPE CARD MOUNT ================= */

const cardElementContainer = document.getElementById("card-element");

if(cardElementContainer){
  card.mount("#card-element");

  // The address form lives inside the same checkout modal as the card
  // element, so it's built here too -- once per page, right before the
  // card mounts -- rather than duplicating this markup across cart.html,
  // product-detail.html, and buyer dashboard.html by hand (all three ship
  // their own copy of #checkoutModal; that kind of triplicated markup is
  // exactly what's caused drift/bugs elsewhere in this codebase).
  const addressFieldDefs = [
    { id: "addrFullName", label: "Full name", required: true },
    { id: "addrLine1", label: "Address line 1", required: true },
    { id: "addrLine2", label: "Address line 2 (optional)", required: false },
    { id: "addrCity", label: "City", required: true },
    { id: "addrState", label: "State", required: true },
    { id: "addrZip", label: "ZIP / postal code", required: true },
    { id: "addrCountry", label: "Country", required: true },
    { id: "addrPhone", label: "Phone (optional)", required: false },
  ];

  const addressSection = document.createElement("div");
  addressSection.id = "deliveryAddressSection";
  addressSection.style.marginBottom = "16px";

  addressSection.innerHTML =
    `<h3 style="margin:0 0 10px;font-size:16px;">Delivery Address</h3>` +
    addressFieldDefs
      .map(
        (f) => `
          <input
            type="text"
            id="${f.id}"
            placeholder="${f.label}"
            style="display:block;width:100%;margin-bottom:8px;box-sizing:border-box;"
            ${f.required ? "required" : ""}
          >
        `
      )
      .join("");

  // Filled in by renderCheckoutSummary() once the server has priced the order.
  const summarySection = document.createElement("div");
  summarySection.id = "checkoutSummary";
  summarySection.style.marginBottom = "16px";

  cardElementContainer.parentNode.insertBefore(summarySection, cardElementContainer);
  cardElementContainer.parentNode.insertBefore(addressSection, cardElementContainer);
}

// Fills the address form from a saved address (or clears it if none exists).
function fillDeliveryAddressForm(address) {
  const a = address || {};
  ["FullName", "Line1", "Line2", "City", "State", "Zip", "Country", "Phone"].forEach((key) => {
    const el = document.getElementById(`addr${key}`);
    if (el) el.value = a[key.charAt(0).toLowerCase() + key.slice(1)] || "";
  });
}

// Reads the address form into a plain object, trimming every field.
function getDeliveryAddressFromForm() {
  const read = (id) => (document.getElementById(id)?.value || "").trim();
  return {
    fullName: read("addrFullName"),
    line1: read("addrLine1"),
    line2: read("addrLine2"),
    city: read("addrCity"),
    state: read("addrState"),
    zip: read("addrZip"),
    country: read("addrCountry"),
    phone: read("addrPhone"),
  };
}

// Required fields only -- line2/phone stay optional, matching the form above.
function isDeliveryAddressComplete(address) {
  return Boolean(
    address.fullName && address.line1 && address.city &&
    address.state && address.zip && address.country
  );
}


/* ================= LOAD PRODUCTS (BUYER) ================= */

async function loadProducts() {
  const productList = document.getElementById("productList");
  if (!productList) return;

  const snapshot = await getDocs(collection(db, "products"));
  allProducts = [];
  productList.innerHTML = "";

  // Cached here (not just where it's used) so the search box can match
  // shop names on any page that loads the product grid, without a second
  // round trip per search.
  loadSellersForSearch();

  snapshot.forEach(docSnap => {
    const product = docSnap.data();
  
    // Hide products that are out of stock
    if (
      product.quantity !== undefined &&
      product.quantity <= 0
    ) return;
  
    allProducts.push({
      id: docSnap.id,
      ...product
    });
  });

  displayProducts(allProducts);
}

// Caches every seller's storeName so the search box can match shop names,
// not just product names.
async function loadSellersForSearch() {
  const snapshot = await getDocs(
    query(collection(db, "users"), where("role", "==", "seller"))
  );

  allSellers = [];

  snapshot.forEach(docSnap => {
    const seller = docSnap.data();
    if (!seller.storeName) return; // hasn't set up a shop yet

    allSellers.push({
      id: docSnap.id,
      storeName: seller.storeName,
      storeDescription: seller.storeDescription || ""
    });
  });
}

// One overall rating for the WHOLE shop -- the average across every review
// left on any of that seller's products, not a per-product breakdown.
async function getShopRating(sellerId) {
  const snapshot = await getDocs(
    query(collection(db, "reviews"), where("sellerId", "==", sellerId))
  );

  if (snapshot.empty) {
    return { average: null, count: 0 };
  }

  let total = 0;
  snapshot.forEach(docSnap => {
    total += Number(docSnap.data().rating) || 0;
  });

  return {
    average: (total / snapshot.size).toFixed(1),
    count: snapshot.size
  };
}

// Renders the "matching shop(s)" banner above the product grid when a
// search term matches a store name. Separate container from #productList
// so shop matches and product matches never overwrite each other.
async function displayShopMatches(sellers) {
  const container = document.getElementById("shopResults");
  if (!container) return;

  if (!sellers || sellers.length === 0) {
    container.innerHTML = "";
    return;
  }

  const cards = await Promise.all(sellers.map(async (seller) => {
    const { average, count } = await getShopRating(seller.id);

    const ratingText = average
      ? `⭐ ${average} (${count} review${count === 1 ? "" : "s"})`
      : "No reviews yet";

    return `
      <a class="shop-card" href="shop.html?sellerId=${seller.id}">
        <div class="shop-card-icon">🏪</div>
        <div>
          <h3>${seller.storeName}</h3>
          <p class="shop-card-rating">${ratingText}</p>
          ${seller.storeDescription ? `<p class="shop-card-desc">${seller.storeDescription}</p>` : ""}
        </div>
      </a>
    `;
  }));

  container.innerHTML = `
    <h3 class="shop-results-heading">Matching shops</h3>
    <div class="shop-card-row">${cards.join("")}</div>
  `;
}
//=======DISPLAY PRODUCT FUNCTION ===========//

function displayProducts(products) {

  const productList = document.getElementById("productList");

  if (!productList) return;

  productList.innerHTML = "";

  if (!products || products.length === 0) {
    productList.innerHTML = `
      <div class="empty-state">
        <div class="empty-glyph">🔍</div>
        <div><strong>No products matched.</strong></div>
        <div style="font-size:13px; margin-top:4px;">Try a different search or category.</div>
      </div>
    `;
    return;
  }

  products.forEach(product => {

    const card = document.createElement("div");

    card.classList.add("product-card");

    card.innerHTML = `
      <img
        src="${product.images ? product.images[0] : product.imageURL}"
        class="product-img"
        style="cursor:pointer;"
      >

      <h3>${product.name}</h3>

      <p class="price">
        $${product.price}
      </p>

      <p class="desc">
        ${product.description}
      </p>
    `;

    // CLICK PRODUCT IMAGE
    card.querySelector("img").addEventListener("click", () => {

      const currentPage = decodeURIComponent(window.location.pathname);

      if (currentPage.includes("buyer dashboard.html")) {
      
        window.location.href =
          `product-detail.html?id=${product.id}&from=buyer`;
      
      } else {
      
        window.location.href =
          `product-detail.html?id=${product.id}&from=index`;
      
      }

    });

    productList.appendChild(card);

  });
}


// ================= PUBLIC HOMEPAGE PRODUCTS =================

document.addEventListener("DOMContentLoaded", () => {

  const productList = document.getElementById("productList");

  if (productList) {
    loadProducts();
  }

});

// ================= BACK TO STORE =================

const backToStoreBtn =
  document.getElementById("backToStoreBtn");

if (backToStoreBtn) {

  backToStoreBtn.addEventListener("click", () => {

    const params =
      new URLSearchParams(window.location.search);

    const from = params.get("from");

    if (from === "buyer") {

      window.location.href =
        "buyer dashboard.html";

    } else {

      window.location.href =
        "index.html";

    }

  });

}


// ================= PUBLIC HOMEPAGE PRODUCTS =================

  document.addEventListener("DOMContentLoaded", () => {

    const productList = document.getElementById("productList");

    if (productList) {
      loadProducts();
    }

  });


  /*setupBuyButtons();
  <button class="buyBtn"
  data-id="${product.id}"
  data-seller="${product.sellerId}">
  Buy
</button>

<button class="addCartBtn" data-id="${product.id}">
  Add to Cart
</button>
  //setupAddCartButtons();*/


//========== AI SEARCH FUNCTION ==========//
  const aiSearchBtn = document.getElementById("aiSearchBtn");

  if (aiSearchBtn) {

    aiSearchBtn.addEventListener("click", async () => {

      const search =
        document.getElementById("aiSearchInput").value.trim();

      if (!search) {
        alert("Type what you're looking for first.");
        return;
      }

      aiSearchBtn.disabled = true;
      const originalLabel = aiSearchBtn.innerText;
      aiSearchBtn.innerText = "Searching...";

      try {

        const response = await fetch(
          "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/aiSearchProducts",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              search
            })
          }
        );

        const data = await response.json();

        if (!response.ok) {
          alert(data.error || "AI search failed. Please try again.");
          return;
        }

        displayProducts(data.products || []);

      } catch (err) {

        console.error(err);
        alert("AI search failed. Please try again.");

      } finally {

        aiSearchBtn.disabled = false;
        aiSearchBtn.innerText = originalLabel;

      }

    });

  }

const searchBtn = document.getElementById("searchBtn");
if (searchBtn) {
  searchBtn.addEventListener("click", () => {
    const term = document.getElementById("searchInput").value.trim().toLowerCase();

    const filtered = term
      ? allProducts.filter(p => p.name.toLowerCase().includes(term))
      : allProducts;

    displayProducts(filtered);

    const matchingShops = term
      ? allSellers.filter(s => s.storeName.toLowerCase().includes(term))
      : [];

    displayShopMatches(matchingShops);
  });
}

/* ================= BUY PRODUCT ================= 
function setupBuyButtons() {
  const buyButtons = document.querySelectorAll(".buyBtn");

  buyButtons.forEach(btn => {
    btn.addEventListener("click", async () => {
      const confirmBuy = confirm("Are you sure you want to buy this product?");
      if (!confirmBuy) return;

      try {
        await addDoc(collection(db, "orders"), {
          productId: btn.dataset.id,
          sellerId: btn.dataset.seller,
          userId: auth.currentUser.uid,
          status: "pending",
          createdAt: new Date()
        });
        await updateDoc(doc(db, "products", btn.dataset.id), {
          sold: true
        });

        alert("Order placed successfully!");
        loadMyOrders();
        loadProducts();
      } catch (err) {
        alert("Order failed: " + err.message);
      }
    });
  });
}
*/

/* ================= BUY PRODUCT ================= */

/*function setupBuyButtons() {

  const buyButtons = document.querySelectorAll(".buyBtn");

  buyButtons.forEach(btn => {

    btn.addEventListener("click", async () => {

      selectedProduct = {
        id: btn.dataset.id,
        sellerId: btn.dataset.seller
      };

      document.getElementById("checkoutModal").style.display = "block";

    });

  });

}*/

/* =============setupAddCartButtons ==========*/

/*function setupAddCartButtons() {
  const addCartButtons = document.querySelectorAll(".addCartBtn");

  addCartButtons.forEach(btn => {
    btn.addEventListener("click", async () => {
      const productId = btn.dataset.id;

      try {
        // Add to "carts" collection
        await addDoc(collection(db, "carts"), {
          productId: productId,
          userId: auth.currentUser.uid,
          quantity: 1,
          addedAt: new Date()
        });

        alert("Product added to cart!");
      } catch (err) {
        alert("Failed to add to cart: " + err.message);
      }
    });
  });
}*/

/* ================= STRIPE PAYMENT ================= */

const payBtn = document.getElementById("payBtn");

// Guards against a second click event that's already queued before
// `payBtn.disabled = true` takes effect (disabling a button doesn't cancel
// an already-dispatched click). Set synchronously, before anything async.
let isPayInFlight = false;

if(payBtn){

  payBtn.addEventListener("click", async () => {

    if (isPayInFlight) return;

    const paymentMessage = document.getElementById("payment-message");

    if (!currentOrderId || !currentClientSecret) {
      // Stale modal left open from an earlier page state (e.g. the tab was
      // restored/back-forward-cached) -- close it instead of leaving the
      // buyer stuck with a Pay Now button that can never work.
      const modal = document.getElementById("checkoutModal");
      if (modal) modal.style.display = "none";

      alert("This checkout session expired. Please click Buy Now / Checkout again to restart.");
      return;
    }

    // Validate and collect the delivery address BEFORE charging the card --
    // an incomplete address should stop checkout here, not after the buyer
    // has already been charged.
    let deliveryAddress = null;

    if (document.getElementById("deliveryAddressSection")) {
      deliveryAddress = getDeliveryAddressFromForm();

      if (!isDeliveryAddressComplete(deliveryAddress)) {
        alert("Please fill in your full name, address, city, state, ZIP, and country.");
        return;
      }
    }

    isPayInFlight = true;
    payBtn.disabled = true;
    payBtn.textContent = "Processing...";

    // Best-effort: remember this as the buyer's default for next time. Not
    // critical to the purchase itself, so a failure here is logged and
    // checkout continues rather than blocking payment over it.
    if (deliveryAddress) {
      try {
        await updateDoc(doc(db, "users", auth.currentUser.uid), {
          defaultAddress: deliveryAddress
        });
      } catch (saveAddressErr) {
        console.error("Could not save default address:", saveAddressErr);
      }
    }

    try {

      // Saved server-side before any money moves, so that even if this tab is
      // closed mid-payment the order Stripe's webhook creates knows where to
      // ship. If it can't be saved, the card is not charged.
      if (deliveryAddress) {
        const saveResponse = await fetch(saveCheckoutAddressURL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${await auth.currentUser.getIdToken()}`
          },
          body: JSON.stringify({ orderId: currentOrderId, deliveryAddress })
        });

        if (!saveResponse.ok) {
          const saveData = await saveResponse.json().catch(() => ({}));

          if (paymentMessage) {
            paymentMessage.textContent =
              saveData.error || "We couldn't save your delivery address. You have not been charged. Please try again.";
          }

          payBtn.disabled = false;
          payBtn.textContent = "Pay Now";
          isPayInFlight = false;

          return;
        }
      }

      const result = await activeStripe.confirmCardPayment(
        currentClientSecret,
        {
          payment_method: {
            card: activeCard
          }
        }
      );

      if (result.error) {

        if (paymentMessage) paymentMessage.textContent = result.error.message;

        payBtn.disabled = false;
        payBtn.textContent = "Pay Now";

        return;
      }

      if (result.paymentIntent.status !== "succeeded") {

        if (paymentMessage) {
          paymentMessage.textContent =
            "Payment was not completed. Status: " + result.paymentIntent.status;
        }

        payBtn.disabled = false;
        payBtn.textContent = "Pay Now";

        return;
      }

      // The client's own view of the payment is never trusted for
      // fulfillment -- ask the server to independently verify it with
      // Stripe before anything is written as "paid".
      const idToken = await auth.currentUser.getIdToken();

      const verifyResponse = await fetch(verifyPaymentURL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`
        },
        body: JSON.stringify({ orderId: currentOrderId, deliveryAddress })
      });

      const verifyData = await verifyResponse.json();

      if (!verifyResponse.ok || !verifyData.success) {

        if (paymentMessage) {
          paymentMessage.textContent =
            "We couldn't confirm your payment (" +
            (verifyData.status || verifyData.error || "unknown error") +
            "). Please try again or contact support.";
        }

        payBtn.disabled = false;
        payBtn.textContent = "Pay Now";

        return;
      }

      if (paymentMessage) paymentMessage.textContent = "Payment Successful!";

      const modal = document.getElementById("checkoutModal");
      if (modal) modal.style.display = "none";

      const finishedOrderIds = verifyData.orderIds || [];
      const finishedMode = currentCheckoutMode;

      currentOrderId = null;
      currentClientSecret = null;
      currentCheckoutMode = null;
      resetCheckoutPaymentMethod();

      payBtn.disabled = false;
      payBtn.textContent = "Pay Now";

      if (finishedMode === "cart") {

        alert("Checkout successful!");

        if (typeof loadCart === "function") loadCart();
        if (typeof loadProducts === "function") loadProducts();
        if (typeof loadMyOrders === "function") loadMyOrders();

      } else if (finishedOrderIds[0]) {

        window.location.href = `order.html?orderId=${finishedOrderIds[0]}`;

      }

    } catch (error) {

      console.error(error);

      if (paymentMessage) paymentMessage.textContent = error.message;

      payBtn.disabled = false;
      payBtn.textContent = "Pay Now";

    } finally {

      isPayInFlight = false;

    }

  });

}

/* ================= CLOSE CHECKOUT MODAL ================= */

const closeCheckout = document.getElementById("closeCheckout");

if(closeCheckout){

  closeCheckout.addEventListener("click", () => {

    document.getElementById("checkoutModal").style.display = "none";

    // Cancelling just abandons the pending order server-side (it stays
    // "pending_payment" and is never finalized) -- nothing to undo here.
    currentOrderId = null;
    currentClientSecret = null;
    currentCheckoutMode = null;
    resetCheckoutPaymentMethod();

    const paymentMessage = document.getElementById("payment-message");
    if (paymentMessage) paymentMessage.textContent = "";

  });

}


/* ================= CONNECT ORDERS (one sub-order per seller) =================
   A checkout now produces one buyer-facing `checkoutOrders` document plus one
   `sellerOrders` document per seller (see verifyPayment). Buyers and sellers
   work with the per-seller sub-orders below; older per-product `orders`
   documents still exist and are shown alongside them, unchanged.

   Every money figure on a sub-order was computed and stored by the server --
   the builders here only format it, and escape every stored string. */

function timestampToDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate();
  if (typeof ts.seconds === "number") return new Date(ts.seconds * 1000);
  return new Date(ts);
}

function orderTimeMs(data) {
  const date = data ? timestampToDate(data.createdAt) : null;
  return date ? date.getTime() : 0;
}

function describeProducts(products) {
  const [first, ...rest] = products || [];

  if (!first) return "Items";

  return rest.length === 0
    ? first.name
    : `${first.name} and ${rest.length} more ${rest.length === 1 ? "item" : "items"}`;
}

function shippingLineHtml(subOrder) {
  const kind = subOrder.shippingMethod === "express" ? " (express)" : "";

  return `Shipping${kind}: ${subOrder.shippingCents === 0 ? "Free" : formatCents(subOrder.shippingCents)}`;
}

function deliveryAddressHtml(addr, heading, showPhone) {
  if (!addr) return "";

  return `
    <p><strong>${heading}</strong><br>
      ${escapeHtml(addr.fullName)}<br>
      ${escapeHtml(addr.line1)}${addr.line2 ? `<br>${escapeHtml(addr.line2)}` : ""}<br>
      ${escapeHtml(addr.city)}, ${escapeHtml(addr.state)} ${escapeHtml(addr.zip)}<br>
      ${escapeHtml(addr.country)}${showPhone && addr.phone ? `<br>Phone: ${escapeHtml(addr.phone)}` : ""}
    </p>
  `;
}

// Single-seller (direct charge) orders: Stripe bills its processing fee to the
// seller's own account, so the amount shown is before that fee. Multi-seller
// orders are paid by Lesovia, so nothing is deducted there.
function earningsFeeNote(subOrder) {
  return subOrder.chargeType === "direct" ? " (before Stripe processing fees)" : "";
}

// Dispute state (from Stripe's dispute webhooks) on the seller's order card.
const DISPUTE_TEXT = {
  warning_needs_response: "the buyer's bank has raised an inquiry",
  warning_under_review: "an inquiry from the buyer's bank is under review",
  warning_closed: "an inquiry from the buyer's bank was closed",
  needs_response: "the buyer's bank disputed this payment",
  under_review: "the buyer's bank disputed this payment; it is under review",
  won: "the buyer's bank disputed this payment; resolved in your favor",
  lost: "the buyer's bank disputed this payment; not resolved in your favor",
  charge_refunded: "the payment was refunded, so the dispute was closed"
};

function disputeLineHtml(subOrder) {
  if (!subOrder.disputeStatus) return "";

  const text = DISPUTE_TEXT[subOrder.disputeStatus] || "the buyer's bank disputed this payment";

  return `<p style="color:#b00020;"><strong>Payment dispute:</strong> ${escapeHtml(text)}.</p>`;
}

function payoutLine(subOrder) {
  if (subOrder.chargeType === "direct") return "Paid to your Stripe balance at checkout";

  if (subOrder.transferStatus === "transferred") return "Sent to your Stripe balance";

  if (subOrder.transferStatus === "failed") return "Transfer to your Stripe balance hasn't gone through yet";

  if (subOrder.transferStatus === "reversed") return "This payment was reversed";

  if (subOrder.transferStatus === "partially_reversed") return "Part of this payment was reversed";

  return "Being sent to your Stripe balance";
}

/* ================= RETURNS & CANCELLATIONS: what buyers and sellers see ================= */
// The numbers below only decide what to SHOW (a button, a date). The server
// enforces the real rules and answers with a clear message if it disagrees.
// They start as the defaults and are replaced by publicConfig/returnPolicy (the
// same document the server reads) when the orders load.
const returnPolicyUi = {
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
function buyerReturnHtml(id, subOrder, ret, nowMs = Date.now()) {
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

// The seller's view of a return on one of their sub-orders.
function sellerReturnHtml(id, subOrder, ret) {
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
      body = `<p><strong>${cancelled ? "Order cancelled" : "Return completed"}.</strong> The buyer was refunded ${formatCents(ret.plan.buyerRefundCents)}.</p>`;
      break;

    case "rejected":
      body = `<p><strong>Closed by Lesovia without a refund.</strong></p>`;
      break;

    default:
      return "";
  }

  return `<div class="rt-box"><h4>${cancelled ? "Cancellation" : "Return"}</h4>${body}${returnDetailsHtml(ret)}</div>`;
}

// One seller's slice of a purchase, as the BUYER sees it. `reviewsByProduct`
// maps productId -> the buyer's existing review for it (delivered orders only).
function buyerSubOrderHtml(id, subOrder, reviewsByProduct, ret) {
  const delivered = subOrder.fulfillmentStatus === "delivered";
  const created = timestampToDate(subOrder.createdAt);

  const productsHtml = (subOrder.products || [])
    .map((product) => {
      const image = product.image
        ? `<img src="${escapeHtml(product.image)}" style="width:90px;height:90px;flex-shrink:0;object-fit:cover;border-radius:8px;">`
        : `<div style="width:90px;height:90px;flex-shrink:0;background:var(--lv-canvas,#F6F8F6);border:1px solid var(--lv-line,#E2E8E4);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--lv-slate,#5B6B62);">No image</div>`;

      const variant = [product.color, product.size].filter(Boolean).map(escapeHtml).join(" / ");
      const reviewKey = escapeHtml(`${id}-${product.productId}`);

      let reviewHtml = "";

      if (delivered) {
        const review = reviewsByProduct.get(product.productId);

        if (review) {
          reviewHtml = `
            <span style="color:green;"><strong>&#10003; Reviewed</strong></span>
            <button onclick="toggleReview('${reviewKey}')">View My Review</button>
            <div id="review-${reviewKey}" style="display:none; margin-top:10px;">
              <p>${"&#9733;".repeat(review.rating)}${"&#9734;".repeat(5 - review.rating)}</p>
              <p>${escapeHtml(review.comment)}</p>
              <div>${(review.photos || []).map((photo) => `
                <a href="${escapeHtml(photo.url)}" target="_blank" rel="noopener">
                  <img src="${escapeHtml(photo.url)}" style="width:70px;height:70px;object-fit:cover;border-radius:6px;margin:0 6px 6px 0;">
                </a>
              `).join("")}</div>
            </div>
          `;
        } else {
          reviewHtml = `
            <button onclick="window.location.href='reviews.html?productId=${encodeURIComponent(product.productId)}&orderId=${encodeURIComponent(id)}'">
              Leave Review
            </button>
          `;
        }
      }

      return `
        <div style="display:flex;gap:12px;margin-bottom:12px;">
          ${image}
          <div>
            <strong>${escapeHtml(product.name)}</strong><br>
            Qty ${escapeHtml(product.quantity)} &times; ${formatCents(product.unitPriceCents)}
            ${variant ? `<br>${variant}` : ""}
            ${reviewHtml ? `<br>${reviewHtml}` : ""}
          </div>
        </div>
      `;
    })
    .join("");

  return `
    <div
      id="order-${escapeHtml(id)}"
      class="order-details"
      data-checkout-id="${escapeHtml(subOrder.checkoutId)}"
    >
      <h3>${escapeHtml(describeProducts(subOrder.products))}</h3>
      ${subOrder.storeName ? `<p>Sold by ${escapeHtml(subOrder.storeName)}</p>` : ""}

      <p><strong>Order #:</strong> ${escapeHtml(subOrder.orderNumber || id)}</p>
      <p><strong>Date Ordered:</strong> ${created ? created.toLocaleString() : "N/A"}</p>

      ${productsHtml}

      <p>Items: ${formatCents(subOrder.productSubtotalCents)}<br>${shippingLineHtml(subOrder)}</p>
      ${subOrder.taxCents > 0 ? `<p>Tax: ${formatCents(subOrder.taxCents)}</p>` : ""}
      <p><strong>Total:</strong> ${formatCents(subOrder.buyerTotalCents)}</p>
      ${subOrder.refundedAmountCents > 0 ? `<p>Refunded: ${formatCents(subOrder.refundedAmountCents)}</p>` : ""}

      <p class="order-status status-${escapeHtml(subOrder.fulfillmentStatus)}">
        <strong>Status:</strong> ${escapeHtml(subOrder.fulfillmentStatus)}
      </p>

      ${subOrder.trackingNumber ? `<p><strong>Tracking #:</strong> ${escapeHtml(subOrder.trackingNumber)}</p>` : ""}
      ${deliveryAddressHtml(subOrder.deliveryAddress, "Delivering to:", false)}
      ${buyerReturnHtml(id, subOrder, ret)}
    </div>
  `;
}

// One sub-order in the SELLER's order list, with what they earn from it.
function sellerSubOrderHtml(id, subOrder, buyerName, ret) {
  const status = subOrder.fulfillmentStatus;
  const idAttr = escapeHtml(id);

  let buttons = "";

  if (status === "paid") {
    buttons =
      `<button onclick="markShipped('${idAttr}','sub')">Ship</button> ` +
      `<button onclick="markDelivered('${idAttr}','sub')">Deliver</button>`;
  } else if (status === "shipped") {
    buttons = `<button onclick="markDelivered('${idAttr}','sub')">Deliver</button>`;
  }

  const statusColor =
    status === "paid" ? "orange" : status === "shipped" ? "blue" : status === "delivered" ? "green" : "black";

  const created = timestampToDate(subOrder.createdAt);
  const deliveredAt = timestampToDate(subOrder.deliveredAt);

  const deliveryInfo =
    created && deliveredAt
      ? `<br><small>Delivered in ${Math.floor((deliveredAt - created) / (1000 * 60 * 60 * 24))} day(s)</small>`
      : "";

  const trackingHtml =
    status === "shipped" || status === "delivered"
      ? `
        <p>
          <strong>Tracking #:</strong> ${escapeHtml(subOrder.trackingNumber) || "Not added yet"}
          <button onclick="editTrackingNumber('${idAttr}','sub')" class="btn-sm">
            ${subOrder.trackingNumber ? "Edit" : "Add"}
          </button>
        </p>
      `
      : "";

  const firstImage = subOrder.products && subOrder.products[0] && subOrder.products[0].image;

  const imageHtml = firstImage
    ? `<img src="${escapeHtml(firstImage)}" style="width:60px;height:60px;object-fit:cover;border-radius:8px;">`
    : `<div style="width:60px;height:60px;border-radius:8px;background:var(--lv-canvas,#F6F8F6);border:1px solid var(--lv-line,#E2E8E4);display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--lv-slate,#5B6B62);text-align:center;">No image</div>`;

  const productsHtml = (subOrder.products || [])
    .map(
      (product) => `
        <p>
          <strong>${escapeHtml(product.name)}</strong> &times; ${escapeHtml(product.quantity)}
          ${product.color ? ` &middot; Color: ${escapeHtml(product.color)}` : ""}
          ${product.size ? ` &middot; Size: ${escapeHtml(product.size)}` : ""}
        </p>
      `
    )
    .join("");

  const commissionPercent = Math.round((Number(subOrder.commissionRate) || 0) * 100);

  return `
    <li id="order-${idAttr}" style="display:flex; align-items:flex-start; gap:15px; margin-bottom:15px;">

      ${imageHtml}

      <div>
        <p><strong>Order #:</strong> ${escapeHtml(subOrder.orderNumber || id)}</p>
        <p><strong>Buyer:</strong> ${escapeHtml(buyerName)}</p>
        <p><small style="color:gray;">${created ? created.toLocaleString() : "Unknown date"}</small></p>

        <p>
          Status:
          <span style="color:${statusColor};font-weight:bold;">${escapeHtml(status)}</span>
        </p>

        ${productsHtml}

        <p>
          Items: ${formatCents(subOrder.productSubtotalCents)}<br>
          ${shippingLineHtml(subOrder)}<br>
          ${subOrder.taxCents > 0 ? `Tax collected: ${formatCents(subOrder.taxCents)} (not part of your earnings)<br>` : ""}
          Lesovia commission (${commissionPercent}%): -${formatCents(subOrder.commissionAmountCents)}<br>
          <strong>Your earnings: ${formatCents(subOrder.sellerProceedsCents)}${earningsFeeNote(subOrder)}</strong>
        </p>
        <p><small>${payoutLine(subOrder)}</small></p>
        ${disputeLineHtml(subOrder)}
        ${subOrder.refundedAmountCents > 0 ? `<p>Refunded to buyer: ${formatCents(subOrder.refundedAmountCents)}</p>` : ""}

        ${deliveryAddressHtml(subOrder.deliveryAddress, "Ship to:", true) ||
          `<p><small style="color:gray;">No delivery address provided.</small></p>`}

        ${trackingHtml}

        ${deliveryInfo}

        ${sellerReturnHtml(id, subOrder, ret)}

        <br>

        ${buttons}
      </div>

    </li>
  `;
}

// One sub-order in the seller's sold-items history.
function soldSubOrderHtml(subOrder, buyer) {
  const status = subOrder.fulfillmentStatus;

  const badgeClass =
    status === "paid" ? "badge-warning" : status === "shipped" ? "badge-info" : status === "delivered" ? "badge-success" : "badge-neutral";

  const created = timestampToDate(subOrder.createdAt);
  const firstImage = (subOrder.products && subOrder.products[0] && subOrder.products[0].image) || "";

  const itemsText = (subOrder.products || [])
    .map((product) => {
      const variant = [product.color, product.size].filter(Boolean).map(escapeHtml).join(", ");
      return `${escapeHtml(product.name)} &times; ${escapeHtml(product.quantity)}${variant ? ` (${variant})` : ""}`;
    })
    .join("; ");

  const buyerName = escapeHtml(buyer.fullName || "Unknown buyer");
  const buyerEmail = buyer.email ? ` (${escapeHtml(buyer.email)})` : "";

  return `
    <div class="sold-item-card">
      <img src="${escapeHtml(firstImage)}" class="sold-item-img" alt="">

      <div class="sold-item-info">
        <div class="sold-item-header">
          <h3>${escapeHtml(describeProducts(subOrder.products))}</h3>
          <span class="badge ${badgeClass}">${escapeHtml(String(status || "unknown").toUpperCase())}</span>
        </div>

        <p><strong>Purchased:</strong> ${created ? created.toLocaleString() : "N/A"}</p>
        <p><strong>Items:</strong> ${itemsText}</p>
        <p><strong>Buyer:</strong> ${buyerName}${buyerEmail}</p>
        <p><strong>Total paid:</strong> ${formatCents(subOrder.buyerTotalCents)} &middot; <strong>Your earnings:</strong> ${formatCents(subOrder.sellerProceedsCents)}${earningsFeeNote(subOrder)}</p>
      </div>
    </div>
  `;
}

// Puts a sub-order card on the buyer's page, first looking up whether they've
// already reviewed each product (only matters once it's delivered).
async function appendBuyerSubOrder(orderList, docSnap, selectedOrderId, highlight) {
  const subOrder = docSnap.data();
  const reviewsByProduct = new Map();

  if (subOrder.fulfillmentStatus === "delivered") {
    for (const product of subOrder.products || []) {
      const reviewSnapshot = await getDocs(
        query(
          collection(db, "reviews"),
          where("productId", "==", product.productId),
          where("buyerId", "==", auth.currentUser.uid)
        )
      );

      if (!reviewSnapshot.empty) reviewsByProduct.set(product.productId, reviewSnapshot.docs[0].data());
    }
  }

  subOrderCache.set(docSnap.id, subOrder);

  orderList.insertAdjacentHTML(
    "beforeend",
    buyerSubOrderHtml(docSnap.id, subOrder, reviewsByProduct, buyerReturns.get(docSnap.id))
  );

  // A purchase can span several sellers; the link from checkout and from
  // notifications names the whole checkout, so highlight all of its cards.
  if (selectedOrderId && (selectedOrderId === docSnap.id || selectedOrderId === subOrder.checkoutId)) {
    const card = document.getElementById(`order-${docSnap.id}`);

    if (card) {
      card.classList.add("highlight-order");

      if (!highlight.scrolled) {
        highlight.scrolled = true;
        setTimeout(() => card.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
      }

      setTimeout(() => card.classList.remove("highlight-order"), 5000);
    }
  }
}

/* ================= CUSTOMER ORDERS ================= */
async function loadMyOrders() {
  //july 22//
  const selectedOrderId =
    new URLSearchParams(window.location.search)
    .get("orderId");
//ends above//
  const orderList = document.getElementById("orderList");
  if (!orderList || !auth.currentUser) return;

  // Older per-product orders and newer per-seller sub-orders, together,
  // newest first.
  const [legacySnapshot, subOrderSnapshot] = await Promise.all([
    getDocs(query(collection(db, "orders"), where("userId", "==", auth.currentUser.uid))),
    getDocs(query(collection(db, "sellerOrders"), where("buyerId", "==", auth.currentUser.uid)))
  ]);

  const entries = [
    ...legacySnapshot.docs.map((docSnap) => ({ kind: "legacy", docSnap })),
    ...subOrderSnapshot.docs.map((docSnap) => ({ kind: "sub", docSnap }))
  ].sort((a, b) => orderTimeMs(b.docSnap.data()) - orderTimeMs(a.docSnap.data()));

  buyerReturns = await fetchReturnsMap("buyerId");

  orderList.innerHTML = "";

  const highlight = { scrolled: false };

  for (const { kind, docSnap } of entries) {
    if (kind === "sub") {
      await appendBuyerSubOrder(orderList, docSnap, selectedOrderId, highlight);
      continue;
    }

    const order = docSnap.data();

    // Product info: prefer the snapshot stored on the order at purchase
    // time (survives the seller editing/deleting the listing later). Only
    // fall back to a live lookup for orders placed before that snapshot
    // existed, and to a placeholder if even that product is gone now.
    let productName = order.productName || null;
    let image = order.productImage || null;

    if (!productName) {
      const productSnap = await getDoc(doc(db, "products", order.productId));
      if (productSnap.exists()) {
        const product = productSnap.data();
        productName = product.name || null;
        image = image || product.images?.[0] || product.imageURL || null;
      }
    }

    productName = productName || "Product no longer available";

//New Update
  const orderDate = order.createdAt
    ? new Date(order.createdAt.seconds * 1000).toLocaleString()
    : "N/A";

  const quantity = order.quantity || 1;
  // order.price has always been stored on every order since day one, so
  // this is correct regardless of whether the product snapshot above
  // exists.
  const price = order.price || 0;
  const total = price * quantity;

  //NEW FUNCTION FOR REVIEW//
  const reviewQuery = query(
    collection(db, "reviews"),
    where("productId", "==", order.productId),
    where("buyerId", "==", auth.currentUser.uid)
  );
  
  const reviewSnapshot = await getDocs(reviewQuery);

  const alreadyReviewed = !reviewSnapshot.empty;

  let reviewData = null;

  if (!reviewSnapshot.empty) {
    reviewData = reviewSnapshot.docs[0].data();
  }
  //ENDS HERE//

  const addr = order.deliveryAddress;

  const addressHtml = addr
    ? `
      <p><strong>Delivering to:</strong><br>
        ${escapeHtml(addr.fullName)}<br>
        ${escapeHtml(addr.line1)}${addr.line2 ? `<br>${escapeHtml(addr.line2)}` : ""}<br>
        ${escapeHtml(addr.city)}, ${escapeHtml(addr.state)} ${escapeHtml(addr.zip)}<br>
        ${escapeHtml(addr.country)}
      </p>
    `
    : "";

  const trackingHtml = order.trackingNumber
    ? `<p><strong>Tracking #:</strong> ${escapeHtml(order.trackingNumber)}</p>`
    : "";

  const productImageHtml = image
    ? `<img src="${image}" class="product-img" style="width: 200px;">`
    : `<div class="product-img" style="width:200px;height:200px;background:var(--lv-canvas,#F6F8F6);border:1px solid var(--lv-line,#E2E8E4);border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--lv-slate,#5B6B62);">No image</div>`;

  orderList.innerHTML += `
   <div
    id="order-${docSnap.id}"
    class="order-details"
  >
      <h3>${productName}</h3>
      ${productImageHtml}

      <p><strong>Order #:</strong> ${escapeHtml(order.orderNumber) || docSnap.id}</p>
      <p><strong>Date Ordered:</strong> ${orderDate}</p>
      <p><strong>Quantity:</strong> ${quantity}</p>
      <p><strong>Total:</strong> $${total}</p>

      <p class="order-status status-${order.status}">
        <strong>Status:</strong> ${order.status}
      </p>

      ${trackingHtml}
      ${addressHtml}

      ${
        order.status === "delivered"
        ? (
            alreadyReviewed
            ? `
              <p style="color:green;">
                <strong>✓ Reviewed</strong>
              </p>
      
              <button onclick="toggleReview('${order.productId}')">
                View My Review
              </button>
      
              <div
                id="review-${order.productId}"
                style="display:none; margin-top:10px;"
              >
                <p>
                  ${"★".repeat(reviewData.rating)}
                  ${"☆".repeat(5 - reviewData.rating)}
                </p>

                <p>${escapeHtml(reviewData.comment)}</p>

                <div>${(reviewData.photos || []).map(p => `
                  <a href="${p.url}" target="_blank" rel="noopener">
                    <img src="${p.url}" style="width:70px;height:70px;object-fit:cover;border-radius:6px;margin:0 6px 6px 0;">
                  </a>
                `).join("")}</div>
              </div>
            `
            : `
              <button onclick="window.location.href='reviews.html?productId=${order.productId}&orderId=${docSnap.id}'">
                Leave Review
              </button>
            `
          )
        : ""
      }

  </div>
`;
//new add july 22//
if (docSnap.id === selectedOrderId) {

    setTimeout(() => {

        const card =
            document.getElementById(`order-${docSnap.id}`);

        if (card) {

            card.scrollIntoView({
                behavior: "smooth",
                block: "center"
            });

        card.classList.add("highlight-order");
        }

        setTimeout(() => {
            card.classList.remove("highlight-order");
            console.log(card.className);
        }, 5000);

    }, 300);

}
}
}

/* ================= LOAD SELLER PRODUCTS ================= */

function loadSellerProducts() {
  const sellerProducts = document.getElementById("sellerProducts");
  if (!sellerProducts || !auth.currentUser) return;

  const highlightProductId =
    new URLSearchParams(window.location.search).get("highlightProduct");

  // Only scroll/highlight on the first render -- this listener re-fires on
  // every product change, and we don't want to keep yanking the seller back
  // to this card every time something unrelated updates.
  let hasHighlighted = false;

  const q = query(
    collection(db, "products"),
    where("sellerId", "==", auth.currentUser.uid)
  );

  onSnapshot(q, async (snapshot) => {
    sellerProducts.innerHTML = "";

    // Units sold through newer per-seller sub-orders, per product -- read
    // once for the whole list rather than once per product.
    const subOrderUnitsSold = new Map();
    const subOrdersSnap = await getDocs(
      query(collection(db, "sellerOrders"), where("sellerId", "==", auth.currentUser.uid))
    );

    subOrdersSnap.forEach(subOrderDoc => {
      (subOrderDoc.data().products || []).forEach(orderedProduct => {
        subOrderUnitsSold.set(
          orderedProduct.productId,
          (subOrderUnitsSold.get(orderedProduct.productId) || 0) + (Number(orderedProduct.quantity) || 0)
        );
      });
    });

    for (const docSnap of snapshot.docs) {
      const product = docSnap.data();

    const quantity =
      product.quantity !== undefined
        ? product.quantity
        : 1;

      // Out-of-stock products used to be hidden entirely here, which meant
      // a seller couldn't even find one to restock or remove. Now they
      // still show, just flagged clearly with the red badge below.
      let stockBadgeClass = "badge-success";
      let stockBadgeText = `✅ ${quantity} in stock`;

      if (quantity <= 0) {
        stockBadgeClass = "badge-danger";
        stockBadgeText = "❌ Out of stock";
      } else if (quantity <= 5) {
        stockBadgeClass = "badge-warning";
        stockBadgeText = `⚠️ Only ${quantity} left`;
      }

      // Total sold = sum of quantity across every order ever placed for
      // this product. Orders only ever exist after a successful payment
      // (see verifyPayment), so this is an accurate historical count even
      // if the product has since been restocked.
      const ordersSnap = await getDocs(
        query(
          collection(db, "orders"),
          where("productId", "==", docSnap.id),
          where("sellerId", "==", auth.currentUser.uid)
        )
      );

      let totalSold = subOrderUnitsSold.get(docSnap.id) || 0;
      ordersSnap.forEach(orderDoc => {
        totalSold += Number(orderDoc.data().quantity) || 0;
      });

      // "Uploaded" = how many units were originally listed. Tracked
      // directly for products created after originalQuantity existed;
      // reconstructed for older ones as current stock + everything sold.
      const totalUploaded =
        product.originalQuantity !== undefined
          ? product.originalQuantity
          : quantity + totalSold;

      const productDiv = document.createElement("div");
      productDiv.id = `product-${docSnap.id}`;

      const images = product.images || [product.imageURL];

    productDiv.innerHTML = `
      <div class="image-slider">
        <button class="prev">◀</button>
        <img src="${images[0]}" />
        <button class="next">▶</button>
      </div>

      <strong>${product.name}</strong>
      <p>${product.description}</p>
      <span>$${product.price}</span>

      <p><span class="badge ${stockBadgeClass}">${stockBadgeText}</span></p>
      <p class="seller-product-stats">📦 ${totalUploaded} uploaded &nbsp;|&nbsp; 🛒 ${totalSold} sold</p>

      <div class="btn-group">
        <button onclick="goToEdit('${docSnap.id}')">Edit</button>
      <button onclick="deleteProduct('${docSnap.id}')">Delete</button>
      </div>
    `;

    const imgElement = productDiv.querySelector("img");
    const prevBtn = productDiv.querySelector(".prev");
    const nextBtn = productDiv.querySelector(".next");

    let index = 0;

    prevBtn.onclick = () => {
      index = (index - 1 + images.length) % images.length;
      imgElement.src = images[index];
    };

    nextBtn.onclick = () => {
      index = (index + 1) % images.length;
      imgElement.src = images[index];
    };
    nextBtn.onclick = () => {
      imgElement.style.opacity = 0;

      setTimeout(() => {
        index = (index + 1) % images.length;
        imgElement.src = images[index];
        imgElement.style.opacity = 1;
      }, 150);
    };

    // Hide arrows if only 1 image
    if (images.length === 1) {
      prevBtn.style.display = "none";
      nextBtn.style.display = "none";
    }

      sellerProducts.appendChild(productDiv);

      if (!hasHighlighted && docSnap.id === highlightProductId) {
        hasHighlighted = true;

        setTimeout(() => {
          productDiv.scrollIntoView({ behavior: "smooth", block: "center" });
          productDiv.classList.add("highlight-order");

          setTimeout(() => {
            productDiv.classList.remove("highlight-order");
          }, 5000);
        }, 300);
      }
    }
  });
}
//======New Edit Function ===========//
window.goToEdit = function(id) {
  window.location.href = `seller-upload.html?edit=${id}`;
};
async function checkEditMode() {
  const params = new URLSearchParams(window.location.search);
  const editId = params.get("edit");

  if (!editId) return;

  editingProductId = editId;
  aiGeneratedThisSession = false;

  const docSnap = await getDoc(doc(db, "products", editId));
  const product = docSnap.data();

  document.getElementById("pName").value = product.name;
  document.getElementById("pPrice").value = product.price;
  document.getElementById("pDesc").value = product.description;
  document.getElementById("pCategory").value = product.category;

  document.querySelector("#productForm button").innerText = "Update Product";
}

window.addEventListener("DOMContentLoaded", checkEditMode);

// Delect Fuction//

window.deleteProduct = async (productId) => {
  const confirmDelete = confirm("Are you sure you want to delete this product?");
  if (!confirmDelete) return;

  const productRef = doc(db, "products", productId);
  const snap = await getDoc(productRef);

  if (!snap.exists()) {
    alert("Product not found.");
    return;
  }

  // make sure seller owns it
  if (snap.data().sellerId !== auth.currentUser.uid) {
    alert("You are not allowed to delete this product.");
    return;
  }

  await deleteDoc(productRef);
  alert("Product deleted.");
};

//Detail page//

if (window.location.pathname.includes("product-detail.html")) {

  const sendMessageBtn =
    document.getElementById("sendMessageBtn");

  if (sendMessageBtn) {

    sendMessageBtn.addEventListener("click", async () => {

      const text =
        document.getElementById("messageInput").value.trim();

      if (!text) {
        alert("Message cannot be empty");
        return;
      }

      const productSnap =
        await getDoc(doc(db, "products", productId));

      const product =
        productSnap.data();

      try {

        const buyerId =
          auth.currentUser.uid;

        const sellerId =
          product.sellerId;

        const conversationId =
          getConversationId(
            buyerId,
            sellerId,
            productId
          );

        /*await addDoc(
          collection(db, "messages"),
          {
            senderId: buyerId,
            receiverId: sellerId,
            productId,
            conversationId,
            text,
            createdAt: serverTimestamp(),
            deletedBy: []
          }
        );*/
      const userDoc =
        await getDoc(
          doc(db, "users", buyerId)
        );

      const userData =
        userDoc.data();

      await addDoc(
        collection(db, "messages"),
        {
          senderId: buyerId,

          senderName:
            userData.fullName ||
            auth.currentUser.email,

          receiverId: sellerId,

          productId,

          conversationId,

          text,

          createdAt: serverTimestamp(),

          deletedBy: []
        }
      );

        alert("Message sent!");

        document.getElementById("messageInput").value = "";

        window.location.href =
          `messages.html?conversationId=${conversationId}`;

      } catch (err) {

        alert("Error: " + err.message);

      }

    });

  }

/*if (window.location.pathname.includes("product-detail.html")) {
const sendMessageBtn = document.getElementById("sendMessageBtn");

if (sendMessageBtn) {
  sendMessageBtn.addEventListener("click", async () => {
    const text = document.getElementById("messageInput").value;

    if (!text) {
      alert("Message cannot be empty");
      return;
    }

    // Get product info to find seller
    const productSnap = await getDoc(doc(db, "products", productId));
    const product = productSnap.data();

    try {
      const buyerId = auth.currentUser.uid;
      const sellerId = product.sellerId;

      const conversationId = [buyerId, sellerId, productId].sort().join("_");

await addDoc(collection(db, "messages"), {
  senderId: buyerId,
  receiverId: sellerId,
  productId: productId,
  conversationId: conversationId,
  text: text,
  createdAt: serverTimestamp(),
  deletedBy: []
});

      alert("Message sent!");
      document.getElementById("messageInput").value = "";

      window.location.href = `messages.html?conversationId=${conversationId}`;

    } catch (err) {
      alert("Error: " + err.message);
    }
  });
}*/

  const urlParams = new URLSearchParams(window.location.search);
  const productId = urlParams.get("id");

  let currentImageIndex = 0;
  let productImages = [];

  async function loadProduct() {
    const docSnap = await getDoc(doc(db, "products", productId));
    //new function//
    console.log("Product ID:", productId);
    console.log("Product Exists:", docSnap.exists());
    //newfunction ends above//
    if (!docSnap.exists()) return alert("Product not found");

    const product = docSnap.data();

    /*productImages = product.images && product.images.length > 0
      ? product.images
      : [product.imageURL];*/
      productImages =
      product.images?.length
        ? product.images
        : (product.imageURL ? [product.imageURL] : []);
      if(productImages.length > 0){
        document.getElementById("detailImage").src = productImages[0];
      }

    //document.getElementById("detailImage").src = productImages[0];

    if (productImages.length <= 1) {
      document.getElementById("prevBtn").style.display = "none";
      document.getElementById("nextBtn").style.display = "none";
    }

    document.getElementById("detailName").innerText = product.name;
    loadAverageRating(productId);
    document.getElementById("detailDesc").innerText = product.description;
    document.getElementById("detailPrice").innerText = product.price;
    //new function//
    loadColors(product.colors);

    loadSizes(product.sizes);

    //NEW FUNCTION FOR SHOWING AVAIABLE STOLK//
    const stockElement =
      document.getElementById("detailQuantityAvailable");

    if (stockElement) {

      if (product.quantity <= 0) {

        stockElement.innerHTML =
          " ❌ Out of Stock";

        stockElement.style.color = "red";

        const addToCartBtn =
          document.getElementById("addToCartBtn");

        if (addToCartBtn) {
          addToCartBtn.disabled = true;
          addToCartBtn.innerText = "Out of Stock";
        }

      } else if (product.quantity <= 3) {

        stockElement.innerHTML =
          ` ⚠️ Only ${product.quantity} left!`;

        stockElement.style.color = "orange";
        stockElement.style.fontWeight = "bold";

      } else {

        stockElement.innerHTML =
          ` ✅ ${product.quantity} available`;

        stockElement.style.color = "green";
      }
    }
      }

  // IMAGE BUTTONS
  document.getElementById("prevBtn").addEventListener("click", () => {
    if (productImages.length === 0) return;

    currentImageIndex--;
    if (currentImageIndex < 0) {
      currentImageIndex = productImages.length - 1;
    }

    document.getElementById("detailImage").src = productImages[currentImageIndex];
  });

  document.getElementById("nextBtn").addEventListener("click", () => {
    if (productImages.length === 0) return;

    currentImageIndex++;
    if (currentImageIndex >= productImages.length) {
      currentImageIndex = 0;
    }

    document.getElementById("detailImage").src = productImages[currentImageIndex];
  });

// ================= ADD TO CART =================

const addToCartBtn = document.getElementById("addToCartBtn");

if (addToCartBtn) {

    addToCartBtn.addEventListener("click", async () => {

        const user = auth.currentUser;

        if (!user) {
            alert("Please login first");
            return;
        }

        const quantity = Number(
            document.getElementById("detailQuantity").value
        );

        if (quantity < 1) {
            alert("Quantity must be at least 1");
            return;
        }

        // Load latest product
        const productSnap = await getDoc(
            doc(db, "products", productId)
        );

        if (!productSnap.exists()) {
            alert("Product not found.");
            return;
        }

        const product = productSnap.data();

        // Require color ONLY if seller added colors
        if (
            product.colors &&
            product.colors.length > 0 &&
            !selectedColor
        ) {
            alert("Please select a color.");
            return;
        }

        // Require size ONLY if seller added sizes
        if (
            product.sizes &&
            product.sizes.length > 0 &&
            !selectedSize
        ) {
            alert("Please select a size.");
            return;
        }

        // Build cart object
        const cartData = {

            userId: user.uid,

            productId: productId,

            quantity: quantity,

            createdAt: serverTimestamp()

        };

        if (selectedColor) {
            cartData.color = selectedColor;
        }

        if (selectedSize) {
            cartData.size = selectedSize;
        }

        try {

            await addDoc(
                collection(db, "carts"),
                cartData
            );

            alert("Product added to cart!");

            window.location.href = "cart.html";

        } catch (err) {

            console.error(err);

            alert("Failed to add to cart: " + err.message);

        }

    });
}
//july 24, 2026//
const buyBtn = document.getElementById("buyBtn");

if (buyBtn) {

    buyBtn.addEventListener("click", async () => {

        const productSnap = await getDoc(
            doc(db, "products", productId)
        );

        if (!productSnap.exists()) {
            alert("Product not found.");
            return;
        }

        const product = productSnap.data();

        if (
            product.colors &&
            product.colors.length > 0 &&
            !selectedColor
        ) {
            alert("Please select a color.");
            return;
        }

        if (
            product.sizes &&
            product.sizes.length > 0 &&
            !selectedSize
        ) {
            alert("Please select a size.");
            return;
        }

        const quantity = Number(
            document.getElementById("detailQuantity").value
        );

        if (!Number.isInteger(quantity) || quantity < 1) {
            alert("Please enter a valid quantity.");
            return;
        }

        // The server re-fetches this product's real price/stock from
        // Firestore -- this is just what the buyer says they want to buy.
        buyBtn.disabled = true;

        await startCheckout(
            [
                {
                    productId,
                    quantity,
                    color: selectedColor,
                    size: selectedSize
                }
            ],
            [],
            "buyNow"
        );

        buyBtn.disabled = false;

    });

}


// LOAD PRODUCT
loadProduct();
loadReviews(productId);

}

  // ===== PRODUCT DETAIL LOGIC END =====

// ===== SHOP PAGE (shop.html?sellerId=...) =====
// Public, like product-detail.html -- no login required to browse a shop.
if (window.location.pathname.includes("shop.html")) {

  async function loadShopPage() {
    const sellerId = new URLSearchParams(window.location.search).get("sellerId");
    const grid = document.getElementById("shopProductList");

    if (!sellerId) {
      document.getElementById("shopName").innerText = "Shop not found";
      return;
    }

    const sellerSnap = await getDoc(doc(db, "users", sellerId));

    if (!sellerSnap.exists() || sellerSnap.data().role !== "seller") {
      document.getElementById("shopName").innerText = "Shop not found";
      return;
    }

    const seller = sellerSnap.data();

    document.getElementById("shopName").innerText =
      seller.storeName || "Unnamed Shop";

    document.getElementById("shopDescription").innerText =
      seller.storeDescription || "";

    const { average, count } = await getShopRating(sellerId);

    document.getElementById("shopRating").innerText = average
      ? `⭐ ${average} (${count} review${count === 1 ? "" : "s"})`
      : "No reviews yet";

    const productsSnap = await getDocs(
      query(collection(db, "products"), where("sellerId", "==", sellerId))
    );

    if (!grid) return;
    grid.innerHTML = "";

    let hasAnyInStock = false;

    productsSnap.forEach((docSnap) => {
      const product = docSnap.data();

      // Same "hide out of stock" rule the main storefront grid uses.
      if (product.quantity !== undefined && product.quantity <= 0) return;

      hasAnyInStock = true;

      const card = document.createElement("div");
      card.classList.add("product-card");

      card.innerHTML = `
        <img
          src="${product.images ? product.images[0] : product.imageURL}"
          class="product-img"
          style="cursor:pointer;"
        >
        <h3>${product.name}</h3>
        <p class="price">$${product.price}</p>
        <p class="desc">${product.description}</p>
      `;

      card.querySelector("img").addEventListener("click", () => {
        window.location.href = `product-detail.html?id=${docSnap.id}&from=index`;
      });

      grid.appendChild(card);
    });

    if (!hasAnyInStock) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-glyph">🛍️</div>
          <div><strong>This shop has no products in stock right now.</strong></div>
        </div>
      `;
    }
  }

  loadShopPage();
}

// ===== CART PAGE =====
if (window.location.pathname.includes("cart.html")) {

  async function loadCart() {
    const cartList = document.getElementById("cartList");
    if (!cartList || !auth.currentUser) return;

    const q = query(collection(db, "carts"), where("userId", "==", auth.currentUser.uid));
    const snapshot = await getDocs(q);

    cartList.innerHTML = "";

    for (const docSnap of snapshot.docs) {
      const order = docSnap.data();
      const productSnap = await getDoc(doc(db, "products", order.productId));
      const product = productSnap.exists() ? productSnap.data() : null;
      if (!product) continue;

      cartList.innerHTML += `
        <li>
          ${product.name} — $${product.price} x ${order.quantity}
          <button onclick="removeFromCart('${docSnap.id}')">Remove</button>
        </li>
      `;
    }
  }

  window.removeFromCart = async (orderId) => {
    const confirmRemove = confirm("Remove this item from cart?");
    if (!confirmRemove) return;

    //await deleteDoc(doc(db, "orders", orderId));
    await deleteDoc(doc(db, "carts", orderId));
    loadCart();
  };

  loadCart();
}

/* ================= LOAD CART ITEMS (BUYER) ================= */
let selectedColor = null;

let selectedSize = null;

// Cart contents cached client-side purely for the checkbox UI / running
// total display -- checkout still sends only productId/quantity to the
// server, which looks up the real price itself.
let cartData = [];
let selectedCartItemIds = new Set();

async function loadCart() {
  const cartDiv = document.getElementById("cartItems");
  if (!cartDiv || !auth.currentUser) return;

  const q = query(collection(db, "carts"), where("userId", "==", auth.currentUser.uid));
  const snapshot = await getDocs(q);

  cartDiv.innerHTML = "";
  cartData = [];
  selectedCartItemIds = new Set();

  for (const docSnap of snapshot.docs) {
    const cartItem = docSnap.data();

    // Get product details
    const productSnap = await getDoc(doc(db, "products", cartItem.productId));
    if (!productSnap.exists()) continue;
    const product = productSnap.data();

    cartData.push({
      cartItemId: docSnap.id,
      productId: cartItem.productId,
      product,
      quantity: cartItem.quantity,
      color: cartItem.color || null,
      size: cartItem.size || null
    });

    // Nothing is pre-selected -- the buyer picks what to check out,
    // either one at a time or via "Select All".

    cartDiv.innerHTML += `
      <div class="cart-item">
        <label>
          <input
            type="checkbox"
            class="cartItemCheckbox"
            onchange="toggleCartItem('${docSnap.id}', this.checked)"
          >
          Select
        </label>
        <img src="${product.images ? product.images[0] : product.imageURL}" class="product-img" width=120>
        <p>${product.name}</p>
        <p><strong>Color:</strong> ${cartItem.color}</p>

        <p><strong>Size:</strong> ${cartItem.size}</p>
        <p>Price: $${product.price}</p>
        <p>Quantity: ${cartItem.quantity}</p>
        <button onclick="removeFromCart('${docSnap.id}')">Remove</button>
      </div>
      <hr>
    `;
  }

  updateSelectAllCheckbox();
  updateCartTotal();
}

// Keep an item's selection in sync with its checkbox, and recompute the
// running total shown to the buyer (checkout itself is unaffected --
// the server always recomputes the real total from Firestore).
window.toggleCartItem = function (cartItemId, checked) {
  if (checked) {
    selectedCartItemIds.add(cartItemId);
  } else {
    selectedCartItemIds.delete(cartItemId);
  }

  updateSelectAllCheckbox();
  updateCartTotal();
};

function updateSelectAllCheckbox() {
  const selectAllCheckbox = document.getElementById("selectAllCheckbox");
  if (!selectAllCheckbox) return;

  selectAllCheckbox.checked =
    cartData.length > 0 && selectedCartItemIds.size === cartData.length;
}

function updateCartTotal() {
  const totalEl = document.getElementById("cartTotal");
  if (!totalEl) return;

  const total = cartData
    .filter(item => selectedCartItemIds.has(item.cartItemId))
    .reduce(
      (sum, item) => sum + (Number(item.product.price) || 0) * item.quantity,
      0
    );

  totalEl.textContent = total.toFixed(2);
}

const selectAllCheckbox = document.getElementById("selectAllCheckbox");

if (selectAllCheckbox) {

  selectAllCheckbox.addEventListener("change", () => {

    if (selectAllCheckbox.checked) {
      cartData.forEach(item => selectedCartItemIds.add(item.cartItemId));
    } else {
      selectedCartItemIds.clear();
    }

    document.querySelectorAll(".cartItemCheckbox").forEach(cb => {
      cb.checked = selectAllCheckbox.checked;
    });

    updateCartTotal();

  });

}
//New Function For Colors//
function loadColors(colors){

  const container =
  document.getElementById("colorOptions");

  container.innerHTML="";

  if(!colors || colors.length===0){

      container.innerHTML="<p>No colors available.</p>";

      return;

  }

  colors.forEach(color=>{

      const chip=document.createElement("div");

      chip.className="colorChip";

      chip.innerText=color;

      chip.onclick=()=>{

          document
          .querySelectorAll(".colorChip")
          .forEach(c=>c.classList.remove("selected"));

          chip.classList.add("selected");

          selectedColor=color;

      };

      container.appendChild(chip);

  });

}
//New Function For Sizes//
function loadSizes(sizes){

  const container=
  document.getElementById("sizeOptions");

  container.innerHTML="";

  if(!sizes || sizes.length===0){

      container.innerHTML="<p>No sizes available.</p>";

      return;

  }

  sizes.forEach(size=>{

      const chip=document.createElement("div");

      chip.className="sizeChip";

      chip.innerText=size;

      chip.onclick=()=>{

          document
          .querySelectorAll(".sizeChip")
          .forEach(c=>c.classList.remove("selected"));

          chip.classList.add("selected");

          selectedSize=size;

      };

      container.appendChild(chip);

  });

}

// Remove from cart
window.removeFromCart = async (cartItems) => {
  await deleteDoc(doc(db, "carts", cartItems));
  loadCart(); // refresh the cart
};



const checkoutBtn = document.getElementById("checkoutBtn");

if (checkoutBtn) {

  checkoutBtn.addEventListener("click", async () => {

    const user = auth.currentUser;

    if (!user) {
      alert("Please login first");
      return;
    }

    if (cartData.length === 0) {
      alert("Your cart is empty!");
      return;
    }

    const selectedItems = cartData.filter(item =>
      selectedCartItemIds.has(item.cartItemId)
    );

    if (selectedItems.length === 0) {
      alert("Please select at least one product to checkout.");
      return;
    }

    // Just describe what's selected -- the server looks up the real
    // price/stock for each productId itself, it does not trust this.
    const items = selectedItems.map(item => ({
      productId: item.productId,
      quantity: item.quantity,
      color: item.color,
      size: item.size
    }));

    const cartItemIds = selectedItems.map(item => item.cartItemId);

    checkoutBtn.disabled = true;

    await startCheckout(items, cartItemIds, "cart");

    checkoutBtn.disabled = false;

  });

}

 //=================loadNotificationBadge function July 22 =================//

function loadNotificationBadge() {

    const badge =
        document.getElementById("notificationBadge");

    if (!badge) return;

    onAuthStateChanged(auth, (user) => {

        if (!user) return;

        const q = query(
            collection(db, "notifications"),
            where("userId", "==", user.uid)
        );

        onSnapshot(q, (snapshot) => {

            let unread = 0;

            snapshot.forEach(docSnap => {

                if (!docSnap.data().read) {
                    unread++;
                }

            });

            if (unread > 0) {

                badge.style.display = "flex";
                badge.innerText = unread;

            } else {

                badge.style.display = "none";

            }

        });

    });

}


/* ================= SELLER ORDERS ================= */
async function loadSellerOrders() {
  const sellerOrders = document.getElementById("sellerOrders");
  if (!sellerOrders || !auth.currentUser) return;

  // Older per-product orders and newer per-seller sub-orders, together,
  // newest first.
  const [legacySnapshot, subOrderSnapshot] = await Promise.all([
    getDocs(query(collection(db, "orders"), where("sellerId", "==", auth.currentUser.uid))),
    getDocs(query(collection(db, "sellerOrders"), where("sellerId", "==", auth.currentUser.uid)))
  ]);

  sellerReturns = await fetchReturnsMap("sellerId");

  sellerOrders.innerHTML = "";

  const sortedEntries = [
    ...legacySnapshot.docs.map((docSnap) => ({ kind: "legacy", docSnap })),
    ...subOrderSnapshot.docs.map((docSnap) => ({ kind: "sub", docSnap }))
  ].sort((a, b) => orderTimeMs(b.docSnap.data()) - orderTimeMs(a.docSnap.data()));

      //NEW FUNCTION FOR IT TO INCLUDE BUYER NAME, COLOR, AND QUATITY ORDER//
      for (const { kind, docSnap } of sortedEntries) {

        if (kind === "sub") {
          const subOrder = docSnap.data();
          const subBuyerSnap = await getDoc(doc(db, "users", subOrder.buyerId));
          const subBuyer = subBuyerSnap.exists() ? subBuyerSnap.data() : {};

          sellerOrders.insertAdjacentHTML(
            "beforeend",
            sellerSubOrderHtml(
              docSnap.id,
              subOrder,
              subBuyer.fullName || subBuyer.name || subBuyer.email || "Unknown Buyer",
              sellerReturns.get(docSnap.id)
            )
          );

          continue;
        }

        const order = docSnap.data();
    
        // Get buyer information
        const buyerSnap = await getDoc(
            doc(db, "users", order.userId)
        );
    
        let buyerName = "Unknown Buyer";
    
        if (buyerSnap.exists()) {
    
            const buyer = buyerSnap.data();
    
            buyerName =
                buyer.fullName ||
                buyer.name ||
                buyer.email ||
                "Unknown Buyer";
    
        }
    
        // Product info: prefer the snapshot stored on the order itself
        // (captured at purchase time, so it survives the seller editing or
        // deleting the listing later). Only fall back to a live lookup for
        // orders placed before that snapshot existed -- and if even that
        // fails (an old order for a product that's since been deleted),
        // fall back to a clean placeholder instead of "Unknown Product".
        let productName = order.productName || null;
        let productImage = order.productImage || null;

        if (!productName) {
            const productSnap = await getDoc(
                doc(db, "products", order.productId)
            );

            if (productSnap.exists()) {
                const product = productSnap.data();
                productName = product.name || null;
                productImage = productImage || product.images?.[0] || product.imageURL || null;
            }
        }

        productName = productName || "Product no longer available";
        // order.price has always been stored on every order since day one,
        // even before this snapshot existed -- so the total below is
        // correct for every order, old or new, regardless of productName.
        const productPrice = order.price || 0;

    let shipBtn = "";
    let deliverBtn = "";

    // PAID (or legacy PENDING) → not shipped yet, show both
    if (order.status === "paid" || order.status === "pending") {
      shipBtn = `<button onclick="markShipped('${docSnap.id}')">Ship</button>`;
      deliverBtn = `<button onclick="markDelivered('${docSnap.id}')">Deliver</button>`;
    }

    // SHIPPED → show ONLY deliver
    else if (order.status === "shipped") {
      deliverBtn = `<button onclick="markDelivered('${docSnap.id}')">Deliver</button>`;
    }

    // DELIVERED → show NOTHING
    else if (order.status === "delivered") {
      shipBtn = "";
      deliverBtn = "";
    }

    let deliveryInfo = "";

    // Calculate delivery time
    if (order.deliveredAt && order.createdAt) {
      const days = Math.floor(
        (order.deliveredAt.toDate() - order.createdAt.toDate()) / (1000 * 60 * 60 * 24)
      );

      deliveryInfo = `<br><small>Delivered in ${days} day(s)</small>`;
    }

    // Status color
    let statusColor = "black";
    if (order.status === "paid" || order.status === "pending") statusColor = "orange";
    else if (order.status === "shipped") statusColor = "blue";
    else if (order.status === "delivered") statusColor = "green";

    const quantity = order.quantity || 1;

    const total = productPrice * quantity;

    const orderDate = order.createdAt
        ? order.createdAt.toDate().toLocaleString()
        : "Unknown date";

    const addr = order.deliveryAddress;

    // Buyer-typed text displayed in the SELLER's browser -- every field
    // goes through escapeHtml so a buyer can't inject markup/script via
    // their own address.
    const addressHtml = addr
      ? `
        <p><strong>Ship to:</strong><br>
          ${escapeHtml(addr.fullName)}<br>
          ${escapeHtml(addr.line1)}${addr.line2 ? `<br>${escapeHtml(addr.line2)}` : ""}<br>
          ${escapeHtml(addr.city)}, ${escapeHtml(addr.state)} ${escapeHtml(addr.zip)}<br>
          ${escapeHtml(addr.country)}
          ${addr.phone ? `<br>Phone: ${escapeHtml(addr.phone)}` : ""}
        </p>
      `
      : `<p><small style="color:gray;">No delivery address provided.</small></p>`;

    const trackingHtml =
      order.status === "shipped" || order.status === "delivered"
        ? `
          <p>
            <strong>Tracking #:</strong> ${escapeHtml(order.trackingNumber) || "Not added yet"}
            <button onclick="editTrackingNumber('${docSnap.id}')" class="btn-sm">
              ${order.trackingNumber ? "Edit" : "Add"}
            </button>
          </p>
        `
        : "";

    const productImageHtml = productImage
      ? `<img src="${productImage}" style="width:60px;height:60px;object-fit:cover;border-radius:8px;">`
      : `<div style="width:60px;height:60px;border-radius:8px;background:var(--lv-canvas,#F6F8F6);border:1px solid var(--lv-line,#E2E8E4);display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--lv-slate,#5B6B62);text-align:center;">No image</div>`;

    // FINAL UI
    sellerOrders.innerHTML += `
    <li id="order-${docSnap.id}" style="display:flex; align-items:center; gap:15px; margin-bottom:15px;">

        ${productImageHtml}

        <div>

            <p><strong>Order #:</strong> ${escapeHtml(order.orderNumber) || docSnap.id}</p>

            <p><strong>Buyer:</strong> ${buyerName}</p>

            <p><small style="color:gray;">${orderDate}</small></p>

            <p>
                <strong>${productName}</strong> |
                Status:
                <span style="color:${statusColor};font-weight:bold;">
                    ${order.status}
                </span>
            </p>

            <p><strong>Quantity:</strong> ${quantity}</p>

            ${order.color ? `<p><strong>Color:</strong> ${order.color}</p>` : ""}

            ${order.size ? `<p><strong>Size:</strong> ${order.size}</p>` : ""}

            <p><strong>Total:</strong> $${total.toFixed(2)}</p>

            ${addressHtml}

            ${trackingHtml}

            ${deliveryInfo}

            <br>

            ${shipBtn}

            ${deliverBtn}

        </div>

    </li>
    `;
  }

  const highlightOrderId =
      new URLSearchParams(window.location.search).get("orderId");

  if (highlightOrderId) {
      setTimeout(() => {
          const card = document.getElementById(`order-${highlightOrderId}`);

          if (card) {
              card.scrollIntoView({ behavior: "smooth", block: "center" });
              card.classList.add("highlight-order");

              setTimeout(() => {
                  card.classList.remove("highlight-order");
              }, 5000);
          }
      }, 300);
  }
}

// ================= SHIP / DELIVER / TRACKING =================
// Each of these applies either to an older per-product order (the default) or,
// when kind === "sub", to one seller's sub-order of a newer checkout. The two
// differ in where they live, what their status field is called, who the buyer
// is, and which order the buyer's notification should open.
function orderTarget(orderId, kind) {
  const isSub = kind === "sub";

  return {
    isSub,
    ref: doc(db, isSub ? "sellerOrders" : "orders", orderId),
    statusField: isSub ? "fulfillmentStatus" : "status"
  };
}

async function productNameForNotification(order, isSub) {
  if (isSub) return describeProducts(order.products);

  const productSnap = await getDoc(doc(db, "products", order.productId));

  return productSnap.exists() ? productSnap.data().name : "Unknown Product";
}

function notifyBuyerOfOrder(order, isSub, orderId, notification) {
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

// The sub-orders on the page, so a button only needs to carry an id.
const subOrderCache = new Map();

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

async function fetchReturnsMap(field) {
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

let buyerReturns = new Map();
let sellerReturns = new Map();

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
const refreshSellerOrders = () => loadSellerOrders();

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
  const ret = [...sellerReturns.values()].find((r) => r.id === returnId);
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

async function shipSubOrder(orderId) {
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

// ================= SHIP ORDER =================
window.markShipped = async (orderId, kind) => {
  try {
    const { isSub, ref, statusField } = orderTarget(orderId, kind);

    // A newer sub-order also asks where a return should be sent.
    if (isSub) return shipSubOrder(orderId);

    const orderSnap = await getDoc(ref);

    if (!orderSnap.exists()) {
      alert("Order not found.");
      return;
    }

    const order = orderSnap.data();
    const productName = await productNameForNotification(order, isSub);

    const trackingNumber = prompt(
      "Tracking number (optional -- leave blank to skip, you can add it later):",
      ""
    );

    const orderUpdate = {
      [statusField]: "shipped",
      shippedAt: new Date() // save timestamp
    };

    // A cancelled prompt returns null -- leave any existing tracking number
    // untouched in that case rather than clearing it.
    if (trackingNumber !== null) {
      orderUpdate.trackingNumber = trackingNumber.trim() || null;
    }

    await updateDoc(ref, orderUpdate);

    await notifyBuyerOfOrder(order, isSub, orderId, {
      type: "shipped",
      title: "Order Shipped",
      message: `Your order for "${productName}" has been shipped.`
    });

    alert("Order marked as shipped");
    loadSellerOrders();

  } catch (err) {
    alert("Failed to update order: " + err.message);
  }
};

// Lets a seller add/correct a tracking number any time after shipping --
// Firestore rules only allow this while the order's status is "shipped" or
// "delivered", same as the check already built into loadSellerOrders above.
window.editTrackingNumber = async (orderId, kind) => {
  try {
    const { ref } = orderTarget(orderId, kind);

    const orderSnap = await getDoc(ref);

    if (!orderSnap.exists()) {
      alert("Order not found.");
      return;
    }

    const current = orderSnap.data().trackingNumber || "";

    const trackingNumber = prompt("Tracking number:", current);

    if (trackingNumber === null) return; // cancelled

    await updateDoc(ref, {
      trackingNumber: trackingNumber.trim() || null
    });

    loadSellerOrders();

  } catch (err) {
    alert("Failed to update tracking number: " + err.message);
  }
};

// ================= DELIVER ORDER =================
window.markDelivered = async (orderId, kind) => {
  try {
    const { isSub, ref, statusField } = orderTarget(orderId, kind);

    const orderSnap = await getDoc(ref);

    if (!orderSnap.exists()) {
      alert("Order not found.");
      return;
    }

    const order = orderSnap.data();
    const productName = await productNameForNotification(order, isSub);

    await updateDoc(ref, {
      [statusField]: "delivered",
      deliveredAt: new Date() // save timestamp
    });

    await notifyBuyerOfOrder(order, isSub, orderId, {
      type: "delivered",
      title: "Order Delivered",
      message: `Your order for "${productName}" has been delivered. Please leave a review.`
    });

    alert("Order marked as delivered");
    loadSellerOrders();

  } catch (err) {
    alert("Failed to update order: " + err.message);
  }
};

/*============SOLD ITEMS HISTORY ===========*/
// This used to show products that had sold OUT entirely (quantity hit 0),
// which only ever covered items that had completely sold and told you
// nothing about individual sales. "History" is now driven by the actual
// orders collection instead -- one entry per sale, with the buyer, date,
// quantity, and amount that sale actually involved.
async function loadSoldProducts() {
  const soldList = document.getElementById("soldProducts");
  if (!soldList || !auth.currentUser) return;

  const [legacySnapshot, subOrderSnapshot] = await Promise.all([
    getDocs(query(collection(db, "orders"), where("sellerId", "==", auth.currentUser.uid))),
    getDocs(query(collection(db, "sellerOrders"), where("sellerId", "==", auth.currentUser.uid)))
  ]);

  soldList.innerHTML = "";

  if (legacySnapshot.empty && subOrderSnapshot.empty) {
    soldList.innerHTML = `
      <div class="empty-state">
        <div class="empty-glyph">🧾</div>
        <div><strong>No sales yet.</strong></div>
        <div style="font-size:13px; margin-top:4px;">Every order you receive will show up here.</div>
      </div>
    `;
    return;
  }

  const orders = [
    ...legacySnapshot.docs.map(d => ({ id: d.id, ...d.data() })),
    ...subOrderSnapshot.docs.map(d => ({ id: d.id, isSubOrder: true, ...d.data() }))
  ].sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

  for (const order of orders) {

    if (order.isSubOrder) {
      const subBuyerSnap = await getDoc(doc(db, "users", order.buyerId));

      soldList.insertAdjacentHTML(
        "beforeend",
        soldSubOrderHtml(order, subBuyerSnap.exists() ? subBuyerSnap.data() : {})
      );

      continue;
    }

    const productSnap = await getDoc(doc(db, "products", order.productId));
    const product = productSnap.exists() ? productSnap.data() : {};
    const image = product.images?.[0] || product.imageURL || "";

    const buyerSnap = await getDoc(doc(db, "users", order.userId));
    const buyer = buyerSnap.exists() ? buyerSnap.data() : {};
    const buyerName = buyer.fullName || "Unknown buyer";
    const buyerEmail = buyer.email || "";

    const purchaseDate = order.createdAt?.toDate
      ? order.createdAt.toDate().toLocaleString()
      : "N/A";

    const quantity = order.quantity || 1;
    const unitPrice = order.price ?? product.price ?? 0;
    const total = (unitPrice * quantity).toFixed(2);

    let statusBadgeClass = "badge-neutral";
    if (order.status === "paid") statusBadgeClass = "badge-warning";
    else if (order.status === "shipped") statusBadgeClass = "badge-info";
    else if (order.status === "delivered") statusBadgeClass = "badge-success";

    const variantBits = [
      order.color ? `Color: ${order.color}` : null,
      order.size ? `Size: ${order.size}` : null,
    ].filter(Boolean).join(" &middot; ");

    soldList.innerHTML += `
      <div class="sold-item-card">
        <img src="${image}" class="sold-item-img" alt="${product.name || ''}">

        <div class="sold-item-info">
          <div class="sold-item-header">
            <h3>${product.name || "Unknown product"}</h3>
            <span class="badge ${statusBadgeClass}">${(order.status || "unknown").toUpperCase()}</span>
          </div>

          <p><strong>Purchased:</strong> ${purchaseDate}</p>
          <p><strong>Quantity:</strong> ${quantity}${variantBits ? ` &middot; ${variantBits}` : ""}</p>
          <p><strong>Buyer:</strong> ${buyerName}${buyerEmail ? ` (${buyerEmail})` : ""}</p>
          <p><strong>Total paid:</strong> $${total}</p>
        </div>
      </div>
    `;
  }
}

/* ================= LOGOUT ================= */
const logoutBtn = document.getElementById("logoutBtn");
if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    await signOut(auth);
    window.location.href = "index.html";
  });
}

/*=============PASSWORD RESET FUNCTION============*/

const resetBtn = document.getElementById("resetPasswordBtn");

if (resetBtn) {
  resetBtn.addEventListener("click", async () => {
    const email = document.getElementById("email").value;

    if (!email) {
      alert("Please enter your email first.");
      return;
    }

    try {
      /*await sendPasswordResetEmail(auth, email);
      alert("Password reset email sent. Check your inbox.");*/

    const response = await fetch(
      "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/sendPasswordResetEmail",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
        }),
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Unable to send password reset email.");
    }

    alert("Password reset email sent. Please check your inbox.");    

    } catch (err) {
      alert(err.message);
    }
  });
}

// ===========================
// RESEND VERIFICATION EMAIL
// ===========================

/*const resendBtn = document.getElementById("resendVerificationBtn");

if (resendBtn) {

  resendBtn.addEventListener("click", async () => {

    const email = document.getElementById("email").value;

    if (!email) {
      alert("Please enter your email first.");
      return;
    }

    try {

      const response = await fetch(
        "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/sendVerificationEmail",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },

          body: JSON.stringify({

            email,
            uid: "resend",
            fullName: ""

          })

        }
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error);
      }

      alert(
        "A new verification email has been sent.\n\nPlease check your inbox."
      );

    } catch (err) {

      alert(err.message);

    }

  });

}*/

/* ================= CORE MESSAGING ================= */

// Always generate SAME conversation ID
function getConversationId(user1, user2, productId) {
  const sortedUsers = [user1, user2].sort(); // ONLY sort users
  return `${sortedUsers[0]}_${sortedUsers[1]}_${productId}`;
}

/*// Send message (USED EVERYWHERE)
async function sendMessage(productId, otherUserId, inputId, existingConvoId = null) {
  const input = document.getElementById(inputId);
  const text = input.value.trim();

  if (!text) return;

  const user = auth.currentUser;
  if (!user) {
    alert("You must be logged in");
    return;
  }

  // USE EXISTING conversationId IF AVAILABLE
  const conversationId =
    existingConvoId ||
    getConversationId(user.uid, otherUserId, productId);*/

    /*try {

      const userDoc =
        await getDoc(doc(db, "users", user.uid));
    
      const userData =
        userDoc.data();
    
      await addDoc(collection(db, "messages"), {
        conversationId,
        productId,
    
        senderId: user.uid,
    
        senderName:
          userData.fullName ||
          user.email,
    
        receiverId: otherUserId,
    
        text,
    
        createdAt: serverTimestamp(),
    
        deletedBy: []
      });

    input.value = "";
    console.log("Message sent in convo:", conversationId);

  } catch (error) {
    console.error("Error sending message:", error);
  }
}*/

// Send message (USED EVERYWHERE)
// File types allowed for a message attachment that isn't an image -- kept
// as an explicit allow-list (mirrored by storage.rules) rather than "any
// file", so this can't become an arbitrary-file drop.
const MESSAGE_ATTACHMENT_ALLOWED_FILE_TYPES = [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain",
];

const MESSAGE_ATTACHMENT_MAX_FILES = 5;
const MESSAGE_ATTACHMENT_MAX_SIZE = 10 * 1024 * 1024;

async function sendMessage(productId, otherUserId, inputId, existingConvoId = null, fileInputId = null) {

    const input = document.getElementById(inputId);
    const text = input.value.trim();

    const fileInput = fileInputId ? document.getElementById(fileInputId) : null;
    const files = fileInput ? Array.from(fileInput.files || []) : [];

    // A message needs SOME content -- text, an attachment, or both.
    if (!text && files.length === 0) return;

    if (files.length > MESSAGE_ATTACHMENT_MAX_FILES) {
        alert(`You can attach up to ${MESSAGE_ATTACHMENT_MAX_FILES} files at once.`);
        return;
    }

    for (const file of files) {
        const isImage = file.type.startsWith("image/");

        if (!isImage && !MESSAGE_ATTACHMENT_ALLOWED_FILE_TYPES.includes(file.type)) {
            alert(`"${file.name}" isn't a supported file type.`);
            return;
        }

        if (file.size > MESSAGE_ATTACHMENT_MAX_SIZE) {
            alert(`"${file.name}" is larger than 10MB.`);
            return;
        }
    }

    const user = auth.currentUser;

    if (!user) {
        alert("You must be logged in");
        return;
    }

    const conversationId =
        existingConvoId ||
        getConversationId(user.uid, otherUserId, productId);

    try {

        // Get sender information
        const userDoc = await getDoc(doc(db, "users", user.uid));
        const userData = userDoc.exists() ? userDoc.data() : {};

        const senderName =
            userData.fullName ||
            user.displayName ||
            user.email;

        // Upload attachments before writing the message doc, so the doc is
        // only ever created with working URLs already in hand.
        const attachments = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const path = `messages/${conversationId}/${user.uid}/${Date.now()}_${i}_${file.name}`;
            const fileRef = ref(storage, path);

            await uploadBytes(fileRef, file);
            const url = await getDownloadURL(fileRef);

            attachments.push({
                url,
                path,
                type: file.type.startsWith("image/") ? "image" : "file",
                fileName: file.name,
                sizeBytes: file.size,
                contentType: file.type,
            });
        }

        // Save message
      await addDoc(collection(db, "messages"), {

          conversationId,
          productId,

          senderId: user.uid,
          senderName: senderName,

          receiverId: otherUserId,

          text,
          attachments,

          createdAt: serverTimestamp(),

          sent: true,

          delivered: false,

          isRead: false,

          deletedBy: []

      });

      // ===============================
      // CREATE MESSAGE NOTIFICATION
      // ===============================

      try {

          // Find receiver role
          const receiverDoc = await getDoc(
              doc(db, "users", otherUserId)
          );

      let messagePage = "messages.html"; // Default -- the real buyer messages page

      if (receiverDoc.exists()) {

          const receiverData = receiverDoc.data();

          if (receiverData.role === "seller") {
              messagePage = "seller-messages.html";
          }
          // Buyers already get the correct default above -- "buyer-messages.html"
          // was never a real file, so this used to fall through Firebase
          // Hosting's catch-all rewrite straight to index.html.

      }

          // Create notification
          await addDoc(collection(db, "notifications"), {

              userId: otherUserId,

              type: "message",

              title: "New Message",

              message: `${senderName} sent you a message.`,

              link: `${messagePage}?conversationId=${conversationId}`,

              read: false,

              createdAt: serverTimestamp()

          });

          console.log("Message notification created.");

      } catch (notificationError) {

          console.error(
              "Notification Error:",
              notificationError
          );

      }
// not included//
        input.value = "";
        if (fileInput) fileInput.value = "";

        console.log(
            "Message sent:",
            conversationId
        );

    } catch (error) {

        console.error(
            "Error sending message:",
            error
        );

    }

}

// Handle reply from UI
window.handleReply = async function(convoId, receiverId, productId, textareaId, fileInputId) {
  const input = document.getElementById(textareaId);
  const text = input.value.trim();

  const fileInput = fileInputId ? document.getElementById(fileInputId) : null;
  const hasFiles = fileInput && fileInput.files && fileInput.files.length > 0;

  if (!text && !hasFiles) {
    alert("Type a message or attach a file.");
    return;
  }

  // PASS convoId HERE
  await sendMessage(productId, receiverId, textareaId, convoId, fileInputId);

  input.value = "";

  loadSellerMessages?.();
  loadBuyerMessages?.();
};

// Get other user in conversation
function getOtherUserId(messages) {
  const currentUser = auth.currentUser.uid;

  for (let msg of messages) {
    if (msg.senderId !== currentUser) return msg.senderId;
    if (msg.receiverId !== currentUser) return msg.receiverId;
  }

  return null;
}

// Shared by loadSellerMessages/loadBuyerMessages -- renders a message's
// attachments, if any. Images show as clickable thumbnails; anything else
// shows as a small download chip with the filename. fileName is the only
// attachment field that's ever user-typed (the original upload's name), so
// it's the only one that needs escaping here.
function renderMessageAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return "";

  return attachments.map(att => {
    if (att.type === "image") {
      return `
        <a href="${att.url}" target="_blank" rel="noopener">
          <img src="${att.url}" style="max-width:160px;max-height:160px;border-radius:8px;margin:4px 4px 0 0;display:inline-block;object-fit:cover;">
        </a>
      `;
    }

    return `
      <a href="${att.url}" target="_blank" rel="noopener"
         style="display:inline-block;margin:4px 4px 0 0;padding:6px 10px;background:#fff;border:1px solid #ccc;border-radius:6px;font-size:12px;text-decoration:none;color:#14231B;">
        📎 ${escapeHtml(att.fileName)}
      </a>
    `;
  }).join("");
}


// Per-role (seller/buyer) in-memory index of each conversation's messages
// and product info, built by renderMessagingUI and read back by
// showConversation -- this is what lets clicking a conversation in the
// list open its thread instantly, without re-querying Firestore.
const messagingState = {
  seller: { conversations: {}, activeId: null },
  buyer: { conversations: {}, activeId: null },
};

// Shared by loadSellerMessages/loadBuyerMessages: queries this user's
// messages, groups them into conversations, and renders the WhatsApp-style
// conversation LIST (photo, product name, last-message time only -- the
// full thread only renders once a conversation is clicked, in
// showConversation below). The query and grouping logic here is unchanged
// from before this redesign; only how each conversation is turned into
// markup is different.
async function renderMessagingUI(role) {
  const listId = role === "seller" ? "sellerMessages" : "buyerMessages";
  const msgList = document.getElementById(listId);

  if (!msgList || !auth.currentUser) return;

  // If we arrived here from a "New Message" notification link, open that
  // specific conversation once the list below is built.
  const targetConversationId =
    new URLSearchParams(window.location.search).get("conversationId");

  // Scoped to this user as sender OR receiver -- a Firestore rule that
  // enforces message privacy will reject an unfiltered collection scan,
  // so this has to be a real query, not a client-side filter.
  // No orderBy here (avoids needing a composite index for the or() + sort
  // combination) -- messages are already re-sorted client-side below.
  const q = query(
    collection(db, "messages"),
    or(
      where("senderId", "==", auth.currentUser.uid),
      where("receiverId", "==", auth.currentUser.uid)
    )
  );

  const snapshot = await getDocs(q);

  const conversations = {};

  snapshot.forEach(docSnap => {
    const msg = docSnap.data();

    if (
      msg.receiverId !== auth.currentUser.uid &&
      msg.senderId !== auth.currentUser.uid
    ) {
      return;
    }

    // The buyer view has always dropped productId-less messages entirely
    // (the seller view never did) -- preserved exactly as it was.
    if (role === "buyer" && !msg.productId) return;

    const convoId = msg.conversationId;

    if (!conversations[convoId]) {
      conversations[convoId] = [];
    }

    conversations[convoId].push(msg);
  });

  // Sort conversations by latest message
  const convoList = Object.values(conversations).sort((a, b) => {

    const latestA = Math.max(
      ...a.map(msg => msg.createdAt?.seconds || 0)
    );

    const latestB = Math.max(
      ...b.map(msg => msg.createdAt?.seconds || 0)
    );

    return latestB - latestA;
  });

  msgList.innerHTML = "";
  messagingState[role].conversations = {};

  for (const msgs of convoList) {

    const visibleMsgs = msgs.filter(
      msg => !msg.deletedBy?.includes(auth.currentUser.uid)
    );

    if (visibleMsgs.length === 0) continue;

    visibleMsgs.sort((a, b) => {
      const timeA = a.createdAt?.seconds || 0;
      const timeB = b.createdAt?.seconds || 0;
      return timeA - timeB;
    });

    const convoId = visibleMsgs[0].conversationId;
    const firstMsg = visibleMsgs[0];

    let product = {};

    if (firstMsg.productId) {

      try {

        const productDoc = await getDoc(
          doc(db, "products", firstMsg.productId)
        );

        if (!productDoc.exists()) {
          continue; // skip this conversation entirely
        }

        product = productDoc.data();

      } catch (err) {

        console.warn(
          "Bad productId:",
          firstMsg.productId
        );

        continue;
      }
    }

    messagingState[role].conversations[convoId] = { visibleMsgs, product, firstMsg };

    const lastMsg = visibleMsgs[visibleMsgs.length - 1];

    const lastTime = lastMsg.createdAt
      ? new Date(lastMsg.createdAt.seconds * 1000).toLocaleString()
      : "";

    const productImage =
      product.images?.[0] ||
      product.imageURL ||
      "";

    const isActive = messagingState[role].activeId === convoId;

    msgList.innerHTML += `
      <div
        class="conversation-row${isActive ? ' active' : ''}"
        id="conv-row-${role}-${convoId}"
        onclick="showConversation('${role}', '${convoId}')"
      >
        <img src="${productImage}" alt="">
        <div class="conversation-row-info">
          <div class="conv-name">${escapeHtml(product.name) || "Unknown Product"}</div>
          <div class="conv-time">${lastTime}</div>
        </div>
      </div>
    `;
  }

  // Re-open whichever conversation was already active (sending a message
  // re-runs this whole function, and the detail pane shouldn't go blank
  // every time), or the one linked from a "New Message" notification.
  const toOpen = messagingState[role].activeId || targetConversationId;

  if (toOpen && messagingState[role].conversations[toOpen]) {
    showConversation(role, toOpen);
  }
}

async function loadSellerMessages() {
  await renderMessagingUI("seller");
}

async function loadBuyerMessages() {
  await renderMessagingUI("buyer");
}

// Renders the full thread for one conversation into the detail pane. Reads
// from messagingState (populated by renderMessagingUI above) rather than
// hitting Firestore again -- the data's already in hand.
window.showConversation = function(role, convoId) {
  const state = messagingState[role];
  const convo = state.conversations[convoId];

  if (!convo) return;

  state.activeId = convoId;

  document.querySelectorAll(`#${role}Messages .conversation-row`).forEach(row => {
    row.classList.remove("active");
  });

  const row = document.getElementById(`conv-row-${role}-${convoId}`);
  if (row) row.classList.add("active");

  const { visibleMsgs, product, firstMsg } = convo;
  const otherUserId = getOtherUserId(visibleMsgs);
  const productImage = product.images?.[0] || product.imageURL || "";
  const productName = escapeHtml(product.name) || "Unknown Product";

  let chatHTML = "";

  visibleMsgs.forEach(msg => {

    const isMe = msg.senderId === auth.currentUser.uid;
    const displayName = isMe ? "You" : (msg.senderName || "Unknown User");

    const time = msg.createdAt
      ? new Date(msg.createdAt.seconds * 1000).toLocaleString()
      : "";

    // Read-receipt ticks have only ever shown on the seller side -- same
    // as before this redesign.
    const statusHtml = role === "seller"
      ? `
        <div class="message-status">
          ${msg.isRead ? "💙 Read" : msg.delivered ? "✔✔ Delivered" : "✔ Sent"}
        </div>
      `
      : "";

    chatHTML += `
      <div style="
        background:${isMe ? '#d1f7c4' : '#f1f1f1'};
        text-align:${isMe ? 'right' : 'left'};
        margin:8px 0;
        padding:12px;
        border-radius:12px;
      ">

        <div style="font-weight:bold; margin-bottom:6px;">
          ${displayName}
        </div>

        <div>
          ${escapeHtml(msg.text)}
          <div>${renderMessageAttachments(msg.attachments)}</div>
          ${statusHtml}
        </div>

        <small style="color:gray; font-size:10px;">
          ${time}
        </small>

      </div>
    `;
  });

  const textareaId = `${role}-${convoId}`;
  const fileInputId = `${role}-files-${convoId}`;
  const chipId = `${role}-chip-${convoId}`;
  const threadId = `thread-${role}-${convoId}`;

  const detail = document.getElementById(`${role}MessageDetail`);
  if (!detail) return;

  detail.innerHTML = `
    <div class="conversation-detail-header">
      <button class="conversation-back-btn" onclick="showConversationList('${role}')" aria-label="Back">←</button>
      <img src="${productImage}" alt="">
      <strong>${productName}</strong>
      <button
        onclick="deleteChat('${convoId}', '${firstMsg.productId}')"
        style="margin-left:auto;background:none;border:none;color:var(--lv-danger,#C6362E);cursor:pointer;font-size:13px;"
      >
        Delete Chat
      </button>
    </div>

    <div class="conversation-thread" id="${threadId}">
      ${chatHTML}
    </div>

    <div id="${chipId}"></div>

    <div class="chat-input-bar">
      <label class="chat-attach-btn" for="${fileInputId}" title="Attach a file">+</label>
      <input
        type="file"
        id="${fileInputId}"
        multiple
        accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
        style="display:none;"
        onchange="updateFileChip('${fileInputId}', '${chipId}')"
      >
      <textarea
        class="chat-text-input"
        id="${textareaId}"
        placeholder="Type a message..."
        rows="1"
        onkeydown="if(event.key === 'Enter' && !event.shiftKey){ event.preventDefault(); handleReply('${convoId}', '${otherUserId}', '${firstMsg.productId}', '${textareaId}', '${fileInputId}'); }"
      ></textarea>
      <button
        class="chat-send-btn"
        onclick="handleReply('${convoId}', '${otherUserId}', '${firstMsg.productId}', '${textareaId}', '${fileInputId}')"
        aria-label="Send"
      >➤</button>
    </div>
  `;

  const threadEl = document.getElementById(threadId);
  if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;

  // Mobile: slide from the list over to the open thread.
  const appEl = document.getElementById(`${role}MessagesApp`);
  if (appEl) appEl.classList.add("showing-detail");
};

// Mobile back button: return from the open thread to the conversation list.
window.showConversationList = function(role) {
  const appEl = document.getElementById(`${role}MessagesApp`);
  if (appEl) appEl.classList.remove("showing-detail");
};

// Shows a small chip for whatever file(s) are currently selected in the
// attach input, so it's clear something's queued up before hitting send.
window.updateFileChip = function(fileInputId, chipId) {
  const input = document.getElementById(fileInputId);
  const chipContainer = document.getElementById(chipId);

  if (!input || !chipContainer) return;

  const files = Array.from(input.files || []);

  chipContainer.innerHTML = files
    .map(f => `<span class="chat-file-chip">📎 ${escapeHtml(f.name)}</span>`)
    .join("");
};


/* ================= AUTH LOAD FOR MESSAGES PAGE ================= 

if (window.location.pathname.includes("messages.html")) {
  onAuthStateChanged(auth, (user) => {
    if (user) {
      loadBuyerMessages();
    }
  });
}*/
/* =========== Delect Conversation ========== */
window.deleteChat = async function(conversationId, productId) {
  const user = auth.currentUser;
  if (!user) return;

  if (!confirm("Delete this chat?")) return;

  const q = query(
    collection(db, "messages"),
    where("conversationId", "==", conversationId),
    where("productId", "==", productId)
  );

  const snapshot = await getDocs(q);
  const batch = writeBatch(db);

  snapshot.forEach((docSnap) => {
    const data = docSnap.data();
    const deletedBy = data.deletedBy || [];

    if (!deletedBy.includes(user.uid)) {
      batch.update(doc(db, "messages", docSnap.id), {
        deletedBy: [...deletedBy, user.uid]
      });
    }
  });

  await batch.commit();

  loadSellerMessages?.();
  loadBuyerMessages?.();
};

// STORE INFORMATION FUNCTION //

const saveStoreBtn = document.getElementById("saveStoreBtn");

if (saveStoreBtn) {

  saveStoreBtn.addEventListener("click", async () => {

    const storeName =
      document.getElementById("storeName").value.trim();

    const storeDescription =
      document.getElementById("storeDescription").value.trim();

    if (!storeName) {
      alert("Please enter a store name");
      return;
    }

    try {

      await updateDoc(
        doc(db, "users", auth.currentUser.uid),
        {
          storeName: storeName,
          storeDescription: storeDescription
        }
      );

      alert("Store profile saved!");

      window.location.href = "seller dashboard.html";

    } catch (err) {

      alert(err.message);

    }

  });

}

async function loadStoreProfile() {

  if (!auth.currentUser) return;

  const userDoc = await getDoc(
    doc(db, "users", auth.currentUser.uid)
  );

  if (!userDoc.exists()) return;

  const data = userDoc.data();

  const storeInput =
    document.getElementById("storeName");

  if (storeInput) {
    storeInput.value = data.storeName || "";
  }

  const descriptionInput =
    document.getElementById("storeDescription");

  if (descriptionInput) {
    descriptionInput.value =
      data.storeDescription || "";
  }

  const storeNameElement =
    document.getElementById("currentStoreName");

  if (storeNameElement) {
    storeNameElement.innerText =
      `🏪 ${data.storeName || "No Store Name Yet"}`;
  }

  const descriptionElement =
    document.getElementById("currentStoreDescription");

  if (descriptionElement) {
    descriptionElement.innerText =
      data.storeDescription || "";
  }

  renderStripeStatus(data);
  fillShippingForm(data.shipping);

}

// Shows the seller's current Stripe Connect onboarding status and
// whether the "Connect with Stripe" button should read "Connect" or
// "Continue setup". Status text is driven entirely by
// stripeOnboardingStatus, which only ever changes via the
// account.updated webhook -- never something this page computes itself.
function renderStripeStatus(data) {
  const statusText = document.getElementById("stripeStatusText");
  const connectBtn = document.getElementById("connectStripeBtn");

  if (!statusText || !connectBtn) return;

  const status = data.stripeOnboardingStatus || "not_started";

  const statusMessages = {
    not_started: "You haven't connected a payout account yet.",
    pending: "Your payout account setup is in progress with Stripe.",
    restricted: "Stripe needs more information before you can receive payouts.",
    complete: "You're all set! Payouts are enabled on your account.",
  };

  statusText.textContent = statusMessages[status] || statusMessages.not_started;

  connectBtn.style.display = status === "complete" ? "none" : "inline-block";
  connectBtn.textContent = status === "not_started" ? "Connect with Stripe" : "Continue setup";
}

const connectStripeBtn = document.getElementById("connectStripeBtn");

if (connectStripeBtn) {

  connectStripeBtn.addEventListener("click", async () => {

    if (!auth.currentUser) {
      alert("Please login first");
      return;
    }

    connectStripeBtn.disabled = true;

    try {

      const idToken = await auth.currentUser.getIdToken();

      const response = await fetch(createConnectOnboardingLinkURL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`
        }
      });

      const data = await response.json();

      if (!response.ok) {
        alert(data.error || "Unable to start Stripe onboarding.");
        connectStripeBtn.disabled = false;
        return;
      }

      window.location.href = data.url;

    } catch (err) {
      alert("Unable to start Stripe onboarding: " + err.message);
      connectStripeBtn.disabled = false;
    }

  });

}

// Populates the shipping form from the seller's saved shipping config, if
// any -- new sellers see empty/unchecked defaults rather than a shipping
// policy they never set.
function fillShippingForm(shipping) {
  const s = shipping || {};

  const freeShippingCheckbox = document.getElementById("freeShippingCheckbox");
  const flatRateInput = document.getElementById("flatRateInput");
  const expressEnabledCheckbox = document.getElementById("expressEnabledCheckbox");
  const expressRateInput = document.getElementById("expressRateInput");

  if (freeShippingCheckbox) freeShippingCheckbox.checked = Boolean(s.freeShipping);
  if (flatRateInput) flatRateInput.value = s.flatRateCents != null ? (s.flatRateCents / 100).toFixed(2) : "";
  if (expressEnabledCheckbox) expressEnabledCheckbox.checked = Boolean(s.expressEnabled);
  if (expressRateInput) expressRateInput.value = s.expressRateCents != null ? (s.expressRateCents / 100).toFixed(2) : "";
}

const saveShippingBtn = document.getElementById("saveShippingBtn");

if (saveShippingBtn) {

  saveShippingBtn.addEventListener("click", async () => {

    const freeShipping = document.getElementById("freeShippingCheckbox").checked;
    const expressEnabled = document.getElementById("expressEnabledCheckbox").checked;

    const flatRateDollars = parseFloat(document.getElementById("flatRateInput").value);
    const expressRateDollars = parseFloat(document.getElementById("expressRateInput").value);

    if (!freeShipping && !(flatRateDollars >= 0)) {
      alert("Please enter a flat-rate shipping price, or offer free shipping.");
      return;
    }

    if (expressEnabled && !(expressRateDollars >= 0)) {
      alert("Please enter an express shipping price, or turn off express shipping.");
      return;
    }

    const shipping = {
      freeShipping,
      flatRateCents: flatRateDollars >= 0 ? Math.round(flatRateDollars * 100) : 0,
      expressEnabled,
      expressRateCents: expressEnabled && expressRateDollars >= 0 ? Math.round(expressRateDollars * 100) : null,
    };

    try {

      await updateDoc(
        doc(db, "users", auth.currentUser.uid),
        { shipping }
      );

      alert("Shipping settings saved!");

    } catch (err) {
      alert(err.message);
    }

  });

}

//LOAD REVIEW FUNCTION//

async function loadReviews(productId) {

  const reviewsContainer =
    document.getElementById("reviewsContainer");

  if (!reviewsContainer) return;

  const q = query(
    collection(db, "reviews"),
    where("productId", "==", productId)
  );

  const snapshot = await getDocs(q);

  reviewsContainer.innerHTML = "";

  if (snapshot.empty) {

    reviewsContainer.innerHTML =
      "<p>No reviews yet.</p>";

    return;
  }

  snapshot.forEach((docSnap) => {

    const review = docSnap.data();

  
    const stars =
      "★".repeat(review.rating) +
      "☆".repeat(5 - review.rating);

    const photosHtml = (review.photos || []).map(p => `
      <a href="${p.url}" target="_blank" rel="noopener">
        <img src="${p.url}" style="width:80px;height:80px;object-fit:cover;border-radius:6px;margin:6px 6px 0 0;">
      </a>
    `).join("");

    reviewsContainer.innerHTML += `
      <div class="review-card">

        <h4>${stars}</h4>

        <p>${escapeHtml(review.comment)}</p>

        <div>${photosHtml}</div>

        <small>
          By ${escapeHtml(review.buyerName) || "Anonymous"}
        </small>

      </div>
      <hr>
    `;
  });
}
//SUBMIT REVIEW BUTTON AND SAFE THE REVIEW//
const submitReviewBtn =
  document.getElementById("submitReviewBtn");

if (submitReviewBtn) {

  submitReviewBtn.addEventListener("click", async () => {

    const productId =
      new URLSearchParams(window.location.search)
      .get("productId");

    const orderId =
      new URLSearchParams(window.location.search)
      .get("orderId");

    if (!orderId) {
      alert("This review link is missing its order reference. Please open this page from \"Leave Review\" on your order.");
      return;
    }

    const rating =
      Number(
        document.getElementById("reviewRating").value
      );

    const comment =
      document.getElementById("reviewComment")
      .value.trim();

    if (!comment) {
      alert("Please write a review");
      return;
    }

    // Photos are optional -- validated the same way message attachments
    // are (count/size/type), mirrored server-side by storage.rules.
    const photoInput = document.getElementById("reviewPhotos");
    const photoFiles = photoInput ? Array.from(photoInput.files || []) : [];

    if (photoFiles.length > 3) {
      alert("You can attach up to 3 photos.");
      return;
    }

    for (const file of photoFiles) {
      if (!file.type.startsWith("image/")) {
        alert(`"${file.name}" isn't an image.`);
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        alert(`"${file.name}" is larger than 5MB.`);
        return;
      }
    }

    const userDoc =
      await getDoc(
        doc(db, "users", auth.currentUser.uid)
      );

    const userData =
      userDoc.data();

      // Get product
      const productSnap = await getDoc(
          doc(db, "products", productId)
      );

      if (!productSnap.exists()) {
          alert("Product not found.");
          return;
      }


  const product = productSnap.data();

    submitReviewBtn.disabled = true;

    try {

      // Upload photos before creating the review doc, so the doc is only
      // ever written with working URLs already in hand.
      const photos = [];

      for (let i = 0; i < photoFiles.length; i++) {
        const file = photoFiles[i];
        const path = `reviews/${auth.currentUser.uid}/${orderId}/${Date.now()}_${i}_${file.name}`;
        const fileRef = ref(storage, path);

        await uploadBytes(fileRef, file);
        const url = await getDownloadURL(fileRef);

        photos.push({ url, path, uploadedAt: new Date().toISOString() });
      }

      await addDoc(
        collection(db, "reviews"),
        {
          productId,

          orderId,

          productName: product.name,

          sellerId: product.sellerId,

          buyerId: auth.currentUser.uid,

          buyerName:
            userData.fullName ||
            auth.currentUser.displayName ||
            auth.currentUser.email,

          rating,

          comment,

          photos,

          createdAt: serverTimestamp()
        }
      );

      // ===============================
      // CREATE NOTIFICATION FOR SELLER
      // ===============================

      try {
        await addDoc(collection(db, "notifications"), {

            userId: product.sellerId,

            type: "review",

            title: "New Review",

            message: `${product.name} received a new review.`,

            link: `seller-reviews.html?productId=${productId}`,

            read: false,

            createdAt: serverTimestamp()

        });

        console.log("Notification saved successfully.");
      } catch (error) {

        console.error("Failed to create review notification:", error);

      }

      alert("Review submitted!");

      window.location.href = "order.html";

    } catch (error) {

      console.error("Failed to submit review:", error);
      alert("Failed to submit review: " + error.message);
      submitReviewBtn.disabled = false;

    }

  });

}

 

      //Submit function//
      window.toggleReview = function(productId) {

        const reviewDiv =
          document.getElementById(`review-${productId}`);

        if (!reviewDiv) return;

        if (reviewDiv.style.display === "none") {

          reviewDiv.style.display = "block";

        } else {

          reviewDiv.style.display = "none";

        }
      };

      //Getting the Average of Product Rating//
      async function loadAverageRating(productId) {

        const reviewsQuery = query(
          collection(db, "reviews"),
          where("productId", "==", productId)
        );

        const snapshot = await getDocs(reviewsQuery);

        const ratingElement =
          document.getElementById("averageRating");

        if (!ratingElement) return;

        if (snapshot.empty) {

          ratingElement.innerHTML =
            "☆☆☆☆☆ No Reviews Yet";

          return;
        }

        let totalRating = 0;

        snapshot.forEach((docSnap) => {
          totalRating += docSnap.data().rating;
        });

        const average =
          (totalRating / snapshot.size).toFixed(1);

        const stars =
          "★".repeat(Math.round(average)) +
          "☆".repeat(5 - Math.round(average));

        ratingElement.innerHTML =
          `${stars} ${average} (${snapshot.size} Reviews)`;
      }

/* ================= SELLER NOTIFICATIONS ================= */

      function loadNotifications() {
          console.log("loadNotifications() started");


          const container = document.getElementById("notificationsList");
          const badge = document.getElementById("notificationBadge");

          if (!container) return;

          onAuthStateChanged(auth, (user) => {
            console.log(user);

              if (!user) {
                  container.innerHTML = "<p>Please log in.</p>";
                  return;
              }

              const notificationsQuery = query(
                  collection(db, "notifications"),
                  where("userId","==",user.uid),
              );
              console.log("Query created");

              onSnapshot(notificationsQuery, (snapshot) => {

                  container.innerHTML = "";

                  let unreadCount = 0;

                  if (snapshot.empty) {

                      container.innerHTML = "<p>No notifications yet.</p>";

                      if (badge) {
                          badge.style.display = "none";
                      }

                      return;
                  }

                  const sortedDocs = snapshot.docs.slice().sort((a, b) => {
                      const aTime = a.data().createdAt
                          ? a.data().createdAt.toMillis()
                          : 0;
                      const bTime = b.data().createdAt
                          ? b.data().createdAt.toMillis()
                          : 0;
                      return bTime - aTime;
                  });

                  sortedDocs.forEach((docSnap) => {
                    console.log(snapshot.size);

                      const notification = docSnap.data();
                      console.log("Notification:", notification);

                      if (!notification.read) {
                          unreadCount++;
                      }

                      // Notification icon
                      let icon = "🔔";

                      switch (notification.type) {

                          case "new_order":
                              icon = "🛒";
                              break;

                          case "review":
                              icon = "⭐";
                              break;

                          case "message":
                              icon = "💬";
                              break;

                          case "delivered":
                              icon = "🚚";
                              break;

                          case "cancelled":
                              icon = "❌";
                              break;

                          case "low_stock":
                              icon = "⚠️";
                              break;
                            
                          case "order_placed":
                              icon = "✅";
                              break;

                      }

                      const date = notification.createdAt
                          ? notification.createdAt.toDate().toLocaleString()
                          : "";

                      container.innerHTML += `
                          <div
                              class="notification-card"
                              data-id="${docSnap.id}"
                              data-link="${notification.link || ''}"
                              style="
                                  cursor:pointer;
                                  background:${notification.read ? "#ffffff" : "#eef6ff"};
                                  border:1px solid #ddd;
                                  border-left:5px solid ${notification.read ? "#cccccc" : "#1E88E5"};
                                  border-radius:10px;
                                  padding:15px;
                                  margin-bottom:12px;
                                  transition:0.2s;
                              "
                          >

                              <h4 style="margin:0 0 8px 0;">
                                  ${icon} ${notification.title}
                              </h4>

                              <p style="margin:0 0 8px 0;">
                                  ${notification.message}
                              </p>

                              <small style="color:gray;">
                                  ${date}
                              </small>

                              <button
                              class="delete-notification"
                              data-id="${docSnap.id}"
                              style="
                                  margin-top:10px;
                                  background:#dc3545;
                                  color:white;
                                  border:none;
                                  padding:6px 10px;
                                  border-radius:5px;
                                  cursor:pointer;
                              ">
                              Delete
                          </button>

                          </div>
                      `;

                  });

                  // Update badge
                  if (badge) {

                      if (unreadCount > 0) {

                          badge.style.display = "inline-block";
                          badge.innerText = unreadCount;

                      } else {

                          badge.style.display = "none";

                      }

                  }

                  // Mark notification as read
           document.querySelectorAll(".notification-card").forEach(card => {

              card.addEventListener("click", async () => {

                await updateDoc(
                    doc(db, "notifications", card.dataset.id),
                    {
                        read: true
                    }
                );

                if (card.dataset.link) {

                    window.location.href = card.dataset.link;

                }

         
              });
        });

          // Delete notification
          document.querySelectorAll(".delete-notification").forEach(button => {

              button.addEventListener("click", async (e) => {

                  // Stop the notification card from opening
                  e.stopPropagation();

                  if (!confirm("Delete this notification?")) {
                      return;
                  }

                  try {

                      await deleteDoc(
                          doc(db, "notifications", button.dataset.id)
                      );

                      console.log("Notification deleted.");

                  } catch (error) {

                      console.error("Error deleting notification:", error);

                  }

              });

          });


              }, (error) => {

                  console.error("Notification Error:", error);

                  container.innerHTML =
                      "<p>Failed to load notifications.</p>";

              });

          });

      }

    //LOAD SELLER REVIEW//
    async function loadSellerReviews() {

        const container =
            document.getElementById("sellerReviewsContainer");

        if (!container || !auth.currentUser) return;

        container.innerHTML = "<p>Loading reviews...</p>";

        // Get seller's products
        const productsQuery = query(
            collection(db, "products"),
            where("sellerId", "==", auth.currentUser.uid)
        );

        const productsSnapshot =
            await getDocs(productsQuery);

        container.innerHTML = "";

        if (productsSnapshot.empty) {

            container.innerHTML =
                "<p>You have not listed any products.</p>";

            return;
        }

          let foundReviews = false;

          let totalRating = 0;
          let totalReviews = 0;

            for (const productDoc of productsSnapshot.docs) {

            const product =
                productDoc.data();

            const reviewsQuery = query(
                collection(db, "reviews"),
                where("productId", "==", productDoc.id)
            );

            const reviewsSnapshot =
                await getDocs(reviewsQuery);

            reviewsSnapshot.forEach(reviewDoc => {

                foundReviews = true;

                const review =
                    reviewDoc.data();

                totalRating += review.rating;
                totalReviews++;

                const stars =
                    "★".repeat(review.rating) +
                    "☆".repeat(5 - review.rating);

                const reviewDate =
                  review.createdAt
                      ? review.createdAt.toDate().toLocaleDateString()
                      : "";

      const productImage =
        product.images?.length
            ? product.images[0]
            : product.imageURL;

      const reviewPhotosHtml = (review.photos || []).map(p => `
        <a href="${p.url}" target="_blank" rel="noopener">
          <img src="${p.url}" style="width:90px;height:90px;object-fit:cover;border-radius:6px;margin:8px 8px 0 0;">
        </a>
      `).join("");

        container.innerHTML += `
            <div class="review-card" style="
                border:1px solid #ddd;
                border-radius:10px;
                padding:15px;
                margin-bottom:20px;
                background:#fff;
            ">

               <img
                src="${productImage}"
                class="product-img"
                width="120"
            >


                <h3>${product.name}</h3>

                <p style="font-size:20px;color:gold;">
                    ${stars}
                </p>

                <p>
                    ${escapeHtml(review.comment)}
                </p>

                <div>${reviewPhotosHtml}</div>

                <small style="color:#666;">
                    <strong>By:</strong> ${escapeHtml(review.buyerName) || "Anonymous"}
                </small>

                <br>

              <small style="color:gray;">
                  ${reviewDate}
              </small>

            </div>

                `;
            });

        }
            if (!foundReviews) {

            container.innerHTML =
                "<p>No reviews yet.</p>";

        }

          if (totalReviews > 0) {

          const averageRating =
              (totalRating / totalReviews).toFixed(1);

          document.getElementById("reviewSummary").innerHTML = `
              <h2>⭐ ${averageRating} / 5</h2>
              <p>${totalReviews} Customer Reviews</p>
          `;
      }

    }


      /* Run only on Seller Dashboard */
   /*   if (window.location.pathname.includes("seller-notifications.html")) {

        loadNotifications();

      }*/
      /* Run Notifications Page july 22 */

      if (
          window.location.pathname.includes("seller-notifications.html") ||
          window.location.pathname.includes("buyer-notifications.html")
      ) {

          loadNotifications();

      }

      //load seller review//
      if (
    window.location.pathname.includes("seller-reviews.html")
) {

    onAuthStateChanged(auth, (user) => {

        if (user) {

            loadSellerReviews();

        }

    });

}

//==========================================//
//TEMPORARY FUNCTION FOR SENDING EMAIL//
//==========================================//

/*window.sendTestEmail = async function () {

    try {

        console.log("Button clicked");

        const response = await fetch(
            "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/sendVerificationEmail",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    email: "newtonolivia542@gmail.com"
                })
            }
        );

        console.log("Response:", response);

        const result = await response.json();

        console.log(result);

        alert(result.message || result.error);

    } catch (err) {

        console.error(err);

        alert(err.message);

    }

};

document
    .getElementById("sendTestEmailBtn")
    .addEventListener("click", window.sendTestEmail);*/


// ================= PUBLIC HOMEPAGE ==08/22/26===============

document.addEventListener("DOMContentLoaded", () => {

  const productList = document.getElementById("productList");

  console.log("Homepage check:", window.location.pathname);
  console.log("productList:", productList);

  if (productList) {
    console.log("Calling loadProducts...");
    loadProducts();
  }

});