import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { appearanceValues, packPluginDir, readManifestFromZip } from "../../../sdk/ofs-package.mjs";
import { startRuntime } from "../plugin/index.mjs";
import { context, fakeClock, fakePuck } from "./helpers/fakes.mjs";

const manifest = JSON.parse(readFileSync(new URL("../plugin/manifest.json", import.meta.url), "utf8"));
const node = (type) => manifest.nodeTypes.find((item) => item.type === `action.x.giggle-puck.${type}`);
const declaredPaths = (type) => (node(type).outputSchema ?? []).map((field) => field.path).sort();

test("every action returns exactly the fields its block declares, with the declared types", async () => {
  const puck = await fakePuck();
  const clock = fakeClock();
  const fixture = context({ devices: [{ name: "Desk", host: "127.0.0.1", port: puck.port }] });
  const runtime = await startRuntime(fixture.ctx, { now: clock.now, timers: clock.timers });
  try {
    const calls = {
      "set-proximity": [{ device: "all", proximity: 0.5 }, { device: "manual:Nope", proximity: 1 }],
      "set-max-speed": [{ device: "all", maxSpeed: 0.3 }, { device: "all", maxSpeed: "x" }],
      vibrate: [{ device: "all", intensity: 50, durationMs: 400 }, { device: "manual:Nope" }],
      stop: [{ device: "all" }, { device: "manual:Nope" }],
      "get-status": [{}],
    };
    for (const [type, inputs] of Object.entries(calls)) {
      const types = Object.fromEntries(node(type).outputSchema.map((field) => [field.path, field.type]));
      for (const input of inputs) {
        const output = fixture.actions.get(type)(input);
        assert.deepEqual(Object.keys(output).sort(), declaredPaths(type), `${type} ${JSON.stringify(input)}`);
        for (const [key, value] of Object.entries(output)) assert.equal(typeof value, types[key], `${type}.${key}`);
      }
    }
  } finally {
    await runtime.shutdown();
    await puck.close();
  }
});

test("every block is in the plugin's namespace, and every handler is registered", async () => {
  const fixture = context();
  const runtime = await startRuntime(fixture.ctx);
  try {
    for (const item of manifest.nodeTypes) {
      assert.match(item.type, /^(trigger|action)\.x\.giggle-puck\.[a-z-]+$/);
      if (item.type.startsWith("action.")) assert.ok(fixture.actions.has(item.type.split(".").at(-1)), `${item.type} has no handler`);
      for (const field of item.outputSchema ?? []) assert.ok(["string", "number", "boolean"].includes(field.type), `${item.type}.${field.path}`);
    }
  } finally {
    await runtime.shutdown();
  }
});

test("the package is reproducible, needs the Studio with appearance, and is a haptic plugin with no shock", () => {
  const out = mkdtempSync(join(tmpdir(), "giggle-puck-package-"));
  try {
    const pluginDir = fileURLToPath(new URL("../plugin", import.meta.url));
    const first = packPluginDir(pluginDir, join(out, "first"));
    const second = packPluginDir(pluginDir, join(out, "second"));
    assert.equal(first.sha256, second.sha256);
    const bytes = readFileSync(first.path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), first.sha256);
    const packed = readManifestFromZip(bytes);
    assert.equal(packed.id, "giggle-puck");
    assert.equal(packed.packageId, "io.github.osc-flow-studio.giggle-puck");
    assert.equal(packed.engines.oscFlowStudio, ">=0.5.10 <0.6.0");
    assert.ok(packed.capabilities.includes("haptics"));
    assert.ok(!packed.capabilities.includes("safety-notice"));
    const { icons, accents } = appearanceValues();
    assert.ok(accents.includes(packed.appearance.accent));
    for (const icon of [packed.appearance.icon, ...packed.nodeTypes.map((item) => item.appearance?.icon)]) assert.ok(icons.includes(icon), icon);
    for (const template of packed.templates) assert.equal(template.flow.enabled, false, `${template.id} must arrive switched off`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
