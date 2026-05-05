import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  collection,
  getDocs,
  doc,
  getDoc,
  deleteDoc,
  updateDoc
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
  let activeCount = 0;

  snapshot.forEach(docSnap => {
    const user = docSnap.data();

        // SAFE DATE HANDLING
    let created = "N/A";
    let lastLogin = "N/A";
    let status = "Inactive";

    let createdTime = null;
    let lastLoginTime = null;

    // createdAt
    if (user.createdAt) {
      try {
        createdTime = user.createdAt.toDate();
        created = createdTime.toLocaleString();
      } catch {
        created = "Invalid date";
      }
    }

    // lastLogin
    if (user.lastLogin) {
      try {
        lastLoginTime = user.lastLogin.toDate();
        lastLogin = lastLoginTime.toLocaleString();
      } catch {
        lastLogin = "Invalid date";
      }
    }

    // Active check
    if (lastLoginTime) {
      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;

      if (now - lastLoginTime.getTime() <= oneDay) {
        status = "Active";
        activeCount++;
      }
    }

    userList.innerHTML += `
      <tr>
        <td>${count}</td>
        <td>${user.email || "N/A"}</td>
        <td>${user.role || "N/A"}</td>
        <td>${created}</td>
        <td>${lastLogin}</td>
        <td style="color:${status === "Active" ? "green" : "red"};">
          ${status}
        </td>
        <td>
          ${
            user.status === "banned"
              ? `<button style="background-color:green; color:white; border:none; padding:5px 10px; border-radius:5px;" onclick="unbanUser('${docSnap.id}')">
                    UnBan
                  </button>`
              : `<button style="background-color:red; color:white; border:none; padding:5px 10px; border-radius:5px;" onclick="banUser('${docSnap.id}')">
                    Ban
                  </button>`
          }
        </td>
        <td style="color:${user.status === "banned" ? "red" : "green"};">
          ${user.status || "active"}
        </td>
        <td>${user.banReason || "-"}</td>
      </tr>
    `;
    count++;
  });
  // update active count
  const activeCountEl = document.getElementById("activeCount");
  if (activeCountEl) {
    activeCountEl.innerText = activeCount;
  }
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

    // DATE FIX
    let created = "N/A";
    if (product.createdAt) {
      try {
        created = product.createdAt.toDate
          ? product.createdAt.toDate().toLocaleString()
          : new Date(product.createdAt).toLocaleString();
      } catch {
        created = "Invalid";
      }
    }

    const productImage = product.images?.[0] || product.imageURL || "";

    const row = document.createElement("tr");

    row.innerHTML = `
      <td>${count}</td>
  <td>
  <img src="${productImage}"
    style="
      width:60px;
      height:60px;
      object-fit:cover;
      border-radius:6px;
      background:#eee;
    "
  >
</td>
      <td>${product.name || "No name"}</td>
      <td>$${product.price || 0}</td>
      <td>${sellerEmail}</td>
      <td>${created}</td>
      <td>
        <button style="background-color:red; color:white; border:none; padding:5px 10px; border-radius:5px;" onclick="deleteProduct('${docSnap.id}')">Delete</button>
      </td>
    `;
    productList.appendChild(row);
    count++; 
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

  if (!orderList) return;
  orderList.innerHTML = "";

  // universal date formatter
  const formatDate = (field) => {
    if (!field) return "N/A";
    try {
      return field.toDate
        ? field.toDate().toLocaleString()
        : new Date(field).toLocaleString();
    } catch {
      return "Invalid";
    }
  };

  for (const docSnap of snapshot.docs) {
    const order = docSnap.data();

    try {
      // ================= FETCH RELATED DATA =================
      let productName = "Unknown";
      if (order.productId) {
        const productSnap = await getDoc(doc(db, "products", order.productId));
        if (productSnap.exists()) {
          productName = productSnap.data().name;
        }
      }

      let buyerEmail = "Unknown";
      if (order.userId) {
        const buyerSnap = await getDoc(doc(db, "users", order.userId));
        if (buyerSnap.exists()) {
          buyerEmail = buyerSnap.data().email;
        }
      }

      let sellerEmail = "Unknown";
      if (order.sellerId) {
        const sellerSnap = await getDoc(doc(db, "users", order.sellerId));
        if (sellerSnap.exists()) {
          sellerEmail = sellerSnap.data().email;
        }
      }

      // ================= DATE HANDLING =================
      const created = formatDate(order.createdAt);

      let shipped = "Not shipped";
      let delivered = "Not delivered";

      if (order.shippedAt) {
        shipped = formatDate(order.shippedAt);
      } else if (order.status === "shipped" || order.status === "delivered") {
        shipped = "Shipped (no timestamp)";
      }

      if (order.deliveredAt) {
        delivered = formatDate(order.deliveredAt);
      } else if (order.status === "delivered") {
        delivered = "Delivered (no timestamp)";
      }

      // ================= DELIVERY TIME CALC =================
      let deliveryTime = "-";

      if (order.createdAt && order.deliveredAt) {
        try {
          const start = order.createdAt.toDate
            ? order.createdAt.toDate()
            : new Date(order.createdAt);

          const end = order.deliveredAt.toDate
            ? order.deliveredAt.toDate()
            : new Date(order.deliveredAt);

          let diffMs = end - start;

          const maxMs = 14 * 24 * 60 * 60 * 1000;

          if (diffMs > maxMs) {
            deliveryTime = "Over 2 weeks ❗";
          } else {
            const minutes = Math.floor(diffMs / (1000 * 60));
            const hours = Math.floor(minutes / 60);
            const days = Math.floor(hours / 24);

            if (days > 0) {
              deliveryTime = `${days} day(s) ${hours % 24} hr`;
            } else if (hours > 0) {
              deliveryTime = `${hours} hr ${minutes % 60} min`;
            } else {
              deliveryTime = `${minutes} min`;
            }
          }

        } catch {
          deliveryTime = "Error";
        }
      }


      const isLate = deliveryTime.includes("Over");

      // ================= RENDER =================
      orderList.innerHTML += `
        <tr>
          <td>${productName}</td>
          <td>${buyerEmail}</td>
          <td>${sellerEmail}</td>
          <td>${created}</td>
          <td>${order.status || "N/A"}</td>
          <td>${shipped}</td>
          <td>${delivered}</td>
          <td style="
            color:white;
            background-color:${isLate ? 'red' : 'grey'};
            padding:4px 8px;
            border-radius:6px;
            text-align:center;
          ">
            ${deliveryTime}
          </td>
        </tr>
      `;

    } catch (err) {
      console.error("Error loading order:", err, order);
    }
  }
}
// ========BAN AND UNBAN FUNCTION ===========/
window.banUser = async function(userId) {
  const reason = prompt("Enter reason for banning this user:");

  if (!reason) {
    alert("Ban cancelled. Reason is required.");
    return;
  }

  await updateDoc(doc(db, "users", userId), {
    status: "banned",
    banReason: reason // ADD THIS
  });

  alert("User banned");
  loadUsers();
};

window.unbanUser = async function(userId) {
  const confirmUnban = confirm("Unban this user?");
  if (!confirmUnban) return;

  await updateDoc(doc(db, "users", userId), {
    status: "active",
    banReason: "" 
  });

  alert("User unbanned");
  loadUsers();
};