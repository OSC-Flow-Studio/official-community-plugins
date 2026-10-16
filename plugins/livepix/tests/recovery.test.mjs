import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../plugin/index.mjs";
import { fakeDashboard, context, until } from "./helpers/dashboard.mjs";

test("manual replay bypasses delivery history while retaining date, currency and request deduplication", async () => {
  const dashboard = await fakeDashboard();
  const fixture = context({ baseUrl: dashboard.baseUrl });
  try {
    const eligible = dashboard.add({ id: "eligible" });
    const old = dashboard.add({ id: "old", occurredAt: "2026-09-21T11:59:59.999Z" });
    const foreign = dashboard.add({ id: "foreign", currency: "USD" });
    const invalid = dashboard.add({ id: "invalid", occurredAt: "invalid" });
    const boundary = dashboard.add({ id: "boundary", occurredAt: "2026-09-21T12:00:00Z" });
    await plugin.activate(fixture.ctx);
    await fixture.actions.get("poll-now")({});
    await until(() => dashboard.sockets.size === 1);
    assert.equal(fixture.triggers.length, 2);
    const send = (body) => { for (const ws of dashboard.sockets) ws.send(JSON.stringify(body)); };
    for (const donation of [eligible, old, foreign, invalid, boundary]) {
      const replay = { type: "donation.replay", requestId: "retry:" + donation.id, donation };
      send(replay); send(replay);
    }
    await until(() => fixture.triggers.length === 4);
    await fixture.actions.get("poll-now")({});
    assert.equal(fixture.triggers.length, 4);
    const recovered = await fixture.actions.get("recover")({});
    assert.equal(recovered.emitted, 2);
    assert.equal(fixture.triggers.length, 6);
    assert.equal((await fixture.actions.get("status")({})).seen, 3);
    send({ type: "donations.recover", requestId: "bulk" });
    send({ type: "donations.recover", requestId: "bulk" });
    await until(() => fixture.triggers.length === 8);
    await fixture.actions.get("poll-now")({});
    assert.equal(fixture.triggers.length, 8);
    assert.deepEqual(new Set(fixture.triggers.map((entry) => entry.payload.eventKey)), new Set(["livepix:donation:eligible", "livepix:donation:boundary"]));
  } finally { await plugin.deactivate(); await dashboard.close(); }
});

test("recovery failure can be retried after restart without resetting either ledger", async () => {
  const dashboard = await fakeDashboard({ rejectSocket: 503 });
  const vault = new Map();
  try {
    dashboard.add({ id: "persisted" });
    let fixture = context({ baseUrl: dashboard.baseUrl }, vault);
    await plugin.activate(fixture.ctx);
    await fixture.actions.get("poll-now")({});
    dashboard.state.rejectApi = 503;
    assert.equal((await fixture.actions.get("recover")({})).ok, false);
    await plugin.deactivate();
    dashboard.state.rejectApi = 0;
    fixture = context({ baseUrl: dashboard.baseUrl }, vault);
    await plugin.activate(fixture.ctx);
    await fixture.actions.get("poll-now")({});
    assert.equal(fixture.triggers.length, 0);
    assert.equal((await fixture.actions.get("recover")({})).emitted, 1);
    assert.equal(fixture.triggers[0].payload.eventKey, "livepix:donation:persisted");
  } finally { await plugin.deactivate(); await dashboard.close(); }
});

test("accounting receipts require a positive downstream result and keep network errors visible", async () => {
  const dashboard = await fakeDashboard({ rejectSocket: 503 });
  const fixture = context({ baseUrl: dashboard.baseUrl });
  try {
    await plugin.activate(fixture.ctx);
    await fixture.actions.get("poll-now")({});
    const confirm = fixture.actions.get("confirm-accounted");
    for (const accounted of [undefined, false, "true", "false", 1]) {
      assert.equal((await confirm({ eventKey: "livepix:donation:E1", accounted })).ok, false);
    }
    assert.equal(dashboard.receipts.length, 0);
    assert.equal((await confirm({ eventKey: "livepix:donation:", accounted: true })).ok, false);
    assert.deepEqual(await confirm({ eventKey: "livepix:donation:E1", accounted: true }), { ok: true, error: "" });
    assert.deepEqual(dashboard.receipts, [{ eventKey: "livepix:donation:E1" }]);
    dashboard.state.rejectApi = 503;
    assert.match((await confirm({ eventKey: "livepix:donation:E1", accounted: true })).error, /503/);
  } finally { await plugin.deactivate(); await dashboard.close(); }
});
