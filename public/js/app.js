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
      
      // Redirect based on role
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
  } else {
    // If not logged in and trying to access dashboard
    if (currentPage.includes("dashboard.html")) {
      window.location.href = "login.html";
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
    } catch (err) {
      alert("Error uploading: " + err.message);
    }
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