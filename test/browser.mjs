import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { handle } from "../worker/index.js";

const root = path.resolve(import.meta.dirname, "..");
const port = 8765;
const debugPort = 9334;
const SELLER = "seller-browser-pass";
const EDITOR = "editor-browser-pass";

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const signingJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
const sessions = new Map();
const kv = {
  async get(key) {
    const row = sessions.get(key);
    if (!row) return null;
    if (row.exp && Date.now() > row.exp) { sessions.delete(key); return null; }
    return row.value;
  },
  async put(key, value, opts = {}) {
    sessions.set(key, { value, exp: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 });
  },
  async delete(key) { sessions.delete(key); }
};
const workerEnv = {
  SESSIONS: kv,
  SELLER_PASSWORD: SELLER,
  EDITOR_PASSWORD: EDITOR,
  OFFLINE_SIGNING_JWK: signingJwk
};

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const url = new URL(req.url, "http://127.0.0.1:" + port);
  if (url.pathname.startsWith("/api/")) {
    console.error("API", req.method, url.pathname);
    const request = new Request("http://127.0.0.1:" + port + req.url, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body
    });
    const response = await handle(request, workerEnv);
    const headers = {};
    response.headers.forEach((value, key) => {
      if (key === "set-cookie") headers[key] = value;
      else headers[key] = value;
    });
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  const rel = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = path.join(root, path.normalize(rel));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end("no");
    return;
  }
  const type = file.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8";
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

const userData = "/tmp/chrome-preventivatore-" + process.pid;
fs.rmSync(userData, { recursive: true, force: true });
const chrome = spawn("google-chrome", [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--disable-features=FileSystemAccessAPI,FileSystemAccess",
  "--remote-debugging-port=" + debugPort,
  "--user-data-dir=" + userData,
  "about:blank"
], { stdio: "ignore" });
function stopAll() {
  try { chrome.kill("SIGKILL"); } catch (e) {}
  try { server.close(); } catch (e) {}
}
process.on("unhandledRejection", (error) => {
  stopAll();
  console.error(error);
  process.exit(1);
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function debuggerUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch("http://127.0.0.1:" + debugPort + "/json/list");
      if (res.ok) {
        const pages = await res.json();
        const page = pages.find((item) => item.type === "page");
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch (e) {}
    await sleep(150);
  }
  throw new Error("Chrome non raggiungibile");
}

const ws = new WebSocket(await debuggerUrl());
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
});
let seq = 0;
const pending = new Map();
const requests = [];
const logs = [];
const exceptions = [];
const dialogs = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const item = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) item.reject(new Error(JSON.stringify(msg.error)));
    else item.resolve(msg.result);
    return;
  }
  if (msg.method === "Network.requestWillBeSent") requests.push(msg.params.request.url);
  if (msg.method === "Runtime.consoleAPICalled") logs.push(msg.params.args.map((a) => a.value || a.description).join(" "));
  if (msg.method === "Runtime.exceptionThrown") exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  if (msg.method === "Page.javascriptDialogOpening") {
    dialogs.push(msg.params.message);
    send("Page.handleJavaScriptDialog", { accept: true });
  }
});
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + " " + (result.exceptionDetails.exception?.description || ""));
  return result.result.value;
}
async function waitFor(expression, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = await evaluate(expression);
    if (value) return value;
    await sleep(100);
  }
  const state = await evaluate("JSON.stringify({cls:document.body.className, err:document.getElementById('gateError')&&document.getElementById('gateError').textContent, pick:!!document.getElementById('pickSeller')})").catch((e) => String(e));
  throw new Error("attesa fallita: " + expression + " stato=" + state + " eccezioni=" + exceptions.slice(-3).join(" | "));
}

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? "OK  " : "FAIL") + " " + name + (detail ? " — " + detail : ""));
  if (!ok) failures.push(name + (detail ? ": " + detail : ""));
}

await send("Network.enable");
await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: "http://127.0.0.1:" + port + "/" });
await waitFor("document.getElementById('pickSeller') && document.body.classList.contains('locked')");
check("apertura", true, "scelta Cliente o Shop Assistant");
await evaluate("document.getElementById('pickSeller').click()");
await waitFor("document.body.classList.contains('ask-pass')");
await evaluate(`
  document.getElementById("gatePassword").value=${JSON.stringify("password-sbagliata")};
  document.getElementById("gateForm").requestSubmit();
`);
await waitFor("document.getElementById('gateError') && !document.getElementById('gateError').classList.contains('hidden')");
const wrong = await evaluate("document.getElementById('gateError').textContent");
check("password errata", wrong === "Password non corretta.", wrong);

await evaluate(`
  document.getElementById("gatePassword").value=${JSON.stringify(SELLER)};
  document.getElementById("gateForm").requestSubmit();
`);
await waitFor("!document.body.classList.contains('locked')");
const grant = await evaluate("JSON.parse(localStorage.getItem('preventivatore-offline-grant'))");
check("autorizzazione offline", !!(grant && grant.token && grant.publicKey && grant.token.split('.').length === 2));
check("niente token github", (await evaluate("localStorage.getItem('preventivatore-' + 'github-token')")) == null);
check("nessuna chiamata a GitHub", !requests.some((url) => url.includes("github.com")), requests.filter((url) => url.includes("github") || url.includes("/api/")).join(", "));

await send("Page.captureScreenshot", { format: "png" }).then((shot) => {
  fs.mkdirSync("/opt/cursor/artifacts", { recursive: true });
  fs.writeFileSync("/opt/cursor/artifacts/shop-assistant.png", Buffer.from(shot.data, "base64"));
});

await evaluate(`
  document.getElementById("name").value="Mario Rossi";
  document.getElementById("email").value="mario@example.com";
  document.getElementById("phone").value="3331234567";
  document.getElementById("mixLightFlat").click();
  document.getElementById("mixGasOff").click();
  document.getElementById("lightConsumption").value="2500";
  document.getElementById("lightSpend").value="900";
  document.getElementById("mixCalculate").click();
`);
await waitFor("!!document.querySelector('input[name^=\"pick_\"]')");
await evaluate(`
  document.querySelector('input[name^="pick_"]').click();
  document.getElementById("confirmSelections").click();
`);
await waitFor("!!document.querySelector('.qpage')");
const offerText = await evaluate("document.querySelector('.qpage').innerText.slice(0,400)");
check("calcolo luce", /€|mese|kWh|FLAT/i.test(offerText), offerText.replace(/\\s+/g, " ").slice(0, 180));
const beforePdf = exceptions.length;
await evaluate("document.getElementById('mixPdf').click()");
await sleep(4000);
check("generazione PDF", exceptions.length === beforePdf && dialogs.length === 0, (dialogs.concat(exceptions.slice(beforePdf))).join(" | ") || "nessun errore");
await send("Page.captureScreenshot", { format: "png" }).then((shot) => {
  fs.mkdirSync("/opt/cursor/artifacts", { recursive: true });
  fs.writeFileSync("/opt/cursor/artifacts/preventivo-luce.png", Buffer.from(shot.data, "base64"));
});

const savedGrant = await evaluate("localStorage.getItem('preventivatore-offline-grant')");
await evaluate("window.__logoutStaff().then(()=>window.__backToChoice())");
await waitFor("document.body.classList.contains('locked')");
await evaluate(`
  const raw=JSON.parse(${JSON.stringify(savedGrant)});
  raw.lastSeen=Date.now()+3*60*60*1000;
  localStorage.setItem("preventivatore-offline-grant", JSON.stringify(raw));
  document.getElementById("pickSeller").click();
`);
await waitFor("document.getElementById('gateError') && !document.getElementById('gateError').classList.contains('hidden')");
const clock = await evaluate("document.getElementById('gateError').textContent");
check("orologio indietro", clock.includes("orologio"), clock);
await evaluate("window.__logoutStaff().then(()=>window.__backToChoice())");
await waitFor("document.getElementById('pickSeller') && !document.getElementById('modePick').classList.contains('hidden')");

const cleared = await evaluate("localStorage.getItem('preventivatore-offline-grant')");
check("logout", cleared == null);

await evaluate("document.getElementById('pickSeller').click()");
await waitFor("document.body.classList.contains('ask-pass')");
await evaluate(`
  document.getElementById("gatePassword").value=${JSON.stringify(EDITOR)};
  document.getElementById("gateForm").requestSubmit();
`);
await waitFor("!!document.getElementById('editorFrame')");
await sleep(600);
const editorState = JSON.parse(await evaluate(`
  const doc=document.getElementById("editorFrame").contentDocument;
  JSON.stringify({token:!!(doc&&doc.getElementById("githubToken")), status:doc&&doc.getElementById("status")?doc.getElementById("status").textContent:""});
`));
check("editor senza token", editorState.token === false, editorState.status);

await evaluate("window.__logoutStaff().then(()=>window.__backToChoice())");
await waitFor("document.body.classList.contains('locked') && !document.getElementById('editorFrame')");
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  (function(){
    try { delete Window.prototype.showDirectoryPicker; } catch (e) {}
    try { delete window.showDirectoryPicker; } catch (e) {}
  })();
` });
await evaluate(`(async()=>{
  await new Promise((resolve,reject)=>{
    const done=indexedDB.deleteDatabase("preventivi-firefox-archivio");
    done.onsuccess=()=>resolve();
    done.onerror=()=>resolve();
  });
  await new Promise((resolve,reject)=>{
    const req=indexedDB.open("preventivi-firefox-archivio",1);
    req.onupgradeneeded=()=>{ if(!req.result.objectStoreNames.contains("archive")) req.result.createObjectStore("archive"); };
    req.onerror=()=>reject(req.error);
    req.onsuccess=()=>{
      const db=req.result;
      const tx=db.transaction("archive","readwrite");
      const quote={id:"q-storico",quoteNumber:"PREV-2026-004",customer:{name:"Anna Verdi",email:"anna@example.com",phone:"3330000000",date:"2026-11-08"},sections:{light:{selectedPromo:{name:"Flat"},calculations:{saving:12}}}};
      tx.objectStore("archive").put({name:"OneDrive",files:{"dati/preventivi/PREV-2026-004_Anna.json":{text:JSON.stringify(quote),mtime:Date.now()}},dirs:["dati","dati/preventivi","dati/cestino"]},"current");
      tx.oncomplete=()=>resolve();
      tx.onerror=()=>reject(tx.error);
    };
  });
})()`);
await send("Page.reload", { ignoreCache: true });
await waitFor("document.getElementById('folderStatus') && document.getElementById('folderStatus').textContent.includes('Archivio riaperto')", 12000);
const pickerGone = await evaluate("!('showDirectoryPicker' in window)");
const folder = await evaluate("document.getElementById('folderStatus').textContent");
const history = await evaluate("document.getElementById('history') ? document.getElementById('history').textContent : ''");
check("archivio Firefox", pickerGone && folder.includes("Archivio riaperto") && history.includes("PREV-2026-004"), "picker="+pickerGone+" | "+folder+" | "+history.slice(0,180));

const badConsole = exceptions.filter((line) => !/favicon/i.test(line));
check("niente eccezioni in console", badConsole.length === 0, badConsole.slice(0, 3).join(" | "));

try { ws.close(); } catch (e) {}
stopAll();
if (failures.length) {
  console.log("FALLITI\\n" + failures.join("\\n"));
  process.exit(1);
}
console.log("browser ok");
