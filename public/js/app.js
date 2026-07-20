import { sendPasswordResetEmail } from
"https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { auth, db } from "./firebase.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import {
  createUserWithEmailAndPassword,
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
      await setDoc(doc(db, "users", userCred.user.uid), {
        fullName,
        email,
        role,
        createdAt: new Date(), // account creation date
        lastLogin: new Date(),  // first login = signup
        status: "active"
      });
      if (role === "seller") {
        window.location.href = "seller dashboard.html";
      } else if (role === "buyer") {
        window.location.href = "buyer dashboard.html";
      } else if (role === "admin") {
        window.location.href = "admin.html";
      }

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
onAuthStateChanged(auth, async (user) => {
  const currentPage = window.location.pathname;

  if (user) {
    const userDoc = await getDoc(doc(db, "users", user.uid));
    if (!userDoc.exists()) return;

    const role = userDoc.data().role;
//looking for user without a fullname//
    const userData = userDoc.data();

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

    // PAGE PROTECTION
    if (currentPage.includes("seller dashboard.html") && role !== "seller") {
      window.location.href = "buyer dashboard.html";
      return;
    }

    if (currentPage.includes("buyer dashboard.html") && role !== "buyer") {
      window.location.href = "seller dashboard.html";
      return;
    }

    if (currentPage.includes("admin.html") && role !== "admin") {
      window.location.href = "index.html";
      return;
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
    }

    if (role === "seller") {
      // First-time seller setup
      if (!userDoc.data().storeName &&
          !window.location.pathname.includes("seller-profile.html")) {

        window.location.href = "seller-profile.html";
        return;
      }

      loadSellerProducts();
      loadSellerOrders();
      loadSoldProducts();
      loadSellerMessages();
      loadStoreProfile();
    }

  } else {
    //  NOT LOGGED IN
    if (
      currentPage.includes("buyer dashboard.html") ||
      currentPage.includes("seller dashboard.html") ||
      currentPage.includes("admin.html")
    ) {
      window.location.href = "index.html";
    }
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

        const storageRef = ref(storage, `products/${Date.now()}_${i}_${file.name}`);
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
      await updateDoc(doc(db, "products", editingProductId), productData);

      alert("Product updated!");
      editingProductId = null;

      document.querySelector("#productForm button").innerText = "Post to Marketplace";
    }

    // ADD NEW PRODUCT
    else {
      await addDoc(collection(db, "products"), productData);
      alert("Product posted!");
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

const functionURL =
  "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/createPaymentIntent";


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

function displayProducts(products) {
  const productList = document.getElementById("productList");
  productList.innerHTML = "";

  products.forEach(product => {
    const card = document.createElement("div");
    card.classList.add("product-card");

    card.innerHTML = `
      <img src="${product.images ? product.images[0] : product.imageURL}" class="product-img" style="cursor:pointer;">
      <h3>${product.name}</h3>
      <p class="price">$${product.price}</p>
      <p class="desc">${product.description}</p>

      <button class="buyBtn"
        data-id="${product.id}"
        data-seller="${product.sellerId}">
        Buy
      </button>

      <button class="addCartBtn" data-id="${product.id}">
        Add to Cart
      </button>
    `;

    //  CLICK IMAGE INSTEAD OF BUTTON //
    card.querySelector("img").addEventListener("click", () => {
      window.location.href = `product-detail.html?id=${product.id}`;
    });

    productList.appendChild(card);
  });

  setupBuyButtons();
  setupAddCartButtons();
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

function setupBuyButtons() {

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

}
/* =============setupAddCartButtons ==========*/

function setupAddCartButtons() {
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
}

/* ================= STRIPE PAYMENT ================= */

const payBtn = document.getElementById("payBtn");

if(payBtn){

  payBtn.addEventListener("click", async () => {

    try {

      payBtn.disabled = true;
      payBtn.textContent = "Processing...";

      const response = await fetch(functionURL, {
        method: "POST"
      });

      const data = await response.json();

      const result = await stripe.confirmCardPayment(
        data.clientSecret,
        {
          payment_method: {
            card: card
          }
        }
      );

      if(result.error){

        document.getElementById("payment-message").textContent =
          result.error.message;

        payBtn.disabled = false;
        payBtn.textContent = "Pay Now";

      } else {

        if(result.paymentIntent.status === "succeeded"){

          await addDoc(collection(db, "orders"), {

            productId: selectedProduct.id,
            sellerId: selectedProduct.sellerId,
            userId: auth.currentUser.uid,
            status: "paid",
            createdAt: new Date()

          });

          await updateDoc(
            doc(db, "products", selectedProduct.id),
            {
              sold: true
            }
          );

          document.getElementById("payment-message").textContent =
            "Payment Successful!";

          document.getElementById("checkoutModal").style.display = "none";

          loadProducts();

          if(typeof loadMyOrders === "function"){
            loadMyOrders();
          }

        }

      }

    } catch(error){

      console.log(error);

      document.getElementById("payment-message").textContent =
        error.message;

    }

  });

}

/* ================= CLOSE CHECKOUT MODAL ================= */

const closeCheckout = document.getElementById("closeCheckout");

if(closeCheckout){

  closeCheckout.addEventListener("click", () => {

    document.getElementById("checkoutModal").style.display = "none";

  });

}


/* ================= CUSTOMER ORDERS ================= */
async function loadMyOrders() {
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
  <div class="order-details">
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

  </div>
`;
}
}

/* ================= LOAD SELLER PRODUCTS ================= */

function loadSellerProducts() {
  const sellerProducts = document.getElementById("sellerProducts");
  if (!sellerProducts || !auth.currentUser) return;

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

async function loadCart() {
  const cartDiv = document.getElementById("cartItems");
  if (!cartDiv || !auth.currentUser) return;

  const q = query(collection(db, "carts"), where("userId", "==", auth.currentUser.uid));
  const snapshot = await getDocs(q);

  cartDiv.innerHTML = "";

  for (const docSnap of snapshot.docs) {
    const cartItem = docSnap.data();

    // Get product details
    const productSnap = await getDoc(doc(db, "products", cartItem.productId));
    if (!productSnap.exists()) continue;
    const product = productSnap.data();

    cartDiv.innerHTML += `
      <div class="cart-item">
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

    const q = query(
      collection(db, "carts"),
      where("userId", "==", auth.currentUser.uid)
    );

    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      alert("Your cart is empty!");
      return;
    }

    for (const docSnap of snapshot.docs) {

      const cartItem = docSnap.data();

      // Get product info
      const productSnap = await getDoc(
        doc(db, "products", cartItem.productId)
      );

      if (!productSnap.exists()) continue;

      const product = productSnap.data();

      // Create order
      await addDoc(collection(db, "orders"), {

        productId: cartItem.productId,

        sellerId: product.sellerId,

        userId: auth.currentUser.uid,

        quantity: cartItem.quantity,

        color: cartItem.color || null,

        size: cartItem.size || null,

        price: product.price,

        status: "pending",

        createdAt: serverTimestamp()

      });

    // =========================
    // CREATE SELLER NOTIFICATION
    // =========================

    await addDoc(collection(db, "notifications"), {

      userId: product.sellerId,

      type: "new_order",

      title: "New Order Received",

      message: `${product.name} was purchased.`,

      link: `seller-orders.html?orderId=${orderRef.id}`,

      read: false,

      createdAt: serverTimestamp()

    });

      // Mark product sold
      /*await updateDoc(
        doc(db, "products", cartItem.productId),
        {
          sold: true
        }
      );*/
    // Update inventory quantity

    const currentQuantity =
      product.quantity ?? 1;

    const newQuantity =
      currentQuantity - cartItem.quantity;

    await updateDoc(
      doc(db, "products", cartItem.productId),
    {
        quantity: Math.max(0, newQuantity)
    }
  );

    // ===========================
    // LOW INVENTORY NOTIFICATION
    // ===========================

  if (newQuantity <= 5 && newQuantity > 0) {

    await addDoc(collection(db, "notifications"), {

      userId: product.sellerId,

      type: "low_stock",

      title: "Low Inventory",

      message: `Only ${newQuantity} ${product.name} left in stock.`,

      link:`seller-dashboard.html?productId=${productId}`,

      read: false,

      createdAt: serverTimestamp()

    });

    }



      // Remove from cart
      await deleteDoc(
        doc(db, "carts", docSnap.id)
      );
    };

    alert("Checkout successful!");

    loadCart();

    if (typeof loadProducts === "function") {
      loadProducts();
    }

    if (typeof loadMyOrders === "function") {
      loadMyOrders();
    }

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
    await updateDoc(doc(db, "orders", orderId), {
      status: "shipped",
      shippedAt: new Date() // save timestamp
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
    await updateDoc(doc(db, "orders", orderId), {
      status: "delivered",
      deliveredAt: new Date() // save timestamp
    });

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

const resetBtn = document.getElementById("resetPasswordBtn");

if (resetBtn) {
  resetBtn.addEventListener("click", async () => {
    const email = document.getElementById("email").value;

    if (!email) {
      alert("Please enter your email first.");
      return;
    }

    try {
      await sendPasswordResetEmail(auth, email);
      alert("Password reset email sent. Check your inbox.");
    } catch (err) {
      alert(err.message);
    }
  });
}

/* ================= CORE MESSAGING ================= */

// Always generate SAME conversation ID
function getConversationId(user1, user2, productId) {
  const sortedUsers = [user1, user2].sort(); // ONLY sort users
  return `${sortedUsers[0]}_${sortedUsers[1]}_${productId}`;
}

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

  // USE EXISTING conversationId IF AVAILABLE
  const conversationId =
    existingConvoId ||
    getConversationId(user.uid, otherUserId, productId);

  
    try {

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
      // ⬇️ PUT THE NOTIFICATION CODE HERE

    const senderName =
        userData.fullName ||
        user.displayName ||
        user.email;

    await addDoc(collection(db, "notifications"), {

        userId: otherUserId,

        type: "message",

        title: "New Message",

        message: `${senderName} sent you a message.`,

        link: `messages.html?conversationId=${conversationId}`,

        read: false,

        createdAt: serverTimestamp()

    });

    input.value = "";
    console.log("Message sent in convo:", conversationId);

  } catch (error) {
    console.error("Error sending message:", error);
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

  const q = query(
    collection(db, "messages"),
    orderBy("createdAt", "asc")
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

    await addDoc(
      collection(db, "reviews"),
      {
        productId,

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

    console.log("sendMessage() is running");

    const productSnap = await getDoc(
      doc(db, "products", productId)
    );

    if (productSnap.exists()) {

      const product = productSnap.data();

    console.log("Creating message notification...");
    console.log("Current User:", user.uid);
    console.log("Receiver:", otherUserId);
    console.log("Conversation:", conversationId);
    console.log("Product:", productId);

      

    await addDoc(collection(db, "notifications"), {

        userId: product.sellerId,

        type: "review",

        title: "New Review",

        message: `${product.name} received a new review.`,

        link: `reviews.html?productId=${productId}`,

        read: false,

        createdAt: serverTimestamp()

    });

    console.log("Notification saved successfully.");
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

              }, (error) => {

                  console.error("Notification Error:", error);

                  container.innerHTML =
                      "<p>Failed to load notifications.</p>";

              });

          });

      }


      /* Run only on Seller Dashboard */
      if (window.location.pathname.includes("seller-notifications.html")) {

        loadNotifications();

      }