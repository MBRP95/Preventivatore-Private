#!/usr/bin/env node
// Stampa lo SHA-256 esadecimale di una password letta da argv o da stdin.
// Esempio: node worker/hash-password.mjs 'la-tua-password'
// Non scrive file e non stampa la password in chiaro oltre all'hash.
import { createHash } from "node:crypto";

const fromArg = process.argv.slice(2).join(" ").trim();
let password = fromArg;
if (!password) {
  password = String(await new Response(process.stdin).text()).replace(/\r?\n$/, "");
}
if (!password) {
  console.error("Uso: node worker/hash-password.mjs 'password'");
  process.exit(1);
}
const hash = createHash("sha256").update(password, "utf8").digest("hex");
process.stdout.write(hash + "\n");
