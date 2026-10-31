// Creates the signing key for official releases: the private half goes into `.env` (never
// committed), the public half into `scripts/official-keys.json` (committed). It never
// replaces a key that is already there and never prints the private key.
//
//   npm run keygen                      key id osc-flow-studio-YYYY-MM
//   npm run keygen -- my-key-id
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { root } from "./plugins.mjs";
import { KEY_ID, newKeyPair } from "./signing.mjs";

export function keygen({ keyId = `osc-flow-studio-${new Date().toISOString().slice(0, 7)}`, envFile = join(root, ".env"), keysFile = join(root, "scripts", "official-keys.json"), exampleFile = join(root, ".env.example") } = {}) {
  if (!KEY_ID.test(keyId)) throw new Error("The key id must be lowercase letters, digits and dashes, 3 to 64 characters");
  const env = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  if (/^\s*OFS_SIGNING_PRIVATE_KEY\s*=\s*\S/m.test(env)) {
    throw new Error(".env already holds a signing key. To replace it, remove OFS_SIGNING_PRIVATE_KEY from .env yourself first; a new key also has to reach OSC Flow Studio before it signs anything.");
  }
  const registry = existsSync(keysFile) ? JSON.parse(readFileSync(keysFile, "utf8")) : { keys: [] };
  if (registry.keys.some((entry) => entry.keyId === keyId)) throw new Error(`scripts/official-keys.json already lists "${keyId}"; pick another key id`);

  const { privateKey, publicKey } = newKeyPair();
  const values = { OFS_SIGNING_KEY_ID: keyId, OFS_SIGNING_PRIVATE_KEY: privateKey };
  // Start from the existing .env, or from the example so the comments come along.
  let text = env || (existsSync(exampleFile) ? readFileSync(exampleFile, "utf8") : "");
  for (const [name, value] of Object.entries(values)) {
    const line = new RegExp(`^\\s*${name}\\s*=.*$`, "m");
    text = line.test(text) ? text.replace(line, `${name}=${value}`) : `${text.replace(/\n?$/, "\n")}${name}=${value}\n`;
  }
  writeFileSync(envFile, text);
  registry.keys.push({ keyId, publicKey, createdAt: new Date().toISOString().slice(0, 10) });
  writeFileSync(keysFile, JSON.stringify(registry, null, 2) + "\n");
  return { keyId, publicKey };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { keyId, publicKey } = keygen(process.argv[2] ? { keyId: process.argv[2] } : {});
    console.log(`Created the signing key "${keyId}".

  Private key: written to .env. Keep a backup somewhere safe; it is never committed.
  Public key:  added to scripts/official-keys.json. Commit that file.

  ${publicKey}

OSC Flow Studio must know the public key before it shows signed packages as official.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
