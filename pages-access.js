// Accesso locale per GitHub Pages (senza Cloudflare Worker).
// Confronta la password con gli hash SHA-256 in access.json.
// Non è una firma offline: chi altera localStorage può aggirare il cancello,
// come su qualsiasi sito statico. Le password in chiaro non stanno nel file.
(function (root) {
  "use strict";

  var PAGES_GRANT_KEY = "preventivatore-pages-grant";
  var PAGES_OVERRIDE_KEY = "preventivatore-pages-access-override";
  var SKEW_MS = 2 * 60 * 1000;
  var MAX_MS = 30 * 24 * 60 * 60 * 1000;
  var BURNED = { negozio: 1, admin: 1, "1001": 1, "1002": 1 };

  function accessUrl() {
    return new URL("access.json", location.href).href;
  }

  async function sha256Hex(text) {
    var bytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)))
    );
    return Array.from(bytes)
      .map(function (b) {
        return b.toString(16).padStart(2, "0");
      })
      .join("");
  }

  function usablePassword(value) {
    var text = String(value || "");
    if (text.length < 8) return "";
    if (BURNED[text]) return "";
    return text;
  }

  function readOverride() {
    try {
      return JSON.parse(localStorage.getItem(PAGES_OVERRIDE_KEY) || "null");
    } catch (e) {
      return null;
    }
  }

  function writeOverride(access) {
    localStorage.setItem(PAGES_OVERRIDE_KEY, JSON.stringify(access));
  }

  function clearOverride() {
    try {
      localStorage.removeItem(PAGES_OVERRIDE_KEY);
    } catch (e) {}
  }

  function normalizeAccess(raw) {
    if (!raw || Number(raw.v) !== 1) return null;
    return {
      v: 1,
      gen: Number(raw.gen) || 0,
      seller: typeof raw.seller === "string" ? raw.seller.toLowerCase() : "",
      admin: typeof raw.admin === "string" ? raw.admin.toLowerCase() : ""
    };
  }

  async function fetchAccessFile() {
    var res = await fetch(accessUrl(), { cache: "no-store" });
    if (!res.ok) return null;
    var data = await res.json().catch(function () {
      return null;
    });
    return normalizeAccess(data);
  }

  async function loadAccess() {
    var file = null;
    try {
      file = await fetchAccessFile();
    } catch (e) {
      file = null;
    }
    var override = normalizeAccess(readOverride());
    if (override && (!file || override.gen >= file.gen)) return { access: override, source: "override" };
    if (file) return { access: file, source: "file" };
    if (override) return { access: override, source: "override" };
    return { access: null, source: "missing" };
  }

  function configured(access) {
    if (!access) return false;
    if (!access.seller && !access.admin) return false;
    if (access.seller && access.admin && access.seller === access.admin) return false;
    return true;
  }

  async function matchRole(password, access) {
    if (!configured(access)) return { error: "unconfigured" };
    var got = await sha256Hex(password);
    if (access.admin && got === access.admin) return { role: "admin", gen: access.gen };
    if (access.seller && got === access.seller) return { role: "seller", gen: access.gen };
    return { error: "invalid" };
  }

  function readGrant(nowMs) {
    var stored;
    try {
      stored = JSON.parse(localStorage.getItem(PAGES_GRANT_KEY) || "null");
    } catch (e) {
      stored = null;
    }
    if (!stored || (stored.role !== "seller" && stored.role !== "admin")) return { ok: false, reason: "missing" };
    var now = nowMs == null ? Date.now() : nowMs;
    if (!Number.isFinite(stored.exp) || now > stored.exp) return { ok: false, reason: "expired" };
    var seen = Number(stored.lastSeen) || 0;
    if (seen && now + SKEW_MS < seen) return { ok: false, reason: "clock" };
    stored.lastSeen = Math.max(seen, now);
    try {
      localStorage.setItem(PAGES_GRANT_KEY, JSON.stringify(stored));
    } catch (e) {}
    return { ok: true, role: stored.role, gen: Number(stored.gen) || 0, exp: stored.exp };
  }

  function saveGrant(role, gen) {
    var now = Date.now();
    localStorage.setItem(
      PAGES_GRANT_KEY,
      JSON.stringify({
        v: 1,
        role: role,
        gen: Number(gen) || 0,
        iat: now,
        exp: now + MAX_MS,
        lastSeen: now
      })
    );
  }

  function clearGrant() {
    try {
      localStorage.removeItem(PAGES_GRANT_KEY);
    } catch (e) {}
  }

  function looksLikeApiMiss(res, data) {
    if (!res) return true;
    if (res.status === 404 || res.status === 405 || res.status === 501 || res.status === 502) return true;
    if (typeof data !== "object" || data === null) return true;
    return false;
  }

  async function login(password) {
    var loaded = await loadAccess();
    if (!loaded.access) return { error: "missing-file" };
    var found = await matchRole(password, loaded.access);
    if (found.error === "unconfigured") return { error: "unconfigured" };
    if (found.error) return { error: "invalid" };
    saveGrant(found.role, found.gen);
    return { role: found.role, gen: found.gen, source: loaded.source };
  }

  async function updatePasswords(seller, admin) {
    var loaded = await loadAccess();
    var current = loaded.access || { v: 1, gen: 0, seller: "", admin: "" };
    var nextSeller = current.seller;
    var nextAdmin = current.admin;
    if (seller) {
      var okSeller = usablePassword(seller);
      if (!okSeller) return { error: "Shop assistant: password troppo corta o già nota." };
      nextSeller = await sha256Hex(okSeller);
    }
    if (admin) {
      var okAdmin = usablePassword(admin);
      if (!okAdmin) return { error: "Admin: password troppo corta o già nota." };
      nextAdmin = await sha256Hex(okAdmin);
    }
    if (!nextSeller && !nextAdmin) return { error: "Scrivi la password da cambiare." };
    if (nextSeller && nextAdmin && nextSeller === nextAdmin) {
      return { error: "Shop assistant e admin devono avere password diverse." };
    }
    var next = { v: 1, gen: (Number(current.gen) || 0) + 1, seller: nextSeller, admin: nextAdmin };
    writeOverride(next);
    clearGrant();
    return { ok: true, access: next };
  }

  function downloadAccess(access) {
    var blob = new Blob([JSON.stringify(access, null, 2) + "\n"], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "access.json";
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
    }, 1000);
  }

  root.PagesAccess = {
    PAGES_GRANT_KEY: PAGES_GRANT_KEY,
    sha256Hex: sha256Hex,
    loadAccess: loadAccess,
    configured: configured,
    matchRole: matchRole,
    readGrant: readGrant,
    saveGrant: saveGrant,
    clearGrant: clearGrant,
    clearOverride: clearOverride,
    looksLikeApiMiss: looksLikeApiMiss,
    login: login,
    updatePasswords: updatePasswords,
    downloadAccess: downloadAccess
  };
})(window);
