// Pubblica solo index.html sul branch main del repository canonico dei listini.
// Preventivatore-Pubblico è il nome storico: GitHub lo reindirizza a MBRP95/Preventivatore.
// Il client non può scegliere owner, repository, branch o percorso.

export const LISTINI_TARGET = {
  owner: "MBRP95",
  repo: "Preventivatore",
  branch: "main",
  path: "index.html"
};

const BANNED = [
  "preventivatore-github-token",
  'id="githubToken"',
  "id='githubToken'",
  'id="site-access"',
  "api.github.com",
  "raw.githubusercontent.com"
];

export function publishBlockReason(html) {
  if (typeof html !== "string" || html.length < 1000 || html.length > 12_000_000) return "File dei listini non riconosciuto.";
  if (!html.includes('id="promo-catalog"') || !html.includes('id="cliente-app"') || !html.includes('id="editor-app"')) {
    return "File dei listini non riconosciuto.";
  }
  for (const needle of BANNED) {
    if (html.includes(needle)) return "Il file contiene il vecchio accesso o un collegamento diretto a GitHub e non può essere pubblicato.";
  }
  return "";
}

function headers(token, accept) {
  return {
    Accept: accept || "application/vnd.github+json",
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
    "User-Agent": "preventivatore-listini",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function base64ToText(content) {
  const clean = String(content || "").replace(/\s/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function api(path) {
  return "https://api.github.com/repos/" + LISTINI_TARGET.owner + "/" + LISTINI_TARGET.repo + path;
}

function githubFailure(status) {
  if (status === 401 || status === 403) return "Il secret GitHub non può leggere o scrivere i listini.";
  if (status === 409) return "Il file sul sito è cambiato. Riapri l'editor.";
  return "Operazione sui listini non riuscita.";
}

export async function readListini(env) {
  if (!env.GITHUB_TOKEN) return { error: "Pubblicazione non configurata.", status: 503 };
  const metaRes = await fetch(api("/contents/" + LISTINI_TARGET.path + "?ref=" + encodeURIComponent(LISTINI_TARGET.branch)), {
    headers: headers(env.GITHUB_TOKEN)
  });
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok || !meta.sha) return { error: githubFailure(metaRes.status), status: 502 };
  let html = "";
  if (meta.encoding === "base64" && meta.content) html = base64ToText(meta.content);
  else {
    const blobRes = await fetch(api("/git/blobs/" + meta.sha), {
      headers: headers(env.GITHUB_TOKEN, "application/vnd.github.raw")
    });
    if (!blobRes.ok) return { error: githubFailure(blobRes.status), status: 502 };
    html = await blobRes.text();
  }
  return { html, sha: meta.sha };
}

export async function writeListini(env, html, message) {
  const blocked = publishBlockReason(html);
  if (blocked) return { error: blocked, status: 400 };
  const current = await readListini(env);
  if (current.error) return current;
  const content = bytesToBase64(new TextEncoder().encode(html));
  const res = await fetch(api("/contents/" + LISTINI_TARGET.path), {
    method: "PUT",
    headers: headers(env.GITHUB_TOKEN),
    body: JSON.stringify({
      message: message || "Aggiorna i listini.",
      content,
      sha: current.sha,
      branch: LISTINI_TARGET.branch
    })
  });
  if (res.status === 409) return { error: "Il file sul sito è cambiato. Riapri l'editor.", status: 409 };
  if (!res.ok) return { error: githubFailure(res.status), status: 502 };
  return { ok: true };
}
