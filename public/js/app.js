import { sendPasswordResetEmail } from 
"https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { auth, db } from "./firebase.js";
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
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

let allProducts = [];

//const storage = getStorage();

/* ================= REGISTER ================= */
const registerForm = document.getElementById("registerForm");
if (registerForm) {
  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("email").value;
    const password = document.getElementById("password").value;
    const role = document.getElementById("role").value;

    try {
      const userCred = await createUserWithEmailAndPassword(auth, email, password);
      await setDoc(doc(db, "users", userCred.user.uid), { email, role });

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

    // 👋 UI
    const welcome = document.getElementById("welcome");
    if (welcome) welcome.innerText = `Logged in as: ${user.email} (${role})`;

    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) logoutBtn.style.display = "block";

    // 🚀 LOAD FEATURES
    if (role === "buyer") {
      loadProducts();
      loadMyOrders();
      loadCart();
    }

    if (role === "seller") {
      loadSellerProducts();
      loadSellerOrders();
      loadSoldProducts();
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

    const fileInput = document.getElementById("pImage");
    const file = fileInput.files[0];

    if (!file) {
      alert("Please choose an image");
      return;
    }

    const storageRef = ref(storage, `products/${Date.now()}_${file.name}`);
    await uploadBytes(storageRef, file);
    const imageURL = await getDownloadURL(storageRef);

    const productData = {
      name: document.getElementById("pName").value,
      price: Number(document.getElementById("pPrice").value),
      description: document.getElementById("pDesc").value,
      imageURL: imageURL,
      sellerId: auth.currentUser.uid,
      category: document.getElementById("pCategory").value,
      createdAt: new Date()
    };

    await addDoc(collection(db, "products"), productData);

    alert("Product posted!");
    productForm.reset();

 
  });
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


/* ================= LOAD PRODUCTS (BUYER) ================= */

async function loadProducts() {
  const productList = document.getElementById("productList");
  if (!productList) return;

  const snapshot = await getDocs(collection(db, "products"));
  allProducts = [];
  productList.innerHTML = "";

  snapshot.forEach(docSnap => {
    const product = docSnap.data();

    if (product.sold === true) return;

    allProducts.push({ id: docSnap.id, ...product });
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
      <img src="${product.imageURL}" class="product-img" style="cursor:pointer;">
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

    // 🔥 CLICK IMAGE INSTEAD OF BUTTON
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

/* ================= BUY PRODUCT ================= */
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

    orderList.innerHTML += `
      <li>
        Product: <strong>${productName}</strong> |
        Status: <strong>${order.status}</strong>
        ${order.status === "pending" ? 
          `<button onclick="cancelOrder('${docSnap.id}', '${order.productId}')">Cancel</button>` 
          : ""}
      </li>
    `;
  }
}

/* ================= LOAD SELLER PRODUCTS ================= */

function loadSellerProducts() {
  const myProducts = document.getElementById("myProducts");
  if (!myProducts || !auth.currentUser) return;

  const q = query(
    collection(db, "products"),
    where("sellerId", "==", auth.currentUser.uid)
  );

  onSnapshot(q, (snapshot) => {
    myProducts.innerHTML = "";

    snapshot.forEach(docSnap => {
      const product = docSnap.data();

      // show ONLY active (not sold)
      if (product.sold === true) return;

      myProducts.innerHTML += `
        <li>
          <strong>${product.name}</strong> — $${product.price}<br>
          ${product.description}<br><br>
          <img src="${product.imageURL}" width="120"><br><br>
          <button onclick="deleteProduct('${docSnap.id}')">Delete</button>
        </li>
        <hr>
      `;
    });
  });
}

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


if (window.location.pathname.includes("product-detail.html")) {
  // ===== PRODUCT DETAIL LOGIC START =====

  const urlParams = new URLSearchParams(window.location.search);
  const productId = urlParams.get("id"); // get product id from query string

  async function loadProduct() {
    const docSnap = await getDoc(doc(db, "products", productId));
    if (!docSnap.exists()) return alert("Product not found");

    const product = docSnap.data();
    document.getElementById("detailImage").src = product.imageURL;
    document.getElementById("detailName").innerText = product.name;
    document.getElementById("detailDesc").innerText = product.description;
    document.getElementById("detailPrice").innerText = product.price;
  }

  loadProduct();

  const addToCartBtn = document.getElementById("addToCartBtn");
  if (addToCartBtn) {
    addToCartBtn.addEventListener("click", async () => {
      const quantity = Number(document.getElementById("detailQuantity").value);
      if (quantity < 1) return alert("Quantity must be at least 1");

      try {
        await addDoc(collection(db, "carts"), {
          productId: productId,
          userId: auth.currentUser.uid,
          quantity: quantity,
          addedAt: new Date()
        });
        alert("Product added to cart!");
        window.location.href = "cart.html"; // redirect to cart page
      } catch (err) {
        alert("Failed to add to cart: " + err.message);
      }
    });
  }

  // ===== PRODUCT DETAIL LOGIC END =====
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

    await deleteDoc(doc(db, "orders", orderId));
    loadCart();
  };

  loadCart();
}

/* ================= LOAD CART ITEMS (BUYER) ================= */
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
        <img src="${product.imageURL}" width="100">
        <p>${product.name}</p>
        <p>Price: $${product.price}</p>
        <p>Quantity: ${cartItem.quantity}</p>
        <button onclick="removeFromCart('${docSnap.id}')">Remove</button>
      </div>
      <hr>
    `;
  }
}

// Remove from cart
window.removeFromCart = async (cartItems) => {
  await deleteDoc(doc(db, "carts", cartItems));
  loadCart(); // refresh the cart
};


/* ===========CHECKOUT BUTTON ============= */

const checkoutBtn = document.getElementById("checkoutBtn");
if (checkoutBtn) {
  checkoutBtn.addEventListener("click", async () => {
    const q = query(collection(db, "carts"), where("userId", "==", auth.currentUser.uid));
    const snapshot = await getDocs(q);

    if (snapshot.empty) return alert("Your cart is empty!");

    for (const docSnap of snapshot.docs) {
      const cartItem = docSnap.data();

      // Create order
      await addDoc(collection(db, "orders"), {
        productId: cartItem.productId,
        userId: auth.currentUser.uid,
        quantity: cartItem.quantity,
        status: "pending",
        createdAt: new Date()
      });

      // Mark product as sold
      await updateDoc(doc(db, "products", cartItem.productId), {
        sold: true
      });

      // Remove from cart
      await deleteDoc(doc(db, "carts", docSnap.id));
    }

    alert("Checkout successful!");
    loadCart();   // refresh cart
    loadProducts(); // refresh buyer dashboard
    loadMyOrders(); // refresh orders page
  });
}



/* ================= SELLER ORDERS ================= */
async function loadSellerOrders() {
  const sellerOrders = document.getElementById("sellerOrders");
  if (!sellerOrders || !auth.currentUser) return;

  const q = query(collection(db, "orders"), where("sellerId", "==", auth.currentUser.uid));
  const snapshot = await getDocs(q);

  sellerOrders.innerHTML = "";

  for (const docSnap of snapshot.docs) {
    const order = docSnap.data();

    // get product info
    const productSnap = await getDoc(doc(db, "products", order.productId));
    const productName = productSnap.exists() ? productSnap.data().name : "Unknown product";

    sellerOrders.innerHTML += `
      <li>
        <strong>${productName}</strong> |
        Status: <strong>${order.status}</strong>
        <button onclick="markShipped('${docSnap.id}')">Ship</button>
        <button onclick="markDelivered('${docSnap.id}')">Deliver</button>
      </li>
    `;
  }
}

window.markShipped = async (orderId) => {
  await updateDoc(doc(db, "orders", orderId), { status: "shipped" });
  loadSellerOrders();
};

window.markDelivered = async (orderId) => {
  await updateDoc(doc(db, "orders", orderId), { status: "delivered" });
  loadSellerOrders();
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

    // Only sold products
    if (product.sold !== true) return;

    soldList.innerHTML += `
      <li>
        ${product.name} — $${product.price}
      </li>
    `;
  });
}

/*=======CANCEL ORDER ========= */
window.cancelOrder = async (orderId, productId) => {
  const confirmCancel = confirm("Are you sure you want to cancel this order?");
  if (!confirmCancel) return;

  try {
    // delete order
    await deleteDoc(doc(db, "orders", orderId));

    // mark product as not sold again
    await updateDoc(doc(db, "products", productId), {
      sold: false
    });

    alert("Order cancelled.");
    loadMyOrders();
    loadProducts(); // refresh store list
  } catch (err) {
    alert("Cancel failed: " + err.message);
  }
};

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