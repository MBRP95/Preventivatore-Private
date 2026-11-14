import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const editorSrc = fs.readFileSync(path.join(root, "modifica_listini.html"), "utf8");
const indexSrc = fs.readFileSync(path.join(root, "index.html"), "utf8");

function grab(fnName) {
  const start = editorSrc.indexOf("function " + fnName);
  assert.ok(start >= 0, fnName + " assente");
  let depth = 0;
  let i = editorSrc.indexOf("{", start);
  for (; i < editorSrc.length; i++) {
    const ch = editorSrc[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return editorSrc.slice(start, i);
}

test("catalogScriptJson legge il listino vero di index.html", () => {
  const catalogScriptJson = new Function(grab("catalogScriptJson") + "; return catalogScriptJson;")();
  const catalog = catalogScriptJson(indexSrc, "promo-catalog");
  assert.ok(catalog.length > 100);
  const data = JSON.parse(catalog);
  assert.ok(data.flat);
  assert.ok(data.commodity.light.private.length >= 1);
});

test("index espone pubblicazione Firebase e regole listini", () => {
  assert.match(indexSrc, /__publishListinoFirebase/);
  assert.match(indexSrc, /__readPublishedListino/);
  assert.match(indexSrc, /listini","published"/);
  assert.match(indexSrc, /firebasePublishMode/);
  const rules = fs.readFileSync(path.join(root, "firestore.rules"), "utf8");
  assert.match(rules, /match \/listini\/\{docId\}/);
  assert.match(rules, /docId == 'published'/);
});
