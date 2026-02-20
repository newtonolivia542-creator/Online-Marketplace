import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  collection,
  getDocs,
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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
  loadOrders();
});

async function loadUsers() {
  const snapshot = await getDocs(collection(db, "users"));
  const userList = document.getElementById("userList");

  snapshot.forEach(docSnap => {
    const user = docSnap.data();
    userList.innerHTML += `<li>${user.email} (${user.role})</li>`;
  });
}

async function loadOrders() {
  const snapshot = await getDocs(collection(db, "orders"));
  const orderList = document.getElementById("allOrders");

  snapshot.forEach(docSnap => {
    const order = docSnap.data();
    orderList.innerHTML += `
      <li>
        Order: ${docSnap.id} |
        Status: ${order.status}
      </li>
    `;
  });
}
