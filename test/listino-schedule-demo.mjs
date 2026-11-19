#!/usr/bin/env node
/**
 * Prova locale della promozione listino programmato.
 * Non tocca Firebase né il sito live.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const indexSrc = fs.readFileSync(path.join(root, "index.html"), "utf8");

function grab(fnName) {
  const start = indexSrc.indexOf("function " + fnName);
  if (start < 0) throw new Error(fnName + " assente");
  let depth = 0;
  let i = indexSrc.indexOf("{", start);
  for (; i < indexSrc.length; i++) {
    if (indexSrc[i] === "{") depth++;
    else if (indexSrc[i] === "}") {
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
  grab("listinoRomeOffsetMin") +
    "\n" +
    grab("listinoRomeMidnightMs") +
    "\n" +
    grab("resolvePublishedPair") +
    ";\nreturn resolvePublishedPair;"
)();

function isoRome(daysFromToday) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date(Date.now() + daysFromToday * 86400000));
}

const liveCatalog = {
  flat: { years: 2, expires: "2099-12-31" },
  commodity: {
    light: { private: [{ name: "LUCE LIVE", fee: 40 }] },
    gas: { private: [{ name: "GAS LIVE", fee: 50 }] },
  },
  marker: "LIVE",
};

function nextCatalog(liveFrom) {
  return {
    liveFrom,
    flat: { years: 1, expires: "2099-06-01" },
    commodity: {
      light: { private: [{ name: "LUCE NUOVA PROVA", fee: 99 }] },
      gas: { private: [{ name: "GAS NUOVA PROVA", fee: 88 }] },
    },
    marker: "NEXT",
  };
}

function row(label, days) {
  const from = isoRome(days);
  const resolved = resolvePublishedPair(
    JSON.stringify(liveCatalog),
    JSON.stringify(nextCatalog(from))
  );
  const cat = JSON.parse(resolved.catalog);
  return {
    scenario: label,
    liveFrom: from,
    promoted: resolved.promoted,
    marker: cat.marker,
    luce: cat.commodity.light.private[0].name,
    gas: cat.commodity.gas.private[0].name,
    flatYears: cat.flat.years,
  };
}

const results = [
  row("Prima della data (domani)", 1),
  row("Alla data di oggi (mezzanotte Roma già passata)", 0),
  row("Dopo la data (ieri)", -1),
];

console.log(JSON.stringify({ ok: true, firebaseTouched: false, results }, null, 2));

const future = results[0];
const due = results[1];
if (future.promoted) throw new Error("Il listino futuro non deve promuovere");
if (!due.promoted) throw new Error("Il listino di oggi deve promuovere");
if (due.luce !== "LUCE NUOVA PROVA" || due.gas !== "GAS NUOVA PROVA") {
  throw new Error("Promo non aggiornate dopo promozione");
}
