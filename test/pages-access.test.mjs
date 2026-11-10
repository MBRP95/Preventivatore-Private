import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

function loadPagesAccess() {
  const code = readFileSync(new URL("../pages-access.js", import.meta.url), "utf8");
  const store = new Map();
  const localStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(String(key));
    }
  };
  const root = {
    localStorage,
    crypto: webcrypto,
    location: { href: "https://mbrp95.github.io/Preventivatore-Private/" },
    fetch: async () => ({ ok: false, status: 404, json: async () => null }),
    document: {
      createElement() {
        return { click() {}, href: "", download: "" };
      }
    },
    URL,
    Blob,
    setTimeout,
    TextEncoder,
    TextDecoder
  };
  root.window = root;
  vm.runInNewContext(code, root, { filename: "pages-access.js" });
  return { PagesAccess: root.PagesAccess, store };
}

function sha256Hex(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

test("pages access matchRole e grant", async () => {
  const { PagesAccess, store } = loadPagesAccess();
  const seller = "negozio-segreto-99";
  const admin = "admin-segreto-99";
  const access = {
    v: 1,
    gen: 2,
    seller: sha256Hex(seller),
    admin: sha256Hex(admin)
  };
  assert.equal(PagesAccess.configured(access), true);
  assert.equal((await PagesAccess.matchRole("nope", access)).error, "invalid");
  assert.equal((await PagesAccess.matchRole(seller, access)).role, "seller");
  assert.equal((await PagesAccess.matchRole(admin, access)).role, "admin");

  PagesAccess.saveGrant("seller", 2);
  const ok = PagesAccess.readGrant();
  assert.equal(ok.ok, true);
  assert.equal(ok.role, "seller");
  PagesAccess.clearGrant();
  assert.equal(PagesAccess.readGrant().ok, false);
  assert.ok(!store.has(PagesAccess.PAGES_GRANT_KEY));
});

test("looksLikeApiMiss riconosce GitHub Pages", () => {
  const { PagesAccess } = loadPagesAccess();
  assert.equal(PagesAccess.looksLikeApiMiss({ status: 405 }, null), true);
  assert.equal(PagesAccess.looksLikeApiMiss({ status: 404 }, null), true);
  assert.equal(PagesAccess.looksLikeApiMiss({ status: 401 }, { error: "Credenziali non valide." }), false);
  assert.equal(PagesAccess.looksLikeApiMiss({ status: 200 }, { role: "seller", csrf: "x" }), false);
});

test("access.json del repository è configurato con hash seller e admin", () => {
  const raw = JSON.parse(readFileSync(new URL("../access.json", import.meta.url), "utf8"));
  const { PagesAccess } = loadPagesAccess();
  assert.equal(raw.v, 1);
  assert.equal(PagesAccess.configured(raw), true);
  assert.match(raw.seller, /^[a-f0-9]{64}$/);
  assert.match(raw.admin, /^[a-f0-9]{64}$/);
  assert.notEqual(raw.seller, raw.admin);
});
