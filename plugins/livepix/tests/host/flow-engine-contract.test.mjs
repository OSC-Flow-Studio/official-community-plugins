import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import livepix from "../../plugin/index.mjs";
import { fakeDashboard, context } from "../helpers/dashboard.mjs";

// The Studio and CatOPanda checkouts sit next to this repository unless the environment says otherwise.
const workspace = fileURLToPath(new URL("../../../../../", import.meta.url));
const hostRoot = resolve(process.env.OSC_FLOW_STUDIO_ROOT || resolve(workspace, "osc-flow-studio"));
const subathonRoot = resolve(process.env.CATOPANDA_SUBATHON_ROOT || resolve(workspace, "catopanda-subathon"));
const hostImport = (path) => import(pathToFileURL(resolve(hostRoot, path)).href);
const { FlowEngine } = await hostImport("packages/flow-engine/dist/index.js");
const { FlowSchema } = await hostImport("packages/core/dist/index.js");
const { assertNodeOutputContract, assertNodeOutputEnvelope } = await hostImport("packages/flow-engine/tests/helpers/node-output-contract.ts");
const { default: subathon } = await import(pathToFileURL(resolve(subathonRoot, "plugin/index.mjs")).href);
const liveManifest = JSON.parse(readFileSync(new URL("../../plugin/manifest.json", import.meta.url), "utf8"));
const subManifest = JSON.parse(readFileSync(resolve(subathonRoot, "plugin/manifest.json"), "utf8"));
const definitions = [...liveManifest.nodeTypes, ...subManifest.nodeTypes];
const fieldValue = (data, path) => path.split(".").reduce((value, key) => value?.[key], data);
const trigger = (metadata = {}) => ({ integration: "livepix", kind: "donation", triggeredAt: new Date().toISOString(),
  actorId: metadata.actorId || "", actorDisplayName: metadata.actorDisplayName || "", metadata });

async function execute(flowInput, entryId, observedId, event, handlers) {
  const flow = structuredClone(flowInput);
  const node = flow.nodes.find((item) => item.id === observedId);
  const schema = definitions.find((item) => item.type === node.type).outputSchema;
  for (const [id, root] of [["probe-json", "$json"], ["probe-node", `$node["${observedId}"]`]]) {
    flow.nodes.push({ id, type: "action.x.contract-probe.capture",
      ...Object.fromEntries(schema.map(({ path }, i) => [`field${i}`, { mode: "expression", expression: `{{ ${root}.${path} }}` }])) });
  }
  flow.edges.push({ id: "probe1", source: observedId, target: "probe-json" }, { id: "probe2", source: "probe-json", target: "probe-node" });
  const captures = new Map();
  const result = await new FlowEngine().execute(FlowSchema.parse({ ...flow, enabled: true }), {
    osc: {}, variables: {}, pluginConfigs: { livepix: { enabled: true }, "catopanda-subathon": { enabled: true } },
    trigger: event, entryNodeId: entryId, triggerNodeId: entryId, nodeOutputStore: {},
    executePluginAction: async ({ nodeType, nodeId, data }) => {
      if (nodeType === "action.x.contract-probe.capture") { captures.set(nodeId, data); return {}; }
      const [, , pluginId, action] = nodeType.split(".");
      return handlers[pluginId].get(action)(data);
    },
  });
  assert.deepEqual(result.errors, []);
  for (const envelope of Object.values(result.nodeOutputStore)) assertNodeOutputEnvelope(envelope);
  const sample = result.nodeOutputStore[observedId];
  assertNodeOutputContract(sample, schema, { requiredPaths: schema.map((field) => field.path) });
  const values = Object.fromEntries(schema.map(({ path }, i) => [`field${i}`, fieldValue(sample.data, path)]));
  assert.deepEqual(captures.get("probe-json"), values);
  assert.deepEqual(captures.get("probe-node"), values);
  return { result, sample, schema };
}

function actionFlow(type, data = {}) {
  return { id: "contract", name: "Plugin output contract", nodes: [
    { id: "entry", type: "trigger.x.contract-probe.manual" }, { id: "action", type, ...data },
  ], edges: [{ id: "run", source: "entry", target: "action" }] };
}

test("LivePix action outputs reach formulas on success, empty reconciliation and API failure", async () => {
  const dashboard = await fakeDashboard({ rejectSocket: 503 });
  const fixture = context({ baseUrl: dashboard.baseUrl });
  try {
    await livepix.activate(fixture.ctx);
    const handlers = { livepix: fixture.actions };
    await fixture.actions.get("poll-now")({});
    for (const operation of ["poll-now", "status", "recover", "confirm-accounted"]) {
      await execute(actionFlow("action.x.livepix." + operation), "entry", "action", trigger(), handlers);
    }
    dashboard.add();
    const success = await execute(actionFlow("action.x.livepix.poll-now"), "entry", "action", trigger(), handlers);
    assert.equal(success.sample.data.emitted, 1);
    dashboard.state.rejectApi = 503;
    const failed = await execute(actionFlow("action.x.livepix.poll-now"), "entry", "action", trigger(), handlers);
    assert.equal(failed.sample.data.ok, false);
    assert.match(failed.sample.data.error, /503/);
    const recoveryFailed = await execute(actionFlow("action.x.livepix.recover"), "entry", "action", trigger(), handlers);
    assert.equal(recoveryFailed.sample.data.ok, false);
    await execute(actionFlow("action.x.livepix.status"), "entry", "action", trigger(), handlers);
    for (const data of [{ ...failed.sample.data, ok: undefined }, { ...failed.sample.data, fetched: "1" }, { ...failed.sample.data, error: null }]) {
      assert.throws(() => assertNodeOutputContract({ ...failed.sample, data }, failed.schema,
        { requiredPaths: failed.schema.map((field) => field.path) }), /Node output contract/);
    }
  } finally { await livepix.deactivate(); await dashboard.close(); }
});

test("dashboard donation reaches the bundled Subathon flow once across transport replay and restart", async () => {
  const dashboard = await fakeDashboard();
  const sourceVault = new Map(), targetVault = new Map();
  const startTarget = async () => {
    const target = context({ port: 0, initialTimerSeconds: 3600, donateSecondsPerReal: 60, warningThresholds: [] }, targetVault);
    await subathon.activate(target.ctx);
    return target;
  };
  let target;
  try {
    target = await startTarget();
    const source = context({ baseUrl: dashboard.baseUrl }, sourceVault);
    await livepix.activate(source.ctx);
    await source.actions.get("poll-now")({});
    dashboard.add({ id: "stable-proof", amount: 500 }, { push: true });
    await source.actions.get("poll-now")({});
    assert.equal(source.triggers.length, 1);
    const event = trigger(source.triggers[0].payload);
    const flow = subManifest.templates.find((item) => item.id === "catopanda-subathon-livepix").flow;
    const handlers = { "catopanda-subathon": target.actions, livepix: source.actions };
    const donation = await execute(flow, "livepix-donation", "livepix-donation", event, handlers);
    assert.equal(donation.sample.data.metadata.eventKey, "livepix:donation:stable-proof");
    const duplicate = await execute(flow, "livepix-donation", "record-donate", event, handlers);
    assert.equal(duplicate.sample.data.duplicate, true);
    assert.equal(duplicate.sample.data.secondsAdded, 0);
    await livepix.deactivate();
    await subathon.deactivate();
    target = await startTarget();
    const restarted = context({ baseUrl: dashboard.baseUrl }, sourceVault);
    await livepix.activate(restarted.ctx);
    await restarted.actions.get("poll-now")({});
    assert.equal(restarted.triggers.length, 0);
    const replay = await execute(flow, "livepix-donation", "record-donate", event, { "catopanda-subathon": target.actions, livepix: restarted.actions });
    assert.equal(replay.sample.data.duplicate, true);
    const state = await target.actions.get("get-state")({});
    assert.equal(state.totals.donate, 500);
    assert.equal(state.totals.addedSeconds, 300);
    assert.equal(state.timer.remainingSeconds, 3900);
    for (const [operation, data] of [["record-bits", { bits: 100, eventKey: "bits" }], ["reset-state", { scope: "ledger" }]]) {
      await execute(actionFlow("action.x.catopanda-subathon." + operation, data), "entry", "action", trigger(), { "catopanda-subathon": target.actions });
    }
  } finally { await livepix.deactivate(); await subathon.deactivate(); await dashboard.close(); }
});

test("recovery repairs a failed flow and a lost receipt without adding the donation twice", async () => {
  const dashboard = await fakeDashboard({ rejectSocket: 503 });
  const source = context({ baseUrl: dashboard.baseUrl });
  const target = context({ port: 0, initialTimerSeconds: 3600, donateSecondsPerReal: 60, warningThresholds: [] });
  try {
    await subathon.activate(target.ctx);
    dashboard.add({ id: "lost-flow", amount: 500 });
    await livepix.activate(source.ctx);
    await source.actions.get("poll-now")({});
    const flow = subManifest.templates.find((item) => item.id === "catopanda-subathon-livepix").flow;
    const firstEvent = trigger(source.triggers[0].payload);
    const failed = await new FlowEngine().execute(FlowSchema.parse({ ...structuredClone(flow), enabled: true }), {
      osc: {}, variables: {}, trigger: firstEvent, entryNodeId: "livepix-donation", triggerNodeId: "livepix-donation",
      pluginConfigs: { livepix: { enabled: true }, "catopanda-subathon": { enabled: true } }, nodeOutputStore: {},
      executePluginAction: async () => { throw new Error("Flow failed before accounting"); },
    });
    assert.ok(failed.errors.length > 0);
    assert.equal((await target.actions.get("get-state")({})).totals.donate, 0);
    assert.equal(dashboard.receipts.length, 0);
    assert.equal(source.triggers.length, 1);
    await source.actions.get("poll-now")({});
    assert.equal(source.triggers.length, 1);
    const recovery = await execute(actionFlow("action.x.livepix.recover"), "entry", "action", trigger(), { livepix: source.actions });
    assert.equal(recovery.sample.data.emitted, 1);
    assert.equal(source.triggers.length, 2);
    const recoveredEvent = trigger(source.triggers[1].payload);
    assert.equal(recoveredEvent.metadata.eventKey, firstEvent.metadata.eventKey);
    dashboard.state.rejectApi = 503;
    const handlers = { "catopanda-subathon": target.actions, livepix: source.actions };
    const lostReceipt = await execute(flow, "livepix-donation", "confirm-livepix", recoveredEvent, handlers);
    assert.equal(lostReceipt.sample.data.ok, false);
    assert.match(lostReceipt.sample.data.error, /503/);
    assert.equal((await target.actions.get("get-state")({})).totals.donate, 500);
    assert.equal(dashboard.receipts.length, 0);
    dashboard.state.rejectApi = 0;
    await source.actions.get("recover")({});
    const retriedEvent = trigger(source.triggers.at(-1).payload);
    const receipt = await execute(flow, "livepix-donation", "confirm-livepix", retriedEvent, handlers);
    assert.equal(receipt.sample.data.ok, true);
    assert.equal(receipt.result.nodeOutputStore["record-donate"].data.duplicate, true);
    assert.deepEqual(dashboard.receipts, [{ eventKey: "livepix:donation:lost-flow" }]);
    const state = await target.actions.get("get-state")({});
    assert.equal(state.totals.donate, 500);
    assert.equal(state.totals.addedSeconds, 300);
    assert.equal(state.timer.remainingSeconds, 3900);
  } finally { await livepix.deactivate(); await subathon.deactivate(); await dashboard.close(); }
});
