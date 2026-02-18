import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD81ZSor8uVttafgktmeQXMqf-7dQ2Uhj4",
  authDomain: "online-marketplace-e99cd.firebaseapp.com",
  projectId: "online-marketplace-e99cd",
  storageBucket: "online-marketplace-e99cd.firebasestorage.app",
  messagingSenderId: "95096517386",
  appId: "1:95096517386:web:b4710bf7215a277944c0f3",
  measurementId: "G-V42V2WLBQ5"
};

// 1. Add 'export' so app.js can see these
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app); // Added this for your 'users' collection