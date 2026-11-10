import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "../worker/index.js";
import { assessStoredGrant, importPrivateJwk, publicJwkOf, signOfflineToken, verifyOfflineToken } from "../worker/offline.js";

const SELLER = "seller-test-pass";
const ADMIN = "admin-test-pass";

function memoryKv() {
  const map = new Map();
  return {
    async get(key) {
      const row = map.get(key);
      if (!row) return null;
      if (row.exp && Date.now() > row.exp) {
        map.delete(key);
        return null;
      }
      return row.value;
    },
    async put(key, value, opts = {}) {
      map.set(key, { value, exp: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 });
    },
    async delete(key) { map.delete(key); }
  };
}

const sessions = memoryKv();
const github = { sha: "abc123", html: "" };
let signingJwk = "";

function listiniHtml(extra = "") {
  return "<!doctype html><html><head><meta name=\"page-rev\" content=\"2026-11-08T23:10:00.000Z\"></head><body>" +
    "<script type=\"application/json\" id=\"promo-catalog\">{\"flat\":{},\"commodity\":{}}</script>" +
    "<script type=\"text/plain\" id=\"cliente-app\">cliente</script>" +
    "<script type=\"text/plain\" id=\"editor-app\">editor</script>" +
    extra + "x".repeat(1100) + "</body></html>";
}

function env(extra = {}) {
  return {
    SESSIONS: sessions,
    SELLER_PASSWORD: SELLER,
    ADMIN_PASSWORD: ADMIN,
    GITHUB_TOKEN: "test-token",
    OFFLINE_SIGNING_JWK: signingJwk,
    ...extra
  };
}

async function call(path, { method = "GET", body, cookie, csrf, headers = {}, ip = "203.0.113.10" } = {}, customEnv) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("CF-Connecting-IP", ip);
  if (cookie) requestHeaders.set("cookie", "pv_session=" + cookie);
  if (csrf) requestHeaders.set("x-csrf-token", csrf);
  if (body !== undefined) requestHeaders.set("content-type", "application/json");
  const request = new Request("https://preventivatore.test" + path, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const response = await handle(request, customEnv || env());
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: response.status, data, headers: response.headers, text };
}

function cookieOf(response) {
  const raw = response.headers.get("set-cookie") || "";
  const match = raw.match(/pv_session=([^;]*)/);
  return match ? match[1] : "";
}

test("backend di accesso e listini", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  signingJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
  github.html = listiniHtml();
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    assert.equal(options.headers.Authorization, "Bearer test-token");
    assert.equal(JSON.stringify(options.headers).includes("seller-test-pass"), false);
    if (target.includes("/contents/index.html") && (!options.method || options.method === "GET")) {
      return new Response(JSON.stringify({ sha: github.sha, encoding: "none" }), { status: 200 });
    }
    if (target.includes("/git/blobs/")) return new Response(github.html, { status: 200 });
    if (target.includes("/contents/index.html") && options.method === "PUT") {
      const body = JSON.parse(options.body);
      assert.equal(body.sha, github.sha);
      assert.equal(body.branch, "main");
      assert.equal(target.includes("/Preventivatore/contents/index.html"), true);
      assert.equal(String(options.body).includes("test-token"), false);
      if (body.message === "conflitto") return new Response("{}", { status: 409 });
      github.sha = "def456";
      github.html = new TextDecoder().decode(Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0)));
      return new Response(JSON.stringify({ content: { sha: github.sha } }), { status: 200 });
    }
    throw new Error("URL non previsto " + target);
  };

  await t.test("login errato, sessione e logout", async () => {
    const bad = await call("/api/login", { method: "POST", body: { password: "sbagliata-12" }, ip: "203.0.113.20" });
    assert.equal(bad.status, 401);
    assert.equal(bad.data.error, "Credenziali non valide.");
    assert.equal(JSON.stringify(bad.data).includes(SELLER), false);

    const seller = await call("/api/login", { method: "POST", body: { password: SELLER }, ip: "203.0.113.21" });
    assert.equal(seller.status, 200);
    assert.equal(seller.data.role, "seller");
    assert.equal(seller.data.sub, "seller");
    assert.ok(seller.data.csrf);
    assert.ok(seller.data.offline.token.includes("."));
    const cookie = seller.headers.get("set-cookie");
    assert.equal(cookie.includes("HttpOnly"), true);
    assert.equal(cookie.includes("Secure"), true);
    assert.equal(cookie.includes("SameSite=Lax"), true);
    const id = cookieOf(seller);

    const session = await call("/api/session", { cookie: id });
    assert.equal(session.status, 200);
    assert.equal(session.data.role, "seller");

    const missing = await call("/api/logout", { method: "POST", cookie: id });
    assert.equal(missing.status, 403);
    const gone = await call("/api/logout", { method: "POST", cookie: id, csrf: seller.data.csrf });
    assert.equal(gone.status, 200);
    const after = await call("/api/session", { cookie: id });
    assert.equal(after.status, 401);
  });

  await t.test("admin pubblica solo index.html dei listini luce e gas", async () => {
    const admin = await call("/api/login", { method: "POST", body: { password: ADMIN }, ip: "203.0.113.30" });
    assert.equal(admin.status, 200);
    const id = cookieOf(admin);
    const read = await call("/api/admin/files", { cookie: id });
    assert.equal(read.status, 200);
    assert.equal(read.data.html.includes("promo-catalog"), true);

    const seller = await call("/api/login", { method: "POST", body: { password: SELLER }, ip: "203.0.113.31" });
    const denied = await call("/api/admin/publish", {
      method: "POST",
      cookie: cookieOf(seller),
      csrf: seller.data.csrf,
      body: { html: listiniHtml(), message: "no" }
    });
    assert.equal(denied.status, 403);

    const blocked = await call("/api/admin/publish", {
      method: "POST",
      cookie: id,
      csrf: admin.data.csrf,
      body: { html: listiniHtml("<b id=\"githubToken\"></b>"), message: "x" }
    });
    assert.equal(blocked.status, 400);

    const published = await call("/api/admin/publish", {
      method: "POST",
      cookie: id,
      csrf: admin.data.csrf,
      body: { html: listiniHtml("<!--offerta-->"), message: "Aggiorna i listini." }
    });
    assert.equal(published.status, 200);
    assert.equal(github.html.includes("offerta"), true);

    const conflict = await call("/api/admin/publish", {
      method: "POST",
      cookie: id,
      csrf: admin.data.csrf,
      body: { html: listiniHtml(), message: "conflitto" }
    });
    assert.equal(conflict.status, 409);
  });

  await t.test("i preventivi non vengono accettati dal server", async () => {
    const response = await call("/api/quotes", {
      method: "POST",
      body: { customer: { name: "Mario Rossi", email: "mario@example.com", phone: "333" } }
    });
    assert.equal(response.status, 404);
    assert.equal(response.text.includes("mario@example.com"), false);
  });

  await t.test("token offline valido, alterato, scaduto e orologio indietro", async () => {
    const key = await importPrivateJwk(signingJwk);
    const publicKey = await publicJwkOf(key);
    const now = Date.now();
    const signed = await signOfflineToken(key, { sub: "seller", role: "seller", nowMs: now });
    const ok = await verifyOfflineToken(signed.token, publicKey, now + 1000);
    assert.equal(ok.ok, true);
    assert.equal(ok.payload.exp - ok.payload.iat, 30 * 24 * 60 * 60);

    const dot = signed.token.indexOf(".");
    const signature = signed.token.slice(dot + 1);
    const broken = signed.token.slice(0, dot + 1) + (signature[0] === "A" ? "B" : "A") + signature.slice(1);
    assert.equal((await verifyOfflineToken(broken, publicKey, now + 1000)).ok, false);
    assert.equal((await verifyOfflineToken(signed.token, publicKey, now + 31 * 24 * 60 * 60 * 1000)).reason, "expired");
    const clock = await assessStoredGrant({ token: signed.token, publicKey, lastSeen: now + 60 * 60 * 1000 }, now);
    assert.equal(clock.reason, "clock");
  });

  await t.test("password storiche e secret assenti", async () => {
    for (const password of ["negozio", "admin", "1001", "1002"]) {
      const response = await call("/api/login", { method: "POST", body: { password }, ip: "198.51.100." + password.length });
      assert.notEqual(response.status, 200);
    }
    const burned = await call("/api/login", { method: "POST", body: { password: "negozio" }, ip: "198.51.100.9" }, env({ SELLER_PASSWORD: "negozio", ADMIN_PASSWORD: "" }));
    assert.equal(burned.status, 503);
    const bare = await call("/api/login", { method: "POST", body: { password: SELLER }, ip: "198.51.100.10" }, env({ SELLER_PASSWORD: "", ADMIN_PASSWORD: "" }));
    assert.equal(bare.status, 503);
    const same = await call("/api/login", { method: "POST", body: { password: SELLER }, ip: "198.51.100.11" }, env({ SELLER_PASSWORD: SELLER, ADMIN_PASSWORD: SELLER }));
    assert.equal(same.status, 503);
  });

  await t.test("troppi tentativi vengono fermati", async () => {
    const ip = "203.0.113.77";
    for (let i = 0; i < 8; i++) {
      const response = await call("/api/login", { method: "POST", body: { password: "tentativo-errato" }, ip });
      assert.equal(response.status, 401);
    }
    const blocked = await call("/api/login", { method: "POST", body: { password: SELLER }, ip });
    assert.equal(blocked.status, 429);
  });

  await t.test("l'admin cambia le password e le sessioni precedenti scadono", async () => {
    const before = await call("/api/access-gen");
    assert.equal(before.status, 200);
    assert.equal(before.data.gen, 0);
    const admin = await call("/api/login", { method: "POST", body: { password: ADMIN }, ip: "203.0.113.40" });
    const seller = await call("/api/login", { method: "POST", body: { password: SELLER }, ip: "203.0.113.41" });
    const denied = await call("/api/admin/passwords", {
      method: "POST",
      cookie: cookieOf(seller),
      csrf: seller.data.csrf,
      body: { seller: "seller-nuova-99" }
    });
    assert.equal(denied.status, 403);
    const missing = await call("/api/admin/passwords", {
      method: "POST",
      cookie: cookieOf(admin),
      body: { seller: "seller-nuova-99" }
    });
    assert.equal(missing.status, 403);
    const short = await call("/api/admin/passwords", {
      method: "POST",
      cookie: cookieOf(admin),
      csrf: admin.data.csrf,
      body: { admin: "corta" }
    });
    assert.equal(short.status, 400);
    const changed = await call("/api/admin/passwords", {
      method: "POST",
      cookie: cookieOf(admin),
      csrf: admin.data.csrf,
      body: { seller: "seller-nuova-99" }
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.gen, 1);
    assert.equal(JSON.stringify(changed.data).includes("seller-nuova-99"), false);
    const oldSeller = await call("/api/login", { method: "POST", body: { password: SELLER }, ip: "203.0.113.42" });
    assert.equal(oldSeller.status, 401);
    const newSeller = await call("/api/login", { method: "POST", body: { password: "seller-nuova-99" }, ip: "203.0.113.43" });
    assert.equal(newSeller.status, 200);
    assert.equal(newSeller.data.role, "seller");
    const stillAdmin = await call("/api/session", { cookie: cookieOf(admin) });
    assert.equal(stillAdmin.status, 200);
    const dropped = await call("/api/session", { cookie: cookieOf(seller) });
    assert.equal(dropped.status, 401);
    await sessions.delete("access:passwords");
  });
});
