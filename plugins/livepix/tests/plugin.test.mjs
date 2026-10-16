import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import plugin, { connectWebSocket, parseStartAt, webhookIdFromToken } from "../plugin/index.mjs";

import { fakeDashboard, context, until, WEBHOOK, TOKEN, START } from "./helpers/dashboard.mjs";

const ids = (fixture) => fixture.triggers.map((t) => t.payload.eventKey.replace("livepix:donation:", ""));
const lastStatus = (fixture) => fixture.statuses[fixture.statuses.length - 1];

test("full reconciliation crosses 60 pages and keeps every ID across toggles and start changes", { timeout: 45000 }, async () => {
  const dashboard = await fakeDashboard({ rejectSocket: 503 });
  const vault = new Map();
  const total = 30001;
  for (let index = 0; index < total; index++) dashboard.add();
  const first = context({ baseUrl: dashboard.baseUrl }, vault);
  try {
    await plugin.activate(first.ctx);
    const synced = await first.actions.get("poll-now")({});
    assert.equal(synced.ok, true);
    assert.equal(first.triggers.length, total);
    await plugin.deactivate();
    const snapshot = JSON.parse(vault.get("livepix-state-v1"));
    assert.ok(snapshot.idLedger.tail.length < 256);
    assert.equal(snapshot.processed, undefined);
    const disabled = context({ enabled: false, baseUrl: dashboard.baseUrl }, vault);
    const beforeRequests = dashboard.requests.length;
    await plugin.activate(disabled.ctx);
    dashboard.add({ id: "WHILE-OFF" });
    await disabled.actions.get("poll-now")({});
    assert.equal(dashboard.requests.length, beforeRequests);
    assert.equal(disabled.triggers.length, 0);
    await plugin.deactivate();
    dashboard.add({ id: "OLDER", occurredAt: "2026-09-21T11:00:00.000Z" });
    const second = context({ baseUrl: dashboard.baseUrl, startAt: "2026-09-21T10:00:00Z" }, vault);
    await plugin.activate(second.ctx);
    assert.equal((await second.actions.get("poll-now")({})).ok, true);
    assert.deepEqual(new Set(ids(second)), new Set(["WHILE-OFF", "OLDER"]));
    assert.equal((await second.actions.get("status")({})).seen, total + 2);
  } finally { await plugin.deactivate(); await dashboard.close(); }
});

test("migrates version 3 IDs and refuses unreadable state instead of replaying history", async () => {
  const dashboard = await fakeDashboard({ rejectSocket: 503 });
  dashboard.add({ id: "OLD" });
  dashboard.add({ id: "NEW" });
  const vault = new Map([["livepix-state-v1", JSON.stringify({ version: 3, processed: [["OLD", Date.parse(START)]], lastSeq: "1" })]]);
  try {
    const first = context({ baseUrl: dashboard.baseUrl }, vault);
    await plugin.activate(first.ctx);
    await first.actions.get("poll-now")({});
    assert.deepEqual(ids(first), ["NEW"]);
    await plugin.deactivate();
    const broken = context({ baseUrl: dashboard.baseUrl }, vault);
    broken.ctx.secrets.get = async () => { throw new Error("vault unavailable"); };
    await assert.rejects(plugin.activate(broken.ctx), /vault unavailable/);
    assert.equal(broken.triggers.length, 0);
    vault.set("livepix-state-v1", "{broken");
    await assert.rejects(plugin.activate(first.ctx), /Cannot restore LivePix state/);
  } finally { await plugin.deactivate(); await dashboard.close(); }
});

test("a failed snapshot does not fire or consume IDs and a retry succeeds once", async () => {
  const dashboard = await fakeDashboard();
  const fixture = context({ baseUrl: dashboard.baseUrl });
  const save = fixture.ctx.secrets.set;
  try {
    await plugin.activate(fixture.ctx);
    await until(() => dashboard.sockets.size === 1);
    await fixture.actions.get("poll-now")({});
    fixture.ctx.secrets.set = async () => { throw new Error("disk full"); };
    dashboard.add({ id: "RETRY" }, { push: true });
    await until(() => fixture.logs.some((line) => line.includes("disk full")));
    assert.equal(fixture.triggers.length, 0);
    assert.equal((await fixture.actions.get("poll-now")({})).ok, false);
    assert.equal((await fixture.actions.get("status")({})).seen, 0);
    fixture.ctx.secrets.set = save;
    assert.equal((await fixture.actions.get("poll-now")({})).ok, true);
    await fixture.actions.get("poll-now")({});
    assert.deepEqual(ids(fixture), ["RETRY"]);
  } finally { fixture.ctx.secrets.set = save; await plugin.deactivate(); await dashboard.close(); }
});

test("reads the subathon start in the formats the field accepts, in local time", () => {
  assert.equal(parseStartAt("2026-09-21 18:30"), new Date(2026, 8, 21, 18, 30).getTime());
  assert.equal(parseStartAt("2026-09-21T18:30"), new Date(2026, 8, 21, 18, 30).getTime());
  assert.equal(parseStartAt("21/09/2026 18:30"), new Date(2026, 8, 21, 18, 30).getTime());
  assert.equal(parseStartAt("21/09/2026"), new Date(2026, 8, 21).getTime());
  assert.equal(parseStartAt("2026-09-21T15:00:00.000Z"), Date.UTC(2026, 8, 21, 15));
  assert.equal(parseStartAt("2026-09-22T06:00:30.123"), new Date(2026, 8, 22, 6, 0, 30, 123).getTime());
  for (const invalid of ["2026-09-22 24:00", "2026-09-22 06:60", "2026-02-30T06:00:00Z", "2026-09-22T06:00:60"]) {
    assert.ok(Number.isNaN(parseStartAt(invalid)), invalid);
  }
  assert.ok(Number.isNaN(parseStartAt("31/02/2026 10:00")));
  assert.ok(Number.isNaN(parseStartAt("amanhã")));
  assert.ok(Number.isNaN(parseStartAt("")));
});

test("the token names its webhook", () => {
  assert.equal(webhookIdFromToken(TOKEN), WEBHOOK);
  assert.equal(webhookIdFromToken("olp_abc_x"), "");
  assert.equal(webhookIdFromToken("not-a-token"), "");
});

test("fires every donation since the subathon start once, oldest first, with the 1.x payload", async () => {
  const dashboard = await fakeDashboard();
  dashboard.add({ id: "BEFORE", occurredAt: "2026-09-21T11:59:59.000Z" });
  dashboard.add({ id: "LATE", occurredAt: "2026-09-21T14:00:00.000Z" });
  dashboard.add({ id: "EARLY", occurredAt: "2026-09-21T12:30:00.000Z", username: "", message: "" });
  const fixture = context({ baseUrl: dashboard.baseUrl });
  try {
    await plugin.activate(fixture.ctx);
    await until(() => fixture.triggers.length === 2);
    assert.deepEqual(ids(fixture), ["EARLY", "LATE"]);
    const [first, second] = fixture.triggers;
    assert.equal(first.name, "donation");
    assert.equal(first.payload.hasMessage, false);
    assert.deepEqual(second.payload, {
      amount: 500,
      amountFormatted: "R$ 5,00",
      currency: "BRL",
      username: "Ana",
      message: "vai!",
      hasMessage: true,
      flagged: false,
      id: "lp2",
      proof: "E2",
      reference: "r2",
      createdAt: "2026-09-21T14:00:00.000Z",
      eventKey: "livepix:donation:LATE",
      actorId: "Ana",
      actorDisplayName: "Ana",
    });
    assert.ok(dashboard.requests.some((r) => r.includes("since=2026-09-21T12%3A00%3A00.000Z")));
    assert.ok(dashboard.state.authorization.every((value) => value === "Bearer " + TOKEN));
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("a donation pushed over the socket fires at once and never again from the API", async () => {
  const dashboard = await fakeDashboard();
  const fixture = context({ baseUrl: dashboard.baseUrl });
  try {
    await plugin.activate(fixture.ctx);
    await until(() => dashboard.sockets.size === 1 && lastStatus(fixture)?.connectionState === "tempo real (WebSocket)");
    dashboard.add({ id: "LIVE" }, { push: true });
    await until(() => fixture.triggers.length === 1);
    const sync = await fixture.actions.get("poll-now")({});
    assert.equal(sync.ok, true);
    assert.equal(sync.fetched, 1);
    assert.equal(sync.emitted, 0);
    assert.deepEqual(ids(fixture), ["LIVE"]);
    const status = await fixture.actions.get("status")({});
    assert.equal(status.transport, "websocket");
    assert.equal(status.seen, 1);
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("after a restart it fires only what arrived while it was off", async () => {
  const dashboard = await fakeDashboard();
  const vault = new Map();
  dashboard.add({ id: "A" });
  dashboard.add({ id: "B" });
  const first = context({ baseUrl: dashboard.baseUrl }, vault);
  try {
    await plugin.activate(first.ctx);
    await until(() => first.triggers.length === 2);
  } finally {
    await plugin.deactivate();
  }
  // Studio closed: the dashboard keeps receiving donations.
  dashboard.add({ id: "C" });
  dashboard.add({ id: "D" });
  const second = context({ baseUrl: dashboard.baseUrl }, vault);
  try {
    await plugin.activate(second.ctx);
    await until(() => second.triggers.length === 2);
    await second.actions.get("poll-now")({});
    assert.deepEqual(ids(second), ["C", "D"]);
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("without the socket it polls the API at the configured interval", async () => {
  const dashboard = await fakeDashboard({ rejectSocket: 503 });
  const fixture = context({ baseUrl: dashboard.baseUrl, pollSeconds: 2 });
  try {
    await plugin.activate(fixture.ctx);
    await until(() => lastStatus(fixture)?.connectionState?.startsWith("consultando a API a cada 2 s"));
    assert.equal(lastStatus(fixture).health, "degraded");
    dashboard.add({ id: "POLLED" });
    await until(() => fixture.triggers.length === 1, 4000);
    assert.deepEqual(ids(fixture), ["POLLED"]);
    const status = await fixture.actions.get("status")({});
    assert.equal(status.transport, "polling");
    // The next poll continues after the last sequence number instead of rereading everything.
    await until(() => dashboard.requests.some((r) => r.includes("after=1")), 4000);
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("reconnects after the socket drops and reads what it missed", async () => {
  const dashboard = await fakeDashboard();
  const fixture = context({ baseUrl: dashboard.baseUrl, pollSeconds: 300 });
  try {
    await plugin.activate(fixture.ctx);
    await until(() => dashboard.sockets.size === 1);
    dashboard.state.rejectSocket = 503;
    dashboard.dropSockets();
    await until(() => dashboard.sockets.size === 0);
    dashboard.add({ id: "MISSED" }, { push: true });
    dashboard.state.rejectSocket = 0;
    // First retry comes after one second; the reconnect runs a full sync from the start.
    await until(() => fixture.triggers.length === 1, 5000);
    assert.deepEqual(ids(fixture), ["MISSED"]);
    assert.equal(dashboard.sockets.size, 1);
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("ignores other currencies and zero amounts without firing them later", async () => {
  const dashboard = await fakeDashboard();
  dashboard.add({ id: "USD", currency: "USD" });
  dashboard.add({ id: "ZERO", amount: 0 });
  dashboard.add({ id: "OK" });
  const fixture = context({ baseUrl: dashboard.baseUrl });
  try {
    await plugin.activate(fixture.ctx);
    await until(() => fixture.triggers.length === 1);
    await fixture.actions.get("poll-now")({});
    assert.deepEqual(ids(fixture), ["OK"]);
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("without a subathon start it counts from the first activation, never the history", async () => {
  const dashboard = await fakeDashboard();
  dashboard.add({ id: "OLD", occurredAt: new Date(Date.now() - 60_000).toISOString() });
  const vault = new Map();
  const fixture = context({ baseUrl: dashboard.baseUrl, startAt: "" }, vault);
  try {
    await plugin.activate(fixture.ctx);
    const sync = await fixture.actions.get("poll-now")({});
    assert.equal(sync.ok, true);
    dashboard.add({ id: "NEW", occurredAt: new Date(Date.now() + 1000).toISOString() }, { push: true });
    await until(() => fixture.triggers.length === 1);
    assert.deepEqual(ids(fixture), ["NEW"]);
    const saved = JSON.parse(vault.get("livepix-state-v1"));
    assert.ok(saved.autoStartAt > 0, "the automatic start survives a restart");
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("donations counted by 1.2.0 stay counted after the update", async () => {
  const dashboard = await fakeDashboard();
  dashboard.add({ id: "E-OLD", occurredAt: new Date(Date.now() + 1000).toISOString() });
  dashboard.add({ id: "E-NEW", occurredAt: new Date(Date.now() + 2000).toISOString() });
  const vault = new Map([["livepix-state-v1", JSON.stringify({ version: 2, initialized: true, seen: ["livepix:E-OLD"], lastPollAt: "" })]]);
  const fixture = context({ baseUrl: dashboard.baseUrl, startAt: "2026-01-01 00:00" }, vault);
  try {
    await plugin.activate(fixture.ctx);
    await until(() => fixture.triggers.length === 1);
    await fixture.actions.get("poll-now")({});
    assert.deepEqual(ids(fixture), ["E-NEW"]);
    assert.equal(JSON.parse(vault.get("livepix-state-v1")).version, 4);
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("a refused token degrades the status with the reason", async () => {
  const dashboard = await fakeDashboard();
  const fixture = context({ baseUrl: dashboard.baseUrl, apiToken: `olp_${WEBHOOK}_wrong` });
  try {
    await plugin.activate(fixture.ctx);
    await until(() => (lastStatus(fixture)?.errors ?? []).some((e) => e.includes("Token recusado")));
    assert.equal(lastStatus(fixture).health, "degraded");
    assert.ok(lastStatus(fixture).errors.some((e) => e.includes("token recusado")));
    assert.equal(fixture.triggers.length, 0);
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("an incomplete configuration waits instead of connecting", async () => {
  for (const [overrides, reason] of [
    [{ apiToken: "" }, /Informe o token/],
    [{ apiToken: "abc" }, /formato/],
    [{ startAt: "ontem" }, /Início do subathon inválido/],
    [{ baseUrl: "http://livepix.example.com" }, /https/],
  ]) {
    const fixture = context(overrides);
    try {
      await plugin.activate(fixture.ctx);
      assert.equal(lastStatus(fixture).health, "degraded");
      assert.match(lastStatus(fixture).errors[0], reason);
      const action = await fixture.actions.get("poll-now")({});
      assert.equal(action.ok, false);
    } finally {
      await plugin.deactivate();
    }
  }
});

test("disabled, it neither connects nor polls", async () => {
  const dashboard = await fakeDashboard();
  const fixture = context({ baseUrl: dashboard.baseUrl, enabled: false });
  try {
    await plugin.activate(fixture.ctx);
    assert.equal(lastStatus(fixture).connectionState, "desativado");
    assert.equal((await fixture.actions.get("poll-now")({})).ok, false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(dashboard.requests.length, 0);
    assert.equal(dashboard.sockets.size, 0);
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("the host abort signal stops the socket and the timers, and it can activate again", async () => {
  const dashboard = await fakeDashboard();
  const fixture = context({ baseUrl: dashboard.baseUrl });
  try {
    await plugin.activate(fixture.ctx);
    await until(() => dashboard.sockets.size === 1);
    fixture.controller.abort();
    await plugin.deactivate();
    await until(() => dashboard.sockets.size === 0);
    const again = context({ baseUrl: dashboard.baseUrl });
    await plugin.activate(again.ctx);
    await until(() => dashboard.sockets.size === 1);
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("the WebSocket client reads fragmented, large and ping frames", async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const big = "x".repeat(70_000);
  const received = [];
  let pongs = 0;
  wss.on("connection", (ws) => {
    ws.on("pong", () => { pongs += 1; });
    ws.on("message", (data) => ws.send("echo:" + String(data)));
    ws.ping("hi");
    ws.send("small");
    ws.send(big);
    ws.send("frag", { fin: false });
    ws.send("mented", { fin: true });
  });
  let closed;
  const done = new Promise((resolve) => { closed = resolve; });
  const client = connectWebSocket(`ws://127.0.0.1:${server.address().port}/`, {}, {
    onOpen: () => client.send("hello"),
    onMessage: (text) => received.push(text),
    onClose: (code) => closed(code),
  });
  try {
    await until(() => received.length === 4);
    assert.deepEqual(received.map((text) => text.length > 100 ? `big:${text.length}` : text), ["small", "big:70000", "fragmented", "echo:hello"]);
    await until(() => pongs === 1);
    client.close(1000);
    assert.equal(await done, 1000);
  } finally {
    wss.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the WebSocket client maps a refused handshake to a close code", async () => {
  const server = http.createServer((req, res) => { res.writeHead(401); res.end(); });
  server.on("upgrade", (req, socket) => socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const code = await new Promise((resolve) => {
      connectWebSocket(`ws://127.0.0.1:${server.address().port}/`, {}, { onMessage: () => {}, onClose: resolve });
    });
    assert.equal(code, 4001);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
