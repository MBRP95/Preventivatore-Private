import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const start = html.indexOf("function makeId()");
const end = html.indexOf("function fileSafe");
const source = html.slice(start, end);

test("gli id nuovi sono 16 esadecimali e non riusano un id già presente", async () => {
  let quotes = [];
  let trashQuotes = [];
  let folderHandle = null;
  const fn = new Function(
    "quotes",
    "trashQuotes",
    "folderHandle",
    "crypto",
    source + "\nreturn {makeId, uniqueQuoteId, ensureUniqueId};"
  );
  const api = fn(quotes, trashQuotes, folderHandle, crypto);
  const id = api.makeId();
  assert.match(id, /^[0-9a-f]{16}$/);
  const original = crypto.getRandomValues.bind(crypto);
  let n = 0;
  crypto.getRandomValues = (bytes) => {
    bytes.fill(n === 0 ? 0xaa : 0xbb);
    n += 1;
    return bytes;
  };
  try {
    quotes.push({ id: "aaaaaaaaaaaaaaaa" });
    assert.equal(api.uniqueQuoteId(), "bbbbbbbbbbbbbbbb");
    const historical = { id: "q-vecchio" };
    await api.ensureUniqueId(historical);
    assert.equal(historical.id, "q-vecchio");
  } finally {
    crypto.getRandomValues = original;
  }
});

test("il numero commerciale resta PREV-YYYY-NNN", () => {
  assert.match(html, /function formatQuoteNumber\(year,n\)\{return "PREV-"\+year\+"-"\+String\(n\)\.padStart\(3,"0"\)\}/);
  assert.equal(html.includes("Math.random().toString(36)"), false);
});
