import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  collection,
  getDocs,
  doc,
  getDoc,
  deleteDoc,
  updateDoc,
  query,
  where
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

  // Page starts hidden (see the inline <style> in admin.html) so there's no
  // flash of admin data before this check runs.
  document.body.style.visibility = "visible";

  // Welcome banner (admin.html hub page only -- no-ops elsewhere).
  const nameEl = document.getElementById("adminName");
  if (nameEl) nameEl.innerText = userDoc.data().fullName || "Admin";

  const emailEl = document.getElementById("adminEmail");
  if (emailEl) emailEl.innerText = user.email;

  loadUsers();
  loadProducts(); // This call needs loadProducts to be defined already
  loadOrders();
  //loadAllUsers();

  // Each of these no-ops on pages that don't have its container (same
  // guard-clause pattern as loadUsers/loadProducts/loadOrders above), so
  // they're safe to call unconditionally on every admin page.
  loadAdminProductGrid();
  loadAdminProductDetail();
  loadSellers();
  loadBuyers();
  loadSellerReviews();
  loadAdmins();

  // Search bars -- one per page, each a no-op if that input isn't present.
  wireAdminSearch("productSearch", "#adminProductGrid .admin-product-card");
  wireAdminSearch("sellerSearch", "#sellerList tr");
  wireAdminSearch("buyerSearch", "#buyerList tr");
  wireAdminSearch("adminSearch", "#adminList tr");
  wireAdminSearch("orderSearch", "#allOrders tr");
  wireAdminSearch("userSearch", "#userList tbody tr");
  wireAdminSearch("productListSearch", "#productList tr");
  wireAdminSearch("reviewSearch", "#sellerReviewsList .admin-seller-section");
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

// =========================================================
// NEW ADMIN PAGES -- additive only, none of the above is touched.
// =========================================================

async function formatFirestoreDate(value) {
  if (!value) return "N/A";
  try {
    return value.toDate ? value.toDate().toLocaleString() : new Date(value).toLocaleString();
  } catch {
    return "Invalid date";
  }
}

function starString(rating) {
  const r = Number(rating) || 0;
  return "★".repeat(r) + "☆".repeat(Math.max(0, 5 - r));
}

// Generic client-side search: as the admin types, shows/hides whichever
// rendered items (rows/cards/sections) match anywhere in their own visible
// text -- covers names, emails, categories, prices, statuses, etc. all at
// once with no extra per-field logic. Safe to call for every page; no-ops
// if that page doesn't have the given search input.
function wireAdminSearch(inputId, itemSelector) {
  const input = document.getElementById(inputId);
  if (!input) return;

  input.addEventListener("input", () => {
    const term = input.value.trim().toLowerCase();

    document.querySelectorAll(itemSelector).forEach((item) => {
      const matches = item.textContent.toLowerCase().includes(term);
      item.style.display = matches ? "" : "none";
    });
  });
}

// ================= ADMIN: ALL PRODUCTS (admin-products.html) =================
async function loadAdminProductGrid() {
  const grid = document.getElementById("adminProductGrid");
  if (!grid) return;

  const snapshot = await getDocs(collection(db, "products"));
  grid.innerHTML = "";

  for (const docSnap of snapshot.docs) {
    const product = docSnap.data();

    let sellerName = "Unknown";
    if (product.sellerId) {
      const sellerSnap = await getDoc(doc(db, "users", product.sellerId));
      if (sellerSnap.exists()) {
        const seller = sellerSnap.data();
        sellerName = seller.fullName || seller.email || "Unknown";
      }
    }

    const uploaded = await formatFirestoreDate(product.createdAt);

    const reviewsSnap = await getDocs(
      query(collection(db, "reviews"), where("productId", "==", docSnap.id))
    );

    let reviewStatus = "No reviews yet";
    if (!reviewsSnap.empty) {
      let total = 0;
      reviewsSnap.forEach((r) => (total += Number(r.data().rating) || 0));
      const avg = (total / reviewsSnap.size).toFixed(1);
      reviewStatus = `⭐ ${avg} (${reviewsSnap.size} review${reviewsSnap.size === 1 ? "" : "s"})`;
    }

    const image = product.images?.[0] || product.imageURL || "";

    const card = document.createElement("div");
    card.className = "admin-product-card";
    card.innerHTML = `
      <img src="${image}" class="admin-product-img" alt="${product.name || ""}">
      <h3>${product.name || "Unnamed product"}</h3>
      <p class="admin-product-price">$${product.price ?? 0}</p>
      <p><strong>Category:</strong> ${product.category || "N/A"}</p>
      <p><strong>Quantity:</strong> ${product.quantity ?? "N/A"}</p>
      <p><strong>Seller:</strong> ${sellerName}</p>
      <p><strong>Uploaded:</strong> ${uploaded}</p>
      <p><strong>Reviews:</strong> ${reviewStatus}</p>
      <div class="admin-product-actions">
        <button class="btn btn-secondary" onclick="window.location.href='admin-product-detail.html?id=${docSnap.id}'">View Details</button>
        <button class="btn btn-danger" onclick="adminDeleteProduct('${docSnap.id}')">Delete Product</button>
      </div>
    `;

    grid.appendChild(card);
  }
}

window.adminDeleteProduct = async function (productId) {
  if (!confirm("Delete this product? This cannot be undone.")) return;
  await deleteDoc(doc(db, "products", productId));
  alert("Product deleted.");
  loadAdminProductGrid();
};

// ================= ADMIN: PRODUCT DETAIL (admin-product-detail.html) =================
async function loadAdminProductDetail() {
  const container = document.getElementById("adminProductDetail");
  if (!container) return;

  const productId = new URLSearchParams(window.location.search).get("id");

  if (!productId) {
    container.innerHTML = "<p>No product specified.</p>";
    return;
  }

  const productSnap = await getDoc(doc(db, "products", productId));

  if (!productSnap.exists()) {
    container.innerHTML = "<p>Product not found. It may have been deleted.</p>";
    return;
  }

  const product = productSnap.data();

  let sellerName = "Unknown";
  let sellerEmail = "Unknown";

  if (product.sellerId) {
    const sellerSnap = await getDoc(doc(db, "users", product.sellerId));
    if (sellerSnap.exists()) {
      const seller = sellerSnap.data();
      sellerName = seller.fullName || "Unknown";
      sellerEmail = seller.email || "Unknown";
    }
  }

  const uploaded = await formatFirestoreDate(product.createdAt);

  // originalQuantity / descriptionGeneratedByAI may not exist on products
  // created before these fields were added -- never guess, say so plainly.
  const originalQuantity =
    product.originalQuantity !== undefined
      ? product.originalQuantity
      : "Not tracked (product uploaded before this feature was added)";

  const aiGenerated =
    product.descriptionGeneratedByAI === true
      ? "Yes"
      : product.descriptionGeneratedByAI === false
      ? "No"
      : "Unknown (not tracked for this product)";

  const images = product.images?.length
    ? product.images
    : product.imageURL
    ? [product.imageURL]
    : [];

  const reviewsSnap = await getDocs(
    query(collection(db, "reviews"), where("productId", "==", productId))
  );

  let reviewsHtml = "<p>No reviews yet.</p>";

  if (!reviewsSnap.empty) {
    reviewsHtml = "";

    for (const r of reviewsSnap.docs) {
      const review = r.data();
      const reviewDate = await formatFirestoreDate(review.createdAt);

      reviewsHtml += `
        <div class="admin-review-card">
          <p class="admin-stars">${starString(review.rating)}</p>
          <p>${review.comment || ""}</p>
          <small>By ${review.buyerName || "Anonymous"} on ${reviewDate}</small>
        </div>
      `;
    }
  }

  container.innerHTML = `
    <div class="admin-detail-images">
      ${images.map((img) => `<img src="${img}" class="admin-detail-img" alt="${product.name || ""}">`).join("") || "<p>No images.</p>"}
    </div>

    <h2>${product.name || "Unnamed product"}</h2>
    <p>${product.description || "No description provided."}</p>

    <p><strong>Price:</strong> $${product.price ?? 0}</p>
    <p><strong>Category:</strong> ${product.category || "N/A"}</p>
    <p><strong>Original quantity uploaded:</strong> ${originalQuantity}</p>
    <p><strong>Current quantity remaining:</strong> ${product.quantity ?? "N/A"}</p>
    <p><strong>Uploaded:</strong> ${uploaded}</p>
    <p><strong>Seller:</strong> ${sellerName}</p>
    <p><strong>Seller email:</strong> ${sellerEmail}</p>
    <p><strong>Description generated by AI:</strong> ${aiGenerated}</p>

    <h3>Reviews</h3>
    ${reviewsHtml}

    <button class="btn btn-danger" onclick="adminDeleteProduct('${productId}')">Delete Product</button>
  `;
}

// ================= ADMIN: SELLERS (admin-sellers.html) =================
async function loadSellers() {
  const container = document.getElementById("sellerList");
  if (!container) return;

  const snapshot = await getDocs(
    query(collection(db, "users"), where("role", "==", "seller"))
  );

  const totalEl = document.getElementById("totalSellers");
  if (totalEl) totalEl.innerText = snapshot.size;

  container.innerHTML = "";

  for (const docSnap of snapshot.docs) {
    const seller = docSnap.data();

    const productsSnap = await getDocs(
      query(collection(db, "products"), where("sellerId", "==", docSnap.id))
    );

    const created = await formatFirestoreDate(seller.createdAt);

    container.innerHTML += `
      <tr>
        <td>${seller.fullName || "N/A"}</td>
        <td>${seller.email || "N/A"}</td>
        <td>${created}</td>
        <td>${productsSnap.size}</td>
        <td style="color:${seller.status === "banned" ? "red" : "green"};">
          ${seller.status || "active"}
        </td>
      </tr>
    `;
  }
}

// ================= ADMIN: BUYERS (admin-buyers.html) =================
async function loadBuyers() {
  const container = document.getElementById("buyerList");
  if (!container) return;

  const snapshot = await getDocs(
    query(collection(db, "users"), where("role", "==", "buyer"))
  );

  const totalEl = document.getElementById("totalBuyers");
  if (totalEl) totalEl.innerText = snapshot.size;

  container.innerHTML = "";

  for (const docSnap of snapshot.docs) {
    const buyer = docSnap.data();

    const ordersSnap = await getDocs(
      query(collection(db, "orders"), where("userId", "==", docSnap.id))
    );

    const created = await formatFirestoreDate(buyer.createdAt);

    container.innerHTML += `
      <tr>
        <td>${buyer.fullName || "N/A"}</td>
        <td>${buyer.email || "N/A"}</td>
        <td>${created}</td>
        <td>${ordersSnap.size}</td>
        <td style="color:${buyer.status === "banned" ? "red" : "green"};">
          ${buyer.status || "active"}
        </td>
      </tr>
    `;
  }
}

// ================= ADMIN: ADMINS (admin-admins.html) =================
// Exists specifically so a real admin can audit who currently holds the
// admin role -- includes lastLogin (not shown on the seller/buyer pages)
// since an unfamiliar account or an odd login time is exactly what this
// page is for catching.
async function loadAdmins() {
  const container = document.getElementById("adminList");
  if (!container) return;

  const snapshot = await getDocs(
    query(collection(db, "users"), where("role", "==", "admin"))
  );

  const totalEl = document.getElementById("totalAdmins");
  if (totalEl) totalEl.innerText = snapshot.size;

  container.innerHTML = "";

  for (const docSnap of snapshot.docs) {
    const admin = docSnap.data();

    const created = await formatFirestoreDate(admin.createdAt);
    const lastLogin = await formatFirestoreDate(admin.lastLogin);

    container.innerHTML += `
      <tr>
        <td>${admin.fullName || "N/A"}</td>
        <td>${admin.email || "N/A"}</td>
        <td>${created}</td>
        <td>${lastLogin}</td>
        <td style="color:${admin.status === "banned" ? "red" : "green"};">
          ${admin.status || "active"}
        </td>
      </tr>
    `;
  }
}

// ================= ADMIN: SELLER REVIEWS (admin-seller-reviews.html) =================
async function loadSellerReviews() {
  const container = document.getElementById("sellerReviewsList");
  if (!container) return;

  const sellersSnap = await getDocs(
    query(collection(db, "users"), where("role", "==", "seller"))
  );

  const reviewsSnap = await getDocs(collection(db, "reviews"));

  const reviewsBySeller = {};

  reviewsSnap.forEach((docSnap) => {
    const review = docSnap.data();
    const sellerId = review.sellerId || "unknown";
    if (!reviewsBySeller[sellerId]) reviewsBySeller[sellerId] = [];
    reviewsBySeller[sellerId].push(review);
  });

  container.innerHTML = "";

  for (const sellerDoc of sellersSnap.docs) {
    const seller = sellerDoc.data();
    const sellerReviews = reviewsBySeller[sellerDoc.id] || [];

    let reviewsHtml = "<p>No reviews yet.</p>";

    if (sellerReviews.length > 0) {
      reviewsHtml = "";

      for (const review of sellerReviews) {
        let productImage = "";

        if (review.productId) {
          const productSnap = await getDoc(doc(db, "products", review.productId));
          if (productSnap.exists()) {
            const product = productSnap.data();
            productImage = product.images?.[0] || product.imageURL || "";
          }
        }

        const reviewDate = await formatFirestoreDate(review.createdAt);

        reviewsHtml += `
          <div class="admin-review-card">
            ${productImage ? `<img src="${productImage}" class="admin-review-img" alt="">` : ""}
            <div>
              <p><strong>${review.productName || "Unknown product"}</strong></p>
              <p class="admin-stars">${starString(review.rating)}</p>
              <p>${review.comment || ""}</p>
              <small>By ${review.buyerName || "Anonymous"} on ${reviewDate}</small>
            </div>
          </div>
        `;
      }
    }

    container.innerHTML += `
      <section class="admin-seller-section">
        <h3>${seller.fullName || seller.email || "Unknown seller"}</h3>
        ${reviewsHtml}
      </section>
    `;
  }
}