// Storage security-rules tests (return photos), against the local Storage
// emulator's REST API:
//
//   npm run test:rules
//
// Uses unsigned tokens, which the emulator accepts and evaluates rules against.

const test = require("node:test");
const assert = require("node:assert/strict");

const PROJECT = "demo-lesovia";
const HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST || process.env.STORAGE_EMULATOR_HOST;
const BUCKET = `${PROJECT}.appspot.com`;
const BASE = `http://${HOST}/v0/b/${BUCKET}/o`;

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

function tokenFor(uid) {
  const now = Math.floor(Date.now() / 1000);

  return `${b64({ alg: "none", typ: "JWT" })}.${b64({
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: uid, user_id: uid,
    auth_time: now, iat: now, exp: now + 3600, firebase: { identity_provider: "custom", sign_in_provider: "custom" },
  })}.`;
}

const headersFor = (uid) => (uid ? { Authorization: `Bearer ${tokenFor(uid)}` } : {});

// A multipart upload, the way the Firebase SDK does it, so the object gets the
// content type the rules check (a bare "media" upload is stored as
// application/octet-stream and would be refused for the wrong reason).
const upload = (uid, path, { type = "image/jpeg", bytes = 10 } = {}) => {
  const boundary = "lesoviaBoundary";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ name: path, contentType: type })}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`),
    Buffer.alloc(bytes, 1),
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  return fetch(`${BASE}?name=${encodeURIComponent(path)}`, {
    method: "POST",
    headers: { ...headersFor(uid), "Content-Type": `multipart/related; boundary=${boundary}`, "X-Goog-Upload-Protocol": "multipart" },
    body,
  });
};

const download = (uid, path) => fetch(`${BASE}/${encodeURIComponent(path)}?alt=media`, { headers: headersFor(uid) });

const ok = (res) => assert.equal(res.status, 200, `expected allowed, got ${res.status}`);
const denied = (res) => assert.ok([401, 403].includes(res.status), `expected denied, got ${res.status}`);

const PATH = "returnPhotos/buyer1/seller1/ret-00000000000000000001/p1.jpg";

test("return photos: the buyer can upload an image into their own return folder", async () => {
  ok(await upload("buyer1", PATH));
});

test("return photos: nobody else can upload there, and only images under 5MB", async () => {
  denied(await upload("seller1", "returnPhotos/buyer1/seller1/ret-00000000000000000002/p.jpg"));
  denied(await upload("buyer2", "returnPhotos/buyer1/seller1/ret-00000000000000000003/p.jpg"));
  denied(await upload(null, "returnPhotos/buyer1/seller1/ret-00000000000000000004/p.jpg"));
  denied(await upload("buyer1", "returnPhotos/buyer1/seller1/ret-00000000000000000005/p.pdf", { type: "application/pdf" }));
  denied(await upload("buyer1", "returnPhotos/buyer1/seller1/ret-00000000000000000006/big.jpg", { bytes: 5 * 1024 * 1024 + 1 }));
});

test("return photos: only the buyer and the named seller can read them", async () => {
  ok(await upload("buyer1", PATH));

  ok(await download("buyer1", PATH));
  ok(await download("seller1", PATH));
  denied(await download("buyer2", PATH));
  denied(await download("seller2", PATH));
  denied(await download(null, PATH));
});

test("partner banner images: anyone can read, but nobody can write from a client", async () => {
  const path = "partners/spot0000000000000001/image-abc.png";

  // The server (Admin SDK) stores the image; the emulator accepts "Bearer owner" for that.
  const boundary = "lesoviaBoundary";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ name: path, contentType: "image/png" })}\r\n--${boundary}\r\nContent-Type: image/png\r\n\r\n`),
    Buffer.alloc(10, 1),
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const stored = await fetch(`${BASE}?name=${encodeURIComponent(path)}`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": `multipart/related; boundary=${boundary}`, "X-Goog-Upload-Protocol": "multipart" },
    body,
  });

  ok(stored);

  ok(await download(null, path));
  ok(await download("buyer1", path));

  denied(await upload("seller1", "partners/spot0000000000000002/image.png", { type: "image/png" }));
  denied(await upload("admin1", "partners/spot0000000000000003/image.png", { type: "image/png" }));
  denied(await upload(null, "partners/spot0000000000000004/image.png", { type: "image/png" }));
});
