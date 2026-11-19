#!/usr/bin/env node
/**
 * Simula: imposto liveFrom = domani, poi avanzo l'orologio al giorno dopo.
 * Non tocca Firebase.
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

function makeResolver(nowMs) {
  const src =
    grab("listinoRomeOffsetMin") +
    "\n" +
    grab("listinoRomeMidnightMs") +
    "\n" +
    grab("resolvePublishedPair");
  // Stessa logica del sito, ma Date.now() è iniettato.
  return new Function(
    "nowMs",
    "const DateNow=()=>nowMs;\n" +
      src.replaceAll("Date.now()", "DateNow()") +
      ";\nreturn resolvePublishedPair;"
  )(nowMs);
}

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const tomorrow = fmt.format(new Date(Date.now() + 86400000));

const live = {
  flat: { years: 2 },
  commodity: {
    light: { private: [{ name: "LUCE LIVE", fee: 40 }] },
    gas: { private: [{ name: "GAS LIVE", fee: 50 }] },
  },
  marker: "LIVE",
};
const next = {
  liveFrom: tomorrow,
  flat: { years: 1 },
  commodity: {
    light: { private: [{ name: "LUCE NUOVA PROVA", fee: 99 }] },
    gas: { private: [{ name: "GAS NUOVA PROVA", fee: 88 }] },
  },
  marker: "NEXT",
};

const liveStr = JSON.stringify(live);
const nextStr = JSON.stringify(next);
const now = Date.now();

const before = makeResolver(now)(liveStr, nextStr);
const after = makeResolver(now + 2 * 86400000)(liveStr, nextStr);
const b = JSON.parse(before.catalog);
const a = JSON.parse(after.catalog);

const report = {
  impostazione: { liveFrom: tomorrow, firebaseTouched: false },
  adesso: {
    promoted: before.promoted,
    luce: b.commodity.light.private[0].name,
    gas: b.commodity.gas.private[0].name,
  },
  dopo_aver_simulato_domani: {
    promoted: after.promoted,
    luce: a.commodity.light.private[0].name,
    gas: a.commodity.gas.private[0].name,
  },
};

console.log(JSON.stringify(report, null, 2));

if (before.promoted) throw new Error("Oggi non deve promuovere");
if (!after.promoted) throw new Error("Domani simulato deve promuovere");
if (a.commodity.light.private[0].name !== "LUCE NUOVA PROVA") {
  throw new Error("Promo luce non aggiornata");
}
if (a.commodity.gas.private[0].name !== "GAS NUOVA PROVA") {
  throw new Error("Promo gas non aggiornata");
}

console.log(
  "OK: liveFrom=domani; simulando il giorno dopo, promo e listino si aggiornano da soli."
);
