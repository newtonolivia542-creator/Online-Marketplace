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
let editingProductId = null;

// True if "Generate with AI" successfully filled the description box during
// the CURRENT upload/edit session. Used to record descriptionGeneratedByAI
// on the product -- resets on submit and on entering/leaving edit mode.
let aiGeneratedThisSession = false;

const functions = getFunctions();
//const storage = getStorage();

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
      //await fetch(
      const response = await fetch(
        "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/sendVerificationEmail",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: userCred.user.email,
            uid: userCred.user.uid,
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

        // Automatically send another verification email
        const response = await fetch(
            "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/sendVerificationEmail",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    email: userCred.user.email,
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

        if (role === "seller") {
          window.location.href = "seller dashboard.html";
        } else if (role === "buyer") {
          window.location.href = "buyer dashboard.html";
        } else if (role === "admin") {
          window.location.href = "admin.html";
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
      if (requiredRole) window.location.href = "login.html";
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

      }

    }

    //  UI
    const welcome = document.getElementById("welcome");
    if (welcome) welcome.innerText = `Logged in as: ${user.email} (${role})`;

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
      window.location.href = "login.html";
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

let stripe = null;
let elements = null;
let card = null;

if (typeof Stripe !== "undefined") {
  stripe = Stripe("pk_test_51TZMZKJP6GbymKnndtGlf6eMNL3TgXgtA5nlZB6i3noPpqmC7dwXnWHbSDMQCuNbhlgSDy6sdzUHCmqKDZGE60sf008lPcapEf");

  elements = stripe.elements();
  card = elements.create("card");
}
//OFC//
let selectedProduct = null;

const createPaymentIntentURL =
  "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/createPaymentIntent";

const verifyPaymentURL =
  "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/verifyPayment";

/* ================= SHARED CHECKOUT (BUY NOW + CART) =================
   The server (createPaymentIntent / verifyPayment) is the only thing that
   ever decides the real total or marks an order "paid". This code just
   asks the server to start a checkout, collects the card, and asks the
   server to verify the result -- it never writes orders/inventory itself. */

let currentOrderId = null;
let currentClientSecret = null;
let currentCheckoutMode = null; // "buyNow" | "cart"

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
        cartItemIds
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

    const modal = document.getElementById("checkoutModal");
    const paymentMessage = document.getElementById("payment-message");

    if (paymentMessage) paymentMessage.textContent = "";
    if (modal) modal.style.display = "block";

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
}


/* ================= LOAD PRODUCTS (BUYER) ================= */

async function loadProducts() {
  const productList = document.getElementById("productList");
  if (!productList) return;

  const snapshot = await getDocs(collection(db, "products"));
  allProducts = [];
  productList.innerHTML = "";

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
//=======DISPLAY PRODUCT FUNCTION ===========//

function displayProducts(products) {

  const productList = document.getElementById("productList");

  if (!productList) return;

  productList.innerHTML = "";

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
        document.getElementById("aiSearchInput").value;

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

    console.log("Products:", data.products);

    displayProducts(data.products);

      } catch (err) {

        console.error(err);

      }

    });

  }

const searchBtn = document.getElementById("searchBtn");
if (searchBtn) {
  searchBtn.addEventListener("click", () => {
    const term = document.getElementById("searchInput").value.toLowerCase();

    const filtered = allProducts.filter(p =>
      p.name.toLowerCase().includes(term)
    );

    displayProducts(filtered);
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

    isPayInFlight = true;
    payBtn.disabled = true;
    payBtn.textContent = "Processing...";

    try {

      const result = await stripe.confirmCardPayment(
        currentClientSecret,
        {
          payment_method: {
            card: card
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
        body: JSON.stringify({ orderId: currentOrderId })
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

    const paymentMessage = document.getElementById("payment-message");
    if (paymentMessage) paymentMessage.textContent = "";

  });

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

  const q = query(collection(db, "orders"), where("userId", "==", auth.currentUser.uid));
  const snapshot = await getDocs(q);

  orderList.innerHTML = "";

  for (const docSnap of snapshot.docs) {
    const order = docSnap.data();

    // Get product info
    const productSnap = await getDoc(doc(db, "products", order.productId));
    const productName = productSnap.exists() ? productSnap.data().name : "Unknown product";
//New Update
  const orderDate = order.createdAt
    ? new Date(order.createdAt.seconds * 1000).toLocaleString()
    : "N/A";

  const quantity = order.quantity || 1;
  const price = order.price || (productSnap.exists() ? productSnap.data().price : 0);
  const total = price * quantity;

  const product = productSnap.exists() ? productSnap.data() : {};
  const image = product.images?.[0] || product.imageURL || "";

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

  orderList.innerHTML += `
   <div
    id="order-${docSnap.id}"
    class="order-details"
  >
      <h3>${productName}</h3>
      <img src="${image}" class="product-img" style="width: 200px;">

      <p><strong>Date Ordered:</strong> ${orderDate}</p>
      <p><strong>Quantity:</strong> ${quantity}</p>
      <p><strong>Total:</strong> $${total}</p>

      <p class="order-status status-${order.status}">
        <strong>Status:</strong> ${order.status}
      </p>

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
      
                <p>${reviewData.comment}</p>
              </div>
            `
            : `
              <button onclick="window.location.href='reviews.html?productId=${order.productId}'">
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

  onSnapshot(q, (snapshot) => {
    sellerProducts.innerHTML = "";

    snapshot.forEach(docSnap => {
      const product = docSnap.data();

     // if ((product.quantity || 0) <= 0) return;
    const quantity =
      product.quantity !== undefined
        ? product.quantity
        : 1;

    if (quantity <= 0) return;

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
    });
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

  const q = query(collection(db, "orders"), where("sellerId", "==", auth.currentUser.uid));
  const snapshot = await getDocs(q);

  sellerOrders.innerHTML = "";


      //NEW FUNCTION FOR IT TO INCLUDE BUYER NAME, COLOR, AND QUATITY ORDER//
      for (const docSnap of snapshot.docs) {

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
    
        // Get product info
        const productSnap = await getDoc(
            doc(db, "products", order.productId)
        );
        //New block Again//
        let productName = "Unknown Product";
        let productImage = "";
        let productPrice = 0;
        
        if (productSnap.exists()) {
        
            const product = productSnap.data();
        
            productName = product.name || "Unknown Product";
        
            productImage =
                product.images?.[0] ||
                product.imageURL ||
                "";
        
            productPrice = product.price || 0;
        }        

    let shipBtn = "";
    let deliverBtn = "";

    // PENDING → show both
    if (order.status === "pending") {
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
    if (order.status === "pending") statusColor = "orange";
    else if (order.status === "shipped") statusColor = "blue";
    else if (order.status === "delivered") statusColor = "green";

    const quantity = order.quantity || 1;

    const total = productPrice * quantity;

    // FINAL UI
    sellerOrders.innerHTML += `
    <li style="display:flex; align-items:center; gap:15px; margin-bottom:15px;">
    
        <img src="${productImage}"
             style="width:60px;height:60px;object-fit:cover;border-radius:8px;">
    
        <div>
    
            <p><strong>Buyer:</strong> ${buyerName}</p>
    
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
    
            ${deliveryInfo}
    
            <br>
    
            ${shipBtn}
    
            ${deliverBtn}
    
        </div>
    
    </li>
    `;
  }
}

// ================= SHIP ORDER =================
window.markShipped = async (orderId) => {
  try {
    //july 22, new try//
    const orderSnap = await getDoc(doc(db, "orders", orderId));

    if (!orderSnap.exists()) {
        alert("Order not found.");
        return;
    }

    const order = orderSnap.data();

    const productSnap = await getDoc(
    doc(db, "products", order.productId)
    );

    const productName = productSnap.exists()
        ? productSnap.data().name
        : "Unknown Product";
    //ends above//

    await updateDoc(doc(db, "orders", orderId), {
      status: "shipped",
      shippedAt: new Date() // save timestamp
    });
    //new one too july 22//

    await addDoc(collection(db, "notifications"), {

    userId: order.userId,

    type: "shipped",

    title: "Order Shipped",

    message: `Your order for "${productName}" has been shipped.`,

    link: "order.html",

    read: false,

    createdAt: serverTimestamp()

});

    alert("Order marked as shipped");
    loadSellerOrders();

  } catch (err) {
    alert("Failed to update order: " + err.message);
  }
};

// ================= DELIVER ORDER =================
window.markDelivered = async (orderId) => {
  try {
    //NEW JUY 22//
    const orderSnap = await getDoc(
    doc(db, "orders", orderId)
    );

    if (!orderSnap.exists()) {
        alert("Order not found.");
        return;
    }

    const order = orderSnap.data();

    const productSnap = await getDoc(
        doc(db, "products", order.productId)
    );

    const productName = productSnap.exists()
        ? productSnap.data().name
        : "Unknown Product";
    //ENDS ABOVE//

    await updateDoc(doc(db, "orders", orderId), {
      status: "delivered",
      deliveredAt: new Date() // save timestamp
    });
    //NEW ONE TOO JULY 22//

  await addDoc(collection(db, "notifications"), {

    userId: order.userId,

    type: "delivered",

    title: "Order Delivered",

    message: `Your order for "${productName}" has been delivered. Please leave a review.`,

    link: `order.html?orderId=${orderId}`,

    read: false,

    createdAt: serverTimestamp()

});
//ENDS ABOVE//

    alert("Order marked as delivered");
    loadSellerOrders();

  } catch (err) {
    alert("Failed to update order: " + err.message);
  }
};

/*============SOLD ITEMS HISTORY ===========*/
async function loadSoldProducts() {
  const soldList = document.getElementById("soldProducts");
  if (!soldList || !auth.currentUser) return;

  const q = query(
    collection(db, "products"),
    where("sellerId", "==", auth.currentUser.uid)
  );

  const snapshot = await getDocs(q);
  soldList.innerHTML = "";

  snapshot.forEach(docSnap => {
    const product = docSnap.data();
    console.log(product);
    console.log(product.colors);
    console.log(product.sizes);

    // Only sold products
    //if (product.sold !== true) return;
    if ((product.quantity || 0) > 0) return;

    const image = product.images?.[0] || product.imageURL || "";

    soldList.innerHTML += `
      <li style="
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 10px;
      ">
        <img src="${image}" style="
          width: 50px;
          height: 50px;
          object-fit: cover;
          border-radius: 6px;
        " />

        <div>
          <strong>${product.name}</strong><br>
          $${product.price}
        </div>
      </li>
    `;
  });
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
async function sendMessage(productId, otherUserId, inputId, existingConvoId = null) {

    const input = document.getElementById(inputId);
    const text = input.value.trim();

    if (!text) return;

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

        // Save message
      await addDoc(collection(db, "messages"), {

          conversationId,
          productId,

          senderId: user.uid,
          senderName: senderName,

          receiverId: otherUserId,

          text,

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

      let messagePage = "messages.html"; // Default

      if (receiverDoc.exists()) {

          const receiverData = receiverDoc.data();

          if (receiverData.role === "seller") {
              messagePage = "seller-messages.html";
          } else if (receiverData.role === "buyer") {
              messagePage = "buyer-messages.html";
          }

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
window.handleReply = async function(convoId, receiverId, productId, textareaId) {
  const input = document.getElementById(textareaId);
  const text = input.value.trim();

  if (!text) {
    alert("Reply cannot be empty");
    return;
  }

  // PASS convoId HERE
  await sendMessage(productId, receiverId, textareaId, convoId);

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


async function loadSellerMessages() {
  const msgList = document.getElementById("sellerMessages");

  if (!msgList || !auth.currentUser) return;

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

  msgList.innerHTML = "";

  const conversations = {};

  snapshot.forEach(docSnap => {
    const msg = docSnap.data();

    if (
      msg.receiverId !== auth.currentUser.uid &&
      msg.senderId !== auth.currentUser.uid
    ) {
      return;
    }

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

  // Render conversations
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

    

    let chatHTML = "";

    visibleMsgs.forEach(msg => {

      const isMe =
        msg.senderId === auth.currentUser.uid;

      const displayName =
        isMe
          ? "You"
          : (msg.senderName || "Unknown User");

      const time = msg.createdAt
        ? new Date(
            msg.createdAt.seconds * 1000
          ).toLocaleString()
        : "";

      chatHTML += `
        <div style="
          background:${isMe ? '#d1f7c4' : '#f1f1f1'};
          text-align:${isMe ? 'right' : 'left'};
          margin:8px 0;
          padding:12px;
          border-radius:12px;
        ">

          <div style="
            font-weight:bold;
            margin-bottom:6px;
          ">
            ${displayName}
          </div>

          <div>
            ${msg.text}

            <div class="message-status">

            ${msg.isRead
                ? "💙 Read"

                : msg.delivered
                    ? "✔✔ Delivered"

                    : "✔ Sent"}

          </div>

          <small style="
            color:gray;
            font-size:10px;
          ">
            ${time}
          </small>

        </div>
      `;
    });

    const productImage =
      product.images?.[0] ||
      product.imageURL ||
      "";

    msgList.innerHTML += `
      <li style="
        margin-bottom:20px;
        border:1px solid #ccc;
        padding:10px;
      ">

        <img
          src="${productImage}"
          width="80"
        ><br>

        <strong>
          ${product.name || "Unknown Product"}
        </strong>

        <div class="chat-box">
          ${chatHTML}
        </div>

        <textarea
          id="seller-${convoId}"
          placeholder="Reply..."
        ></textarea><br>

        <button onclick="
          handleReply(
            '${convoId}',
            '${getOtherUserId(visibleMsgs)}',
            '${firstMsg.productId}',
            'seller-${convoId}'
          )
        ">
          Reply
        </button>

        <button
          onclick="
            deleteChat(
              '${convoId}',
              '${firstMsg.productId}'
            )
          "
          style="
            background:red;
            color:white;
            margin-top:10px;
          "
        >
          Delete Chat
        </button>

      </li>
    `;
  }
}


/* ================= LOAD BUYER MESSAGES ================= */

async function loadBuyerMessages() {
  const msgList = document.getElementById("buyerMessages");
  if (!msgList || !auth.currentUser) return;
//Line that I revert//
  const snapshot = await getDocs(collection(db, "messages"));
  msgList.innerHTML = "";

  const conversations = {};

  // ONLY ONE LOOP (correct one)
  snapshot.forEach(docSnap => {
    const msg = docSnap.data();
    console.log(
      "DOC:",
      docSnap.id,
      msg.conversationId,
      msg.productId,
      msg.text
    );
    if (!msg.productId) return;

    if (
      msg.receiverId !== auth.currentUser.uid &&
      msg.senderId !== auth.currentUser.uid
    ) return;

    // ALWAYS recompute conversationId
    const convoId = msg.conversationId;

    if (!conversations[convoId]) conversations[convoId] = [];

    conversations[convoId].push(msg);
  });

  //sorting the conversation//
  const sortedConversations = Object.entries(conversations)
  .sort(([, msgsA], [, msgsB]) => {

    const latestA = Math.max(
      ...msgsA.map(msg => msg.createdAt?.seconds || 0)
    );

    const latestB = Math.max(
      ...msgsB.map(msg => msg.createdAt?.seconds || 0)
    );

    return latestB - latestA; // newest first
  });

  // render
  /*for (const convoId in conversations) {
  
    const msgs = conversations[convoId].filter(
      msg => !msg.deletedBy?.includes(auth.currentUser.uid)
    );*/
  // render
for (const [convoId, msgsArray] of sortedConversations) {

  const msgs = msgsArray.filter(
    msg => !msg.deletedBy?.includes(auth.currentUser.uid)
  );

  if (msgs.length === 0) continue;

    if (msgs.length === 0) continue;

    msgs.sort((a, b) => {
      const getTime = (msg) => {
        if (!msg.createdAt) return 0;
        if (msg.createdAt.seconds) return msg.createdAt.seconds;
        if (msg.createdAt instanceof Date) return msg.createdAt.getTime() / 1000;
        return 0;
      };

      return getTime(a) - getTime(b);
    });

    const firstMsg = msgs[0];

    //const productDoc = await getDoc(doc(db, "products", firstMsg.productId));
    //const product = productDoc.exists() ? productDoc.data() : {};
    let product = {};

     /* if (firstMsg.productId) {
        try {
        const productDoc = await getDoc(doc(db, "products", firstMsg.productId));
        if (productDoc.exists()) {
          product = productDoc.data();
        }
      } catch (err) {
        console.warn("Bad productId:", firstMsg.productId);
      }
    }*/
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


    let chatHTML = "";

    msgs.forEach(msg => {
      if (msg.deletedBy?.includes(auth.currentUser.uid)) return;

        const isMe = msg.senderId === auth.currentUser.uid;

        const displayName =
          isMe
            ? "You"
            : (msg.senderName || "Unknown User");

        const time = msg.createdAt
          ? new Date(msg.createdAt.seconds * 1000).toLocaleString()
          : "";

          
chatHTML += `
  <div style="
    background:${isMe ? '#d1f7c4' : '#f1f1f1'};
    text-align:${isMe ? 'right' : 'left'};
    margin:8px 0;
    padding:12px;
    border-radius:12px;
  ">

    <div style="
      font-weight:bold;
      margin-bottom:6px;
    ">
      ${displayName}
    </div>

    <div>
      ${msg.text}
    </div>

    <small style="
      color:gray;
      font-size:10px;
    ">
      ${time}
    </small>

  </div>
`;
});

    const productImage = product.images?.[0] || product.imageURL || "";

    msgList.innerHTML += `
      <li style="margin-bottom:20px; border:1px solid #ccc; padding:10px;">
        <img src="${productImage}" width="80"><br>
        <strong>${product.name || "Unknown Product"}</strong>

        <div class="chat-box">
          ${chatHTML}</div>
 
        <textarea id="buyer-${convoId}" placeholder="Reply..."></textarea><br>

        <button onclick="handleReply('${convoId}', '${getOtherUserId(msgs)}', '${firstMsg.productId}', 'buyer-${convoId}')">
          Reply
        </button>

        <button onclick="deleteChat('${convoId}', '${firstMsg.productId}')"
          style="background:red; color:white; margin-top:10px;">
          Delete Chat
        </button>
      </li>
    `;
  }
}


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

    reviewsContainer.innerHTML += `
      <div class="review-card">

        <h4>${stars}</h4>

        <p>${review.comment}</p>

        <small>
          By ${review.buyerName || "Anonymous"}
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

    await addDoc(
      collection(db, "reviews"),
      {
        productId,

        productName: product.name,

        sellerId: product.sellerId,

        buyerId: auth.currentUser.uid,

        buyerName:
          userData.fullName ||
          auth.currentUser.displayName ||
          auth.currentUser.email,

        rating,

        comment,

        createdAt: serverTimestamp()
      }
    );

   /* alert("Review submitted!");

    window.location.href = "order.html";

  });

}*/

    // ===============================
    // CREATE NOTIFICATION FOR SELLER
    // ===============================

    /*console.log("Creating review notification...");

    const productSnap = await getDoc(
      doc(db, "products", productId)
    );

    if (productSnap.exists()) {

      const product = productSnap.data();*/

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

                  snapshot.forEach((docSnap) => {
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
                    ${review.comment}
                </p>

                <small style="color:#666;">
                    <strong>By:</strong> ${review.buyerName || "Anonymous"}
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