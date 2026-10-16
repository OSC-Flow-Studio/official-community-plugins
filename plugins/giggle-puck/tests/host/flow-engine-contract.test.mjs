import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startRuntime } from "../../plugin/index.mjs";
import { context, fakeClock, fakePuck, until } from "../helpers/fakes.mjs";

// The bundled template, run by the real Studio flow engine. The Studio checkout sits next
// to this repository unless OSC_FLOW_STUDIO_ROOT says otherwise.
const workspace = fileURLToPath(new URL("../../../../../", import.meta.url));
const hostRoot = resolve(process.env.OSC_FLOW_STUDIO_ROOT || resolve(workspace, "osc-flow-studio"));
const hostImport = (path) => import(pathToFileURL(resolve(hostRoot, path)).href);
const { FlowEngine } = await hostImport("packages/flow-engine/dist/index.js");
const { FlowSchema, buildOscTriggerOutput, buildPluginTriggerOutput } = await hostImport("packages/core/dist/index.js");
const { assertNodeOutputContract, assertNodeOutputEnvelope } = await hostImport("packages/flow-engine/tests/helpers/node-output-contract.ts");

const manifest = JSON.parse(readFileSync(new URL("../../plugin/manifest.json", import.meta.url), "utf8"));
const template = manifest.templates.find((item) => item.id === "giggle-puck-contact").flow;
const schemaOf = (type) => manifest.nodeTypes.find((item) => item.type === type).outputSchema;
const fieldValue = (data, path) => path.split(".").reduce((value, key) => value?.[key], data);

const oscTrigger = (address, args, matchedKeyId) =>
  buildOscTriggerOutput({ message: { address, args, receivedAt: Date.now(), raw: args }, matchedKeyId, branchName: "out" });

/** Runs the template from `entryId`, with probes reading `observedId`'s output through `$json` and `$node`. */
async function run(fixture, entryId, observedId, trigger) {
  const flow = structuredClone(template);
  const observed = flow.nodes.find((node) => node.id === observedId);
  const schema = schemaOf(observed.type);
  for (const [id, root] of [["probe-json", "$json"], ["probe-node", `$node["${observedId}"]`]]) {
    flow.nodes.push({ id, type: "action.x.contract-probe.capture",
      ...Object.fromEntries(schema.map(({ path }, i) => [`field${i}`, { mode: "expression", expression: `{{ ${root}.${path} }}` }])) });
  }
  flow.edges.push({ id: "probe1", source: observedId, target: "probe-json" }, { id: "probe2", source: "probe-json", target: "probe-node" });
  const sentToAvatar = [];
  const captures = new Map();
  const result = await new FlowEngine().execute(FlowSchema.parse({ ...flow, enabled: true }), {
    osc: { sendArg: async (address, arg) => { sentToAvatar.push([address, arg]); } },
    variables: {},
    nodeOutputStore: {},
    pluginConfigs: { "giggle-puck": { enabled: true } },
    trigger,
    entryNodeId: entryId,
    triggerNodeId: entryId,
    executePluginAction: async ({ nodeType, nodeId, data }) => {
      if (nodeType === "action.x.contract-probe.capture") {
        captures.set(nodeId, data);
        return {};
      }
      return fixture.actions.get(nodeType.split(".").at(-1))(data);
    },
  });
  assert.deepEqual(result.errors, []);
  for (const envelope of Object.values(result.nodeOutputStore)) assertNodeOutputEnvelope(envelope);
  const sample = result.nodeOutputStore[observedId];
  assertNodeOutputContract(sample, schema, { requiredPaths: schema.map((field) => field.path) });
  const values = Object.fromEntries(schema.map(({ path }, i) => [`field${i}`, fieldValue(sample.data, path)]));
  assert.deepEqual(captures.get("probe-json"), values);
  assert.deepEqual(captures.get("probe-node"), values);
  return { sample, sentToAvatar, flow };
}

test("the template turns avatar proximity and max_speed into motor values a downstream formula can read", async () => {
  const puck = await fakePuck();
  const clock = fakeClock();
  const fixture = context({ devices: [{ name: "Desk", host: "127.0.0.1", port: puck.port }] });
  const runtime = await startRuntime(fixture.ctx, { now: clock.now, timers: clock.timers });
  try {
    const touch = await run(fixture, "gp-proximity", "gp-set-proximity",
      oscTrigger("/avatar/parameters/proximity_01", [0.5], "key-proximity"));
    assert.deepEqual(touch.sample.data, { ok: true, tx: 21, devices: 1, error: "" });
    await until(() => puck.values().includes(21));

    const speed = await run(fixture, "gp-max-speed", "gp-set-max-speed",
      oscTrigger("/avatar/parameters/max_speed", [0.3], "key-max-speed"));
    assert.deepEqual(speed.sample.data, { ok: true, maxSpeedPercent: 30, clamped: false, devices: 1, error: "" });

    clock.advance(50);
    const deeper = await run(fixture, "gp-proximity", "gp-set-proximity",
      oscTrigger("/avatar/parameters/proximity_01", [1], "key-proximity"));
    assert.equal(deeper.sample.data.tx, 50, "the avatar's max_speed raised the ceiling of the next touch");

    // A packet with no argument has no receivedValue: the Puck is set to 0, never left running.
    clock.advance(50);
    const empty = await run(fixture, "gp-proximity", "gp-set-proximity",
      oscTrigger("/avatar/parameters/proximity_01", [], "key-proximity"));
    assert.equal(empty.sample.data.ok, false);
    assert.equal(empty.sample.data.tx, 0);
    await until(() => puck.values().at(-1) === 0);
  } finally {
    await runtime.shutdown();
    await puck.close();
  }
});

test("a Puck coming online pulses GigglePuck_online false, then true, on the avatar", async () => {
  const fixture = context();
  const runtime = await startRuntime(fixture.ctx);
  try {
    const payload = { change: "online", deviceId: "ip:10.0.0.5", name: "giggletech", address: "10.0.0.5", source: "unicast", onlineCount: 1, actorId: "ip:10.0.0.5", actorDisplayName: "giggletech" };
    const online = await run(fixture, "gp-online", "gp-online", buildPluginTriggerOutput("giggle-puck", "device-status", payload));
    assert.deepEqual(online.sentToAvatar, [
      ["/avatar/parameters/GigglePuck_online", { type: "bool", value: false }],
      ["/avatar/parameters/GigglePuck_online", { type: "bool", value: true }],
    ]);
  } finally {
    await runtime.shutdown();
  }
});
