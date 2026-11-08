// Autorizzazione offline firmata con ECDSA P-256.
// La chiave privata resta nel secret OFFLINE_SIGNING_JWK.
// La chiave pubblica può stare nel browser: non permette di creare token validi.
//
// Limite: senza rete il browser confronta la scadenza con l'orologio del dispositivo
// e con l'ultimo istante che l'app stessa ha registrato (lastSeen).
// Se qualcuno sposta l'orologio indietro e modifica anche lastSeen, oppure lascia
// l'orologio fermo prima della scadenza, il controllo offline non può accorgersene.
// La firma impedisce di allungare la scadenza o di cambiare ruolo e utente.

export const OFFLINE_TTL_SEC = 30 * 24 * 60 * 60;
export const CLOCK_SKEW_MS = 2 * 60 * 1000;
export const GRANT_KEY = "preventivatore-offline-grant";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function bytesToB64url(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function b64urlToBytes(text) {
  const pad = "=".repeat((4 - (text.length % 4)) % 4);
  const bin = atob(String(text).replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function importPrivateJwk(jwk) {
  const parsed = typeof jwk === "string" ? JSON.parse(jwk) : jwk;
  return crypto.subtle.importKey(
    "jwk",
    parsed,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"]
  );
}

export async function publicJwkOf(privateKey) {
  const full = await crypto.subtle.exportKey("jwk", privateKey);
  return { kty: full.kty, crv: full.crv, x: full.x, y: full.y, ext: true, key_ops: ["verify"] };
}

export async function signOfflineToken(privateKey, { sub, role, nowMs }) {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + OFFLINE_TTL_SEC;
  const jti = bytesToB64url(crypto.getRandomValues(new Uint8Array(16)));
  const payload = { v: 1, sub, role, iat, exp, jti };
  const data = textEncoder.encode(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data));
  return {
    token: bytesToB64url(data) + "." + bytesToB64url(sig),
    payload
  };
}

export async function verifyOfflineToken(token, publicJwk, nowMs) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  let payload;
  try {
    payload = JSON.parse(textDecoder.decode(b64urlToBytes(parts[0])));
  } catch (e) {
    return { ok: false, reason: "malformed" };
  }
  if (!payload || payload.v !== 1) return { ok: false, reason: "malformed" };
  if (payload.role !== "seller" && payload.role !== "editor") return { ok: false, reason: "malformed" };
  if (payload.sub !== payload.role) return { ok: false, reason: "malformed" };
  if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp) || !payload.jti) return { ok: false, reason: "malformed" };
  if ((payload.exp - payload.iat) * 1000 > OFFLINE_TTL_SEC * 1000 + 5000) return { ok: false, reason: "lifetime" };
  let key;
  try {
    key = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch (e) {
    return { ok: false, reason: "malformed" };
  }
  let valid = false;
  try {
    valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64urlToBytes(parts[1]), b64urlToBytes(parts[0]));
  } catch (e) {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad-signature" };
  if (nowMs > payload.exp * 1000) return { ok: false, reason: "expired" };
  if (nowMs + CLOCK_SKEW_MS < payload.iat * 1000) return { ok: false, reason: "not-yet" };
  return { ok: true, payload };
}

export async function assessStoredGrant(stored, nowMs) {
  if (!stored || !stored.token || !stored.publicKey) return { ok: false, reason: "missing" };
  const checked = await verifyOfflineToken(stored.token, stored.publicKey, nowMs);
  if (!checked.ok) return checked;
  const seen = Number(stored.lastSeen) || 0;
  if (seen && nowMs + CLOCK_SKEW_MS < seen) return { ok: false, reason: "clock" };
  return { ok: true, payload: checked.payload, lastSeen: Math.max(seen, nowMs) };
}
