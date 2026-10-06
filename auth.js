// Google sign-in + signed session cookies.
// Uses only Web Crypto and fetch, so it runs on Workers, Node 20+, Deno, or Bun unchanged.

const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const SESSION_COOKIE = "bar540_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToBase64Url(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Accepts either a plain string env var or a secret-store style binding with .get().
export async function readSecret(value) {
  if (!value) return null;
  return typeof value === "string" ? value : await value.get();
}

export function allowedEmails(raw) {
  return (raw || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// --- Google ID token verification ---

let certCache = { keys: null, expires: 0 };

async function googleKeys() {
  if (certCache.keys && Date.now() < certCache.expires) return certCache.keys;
  const resp = await fetch(GOOGLE_CERTS_URL);
  if (!resp.ok) throw new Error("Could not fetch Google signing keys");
  const { keys } = await resp.json();
  const maxAge = Number((resp.headers.get("cache-control") || "").match(/max-age=(\d+)/)?.[1] || 3600);
  certCache = { keys, expires: Date.now() + maxAge * 1000 };
  return keys;
}

// Returns the token's claims if it is a valid, unexpired Google ID token for our client; otherwise throws.
export async function verifyGoogleIdToken(token, clientId) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(decoder.decode(base64UrlToBytes(headerB64)));
  const claims = JSON.parse(decoder.decode(base64UrlToBytes(payloadB64)));

  if (header.alg !== "RS256") throw new Error("Unexpected token algorithm");
  const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(sigB64),
    encoder.encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) throw new Error("Bad token signature");

  const now = Math.floor(Date.now() / 1000);
  if (!GOOGLE_ISSUERS.includes(claims.iss)) throw new Error("Wrong issuer");
  if (claims.aud !== clientId) throw new Error("Wrong audience");
  if (!claims.exp || claims.exp < now) throw new Error("Token expired");
  if (claims.email_verified !== true && claims.email_verified !== "true") throw new Error("Email not verified");
  return claims;
}

// --- Session cookie: base64url(JSON payload) + "." + base64url(HMAC-SHA256) ---

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function createSessionCookie({ email, name }, secret, secure) {
  const payload = bytesToBase64Url(
    encoder.encode(JSON.stringify({ email, name, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }))
  );
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload));
  return cookieHeader(`${payload}.${bytesToBase64Url(sig)}`, SESSION_TTL_SECONDS, secure);
}

export function clearSessionCookie(secure) {
  return cookieHeader("", 0, secure);
}

function cookieHeader(value, maxAge, secure) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

// Returns { email, name } for a valid session whose email is still allowlisted, else null.
export async function readSession(request, secret, allowed) {
  if (!secret) return null;
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;

  const [payload, sig] = match[1].split(".");
  if (!payload || !sig) return null;
  try {
    // crypto.subtle.verify compares in constant time.
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      base64UrlToBytes(sig),
      encoder.encode(payload)
    );
    if (!ok) return null;
    const session = JSON.parse(decoder.decode(base64UrlToBytes(payload)));
    if (!session.exp || session.exp < Math.floor(Date.now() / 1000)) return null;
    if (!allowed.includes(String(session.email).toLowerCase())) return null;
    return { email: session.email, name: session.name || null };
  } catch (e) {
    return null;
  }
}
