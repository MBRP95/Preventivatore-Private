// Stampa su stdout la chiave privata ECDSA P-256 da mettere nel secret
// OFFLINE_SIGNING_JWK. Non scrive file e non va committata.
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
process.stdout.write(JSON.stringify(jwk) + "\n");
