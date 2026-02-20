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
  collection
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/* REGISTER */
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
      window.location.href = (role === "seller") ? "dashboard.html" : "index.html";
    } catch (err) { alert(err.message); }
  });
}

/* LOGIN */
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
        window.location.href = (role === "seller") ? "dashboard.html" : "index.html";
      }
    } catch (err) { alert(err.message); }
  });
}

/* AUTH STATE & SECURITY */
onAuthStateChanged(auth, async (user) => {
  const currentPage = window.location.pathname;

  if (user) {
    const userDoc = await getDoc(doc(db, "users", user.uid));
    if (userDoc.exists()) {
      const role = userDoc.data().role;
      
      // PROTECTION: Kicks buyers out of the dashboard
      if (currentPage.includes("dashboard.html") && role !== "seller") {
        window.location.href = "index.html";
      }
      
      // UI Updates
      const welcome = document.getElementById("welcome");
      if (welcome) welcome.innerText = `Logged in as: ${user.email} (${role})`;
      if (document.getElementById("logoutBtn")) document.getElementById("logoutBtn").style.display = "block";
    }

  /* AUTH STATE & SECURITY */
onAuthStateChanged(auth, async (user) => {
  if (user) {
    try {
      const userDoc = await getDoc(doc(db, "users", user.uid));
      if (userDoc.exists()) {
        const role = userDoc.data().role;
        // ... rest of your logic
      }
    } catch (error) {
      console.error("Error fetching user role:", error);
    }
  }
});


/* PRODUCT UPLOAD (For Dashboard) */
const productForm = document.getElementById("productForm");
if (productForm) {
  productForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    
    const productData = {
      name: document.getElementById("pName").value,
      price: Number(document.getElementById("pPrice").value),
      description: document.getElementById("pDesc").value,
      sellerId: auth.currentUser.uid,
      createdAt: new Date()
    };

    try {
      await addDoc(collection(db, "products"), productData);
      alert("Product posted successfully!");
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

  const snapshot = await getDocs(collection(db, "products"));
  productList.innerHTML = "";

  snapshot.forEach(docSnap => {
    const product = docSnap.data();
    productList.innerHTML += `
      <div>
        <h3>${product.name}</h3>
        <p>$${product.price}</p>
        <p>${product.description}</p>
        <button class="buyBtn"
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
      try {
        await addDoc(collection(db, "orders"), {
          productId: btn.dataset.id,
          sellerId: btn.dataset.seller,
          userId: auth.currentUser.uid,
          status: "pending",
          createdAt: new Date()
        });
        alert("Order placed!");
        loadMyOrders();
    } catch (err) {
      alert("Error uploading: " + err.message);
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
    myProducts.innerHTML += `
      <li>
        ${product.name} - $${product.price}
        <button onclick="deleteProduct('${docSnap.id}')">Delete</button>
      </li>
    `;
  });
}

/* LOGOUT */
const logoutBtn = document.getElementById("logoutBtn");
if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    await signOut(auth);
    window.location.href = "login.html";
  });
}
