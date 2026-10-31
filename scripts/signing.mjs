// Signs and checks the statement that a plugin ZIP was published by the OSC Flow Studio
// team. The statement names the package, its version and the SHA-256 and size of the ZIP
// bytes, so a signature is worth nothing for any other file.
//
// The private key stays in `.env` on the maintainer's machine. The ZIP is reproducible,
// so the release workflow rebuilds the same bytes and only has to verify the signature
// with the public key in `official-keys.json`.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { packPluginDir } from "../sdk/ofs-package.mjs";
import { root } from "./plugins.mjs";

export const ATTESTATION_TYPE = "osc-flow-studio.package-attestation";
export const PUBLISHER = "osc-flow-studio";
export const KEY_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;

/** The exact bytes that get signed. Field order is fixed, so the text never varies. */
export function attestationPayload({ packageId, version, sha256, size }) {
  return JSON.stringify({ type: ATTESTATION_TYPE, publisher: PUBLISHER, packageId, version, sha256, size });
}

/** `{ keyId, payload, signature }`, the content of a `.zip.sig` file. */
export function signArtifact({ keyId, privateKey, packageId, version, sha256, size }) {
  const payload = attestationPayload({ packageId, version, sha256, size });
  const signature = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
  return { keyId, payload, signature };
}

/**
 * Checks an attestation against the artifact it travels with. Returns `null` when it is
 * good, or the reason it is not.
 */
export function attestationProblem(attestation, { publicKeys, packageId, version, sha256, size }) {
  if (!attestation || typeof attestation !== "object") return "no signature";
  const { keyId, payload, signature } = attestation;
  if (typeof keyId !== "string" || typeof payload !== "string" || typeof signature !== "string") return "the signature file is malformed";
  const publicKey = publicKeys.get(keyId);
  if (!publicKey) return `the key "${keyId}" is not an official key`;
  let valid = false;
  try {
    valid = verify(null, Buffer.from(payload, "utf8"), publicKey, Buffer.from(signature, "base64"));
  } catch {
    valid = false;
  }
  if (!valid) return "the signature does not match";
  let claim;
  try {
    claim = JSON.parse(payload);
  } catch {
    return "the signed statement is not JSON";
  }
  if (payload !== attestationPayload(claim) || claim.type !== ATTESTATION_TYPE || claim.publisher !== PUBLISHER) {
    return "the signed statement is not an OSC Flow Studio package attestation";
  }
  if (claim.packageId !== packageId || claim.version !== version) return `the signature is for ${claim.packageId} ${claim.version}`;
  if (claim.sha256 !== sha256 || claim.size !== size) return "the signature is for different ZIP bytes";
  return null;
}

/** The official public keys, by key id, from `scripts/official-keys.json`. */
export function officialPublicKeys(path = join(root, "scripts", "official-keys.json")) {
  const keys = new Map();
  for (const entry of JSON.parse(readFileSync(path, "utf8")).keys) {
    keys.set(entry.keyId, createPublicKey({ key: Buffer.from(entry.publicKey, "base64"), format: "der", type: "spki" }));
  }
  return keys;
}

/** Reads `.env` (when present) and returns the signing key, or `null` when none is set. */
export function loadSigningKey({ env = process.env, envFile = join(root, ".env") } = {}) {
  if (envFile && existsSync(envFile)) process.loadEnvFile(envFile);
  const keyId = env.OFS_SIGNING_KEY_ID?.trim();
  const encoded = env.OFS_SIGNING_PRIVATE_KEY?.trim();
  if (!keyId || !encoded) return null;
  if (!KEY_ID.test(keyId)) throw new Error("OFS_SIGNING_KEY_ID must be lowercase letters, digits and dashes");
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "pkcs8" });
  } catch {
    throw new Error("OFS_SIGNING_PRIVATE_KEY is not a base64 PKCS#8 private key");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("OFS_SIGNING_PRIVATE_KEY must be an Ed25519 key");
  return { keyId, privateKey };
}

/** A new Ed25519 key pair, both halves as base64 DER. */
export function newKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

/** The public half of a private key, as base64 SPKI DER. */
export const publicKeyOf = (privateKey) =>
  createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");

/**
 * Packs `pluginDir` into a scratch folder, signs the ZIP and writes the statement to
 * `<plugin>/signatures/<version>.json`. The ZIP is reproducible, so the workflow that
 * rebuilds it from the tagged commit gets the same bytes.
 */
export function signPluginDir({ dir, pluginDir }, { keyId, privateKey }) {
  const scratch = mkdtempSync(join(tmpdir(), "ofs-sign-"));
  let packed;
  try {
    packed = packPluginDir(pluginDir, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const { packageId, version } = packed.manifest;
  const attestation = signArtifact({ keyId, privateKey, packageId, version, sha256: packed.sha256, size: packed.size });
  const path = join(dir, "signatures", `${version}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(attestation, null, 2)}\n`);
  return { path, packed, attestation };
}
