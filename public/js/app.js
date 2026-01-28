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
  getDoc
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
      await setDoc(doc(db, "users", userCred.user.uid), {
        email,
        role
      });
      window.location.href = "index.html";
    } catch (err) {
      alert(err.message);
    }
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
      await signInWithEmailAndPassword(auth, email, password);
      window.location.href = "index.html";
    } catch (err) {
      alert(err.message);
    }
  });
}

/* AUTH STATE */
/* AUTH STATE */
onAuthStateChanged(auth, async (user) => {
  const sellerSection = document.getElementById("seller-section");
  const welcomeElement = document.getElementById("welcome");
  
  if (user) {
    try {
      const userDoc = await getDoc(doc(db, "users", user.uid));
      if (userDoc.exists()) {
        const role = userDoc.data().role;
        
        // Only update 'welcome' if it exists on this specific page
        if (welcomeElement) {
          welcomeElement.innerText = `Welcome ${user.email} (${role})`;
        }

        // Only update 'sellerSection' if it exists on this specific page
        if (role === "seller" && sellerSection) {
          sellerSection.style.display = "block";
        }
      }
    } catch (err) {
      console.error("Error fetching user data:", err);
    }
  } else {
    // Safety check for logout state
    if (sellerSection) {
      sellerSection.style.display = "none";
    }
  }
});
//});

/* LOGOUT */
const logoutBtn = document.getElementById("logoutBtn");
if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    await signOut(auth);
    window.location.href = "login.html";
  });
}
