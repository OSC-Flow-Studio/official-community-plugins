import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// The fields flows rely on through `$json` and `$node["…"]` formulas. The Studio offers
// exactly what the manifest declares under `outputSchema`, so a path missing here is a
// formula that stops resolving for every user after an update.
const manifest = JSON.parse(readFileSync(new URL("../plugin/manifest.json", import.meta.url), "utf8"));

const declared = (type) => {
  const node = manifest.nodeTypes.find((item) => item.type === type);
  assert.ok(node, `${type} is not declared in the manifest`);
  return Object.fromEntries((node.outputSchema ?? []).map((field) => [field.path, field.type]));
};

test("the manifest keeps the output fields flows address by formula", () => {
  for (const [type, path, valueType] of [
    ["trigger.x.livepix.donation", "metadata.eventKey", "string"],
    ["trigger.x.livepix.donation", "metadata.amount", "number"],
    ["action.x.livepix.poll-now", "emitted", "number"],
    ["action.x.livepix.status", "startAt", "string"],
    ["action.x.livepix.recover", "emitted", "number"],
    ["action.x.livepix.confirm-accounted", "ok", "boolean"],
  ]) {
    assert.equal(declared(type)[path], valueType, `${type} must declare ${path} as ${valueType}`);
  }
});

test("every declared output field has a path and a primitive type", () => {
  for (const node of manifest.nodeTypes) {
    for (const field of node.outputSchema ?? []) {
      assert.match(field.path, /^[A-Za-z][\w.]*$/, `${node.type}: bad path ${field.path}`);
      assert.ok(["string", "number", "boolean", "object"].includes(field.type), `${node.type}.${field.path}: type ${field.type}`);
    }
  }
});
