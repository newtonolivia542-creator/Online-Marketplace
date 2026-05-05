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
      await setDoc(doc(db, "users", userCred.user.uid), {
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
      //loadBuyerMessages();
    }

    if (role === "seller") {
      loadSellerProducts();
      loadSellerOrders();
      loadSoldProducts();
      loadSellerMessages();
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

    const productData = {
      name: document.getElementById("pName").value,
      price: Number(document.getElementById("pPrice").value),
      description: document.getElementById("pDesc").value,
      images: imageURLs,
      sellerId: auth.currentUser.uid,
      category: document.getElementById("pCategory").value,
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
//New Update
  const orderDate = order.createdAt
    ? new Date(order.createdAt.seconds * 1000).toLocaleString()
    : "N/A";

  const quantity = order.quantity || 1;
  const price = order.price || (productSnap.exists() ? productSnap.data().price : 0);
  const total = price * quantity;

  const product = productSnap.exists() ? productSnap.data() : {};
  const image = product.images?.[0] || product.imageURL || "";

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

      if (product.sold === true) return;

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
}

  const urlParams = new URLSearchParams(window.location.search);
  const productId = urlParams.get("id");

  let currentImageIndex = 0;
  let productImages = [];

  async function loadProduct() {
    const docSnap = await getDoc(doc(db, "products", productId));
    if (!docSnap.exists()) return alert("Product not found");

    const product = docSnap.data();

    productImages = product.images && product.images.length > 0
      ? product.images
      : [product.imageURL];

    document.getElementById("detailImage").src = productImages[0];

    if (productImages.length <= 1) {
      document.getElementById("prevBtn").style.display = "none";
      document.getElementById("nextBtn").style.display = "none";
    }

    document.getElementById("detailName").innerText = product.name;
    document.getElementById("detailDesc").innerText = product.description;
    document.getElementById("detailPrice").innerText = product.price;
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

  //  ADD TO CART (MOVE IT HERE)
  const addToCartBtn = document.getElementById("addToCartBtn");

  if (addToCartBtn) {
    addToCartBtn.addEventListener("click", async () => {
      const quantity = Number(document.getElementById("detailQuantity").value);

      if (quantity < 1) return alert("Quantity must be at least 1");

      try {
        // create unique conversation ID per product + users
        const buyerId = auth.currentUser.uid;
        const sellerId = product.sellerId;

        const users = [buyerId, sellerId].sort();
        const conversationId = `${users[0]}_${users[1]}_${productId}`;

        alert("Product added to cart!");
        window.location.href = "cart.html";

      } catch (err) {
        alert("Failed to add to cart: " + err.message);
      }
    });
  }

  loadProduct();
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
        <img src="${product.images ? product.images[0] : product.imageURL}" class="product-img" width=120>
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
    //const productSnap = await getDoc(doc(db, "products", order.productId));
    //const productName = productSnap.exists() ? productSnap.data().name : "Unknown product";
    const productSnap = await getDoc(doc(db, "products", order.productId));

    let productName = "Unknown product";
    let productImage = "";

    if (productSnap.exists()) {
      const product = productSnap.data();
      productName = product.name;
      productImage = product.images?.[0] || product.imageURL || "";
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

    // FINAL UI
sellerOrders.innerHTML += `
  <li style="display:flex; align-items:center; gap:15px; margin-bottom:15px;">
    
    <img src="${productImage}" 
         style="width:60px; height:60px; object-fit:cover; border-radius:8px;" />

    <div>
      <strong>${productName}</strong> |
      Status: <span style="color:${statusColor}; font-weight:bold;">
        ${order.status}
      </span>
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

    // Only sold products
    if (product.sold !== true) return;

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

  //Function to stop data from entering Firestore again//
  if (!productId) {
    console.error("❌ Tried to send message without productId");
    alert("Something went wrong. Please reload the page.");
    return;
  }

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
    await addDoc(collection(db, "messages"), {
      conversationId,
      productId,
      senderId: user.uid,
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


/* ================= LOAD SELLER MESSAGES ================= */;

async function loadSellerMessages() {
  const msgList = document.getElementById("sellerMessages");
  if (!msgList || !auth.currentUser) return;

  const q = query(
    collection(db, "messages"),
    orderBy("createdAt", "asc") // oldest → newest
  );

  const snapshot = await getDocs(q);
  msgList.innerHTML = "";

  const conversations = {};

  snapshot.forEach(docSnap => {
    const msg = docSnap.data();

    if (
      msg.receiverId !== auth.currentUser.uid &&
      msg.senderId !== auth.currentUser.uid
    ) return;

    const users = [msg.senderId, msg.receiverId].sort().join("_");
    const convoId = `${users}_${msg.productId}`;
    if (!conversations[convoId]) conversations[convoId] = [];

    conversations[convoId].push(msg);
  });

  // GROUP BY PRODUCT (FIX DUPLICATES WITHOUT BREAKING REPLY)
  const convoList = Object.values(conversations);

// NOW RENDER
for (const msgs of convoList) {
  const convoId = msgs[0].conversationId;
  const firstMsg = msgs[0];

  const productDoc = await getDoc(doc(db, "products", firstMsg.productId));
  const product = productDoc.exists() ? productDoc.data() : {};
  //console.log("Conversation ID:", msgs[0].conversationId);//

    //Sort message function//
    msgs.sort((a, b) => {
      const timeA = a.createdAt?.seconds || 0;
      const timeB = b.createdAt?.seconds || 0;
      return timeA - timeB;
    });

    let chatHTML = "";

    msgs.forEach(msg => {
      if (msg.deletedBy?.includes(auth.currentUser.uid)) return;

      const isMe = msg.senderId === auth.currentUser.uid;

      const time = msg.createdAt
        ? new Date(msg.createdAt.seconds * 1000).toLocaleString()
        : "";

      chatHTML += `
        <div style="
          background:${isMe ? '#d1f7c4' : '#f1f1f1'};
          text-align:${isMe ? 'right' : 'left'};
          margin:5px;
          padding:8px;
          border-radius:8px;
        ">
          ${msg.text}
          <br>
          <small style="font-size:10px; color:gray;">${time}</small>
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

        <textarea id="seller-${convoId}" placeholder="Reply..."></textarea><br>

        <button onclick="handleReply('${convoId}', '${getOtherUserId(msgs)}', '${firstMsg.productId}', 'seller-${convoId}')">
          Reply
        </button>

        <!-- FIXED BUTTON -->
        <button onclick="deleteChat('${convoId}', '${firstMsg.productId}')"
          style="background:red; color:white; margin-top:10px;">
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
    if (!msg.productId) return;

    if (
      msg.receiverId !== auth.currentUser.uid &&
      msg.senderId !== auth.currentUser.uid
    ) return;

    // ALWAYS recompute conversationId
    const users = [msg.senderId, msg.receiverId].sort().join("_");
    const convoId = `${users}_${msg.productId}`;
    if (!conversations[convoId]) conversations[convoId] = [];

    conversations[convoId].push(msg);
  });

  // render
  for (const convoId in conversations) {
    const msgs = conversations[convoId];

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
        const productDoc = await getDoc(doc(db, "products", firstMsg.productId));
        if (productDoc.exists()) {
          product = productDoc.data();
        }
      } catch (err) {
        console.warn("Bad productId:", firstMsg.productId);
      }
    }


    let chatHTML = "";

    msgs.forEach(msg => {
      if (msg.deletedBy?.includes(auth.currentUser.uid)) return;

      const isMe = msg.senderId === auth.currentUser.uid;

      const time = msg.createdAt
        ? new Date(msg.createdAt.seconds * 1000).toLocaleString()
        : "";

      chatHTML += `
        <div style="
          background:${isMe ? '#d1f7c4' : '#f1f1f1'};
          text-align:${isMe ? 'right' : 'left'};
          margin:5px;
          padding:8px;
          border-radius:8px;
        ">
          ${msg.text}
          <br>
          <small style="font-size:10px; color:gray;">${time}</small>
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


/* ================= AUTH LOAD FOR MESSAGES PAGE ================= */

if (window.location.pathname.includes("messages.html")) {
  onAuthStateChanged(auth, (user) => {
    if (user) {
      loadBuyerMessages();
    }
  });
}
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