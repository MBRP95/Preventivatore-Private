// Backend del preventivatore luce e gas.
// Secret da impostare su Cloudflare (wrangler secret put), mai nel codice:
//   SELLER_PASSWORD   password dello shop assistant
//   ADMIN_PASSWORD   password di chi pubblica i listini luce e gas
//   GITHUB_TOKEN      PAT con Contents su MBRP95/Preventivatore, solo index.html di main
//   OFFLINE_SIGNING_JWK  chiave privata ECDSA P-256, generata con node worker/generate-offline-key.mjs
// Binding KV: SESSIONS. Senza questo binding il login viene rifiutato, perché il logout
// deve poter cancellare la sessione. I preventivi e i dati dei clienti non vengono salvati qui.
//
// Le password di prova negozio, admin e i PIN 1001 e 1002 sono rifiutate anche se messe nei secret.

import { assessStoredGrant, importPrivateJwk, publicJwkOf, signOfflineToken } from "./offline.js";
import { publishBlockReason, readListini, writeListini } from "./github.js";

const SESSION_TTL = 12 * 60 * 60;
const FAIL_LIMIT = 8;
const FAIL_WINDOW = 15 * 60;
const BURNED = new Set(["negozio", "admin", "1001", "1002"]);

function json(data, status, extra) {
  const headers = new Headers(extra || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status: status || 200, headers });
}

function clientIp(request) {
  const cf = request.headers.get("CF-Connecting-IP");
  if (cf) return cf;
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "local";
}

function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const piece = part.trim();
    if (piece.startsWith(name + "=")) return decodeURIComponent(piece.slice(name.length + 1));
  }
  return "";
}

function sessionCookie(id, request, maxAge) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const age = maxAge ? "; Max-Age=" + maxAge : "; Max-Age=0";
  return "pv_session=" + (maxAge ? id : "") + "; HttpOnly; Path=/; SameSite=Lax" + age + secure;
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text))));
}

function sameBytes(a, b) {
  let diff = a.length === b.length ? 0 : 1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

function usableSecret(value) {
  const text = String(value || "");
  if (text.length < 8) return "";
  if (BURNED.has(text)) return "";
  return text;
}

async function matchRole(password, env) {
  const seller = usableSecret(env.SELLER_PASSWORD);
  const admin = usableSecret(env.ADMIN_PASSWORD);
  if (!seller && !admin) return { error: "unconfigured" };
  if (seller && admin && seller === admin) return { error: "unconfigured" };
  const got = await sha256(password);
  const adminDigest = await sha256(admin || "admin-unset");
  const sellerDigest = await sha256(seller || "seller-unset");
  const adminOk = !!admin && sameBytes(got, adminDigest);
  const sellerOk = !!seller && sameBytes(got, sellerDigest);
  if (adminOk) return { role: "admin" };
  if (sellerOk) return { role: "seller" };
  return { error: "invalid" };
}

function randomId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function tooMany(env, ip) {
  const raw = await env.SESSIONS.get("fail:" + ip);
  return (Number(raw) || 0) >= FAIL_LIMIT;
}

async function markFail(env, ip) {
  const key = "fail:" + ip;
  const n = (Number(await env.SESSIONS.get(key)) || 0) + 1;
  await env.SESSIONS.put(key, String(n), { expirationTtl: FAIL_WINDOW });
}

async function clearFail(env, ip) {
  await env.SESSIONS.delete("fail:" + ip);
}

async function createSession(env, role) {
  const id = randomId();
  const csrf = randomId();
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  await env.SESSIONS.put("sess:" + id, JSON.stringify({ role, sub: role, exp, csrf }), { expirationTtl: SESSION_TTL });
  return { id, csrf, exp, role, sub: role };
}

async function readSession(env, request) {
  if (!env.SESSIONS) return null;
  const id = readCookie(request, "pv_session");
  if (!id) return null;
  const raw = await env.SESSIONS.get("sess:" + id);
  if (!raw) return null;
  let row;
  try { row = JSON.parse(raw); } catch (e) { return null; }
  if (!row || !row.exp || row.exp * 1000 <= Date.now()) {
    await env.SESSIONS.delete("sess:" + id);
    return null;
  }
  if (row.role !== "seller" && row.role !== "admin") return null;
  return { id, ...row };
}

function csrfOk(request, session) {
  const header = request.headers.get("x-csrf-token") || "";
  if (!session || !session.csrf || header.length !== session.csrf.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ session.csrf.charCodeAt(i);
  return diff === 0;
}

let signingKeyPromise = null;
let signingKeySource = "";

async function signingKey(env) {
  const raw = String(env.OFFLINE_SIGNING_JWK || "");
  if (!raw) return null;
  if (!signingKeyPromise || signingKeySource !== raw) {
    signingKeySource = raw;
    signingKeyPromise = importPrivateJwk(raw).catch((error) => {
      signingKeyPromise = null;
      throw error;
    });
  }
  return signingKeyPromise;
}

async function offlineGrant(env, role) {
  try {
    const key = await signingKey(env);
    if (!key) return { offline: null, offlineError: "Chiave di firma offline non configurata." };
    const signed = await signOfflineToken(key, { sub: role, role, nowMs: Date.now() });
    const publicKey = await publicJwkOf(key);
    return {
      offline: {
        token: signed.token,
        publicKey,
        expiresAt: new Date(signed.payload.exp * 1000).toISOString()
      }
    };
  } catch (e) {
    return { offline: null, offlineError: "Chiave di firma offline non valida." };
  }
}

function sessionBody(session, grant) {
  return {
    ok: true,
    role: session.role,
    sub: session.sub,
    csrf: session.csrf,
    expiresAt: new Date(session.exp * 1000).toISOString(),
    offline: grant.offline,
    offlineError: grant.offlineError || ""
  };
}

async function requireSession(request, env) {
  if (!env.SESSIONS) return { error: json({ error: "Sessioni non configurate." }, 503) };
  const session = await readSession(env, request);
  if (!session) return { error: json({ error: "Accesso scaduto." }, 401) };
  return { session };
}

function cleanMessage(value) {
  const text = String(value || "Aggiorna i listini.").replace(/[\r\n\u0000]/g, " ").trim();
  return text.slice(0, 120) || "Aggiorna i listini.";
}

async function api(request, env, url) {
  if (!env.SESSIONS && url.pathname !== "/api/public-index") {
    return json({ error: "Sessioni non configurate." }, 503);
  }
  if (request.method === "POST" && url.pathname === "/api/login") return login(request, env);
  if (request.method === "GET" && url.pathname === "/api/session") return session(request, env);
  if (request.method === "POST" && url.pathname === "/api/logout") return logout(request, env);
  if (request.method === "POST" && url.pathname === "/api/offline-token") return offlineToken(request, env);
  if (request.method === "GET" && url.pathname === "/api/offline-pubkey") return offlinePubkey(env);
  if (request.method === "GET" && url.pathname === "/api/admin/files") return adminFiles(request, env);
  if (request.method === "POST" && url.pathname === "/api/admin/publish") return adminPublish(request, env);
  if (request.method === "GET" && url.pathname === "/api/public-index") return publicIndex(env);
  if (url.pathname === "/api/quotes" || url.pathname.startsWith("/api/quotes/")) {
    return json({ error: "I preventivi restano sul computer." }, 404);
  }
  return json({ error: "Non trovato." }, 404);
}

async function login(request, env) {
  const ip = clientIp(request);
  if (await tooMany(env, ip)) return json({ error: "Troppi tentativi. Riprova tra qualche minuto." }, 429);
  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  const password = String(body.password || "");
  const found = await matchRole(password, env);
  if (found.error === "unconfigured") return json({ error: "Accesso non configurato." }, 503);
  if (found.error) {
    await markFail(env, ip);
    return json({ error: "Credenziali non valide." }, 401);
  }
  await clearFail(env, ip);
  const created = await createSession(env, found.role);
  const grant = await offlineGrant(env, found.role);
  return json(sessionBody(created, grant), 200, { "set-cookie": sessionCookie(created.id, request, SESSION_TTL) });
}

async function session(request, env) {
  const gate = await requireSession(request, env);
  if (gate.error) return gate.error;
  const grant = await offlineGrant(env, gate.session.role);
  return json(sessionBody(gate.session, grant));
}

async function logout(request, env) {
  const gate = await requireSession(request, env);
  if (gate.error) return gate.error;
  if (!csrfOk(request, gate.session)) return json({ error: "Richiesta non valida." }, 403);
  await env.SESSIONS.delete("sess:" + gate.session.id);
  return json({ ok: true }, 200, { "set-cookie": sessionCookie("", request, 0) });
}

async function offlineToken(request, env) {
  const gate = await requireSession(request, env);
  if (gate.error) return gate.error;
  if (!csrfOk(request, gate.session)) return json({ error: "Richiesta non valida." }, 403);
  const grant = await offlineGrant(env, gate.session.role);
  if (!grant.offline) return json({ error: grant.offlineError }, 503);
  return json({ ok: true, role: gate.session.role, sub: gate.session.sub, ...grant });
}

async function offlinePubkey(env) {
  try {
    const key = await signingKey(env);
    if (!key) return json({ error: "Chiave di firma offline non configurata." }, 503);
    return json({ publicKey: await publicJwkOf(key) });
  } catch (e) {
    return json({ error: "Chiave di firma offline non valida." }, 503);
  }
}

async function adminFiles(request, env) {
  const gate = await requireSession(request, env);
  if (gate.error) return gate.error;
  if (gate.session.role !== "admin") return json({ error: "Operazione riservata all'amministratore." }, 403);
  const file = await readListini(env);
  if (file.error) return json({ error: file.error }, file.status || 502);
  return json({ html: file.html });
}

async function adminPublish(request, env) {
  const gate = await requireSession(request, env);
  if (gate.error) return gate.error;
  if (!csrfOk(request, gate.session)) return json({ error: "Richiesta non valida." }, 403);
  if (gate.session.role !== "admin") return json({ error: "Operazione riservata all'amministratore." }, 403);
  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  const html = String(body.html || "");
  const blocked = publishBlockReason(html);
  if (blocked) return json({ error: blocked }, 400);
  const written = await writeListini(env, html, cleanMessage(body.message));
  if (written.error) return json({ error: written.error }, written.status || 502);
  return json({ ok: true });
}

async function publicIndex(env) {
  const file = await readListini(env);
  if (file.error) return json({ error: file.error }, file.status || 502);
  return new Response(file.html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  });
}

function patchEditorFallback(html) {
  const before = [
    "      publishMode=true;",
    '      $("fileGestionale").closest("label").classList.add("hidden");',
    '      $("fileCliente").closest("label").classList.add("hidden");',
    '      $("download").textContent="Pubblica listini";',
    '      const html=await shellWithCatalog(data.html||"");',
    '      if(kindOf(html)!=="unito") throw Error("Il file dei listini non è l\'index del sito.");',
    '      loadCombined(html,"index.html");',
    '      $("status").textContent="Listino letto dal sito. Pubblica per aggiornarlo."+scheduleLoadedNote();',
    "    }catch(err){",
    '      $("status").textContent=err&&err.message?err.message:String(err);',
  ].join("\n");
  const after = [
    '      const html=await shellWithCatalog(data.html||"");',
    '      if(kindOf(html)!=="unito") throw Error("Il file dei listini non è l\'index del sito.");',
    '      loadCombined(html,"index.html");',
    "      // Nascondi il caricamento manuale solo dopo il caricamento completo.",
    "      publishMode=true;",
    '      $("fileGestionale").closest("label").classList.add("hidden");',
    '      $("fileCliente").closest("label").classList.add("hidden");',
    '      $("download").textContent="Pubblica listini";',
    '      $("status").textContent="Listino letto dal sito. Pubblica per aggiornarlo."+scheduleLoadedNote();',
    "    }catch(err){",
    "      // Se il caricamento online fallisce, mantieni disponibile il fallback manuale.",
    "      publishMode=false;",
    '      csrfToken="";',
    "      loaded.gestionale=null;",
    "      loaded.cliente=null;",
    "      catalog=null;",
    "      baselineCatalog=null;",
    "      dirty=false;",
    '      $("fileGestionale").closest("label").classList.remove("hidden");',
    '      $("fileCliente").closest("label").classList.remove("hidden");',
    '      $("download").textContent="Scarica HTML aggiornato";',
    '      $("download").disabled=true;',
    '      $("reset").disabled=true;',
    '      $("status").textContent="Caricamento online non riuscito: "+(err&&err.message?err.message:String(err))+" Puoi continuare caricando manualmente Gestionale e Preventivo cliente.";',
  ].join("\n");
  let patched = html.includes(before) ? html.replace(before, after) : html;
  const parserPatches = [
    [
      'id="promo-catalog">([\\s\\S]*?)%%EDITOR_ESCAPED_SCRIPT%%>',
      'id="promo-catalog">([\\s\\S]*?)(?:%%EDITOR_ESCAPED_SCRIPT%%>|\\x3C\\/script>)'
    ],
    [
      'id="promo-catalog-next">([\\s\\S]*?)%%EDITOR_ESCAPED_SCRIPT%%>',
      'id="promo-catalog-next">([\\s\\S]*?)(?:%%EDITOR_ESCAPED_SCRIPT%%>|\\x3C\\/script>)'
    ],
    [
      'id="promo-catalog-next">[\\s\\S]*?%%EDITOR_ESCAPED_SCRIPT%%>',
      'id="promo-catalog-next">[\\s\\S]*?(?:%%EDITOR_ESCAPED_SCRIPT%%>|\\x3C\\/script>)'
    ],
    [
      'id="promo-catalog">[\\s\\S]*?%%EDITOR_ESCAPED_SCRIPT%%>',
      'id="promo-catalog">[\\s\\S]*?(?:%%EDITOR_ESCAPED_SCRIPT%%>|\\x3C\\/script>)'
    ]
  ];
  for (const [from, to] of parserPatches) patched = patched.replaceAll(from, to);
  // L’editor viene scritto in un iframe about:blank: usa l’origine della pagina contenitrice per avviare il caricamento online.
  patched = patched.replaceAll('if(location.protocol==="http:"||location.protocol==="https:"){', 'if(location.protocol==="http:"||location.protocol==="https:"||(window.parent&&window.parent!==window&&/^https?:$/.test(window.parent.location.protocol))){');
  patched = patched.replaceAll('fetch("/api/session",{credentials:"same-origin",cache:"no-store"})', 'fetch(new URL("/api/session",window.parent&&window.parent!==window?window.parent.location.href:location.href),{credentials:"same-origin",cache:"no-store"})');
  patched = patched.replaceAll('fetch("/api/admin/files",{credentials:"same-origin",cache:"no-store"})', 'fetch(new URL("/api/admin/files",window.parent&&window.parent!==window?window.parent.location.href:location.href),{credentials:"same-origin",cache:"no-store"})');
  // Il ruolo privilegiato del backend è admin: allinea il bootstrap dell'editor incorporato.
  patched = patched.replaceAll('session.role!=="editor"', 'session.role!=="admin"');
  // Allinea il gate principale: admin apre l'editor, seller apre il gestionale.
  patched = patched.replaceAll('payload.role!=="seller"&&payload.role!=="editor"', 'payload.role!=="seller"&&payload.role!=="admin"');
  patched = patched.replaceAll('if(role==="editor")', 'if(role==="admin")');
  patched = patched.replaceAll('session.role==="seller"||session.role==="editor"', 'session.role==="seller"||session.role==="admin"');
  return patched;
}

export async function handle(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return api(request, env, url);
  if (env.ASSETS && env.ASSETS.fetch) {
    const response = await env.ASSETS.fetch(request);
    if ((url.pathname === "/" || url.pathname === "/index.html") && response.ok &&
        (response.headers.get("content-type") || "").includes("text/html")) {
      const original = await response.clone().text();
      const patched = patchEditorFallback(original);
      if (patched !== original) {
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.set("cache-control", "no-store");
        return new Response(patched, {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      }
    }
    return response;
  }
  return new Response("Non trovato.", { status: 404 });
}

export default { fetch: handle };

export const __test = { assessStoredGrant };
