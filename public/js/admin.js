import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  collection,
  getDocs,
  doc,
  getDoc,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const userList = document.getElementById("userList");
const orderList = document.getElementById("allOrders");
const productList = document.getElementById("productList");
const logoutBtn = document.getElementById("logoutBtn");

logoutBtn.addEventListener("click", () => {
  signOut(auth);
  window.location.href = "login.html";
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "login.html";
    return;
  }

  const userDoc = await getDoc(doc(db, "users", user.uid));

  if (!userDoc.exists() || userDoc.data().role !== "admin") {
    alert("Access denied");
    window.location.href = "index.html";
    return;
  }

  loadUsers();
  loadProducts(); // This call needs loadProducts to be defined already
  loadOrders();
  //loadAllUsers();
});

// ================= USERS =================
async function loadUsers() {
  const snapshot = await getDocs(collection(db, "users"));
  const userList = document.getElementById("userList").querySelector("tbody");

  if (!userList) return;

  userList.innerHTML = ""; // clear previous content

  let count = 1; 

  snapshot.forEach(docSnap => {
    const user = docSnap.data();

        // ✅ SAFE DATE HANDLING
    let created = "N/A";
    let lastLogin = "N/A";

    if (user.createdAt && user.createdAt.seconds) {
      created = new Date(user.createdAt.seconds * 1000).toLocaleString();
    }

    if (user.lastLogin && user.lastLogin.seconds) {
      lastLogin = new Date(user.lastLogin.seconds * 1000).toLocaleString();
    }

    userList.innerHTML += `
      <tr>
        <td>${count}</td>
        <td>${user.email || "N/A"}</td>
        <td>${user.role || "N/A"}</td>
        <td>${created}</td>
        <td>${lastLogin}</td>
      </tr>
    `;
    count++;
  });
}


// ================= PRODUCTS =================
async function loadProducts() {
  const snapshot = await getDocs(collection(db, "products"));
  const productList = document.getElementById("productList");

  if (!productList) return;
  productList.innerHTML = "";

  let count = 1; 

  for (const docSnap of snapshot.docs) {
    const product = docSnap.data();

    // get seller email
    let sellerEmail = "Unknown";
    if (product.sellerId) {
      const sellerSnap = await getDoc(doc(db, "users", product.sellerId));
      if (sellerSnap.exists()) {
        sellerEmail = sellerSnap.data().email;
      }
    }

    const row = document.createElement("tr");

    row.innerHTML = `
      <td>${count}</td>
      <td>${product.name || "No name"}</td>
      <td>$${product.price || 0}</td>
      <td>${sellerEmail}</td>
      <td>
        <button onclick="deleteProduct('${docSnap.id}')">Delete</button>
      </td>
    `;
    count++; 

    productList.appendChild(row);
  }
}
window.deleteProduct = async function(productId) {
  if (!confirm("Delete this product?")) return;
  await deleteDoc(doc(db, "products", productId));
  alert("Product deleted");
  loadProducts();
};

// ================= ORDERS =================
async function loadOrders() {
  const snapshot = await getDocs(collection(db, "orders"));
  const orderList = document.getElementById("allOrders");
  orderList.innerHTML = "";

  for (const docSnap of snapshot.docs) {
    const order = docSnap.data();

    // get product
    const productSnap = await getDoc(doc(db, "products", order.productId));
    const productName = productSnap.exists() ? productSnap.data().name : "Unknown";

    // get buyer
    const buyerSnap = await getDoc(doc(db, "users", order.userId));
    const buyerEmail = buyerSnap.exists() ? buyerSnap.data().email : "Unknown";

    // get seller
    const sellerSnap = await getDoc(doc(db, "users", order.sellerId));
    const sellerEmail = sellerSnap.exists() ? sellerSnap.data().email : "Unknown";

    orderList.innerHTML += `
      <tr>
        <td>${productName}</td>
        <td>${buyerEmail}</td>
        <td>${sellerEmail}</td>
        <td>${order.status}</td>
      </tr>
    `;
  }
}
