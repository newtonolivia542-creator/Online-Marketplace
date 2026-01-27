// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyD81ZSor8uVttafgktmeQXMqf-7dQ2Uhj4",
  authDomain: "online-marketplace-e99cd.firebaseapp.com",
  projectId: "online-marketplace-e99cd",
  storageBucket: "online-marketplace-e99cd.firebasestorage.app",
  messagingSenderId: "95096517386",
  appId: "1:95096517386:web:b4710bf7215a277944c0f3",
  measurementId: "G-V42V2WLBQ5"
};
// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);