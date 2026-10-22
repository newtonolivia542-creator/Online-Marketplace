// A phone number as a BACKUP for getting back into an account -- not a way to
// sign in. Its one job is to let a seller reset their password when they can't
// use their email.
//
//   * Login page  -> "Can't use your email?": prove the phone with a texted
//     code, then choose a new password. (Then sign in the normal way.)
//   * Seller Profile -> Security: add or remove the recovery number, change
//     password, change email.
//   * Seller dashboard: a reminder to add a number until they do.
//
// The number is verified with a texted code on a THROWAWAY Firebase session
// (its own app instance, kept in memory only) and is never linked to the
// person's real account -- a linked number would work as a login. The server
// checks the code from the token Firebase issued for it and keeps the number
// in a private record (accountRecovery/{uid}); it is never in the users
// document, which every signed-in user can read.
//
// Each piece wires itself only if the current page has its elements, so this
// module is safe to load on every page (app.js imports it).

import { auth, db, firebaseConfig } from "./firebase.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";

import {
  initializeAuth,
  inMemoryPersistence,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signOut,
  unlink,
  updatePassword,
  EmailAuthProvider,
  reauthenticateWithCredential,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { normalizePhone, maskPhone, phoneAuthErrorMessage } from "./helpers.js";

const FUNCTIONS_BASE = "https://us-central1-online-marketplace-e99cd.cloudfunctions.net/";

const byId = (id) => document.getElementById(id);

function say(id, text, isError = false) {
  const el = byId(id);

  if (!el) return;

  el.textContent = text;
  el.style.color = isError ? "#b00020" : "inherit";
}

const SIX_DIGITS = /^\d{6}$/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ================= verifying a phone number (throwaway session) ================= */

let verifyAuth = null;

// Its own app instance with in-memory persistence: nothing from this session is
// ever saved in the browser, and it never touches the seller's real session.
function phoneVerifyAuth() {
  if (!verifyAuth) {
    verifyAuth = initializeAuth(initializeApp(firebaseConfig, "phone-verify"), { persistence: inMemoryPersistence });
  }

  return verifyAuth;
}

let verifier = null;

// reCAPTCHA (invisible) is what stops bots from running up SMS charges. A
// verifier can only be used once, so each text request gets a fresh one.
function freshVerifier(holderId) {
  discardVerifier();

  const holder = byId(holderId);
  holder.innerHTML = "";

  const target = document.createElement("div");
  holder.appendChild(target);

  verifier = new RecaptchaVerifier(phoneVerifyAuth(), target, { size: "invisible" });

  return verifier;
}

function discardVerifier() {
  if (verifier) {
    try { verifier.clear(); } catch (err) { /* already gone */ }
    verifier = null;
  }
}

// Texts a code. Resolves to a function that takes the code and returns the
// token Firebase issues for it (which the server then checks).
async function textCode(phone, holderId) {
  const confirmation = await signInWithPhoneNumber(phoneVerifyAuth(), phone, freshVerifier(holderId));

  return async (code) => {
    const result = await confirmation.confirm(code);
    const token = await result.user.getIdToken();

    try { await signOut(phoneVerifyAuth()); } catch (err) { /* it's throwaway anyway */ }

    return token;
  };
}

// Calls one of our functions. Failures carry the server's plain-English message.
async function callFunction(name, body, user = null) {
  const headers = { "Content-Type": "application/json" };

  if (user) headers.Authorization = `Bearer ${await user.getIdToken()}`;

  let response;

  try {
    response = await fetch(`${FUNCTIONS_BASE}${name}`, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (err) {
    throw { code: "auth/network-request-failed" };
  }

  const data = await response.json().catch(() => ({}));

  if (response.status === 429) throw { code: "auth/too-many-requests" };
  if (response.status === 403 && data.code === "recent-login") throw { code: "auth/requires-recent-login" };

  if (!response.ok) throw { message: data.error || "Something went wrong. Please try again.", fromServer: true };

  return data;
}

const messageOf = (err) => (err && err.fromServer ? err.message : phoneAuthErrorMessage(err));

/* ================= LOGIN PAGE: RESET PASSWORD WITH A PHONE ================= */

// The green notice at the top of the login box.
function showLoginNotice(text) {
  const notice = byId("loginNotice");

  if (!notice) return;

  notice.textContent = text;
  notice.style.display = "block";

  if (notice.scrollIntoView) notice.scrollIntoView({ behavior: "smooth", block: "center" });
}

function wireRecovery() {
  const form = byId("phoneRecoveryForm");

  if (!form) return;

  const toggle = byId("phoneRecoveryToggle");
  const sendBtn = byId("phoneRecoverySendBtn");
  const verifyBtn = byId("phoneRecoveryVerifyBtn");
  const setBtn = byId("phoneRecoverySetBtn");

  let confirmCode = null;  // set once a code has been texted
  let phoneToken = null;   // set once the code was confirmed
  let accountEmail = null;

  if (toggle) {
    toggle.addEventListener("click", () => {
      form.style.display = form.style.display === "none" ? "block" : "none";
    });
  }

  sendBtn.addEventListener("click", async () => {
    const email = byId("phoneRecoveryEmail").value.trim().toLowerCase();
    const phone = normalizePhone(byId("phoneRecoveryNumber").value);

    if (!EMAIL_SHAPE.test(email)) {
      say("phoneRecoveryMessage", "Enter the email address on your Lesovia account.", true);
      return;
    }

    if (!phone) {
      say("phoneRecoveryMessage", "Enter your recovery phone number with the area code, for example (712) 555-0123.", true);
      return;
    }

    sendBtn.disabled = true;
    say("phoneRecoveryMessage", "Checking your details...");

    try {
      // A code is only texted when this email AND this recovery number belong
      // to the same account. If the check can't finish, nothing is sent.
      const { match } = await callFunction("checkRecoveryPhone", { email, phone });

      if (!match) {
        say(
          "phoneRecoveryMessage",
          "Those details don't match a recovery phone on file. Check them, or email support@lesovia.com.",
          true
        );
        return;
      }

      say("phoneRecoveryMessage", "Sending your code...");

      confirmCode = await textCode(phone, "phoneRecoveryRecaptcha");
      accountEmail = email;

      byId("phoneRecoveryCodeRow").style.display = "block";
      say("phoneRecoveryMessage", `We texted a 6-digit code to the number ${maskPhone(phone)}.`);
      byId("phoneRecoveryCode").focus();
    } catch (err) {
      console.error(err);
      discardVerifier();
      say("phoneRecoveryMessage", messageOf(err), true);
    } finally {
      sendBtn.disabled = false;
    }
  });

  verifyBtn.addEventListener("click", async () => {
    const code = byId("phoneRecoveryCode").value.trim();

    if (!confirmCode) {
      say("phoneRecoveryMessage", "Request a code first.", true);
      return;
    }

    if (!SIX_DIGITS.test(code)) {
      say("phoneRecoveryMessage", "Enter the 6-digit code we texted you.", true);
      return;
    }

    verifyBtn.disabled = true;

    try {
      phoneToken = await confirmCode(code);

      byId("phoneRecoveryCodeRow").style.display = "none";
      byId("phoneRecoveryPasswordRow").style.display = "block";
      say("phoneRecoveryMessage", "Number confirmed. Choose a new password.");
      byId("phoneRecoveryNewPassword").focus();
    } catch (err) {
      console.error(err);
      say("phoneRecoveryMessage", messageOf(err), true);
    } finally {
      verifyBtn.disabled = false;
    }
  });

  setBtn.addEventListener("click", async () => {
    const next = byId("phoneRecoveryNewPassword").value;
    const again = byId("phoneRecoveryConfirmPassword").value;

    if (!phoneToken) {
      say("phoneRecoveryMessage", "Confirm your phone number first.", true);
      return;
    }

    if (next.length < 8) {
      say("phoneRecoveryMessage", "Choose a password with at least 8 characters.", true);
      return;
    }

    if (next !== again) {
      say("phoneRecoveryMessage", "The two passwords don't match.", true);
      return;
    }

    setBtn.disabled = true;

    try {
      await callFunction("recoverPasswordWithPhone", { email: accountEmail, phoneIdToken: phoneToken, newPassword: next });

      const signInEmail = accountEmail;

      // Done with recovery: wipe it, close it, and hand the person to the login
      // box with their email filled in and the cursor in the password field.
      phoneToken = null;
      confirmCode = null;
      accountEmail = null;

      for (const field of ["phoneRecoveryEmail", "phoneRecoveryNumber", "phoneRecoveryCode", "phoneRecoveryNewPassword", "phoneRecoveryConfirmPassword"]) {
        byId(field).value = "";
      }

      byId("phoneRecoveryCodeRow").style.display = "none";
      byId("phoneRecoveryPasswordRow").style.display = "none";
      say("phoneRecoveryMessage", "");
      form.style.display = "none";

      showLoginNotice("Your password has been changed. Sign in with your email and your new password.");

      const loginEmail = byId("email");
      const loginPassword = byId("password");

      if (loginEmail) loginEmail.value = signInEmail;
      if (loginPassword) loginPassword.focus();
    } catch (err) {
      console.error(err);
      say("phoneRecoveryMessage", messageOf(err), true);
    } finally {
      setBtn.disabled = false;
    }
  });
}

/* ================= SELLER PROFILE: SECURITY ================= */

// What the page knows about this seller's recovery number.
let recoveryPhone = null;

async function loadRecoveryPhone(user) {
  recoveryPhone = null;

  if (!user) return;

  try {
    const snap = await getDoc(doc(db, "accountRecovery", user.uid));

    recoveryPhone = snap.exists() ? snap.data().phone || null : null;
  } catch (err) {
    console.error("Could not read the recovery phone:", err);
  }
}

function renderSecurity(user) {
  const linked = byId("securityPhoneLinked");
  const addRow = byId("securityPhoneAdd");

  if (!linked || !addRow) return;

  // A phone number linked to the account itself would work as a sign-in -- the
  // earlier version of this feature did that. Offer to remove it.
  const legacy = byId("securityLegacyPhone");

  if (legacy) legacy.style.display = user && user.phoneNumber ? "block" : "none";

  if (recoveryPhone) {
    linked.style.display = "block";
    addRow.style.display = "none";
    say("securityPhoneStatus", `Recovery phone on file (${maskPhone(recoveryPhone)}). You can use it to reset your password if you can't use your email.`);
  } else {
    linked.style.display = "none";
    addRow.style.display = "block";
    byId("securityPhoneCodeRow").style.display = "none";
  }
}

function wireSecurity() {
  const section = byId("securityPhoneSection");

  if (!section) return;

  const sendBtn = byId("securityPhoneSendBtn");
  const confirmBtn = byId("securityPhoneConfirmBtn");
  const removeBtn = byId("securityPhoneRemoveBtn");

  let confirmCode = null;

  sendBtn.addEventListener("click", async () => {
    const phone = normalizePhone(byId("securityPhoneNumber").value);

    if (!phone) {
      say("securityPhoneMessage", "Enter your phone number with the area code, for example (712) 555-0123.", true);
      return;
    }

    sendBtn.disabled = true;
    say("securityPhoneMessage", "Sending your code...");

    try {
      confirmCode = await textCode(phone, "securityPhoneRecaptcha");

      byId("securityPhoneCodeRow").style.display = "block";
      say("securityPhoneMessage", `We texted a 6-digit code to the number ${maskPhone(phone)}.`);
      byId("securityPhoneCode").focus();
    } catch (err) {
      console.error(err);
      discardVerifier();
      say("securityPhoneMessage", messageOf(err), true);
    } finally {
      sendBtn.disabled = false;
    }
  });

  confirmBtn.addEventListener("click", async () => {
    const code = byId("securityPhoneCode").value.trim();
    const user = auth.currentUser;

    if (!confirmCode) {
      say("securityPhoneMessage", "Request a code first.", true);
      return;
    }

    if (!SIX_DIGITS.test(code)) {
      say("securityPhoneMessage", "Enter the 6-digit code we texted you.", true);
      return;
    }

    confirmBtn.disabled = true;

    try {
      const phoneIdToken = await confirmCode(code);

      await callFunction("saveRecoveryPhone", { phoneIdToken }, user);
      await loadRecoveryPhone(user);

      byId("securityPhoneNumber").value = "";
      byId("securityPhoneCode").value = "";
      confirmCode = null;
      say("securityPhoneMessage", "");

      renderSecurity(user);
    } catch (err) {
      console.error(err);
      say("securityPhoneMessage", messageOf(err), true);
    } finally {
      confirmBtn.disabled = false;
    }
  });

  removeBtn.addEventListener("click", async () => {
    if (!confirm("Remove your recovery phone number? You won't be able to reset your password by text message.")) return;

    removeBtn.disabled = true;

    try {
      await callFunction("removeRecoveryPhone", {}, auth.currentUser);
      await loadRecoveryPhone(auth.currentUser);

      renderSecurity(auth.currentUser);
    } catch (err) {
      console.error(err);
      say("securityPhoneStatus", messageOf(err), true);
    } finally {
      removeBtn.disabled = false;
    }
  });

  const legacyBtn = byId("securityLegacyRemoveBtn");

  if (legacyBtn) {
    legacyBtn.addEventListener("click", async () => {
      try {
        await unlink(auth.currentUser, "phone");
        await auth.currentUser.reload();

        renderSecurity(auth.currentUser);
      } catch (err) {
        console.error(err);
        say("securityLegacyMessage", phoneAuthErrorMessage(err), true);
      }
    });
  }

  // ---- change password ----
  const passwordBtn = byId("securityChangePasswordBtn");

  passwordBtn.addEventListener("click", async () => {
    const next = byId("securityNewPassword").value;
    const again = byId("securityConfirmPassword").value;

    if (next.length < 8) {
      say("securityPasswordMessage", "Choose a password with at least 8 characters.", true);
      return;
    }

    if (next !== again) {
      say("securityPasswordMessage", "The two passwords don't match.", true);
      return;
    }

    passwordBtn.disabled = true;

    try {
      await updatePassword(auth.currentUser, next);

      byId("securityNewPassword").value = "";
      byId("securityConfirmPassword").value = "";
      say("securityPasswordMessage", "Your password was changed.");
    } catch (err) {
      console.error(err);
      say("securityPasswordMessage", phoneAuthErrorMessage(err), true);
    } finally {
      passwordBtn.disabled = false;
    }
  });

  // ---- change email: current password, then a link to the NEW address ----
  const emailBtn = byId("securityChangeEmailBtn");

  emailBtn.addEventListener("click", async () => {
    const user = auth.currentUser;
    const newEmail = byId("securityNewEmail").value.trim().toLowerCase();
    const password = byId("securityEmailPassword").value;

    if (!EMAIL_SHAPE.test(newEmail)) {
      say("securityEmailMessage", "Enter a valid email address.", true);
      return;
    }

    if (!password) {
      say("securityEmailMessage", "Enter your current password to confirm it's you.", true);
      return;
    }

    emailBtn.disabled = true;
    say("securityEmailMessage", "Checking...");

    try {
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));

      // A fresh token, so the server can see the password was just re-entered.
      await user.getIdToken(true);

      await callFunction("startEmailChange", { newEmail }, user);

      byId("securityEmailPassword").value = "";
      say("securityEmailMessage", `We sent a confirmation link to ${newEmail}. Your email changes when you click it.`);
    } catch (err) {
      console.error(err);

      const wrongPassword = err && (err.code === "auth/wrong-password" || err.code === "auth/invalid-credential");

      say("securityEmailMessage", wrongPassword ? "That password isn't right." : messageOf(err), true);
    } finally {
      emailBtn.disabled = false;
    }
  });
}

/* ================= SELLER DASHBOARD: REMINDER ================= */

const REMINDER_KEY = "lesovia.phoneReminderDismissed";

function wireReminder() {
  const dismiss = byId("phoneReminderDismiss");

  if (!dismiss) return;

  dismiss.addEventListener("click", () => {
    byId("phoneReminder").style.display = "none";

    try { localStorage.setItem(REMINDER_KEY, "1"); } catch (err) { /* private browsing: it will just show again */ }
  });
}

function showReminderIfNeeded(user) {
  const banner = byId("phoneReminder");

  if (!banner) return;

  let dismissed = false;

  try { dismissed = localStorage.getItem(REMINDER_KEY) === "1"; } catch (err) { /* treat as not dismissed */ }

  banner.style.display = user && !recoveryPhone && !dismissed ? "block" : "none";
}

wireRecovery();
wireSecurity();
wireReminder();

onAuthStateChanged(auth, async (user) => {
  // Only the pages that show the recovery number need to look it up.
  if (byId("securityPhoneSection") || byId("phoneReminder")) {
    await loadRecoveryPhone(user);
  }

  renderSecurity(user);
  showReminderIfNeeded(user);
});
