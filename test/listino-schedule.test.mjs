import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const indexSrc = fs.readFileSync(path.join(root, "index.html"), "utf8");

function grabFromIndex(fnName) {
  const start = indexSrc.indexOf("function " + fnName);
  assert.ok(start >= 0, fnName + " assente in index.html");
  let depth = 0;
  let i = indexSrc.indexOf("{", start);
  for (; i < indexSrc.length; i++) {
    const ch = indexSrc[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return indexSrc.slice(start, i);
}

const resolvePublishedPair = new Function(
  grabFromIndex("listinoRomeOffsetMin") +
    "\n" +
    grabFromIndex("listinoRomeMidnightMs") +
    "\n" +
    grabFromIndex("resolvePublishedPair") +
    ";\nreturn resolvePublishedPair;"
)();

function isoRome(daysFromToday) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const base = new Date(Date.now() + daysFromToday * 86400000);
  return fmt.format(base); // YYYY-MM-DD
}

const liveCatalog = {
  flat: { years: 2, expires: "2099-12-31" },
  commodity: {
    light: { private: [{ name: "LIVE_LUCE", fee: 10 }] },
    gas: { private: [{ name: "LIVE_GAS", fee: 20 }] },
  },
  marker: "LIVE_NOW",
};

const nextCatalog = {
  liveFrom: isoRome(1),
  flat: { years: 1, expires: "2099-06-30" },
  commodity: {
    light: { private: [{ name: "NEXT_LUCE_PROVA", fee: 99 }] },
    gas: { private: [{ name: "NEXT_GAS_PROVA", fee: 88 }] },
  },
  marker: "SCHEDULED_NEXT",
};

test("listino futuro resta in next fino alla mezzanotte di Roma", () => {
  const live = JSON.stringify(liveCatalog);
  const next = JSON.stringify({ ...nextCatalog, liveFrom: isoRome(1) });
  const resolved = resolvePublishedPair(live, next);
  assert.equal(resolved.promoted, false);
  assert.equal(resolved.next, next);
  const cat = JSON.parse(resolved.catalog);
  assert.equal(cat.marker, "LIVE_NOW");
  assert.equal(cat.commodity.light.private[0].name, "LIVE_LUCE");
});

test("listino con data già passata viene promosso automaticamente", () => {
  const live = JSON.stringify(liveCatalog);
  const next = JSON.stringify({ ...nextCatalog, liveFrom: isoRome(-1) });
  const resolved = resolvePublishedPair(live, next);
  assert.equal(resolved.promoted, true);
  assert.equal(resolved.next, "");
  const cat = JSON.parse(resolved.catalog);
  assert.equal(cat.marker, "SCHEDULED_NEXT");
  assert.equal(cat.flat.years, 1);
  assert.equal(cat.commodity.light.private[0].name, "NEXT_LUCE_PROVA");
  assert.equal(cat.commodity.gas.private[0].name, "NEXT_GAS_PROVA");
  assert.equal("liveFrom" in cat, false);
});

test("listino di oggi (mezzanotte Roma già passata) è già in vigore", () => {
  const live = JSON.stringify(liveCatalog);
  const next = JSON.stringify({ ...nextCatalog, liveFrom: isoRome(0) });
  const resolved = resolvePublishedPair(live, next);
  assert.equal(resolved.promoted, true);
  const cat = JSON.parse(resolved.catalog);
  assert.equal(cat.marker, "SCHEDULED_NEXT");
});

test("catalogJsonForFirebase con data futura tiene catalog live e next programmato", () => {
  // Verifica solo la firma nel sorgente editor: la funzione vive nell'iframe.
  assert.match(indexSrc, /function catalogJsonForFirebase\(edited, fileHtml, from\)/);
  assert.match(indexSrc, /nextObj\.liveFrom=from/);
  assert.match(indexSrc, /return \{catalog:JSON\.stringify\(liveObj\), next:JSON\.stringify\(nextObj\)\}/);
});
