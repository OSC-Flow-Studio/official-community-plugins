import assert from "node:assert/strict";
import test from "node:test";
import { loadIdLedger } from "../plugin/id-ledger.mjs";

test("page writes remain uncommitted until the accounting snapshot succeeds", async () => {
  const vault = new Map();
  const secrets = { get: async (key) => vault.get(key), set: async (key, value) => vault.set(key, value) };
  const ledger = await loadIdLedger(secrets, "test", undefined, Array.from({ length: 255 }, (_, i) => String(i)));
  const saved = structuredClone(ledger.descriptor);
  const prepared = await ledger.prepare(["next", "last"]);
  assert.equal(prepared.pages, 1);
  assert.equal(ledger.ids.has("next"), false);
  const restored = await loadIdLedger(secrets, "test", saved);
  assert.equal(restored.ids.has("next"), false);
  const retry = await restored.prepare(["different"]);
  restored.commit(retry, ["different"]);
  const restarted = await loadIdLedger(secrets, "test", retry);
  assert.equal(restarted.ids.size, 256);
  assert.equal(restarted.ids.has("different"), true);
  assert.equal(restarted.ids.has("next"), false);
  vault.clear();
  await assert.rejects(loadIdLedger(secrets, "test", retry));
});
