import assert from "node:assert/strict";
import test from "node:test";
import { MotorChannel, clampMaxSpeed, maxTxFor, motorSettings, proximityToTx } from "../plugin/motor.mjs";
import { encodeOscInt } from "../plugin/osc.mjs";
import { decodeOsc, fakeClock } from "./helpers/fakes.mjs";

test("OSC int messages are padded to four bytes and big-endian", () => {
  assert.deepEqual(
    [...encodeOscInt("/motor", 42)],
    [0x2f, 0x6d, 0x6f, 0x74, 0x6f, 0x72, 0, 0, 0x2c, 0x69, 0, 0, 0, 0, 0, 42],
  );
  // A 4-byte address still gets a full NUL word after it.
  assert.equal(encodeOscInt("/abc", 1).length, 8 + 4 + 4);
  assert.deepEqual(decodeOsc(encodeOscInt("/avatar/parameters/motor", 255)), { address: "/avatar/parameters/motor", args: [255] });
  assert.deepEqual(decodeOsc(encodeOscInt("/motor", -1)).args, [-1]);
  assert.throws(() => encodeOscInt("motor", 1), /start with \//);
});

test("settings are clamped and the maximum never exceeds the ceiling", () => {
  const defaults = motorSettings({});
  assert.equal(defaults.maxSpeed, 0.25);
  assert.equal(maxTxFor(defaults, defaults.maxSpeed), 42);
  assert.equal(motorSettings({ maxSpeedPercent: 90, maxSpeedCeilingPercent: 40 }).maxSpeed, 0.4);
  assert.equal(motorSettings({ maxSpeedPercent: "500" }).maxSpeed, 1);
  assert.equal(motorSettings({ startTx: 999 }).startTx, 255);
  assert.equal(motorSettings({ inputTimeoutSeconds: 0 }).inputTimeoutMs, 1000);
  assert.equal(motorSettings({ outerProximity: 0.6, innerProximity: 0.4 }).bandValid, false);
});

test("proximity maps through the band to a value capped by the maximum", () => {
  const settings = motorSettings({});
  const tx = (value, wasOff = false) => proximityToTx(value, settings, settings.maxSpeed, wasOff).tx;
  assert.equal(tx(0), 0);
  assert.equal(tx(-1), 0);
  assert.equal(tx(1), 42);
  assert.equal(tx(1.7), 42, "past the inner edge saturates");
  assert.equal(tx(0.5), 21);
  assert.equal(tx("0.5"), 21, "a value that arrives as text still counts");
  assert.equal(tx("not a number"), 0);
  assert.equal(tx(Number.NaN), 0);
  // First touch is raised to the start pulse.
  assert.equal(tx(0.05, true), 20);
  assert.equal(tx(0.05, false), 2);

  const banded = motorSettings({ outerProximity: 0.2, innerProximity: 0.6 });
  assert.equal(proximityToTx(0.1, banded, banded.maxSpeed, false).tx, 0);
  assert.equal(proximityToTx(0.4, banded, banded.maxSpeed, false).tx, 21);
  assert.equal(proximityToTx(0.9, banded, banded.maxSpeed, false).tx, 42);
  const broken = motorSettings({ outerProximity: 0.6, innerProximity: 0.6 });
  assert.equal(proximityToTx(1, broken, broken.maxSpeed, true).tx, 0);
});

test("the start pulse never goes above a low maximum", () => {
  const settings = motorSettings({ maxSpeedPercent: 5, startTx: 20 });
  assert.equal(maxTxFor(settings, settings.maxSpeed), 8);
  assert.equal(proximityToTx(0.01, settings, settings.maxSpeed, true).tx, 8);
});

test("the avatar's maximum speed is kept between 5 % and the ceiling", () => {
  const settings = motorSettings({ maxSpeedCeilingPercent: 60 });
  assert.deepEqual(clampMaxSpeed(0.5, settings), { valid: true, maxSpeed: 0.5, clamped: false });
  assert.deepEqual(clampMaxSpeed(5, settings), { valid: true, maxSpeed: 0.6, clamped: true });
  assert.deepEqual(clampMaxSpeed(0, settings), { valid: true, maxSpeed: 0.05, clamped: true });
  assert.equal(clampMaxSpeed("x", settings).valid, false);
});

function channel(options = {}) {
  const clock = fakeClock();
  const sent = [];
  const settings = motorSettings({ minSendIntervalMs: 20, inputTimeoutSeconds: 5, ...options });
  const motor = new MotorChannel({ send: (tx) => sent.push([clock.now() - 1_000_000, tx]), settings, now: clock.now, timers: clock.timers });
  return { clock, sent, motor, values: () => sent.map(([, tx]) => tx) };
}

test("updates are latest-wins: one send per interval, the trailing one carrying the newest value", () => {
  const { clock, sent, motor } = channel();
  motor.setProximity(0.2);
  clock.advance(5);
  motor.setProximity(0.4);
  clock.advance(5);
  motor.setProximity(0.6);
  clock.advance(5);
  motor.setProximity(0.8);
  clock.advance(30);
  assert.deepEqual(sent, [[0, 20], [20, 34]]);
  motor.setProximity(0.8);
  clock.advance(30);
  assert.equal(sent.length, 2, "an unchanged value is not sent again");
  motor.dispose();
});

test("a 0 goes out at once, then four repeats, then once a second until the next touch", () => {
  const { clock, sent, motor, values } = channel();
  motor.setProximity(1);
  clock.advance(1);
  motor.setProximity(0);
  assert.deepEqual(sent.at(-1), [1, 0], "the stop does not wait for the send interval");
  clock.advance(200);
  assert.deepEqual(values(), [42, 0, 0, 0, 0, 0]);
  clock.advance(3000);
  assert.deepEqual(values().slice(6), [0, 0, 0]);
  motor.setProximity(1);
  clock.advance(5300);
  assert.equal(values().at(-1), 0, "silence after the touch stops it again");
  motor.dispose();
});

test("silence from the avatar stops a running motor after the input timeout", () => {
  const { clock, motor, values } = channel({ inputTimeoutSeconds: 2 });
  motor.setProximity(0.5);
  clock.advance(1900);
  assert.deepEqual(values(), [21]);
  clock.advance(500);
  assert.deepEqual(values(), [21, 0, 0, 0, 0, 0], "the stop and its four repeats");
  motor.dispose();
});

test("a buzz rides on top of the contact and then returns to it", () => {
  const { clock, motor, values } = channel();
  motor.setProximity(0.25);
  clock.advance(50);
  assert.deepEqual(motor.vibrate(100, 300), { tx: 42, durationMs: 300 });
  clock.advance(250);
  motor.setProximity(0.25);
  clock.advance(100);
  assert.deepEqual(values(), [20, 42, 11]);
  motor.stop();
  assert.equal(values().at(-1), 0);
  assert.deepEqual(motor.vibrate(0, 300), { tx: 0, durationMs: 300 });
  assert.equal(motor.vibrate(50, 999_999).durationMs, 10_000);
  motor.dispose();
});

test("lowering the maximum caps a running motor at once", () => {
  const { clock, motor, values } = channel();
  motor.setProximity(1);
  clock.advance(50);
  motor.setMaxSpeed(0.1);
  clock.advance(50);
  assert.deepEqual(values(), [42, 17]);
  motor.dispose();
});

test("a disposed channel sends nothing", () => {
  const { clock, motor, values } = channel();
  motor.dispose();
  motor.setProximity(1);
  clock.advance(10_000);
  assert.deepEqual(values(), []);
});
