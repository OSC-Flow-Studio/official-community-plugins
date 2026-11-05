import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appearanceValues, packPluginDir, readManifestFromZip } from "../../../sdk/ofs-package.mjs";
import { buildManifest, render } from "../build/manifest.mjs";
import { boot, playEverything } from "./helpers/scenario.mjs";

const manifestText = readFileSync(new URL("../plugin/manifest.json", import.meta.url), "utf8");
const manifest = JSON.parse(manifestText);
const triggerTypes = manifest.nodeTypes.filter((item) => item.role === "trigger");
const actionTypes = manifest.nodeTypes.filter((item) => item.role !== "trigger");
const name = (item) => item.type.split(".").at(-1);
const typeOf = (value) => (Array.isArray(value) || (value && typeof value === "object") ? "object" : typeof value);

test("the committed manifest is what build/manifest.mjs generates", () => {
  assert.equal(manifestText.replace(/\r\n/g, "\n"), render(buildManifest(manifest.version)));
});

test("every trigger the runtime fires carries exactly the fields its block declares", async () => {
  const run = await boot({ emitRawEvents: true });
  try {
    playEverything(run);
    await run.actions.get("send-chat")({ message: "hi" });
    const fired = new Set(run.kinds());
    for (const item of triggerTypes) assert.ok(fired.has(name(item)), `${name(item)} never fired in the scenario`);
    for (const { kind, payload } of run.triggers) {
      const item = triggerTypes.find((type) => name(type) === kind);
      assert.ok(item, `${kind} is fired but not declared`);
      const declared = new Map(item.outputSchema.map((field) => [field.path.replace(/^metadata\./, ""), field.type]));
      const keys = Object.keys(payload).filter((key) => key !== "actorId" && !(key === "actorDisplayName" && !declared.has("actorDisplayName")));
      assert.deepEqual(keys.sort(), [...declared.keys()].sort(), kind);
      for (const key of keys) assert.equal(typeOf(payload[key]), declared.get(key), `${kind}.${key}`);
      for (const matchField of item.matchFields ?? []) assert.ok(matchField.eventField in payload, `${kind} matches on missing ${matchField.eventField}`);
    }
  } finally {
    await run.runtime.shutdown();
  }
});

test("every action and input is registered and returns exactly its declared fields", async () => {
  const run = await boot({ chatEnabled: true, signApiKey: "euler_test" });
  try {
    playEverything(run);
    const inputs = {
      connect: [{}], disconnect: [{}], "refresh-gifts": [{}], "reset-session": [{ scope: "coins" }, { scope: "nope" }],
      "wait-until-live": [{ timeoutSeconds: 1 }], "send-chat": [{ message: "" }, { message: "hello" }],
      "chat-sign-in": [{}], "chat-sign-out": [{}], status: [{}], "room-stats": [{}],
      "gift-lookup": [{ giftId: 5655 }, { giftName: "nothing" }], "battle-state": [{}], "top-gifters": [{ limit: 3 }],
      "user-stats": [{ uniqueId: "viewer_6" }, { uniqueId: "" }],
    };
    for (const item of actionTypes) {
      const handler = run.actions.get(name(item));
      assert.ok(handler, `${item.type} has no handler`);
      const declared = new Map(item.outputSchema.map((field) => [field.path, field.type]));
      for (const input of inputs[name(item)] ?? [{}]) {
        const promise = handler(input);
        run.clock.advance(30_000);
        const output = await promise;
        assert.deepEqual(Object.keys(output).sort(), [...declared.keys()].sort(), `${name(item)} ${JSON.stringify(input)}`);
        for (const [key, value] of Object.entries(output)) assert.equal(typeOf(value), declared.get(key), `${name(item)}.${key}`);
      }
    }
    assert.equal(run.actions.size, actionTypes.length);
  } finally {
    await run.runtime.shutdown();
  }
});

test("blocks live in the plugin's namespace, use allowed icons, and templates arrive switched off", () => {
  const { icons, accents } = appearanceValues();
  assert.ok(accents.includes(manifest.appearance.accent));
  for (const item of manifest.nodeTypes) {
    assert.match(item.type, /^(trigger|action)\.x\.tiktok-live\.[a-z-]+$/);
    assert.ok(icons.includes(item.appearance.icon), `${item.type} icon ${item.appearance.icon}`);
    assert.match(item.label, /^TikTok: /);
    // One palette group: the Studio splits a plugin into groups by subcategory.
    assert.equal(item.category, "TikTok LIVE");
    assert.equal(item.subcategory, undefined, `${item.type} would open a palette group of its own`);
    for (const field of item.outputSchema) assert.ok(["string", "number", "boolean", "object"].includes(field.type), `${item.type}.${field.path}`);
  }
  for (const template of manifest.templates) assert.equal(template.flow.enabled, false, template.id);
  const about = manifest.configSchema.fields.filter((field) => field.tab === "about").map((field) => field.description).join(" ");
  for (const link of ["https://github.com/zerodytrash/TikTok-Live-Connector", "https://github.com/isaackogan/TikTok-Webcast-Protobuf", "https://www.eulerstream.com", "https://tikfinity.zerody.one"]) assert.ok(about.includes(link), link);
});

test("the package is reproducible and carries the bundled client with its licenses", () => {
  const out = mkdtempSync(join(tmpdir(), "tiktok-live-package-"));
  try {
    const pluginDir = fileURLToPath(new URL("../plugin", import.meta.url));
    const first = packPluginDir(pluginDir, join(out, "first"));
    const second = packPluginDir(pluginDir, join(out, "second"));
    assert.equal(first.sha256, second.sha256);
    const bytes = readFileSync(first.path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), first.sha256);
    const packed = readManifestFromZip(bytes);
    assert.equal(packed.id, "tiktok-live");
    assert.equal(packed.packageId, "io.github.osc-flow-studio.tiktok-live");
    assert.equal(packed.engines.oscFlowStudio, ">=1.0.0 <2.0.0");
    assert.equal(packed.permissions.network, "any");
    assert.ok(bytes.includes(Buffer.from("vendor/NOTICE.md")));
    assert.ok(bytes.includes(Buffer.from("vendor/THIRD_PARTY_LICENSES.txt")));
    assert.ok(first.size < 20 * 1024 * 1024);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
