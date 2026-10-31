import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkIssues } from "../scripts/validate.mjs";

function withCode(source, run) {
  const dir = mkdtempSync(join(tmpdir(), "network-permission-"));
  try {
    writeFileSync(join(dir, "index.mjs"), source);
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a plugin that opens sockets cannot declare no network", () => {
  withCode('import https from "node:https";\nexport default {};\n', (dir) => {
    assert.deepEqual(networkIssues(dir, { permissions: { network: "none" } }), [
      'permissions.network is "none" but the code uses node:https',
    ]);
    assert.deepEqual(networkIssues(dir, { permissions: { network: "internet" } }), []);
  });
});

test("fetch and WebSocket count as network use", () => {
  withCode("export default { async activate() { await fetch('https://example.com'); new WebSocket('wss://x'); } };\n", (dir) => {
    const [issue] = networkIssues(dir, { permissions: {} });
    assert.match(issue, /fetch/);
    assert.match(issue, /WebSocket/);
  });
});

test("UDP needs the local network", () => {
  withCode('import dgram from "node:dgram";\nexport default {};\n', (dir) => {
    assert.equal(networkIssues(dir, { permissions: { network: "internet" } }).length, 1);
    assert.deepEqual(networkIssues(dir, { permissions: { network: "local" } }), []);
    assert.deepEqual(networkIssues(dir, { permissions: { network: "any" } }), []);
  });
});

test("a plugin without sockets may declare none", () => {
  withCode("export default { activate() {} };\n", (dir) => {
    assert.deepEqual(networkIssues(dir, { permissions: { network: "none" } }), []);
  });
});
