import assert from "node:assert/strict";
import test from "node:test";
import plugin, { startRuntime } from "../plugin/index.mjs";
import { context, fakeClock, fakePuck, fakeResponder, until } from "./helpers/fakes.mjs";

// Real UDP sockets on 127.0.0.1, a fake responder standing in for the network, and a hand
// driven clock for the scan schedule and the motor timers.

test("finds a Puck, drives it, coalesces a burst, stops it, and notices when it leaves", async () => {
  const puck = await fakePuck();
  const responder = await fakeResponder(["127.0.0.1"]);
  const clock = fakeClock();
  const fixture = context({ discovery: true, rescanSeconds: 10 });
  const runtime = await startRuntime(fixture.ctx, {
    now: clock.now,
    timers: clock.timers,
    discoveredPort: puck.port,
    discovery: { target: responder.target, interfaces: ["127.0.0.1"], listener: false, resolver: false },
  });
  try {
    assert.equal(fixture.statuses.at(-1).connectionState, "searching for Pucks");
    clock.advance(0);
    await until(() => fixture.triggers.length > 0);
    assert.deepEqual(fixture.triggers[0], {
      kind: "device-status",
      payload: {
        change: "online", deviceId: "ip:127.0.0.1", name: "giggletech-127-0-0-1", address: "127.0.0.1",
        source: "unicast", onlineCount: 1, actorId: "ip:127.0.0.1", actorDisplayName: "giggletech-127-0-0-1",
      },
    });
    assert.deepEqual(fixture.resources.at(-1).items.map((item) => item.value), ["all", "ip:127.0.0.1"]);
    assert.equal(fixture.statuses.at(-1).health, "healthy");

    const proximity = fixture.actions.get("set-proximity");
    assert.deepEqual(proximity({ device: "all", proximity: 0.5 }), { ok: true, tx: 21, devices: 1, error: "" });
    await until(() => puck.values().length === 1 && puck.values("/avatar/parameters/motor").length === 1);
    assert.deepEqual(puck.values(), [21]);

    // A 60 Hz burst inside one send interval goes out as one trailing value.
    for (const value of [0.6, 0.7, 0.8, 0.9, 1]) proximity({ device: "all", proximity: value });
    clock.advance(25);
    await until(() => puck.values().length === 2);
    assert.deepEqual(puck.values(), [21, 42]);

    proximity({ device: "all", proximity: 0 });
    clock.advance(200);
    await until(() => puck.values().length === 7);
    assert.deepEqual(puck.values().slice(2), [0, 0, 0, 0, 0]);

    const status = fixture.actions.get("get-status")();
    assert.equal(status.onlineCount, 1);
    assert.equal(status.discovery, "unicast");
    assert.equal(status.lastTx, 0);
    assert.notEqual(status.lastInputAt, "");

    // The Puck stops answering: offline after two missed scans.
    responder.state.pucks = [];
    clock.advance(7500);
    clock.advance(2500);
    clock.advance(4000);
    assert.equal(fixture.triggers.length, 1, "one missed scan is not enough");
    clock.advance(6000);
    clock.advance(4000);
    assert.equal(fixture.triggers.at(-1).payload.change, "offline");
    assert.equal(fixture.triggers.at(-1).payload.onlineCount, 0);
    assert.equal(fixture.statuses.at(-1).health, "degraded");
    assert.deepEqual(proximity({ device: "all", proximity: 1 }), { ok: false, tx: 0, devices: 0, error: "No Giggle Puck is online." });
  } finally {
    const before = puck.values().length;
    await runtime.shutdown();
    await until(() => puck.values().length >= before + 3);
    assert.ok(puck.values().slice(before).every((value) => value === 0), "shutting down sets the Puck to 0");
    await responder.close();
    await puck.close();
  }
});

test("a Puck added by address works without discovery, and bad input never runs the motor", async () => {
  const puck = await fakePuck();
  const clock = fakeClock();
  const fixture = context({ devices: [{ name: "Desk", host: "127.0.0.1", port: puck.port, enabled: true }, { name: "Off", host: "10.9.9.9", enabled: false }] });
  const runtime = await startRuntime(fixture.ctx, { now: clock.now, timers: clock.timers });
  try {
    assert.deepEqual(fixture.triggers.map(({ payload }) => [payload.change, payload.deviceId, payload.source]), [["online", "manual:Desk", "manual"]]);
    assert.deepEqual(fixture.resources.at(-1).items.find((item) => item.value === "manual:Desk"),
      { value: "manual:Desk", label: "Desk (127.0.0.1)", connected: true, group: "Added by address" });

    const vibrate = fixture.actions.get("vibrate");
    assert.deepEqual(vibrate({ device: "manual:Desk", intensity: "100", durationMs: "300" }), { ok: true, tx: 42, durationMs: 300, devices: 1, error: "" });
    clock.advance(350);
    await until(() => puck.values().length >= 2);
    assert.deepEqual(puck.values().slice(0, 2), [42, 0]);

    const maxSpeed = fixture.actions.get("set-max-speed");
    assert.deepEqual(maxSpeed({ device: "all", maxSpeed: 5 }), { ok: true, maxSpeedPercent: 100, clamped: true, devices: 1, error: "" });
    assert.equal(maxSpeed({ device: "all", maxSpeed: "fast" }).ok, false);

    const proximity = fixture.actions.get("set-proximity");
    const sentBefore = puck.values().length;
    assert.deepEqual(proximity({ device: "manual:Desk", proximity: "abc" }), { ok: false, tx: 0, devices: 1, error: "Proximity is not a number, so the Puck was set to 0." });
    assert.equal(proximity({ device: "manual:Unknown", proximity: 1 }).error, "That Puck is not known or has no address yet.");
    clock.advance(100);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(puck.values().slice(sentBefore).every((value) => value === 0));

    assert.deepEqual(fixture.actions.get("stop")({ device: "all" }), { ok: true, devices: 1, error: "" });
  } finally {
    await runtime.shutdown();
    await puck.close();
  }
});

test("the plugin runs once, and deactivate sets every Puck to 0", async () => {
  const puck = await fakePuck();
  const fixture = context({ devices: [{ name: "Desk", host: "127.0.0.1", port: puck.port }] });
  await plugin.activate(fixture.ctx);
  try {
    await assert.rejects(plugin.activate(context().ctx), /already running/);
    fixture.actions.get("set-proximity")({ device: "all", proximity: 1 });
    await until(() => puck.values().includes(42));
  } finally {
    await plugin.deactivate();
  }
  await until(() => puck.values().filter((value) => value === 0).length >= 3);
  assert.equal(puck.values().at(-1), 0);
  await puck.close();
});
