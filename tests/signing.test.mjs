import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { keygen } from "../scripts/keygen.mjs";
import { attestationPayload, attestationProblem, loadSigningKey, newKeyPair, officialPublicKeys, signArtifact } from "../scripts/signing.mjs";

const pair = () => {
  const { privateKey, publicKey } = newKeyPair();
  return {
    privateKey: createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" }),
    publicKey: createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }),
  };
};
const artifact = { packageId: "io.github.osc-flow-studio.giggle-puck", version: "0.2.0", sha256: "a".repeat(64), size: 17_000 };

test("a signature holds only for the package, version and bytes it names", () => {
  const official = pair();
  const publicKeys = new Map([["official-1", official.publicKey]]);
  const attestation = signArtifact({ keyId: "official-1", privateKey: official.privateKey, ...artifact });
  assert.equal(attestation.payload, attestationPayload(artifact));
  assert.equal(attestationProblem(attestation, { publicKeys, ...artifact }), null);

  assert.match(attestationProblem(attestation, { publicKeys, ...artifact, sha256: "b".repeat(64) }), /different ZIP bytes/);
  assert.match(attestationProblem(attestation, { publicKeys, ...artifact, size: 1 }), /different ZIP bytes/);
  assert.match(attestationProblem(attestation, { publicKeys, ...artifact, version: "0.2.1" }), /for io\.github\.osc-flow-studio\.giggle-puck 0\.2\.0/);
  assert.match(attestationProblem(attestation, { publicKeys, ...artifact, packageId: "io.example.other" }), /for io\.github/);

  // An edited statement, a key nobody trusts, or a forged signature never pass.
  const edited = { ...attestation, payload: attestation.payload.replace("0.2.0", "9.9.9") };
  assert.match(attestationProblem(edited, { publicKeys, ...artifact }), /does not match/);
  const stranger = pair();
  const foreign = signArtifact({ keyId: "official-1", privateKey: stranger.privateKey, ...artifact });
  assert.match(attestationProblem(foreign, { publicKeys, ...artifact }), /does not match/);
  assert.match(attestationProblem({ ...attestation, keyId: "someone-else" }, { publicKeys, ...artifact }), /not an official key/);
  assert.match(attestationProblem({ ...attestation, signature: "AAAA" }, { publicKeys, ...artifact }), /does not match/);
  assert.match(attestationProblem(undefined, { publicKeys, ...artifact }), /no signature/);
  assert.match(attestationProblem({ keyId: 1 }, { publicKeys, ...artifact }), /malformed/);
});

test("keygen writes the private key to .env, the public key to the registry, and never replaces a key", () => {
  const dir = mkdtempSync(join(tmpdir(), "ofs-keygen-"));
  try {
    const files = { envFile: join(dir, ".env"), keysFile: join(dir, "official-keys.json"), exampleFile: join(dir, ".env.example") };
    writeFileSync(files.exampleFile, "# comment kept\nOFS_SIGNING_KEY_ID=\nOFS_SIGNING_PRIVATE_KEY=\n");
    const { keyId, publicKey } = keygen({ keyId: "test-key", ...files });
    const env = readFileSync(files.envFile, "utf8");
    assert.match(env, /^# comment kept$/m);
    assert.match(env, /^OFS_SIGNING_KEY_ID=test-key$/m);
    assert.doesNotMatch(env, new RegExp(publicKey.replace(/[+/=]/g, "\\$&")), "the public key is not the private one");

    const environment = {};
    const signing = loadSigningKey({ env: { OFS_SIGNING_KEY_ID: "test-key", OFS_SIGNING_PRIVATE_KEY: /^OFS_SIGNING_PRIVATE_KEY=(.+)$/m.exec(env)[1] }, envFile: null });
    assert.equal(signing.keyId, keyId);
    const keys = officialPublicKeys(files.keysFile);
    const attestation = signArtifact({ keyId, privateKey: signing.privateKey, ...artifact });
    assert.equal(attestationProblem(attestation, { publicKeys: keys, ...artifact }), null);

    assert.throws(() => keygen({ keyId: "second-key", ...files }), /already holds a signing key/);
    assert.equal(JSON.parse(readFileSync(files.keysFile, "utf8")).keys.length, 1);
    assert.equal(loadSigningKey({ env: environment, envFile: null }), null);
    assert.throws(() => loadSigningKey({ env: { OFS_SIGNING_KEY_ID: "x y", OFS_SIGNING_PRIVATE_KEY: "AAAA" }, envFile: null }), /lowercase/);
    assert.throws(() => loadSigningKey({ env: { OFS_SIGNING_KEY_ID: "abc", OFS_SIGNING_PRIVATE_KEY: "not-a-key" }, envFile: null }), /PKCS#8/);
    assert.throws(() => keygen({ keyId: "Bad Id", ...files }), /lowercase/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
