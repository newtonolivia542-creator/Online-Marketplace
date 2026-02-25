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
  addDoc,
  collection,
  query,
  where,
  getDocs,
  deleteDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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

    // 🔐 PAGE PROTECTION
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
    }

    if (role === "seller") {
      loadSellerProducts();
      loadSellerOrders();
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

const productForm = document.getElementById("productForm");
if (productForm) {
  productForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const productData = {
      name: document.getElementById("pName").value,
      price: Number(document.getElementById("pPrice").value),
      description: document.getElementById("pDesc").value,
      sellerId: auth.currentUser.uid,
      createdAt: new Date(),
      sold: false
    };

    try {
      await addDoc(collection(db, "products"), productData);
      alert("Product posted!");
      productForm.reset();
      loadSellerProducts();
    } catch (err) {
      alert("Upload failed: " + err.message);
    }
  });
}

/* ================= LOAD PRODUCTS (BUYER) ================= */

async function loadProducts() {
  const productList = document.getElementById("productList");
  if (!productList) return;

  const q = query(collection(db, "products"), where("sold", "==", false));
  const snapshot = await getDocs(q);

  productList.innerHTML = "";

  snapshot.forEach(docSnap => {
    const product = docSnap.data();

    productList.innerHTML += `
      <div>
        <h3>${product.name}</h3>
        <p>$${product.price}</p>
        <p>${product.description}</p>
        <button type="button" class="buyBtn"
        data-id="${docSnap.id}"
        data-seller="${product.sellerId}">
          Buy
        </button>
      </div>
      <hr>
    `;
  });

  setupBuyButtons();
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

/* ================= SELLER PRODUCTS ================= */
async function loadSellerProducts() {
  const myProducts = document.getElementById("myProducts");
  if (!myProducts || !auth.currentUser) return;

  const q = query(collection(db, "products"), where("sellerId", "==", auth.currentUser.uid));
  const snapshot = await getDocs(q);
  myProducts.innerHTML = "";
  snapshot.forEach(docSnap => {
    const product = docSnap.data();

    // ✅ Only show products that are NOT sold
    if (product.sold === true) return;

    myProducts.innerHTML += `
      <li>
        ${product.name} - $${product.price}
        <button onclick="deleteProduct('${docSnap.id}')">Delete</button>
      </li>
    `;
  });
}

window.deleteProduct = async (productId) => {
  await deleteDoc(doc(db, "products", productId));
  alert("Product deleted");
  loadSellerProducts();
};

/* ================= SELLER ORDERS ================= */
async function loadSellerOrders() {
  const sellerOrders = document.getElementById("sellerOrders");
  if (!sellerOrders || !auth.currentUser) return;

  const q = query(collection(db, "orders"), where("sellerId", "==", auth.currentUser.uid));
  const snapshot = await getDocs(q);

  sellerOrders.innerHTML = "";
  snapshot.forEach(docSnap => {
    const order = docSnap.data();
    sellerOrders.innerHTML += `
      <li>
        Order ${docSnap.id} |
        Status: ${order.status}
        <button onclick="markShipped('${docSnap.id}')">Ship</button>
        <button onclick="markDelivered('${docSnap.id}')">Deliver</button>
      </li>
    `;
  });
};

window.markShipped = async (orderId) => {
  await updateDoc(doc(db, "orders", orderId), { status: "shipped" });
  loadSellerOrders();
};

window.markDelivered = async (orderId) => {
  await updateDoc(doc(db, "orders", orderId), { status: "delivered" });
  loadSellerOrders();
};

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