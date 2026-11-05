import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { ChatSender, NotLiveError } from "../plugin/chat/sender.mjs";
import { DirectSource, explain } from "../plugin/sources/direct.mjs";
import { TikfinitySource } from "../plugin/sources/tikfinity.mjs";
import { fakeClock } from "./helpers/fakes.mjs";

const settle = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};
const log = { info: () => {}, warn: () => {}, error: () => {} };

class UserOfflineError extends Error {}
class SignatureRateLimitError extends Error {
  constructor(message, retryAfter) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

/** A stand-in for the bundled library: each connect() takes the next scripted outcome. */
function fakeLibrary(script) {
  const made = [];
  class TikTokLiveConnection extends EventEmitter {
    constructor(uniqueId, options) {
      super();
      this.uniqueId = uniqueId;
      this.options = options;
      this.roomId = "R1";
      made.push(this);
    }
    async connect() {
      const next = script.connect.shift() ?? "ok";
      if (next instanceof Error) throw next;
      return {};
    }
    async disconnect() {
      this.emit("disconnected", {});
    }
    async fetchIsLive() {
      return script.live.shift() ?? false;
    }
    async fetchRoomInfo() {
      return { data: { owner: { id_str: "100", display_id: "host" }, title: "Hi", create_time: 1793890000, status: 2 } };
    }
    async fetchRoomId() {
      return script.roomId ?? "R2";
    }
    async sendMessage(content, roomId) {
      script.sent.push({ content, roomId, session: this.options.session });
    }
  }
  return { made, lib: { TikTokLiveConnection, SignConfig: {}, getRandomPresets: () => ({ device: {}, screen: {} }) } };
}

function direct(script, clock) {
  const { made, lib } = fakeLibrary(script);
  const states = [];
  const rooms = [];
  const events = [];
  const source = new DirectSource({ uniqueId: "host", signApiKey: "k1", reconnectMinMs: 5000, reconnectMaxMs: 20_000, offlinePollMs: 60_000, timers: clock.timers, log, load: async () => lib });
  source.onState((state) => states.push(state));
  source.onRoom((room) => rooms.push(room));
  source.onEvent((event) => events.push(event));
  return { source, states, rooms, events, made, lib };
}

test("offline streamer: the direct source waits, checks without signing, and connects once live", async () => {
  const clock = fakeClock();
  const script = { connect: [new UserOfflineError("The requested user isn't online :(")], live: [false, true], sent: [] };
  const run = direct(script, clock);
  await run.source.start();
  await settle();
  assert.equal(run.states.at(-1).state, "waiting");
  clock.advance(60_000);
  await settle();
  assert.equal(run.states.at(-1).state, "waiting");
  clock.advance(60_000);
  await settle(10);
  assert.equal(run.states.at(-1).state, "connected");
  assert.equal(run.rooms[0].hostUserId, "100");
  assert.equal(run.lib.SignConfig.apiKey, "k1");
  assert.deepEqual(run.made.at(-1).options.clientPresets.location, { lang_country: "en-US", lang: "en", country: "US", tz_name: "America/New_York" });
  assert.equal(run.made.at(-1).options.enableExtendedGiftInfo, false);
  run.made.at(-1).emit("decodedData", "WebcastChatMessage", { type: "WebcastChatMessage", data: { content: "hi" } });
  assert.deepEqual(run.events[0], { transport: "direct", format: "proto", type: "WebcastChatMessage", data: { content: "hi" } });
  await run.source.stop();
});

test("a rate limit waits at least 60 s; other failures back off and double", async () => {
  const clock = fakeClock();
  const script = { connect: [new SignatureRateLimitError("Too many connections started", 1000), new Error("socket hang up"), new Error("socket hang up")], live: [], sent: [] };
  const run = direct(script, clock);
  await run.source.start();
  await settle();
  assert.equal(run.states.at(-1).state, "error");
  assert.equal(run.states.at(-1).rateLimited, true);
  assert.match(run.states.at(-1).reason, /rate limit/);
  clock.advance(59_000);
  await settle();
  assert.equal(run.made.length, 1, "no retry before 60 s");
  clock.advance(1000);
  await settle();
  assert.equal(run.made.length, 2);
  clock.advance(10_000);
  await settle();
  assert.equal(run.made.length, 3, "second failure waits 10 s (doubled from 5 s)");
  clock.advance(20_000);
  await settle(10);
  assert.equal(run.states.at(-1).state, "connected");
  await run.source.stop();
  assert.equal(clock.pending(), 0, "stop clears every timer");
});

test("a dropped connection reconnects; a stream end waits for the next LIVE", async () => {
  const clock = fakeClock();
  const script = { connect: ["ok", "ok"], live: [true], sent: [] };
  const run = direct(script, clock);
  await run.source.start();
  await settle(10);
  run.made[0].emit("disconnected", {});
  await settle();
  assert.equal(run.states.at(-1).state, "disconnected");
  clock.advance(5000);
  await settle(10);
  assert.equal(run.states.at(-1).state, "connected");
  run.made[1].emit("streamEnd", {});
  run.made[1].emit("disconnected", {});
  await settle();
  assert.equal(run.states.at(-1).state, "waiting");
  await run.source.stop();
});

test("chat goes out through its own client with the cookies, and finds the room without a connection", async () => {
  const script = { connect: [], live: [true], sent: [] };
  const { made, lib } = fakeLibrary(script);
  const sender = new ChatSender({ load: async () => lib });
  const request = { uniqueId: "host", apiKey: "k1", sessionId: "s1", ttTargetIdc: "useast2a", message: "hello" };
  assert.deepEqual(await sender.send(request), { roomId: "R2" });
  assert.equal(lib.SignConfig.apiKey, "k1");
  assert.equal(made[0].options.fetchRoomInfoOnConnect, false);
  assert.deepEqual(script.sent[0], { content: "hello", roomId: "R2", session: { cookie: { type: "cookie", value: { sessionId: "s1", ttTargetIdc: "useast2a" } } } });
  // The open connection's room skips the lookup.
  assert.deepEqual(await sender.send({ ...request, roomId: "R1" }), { roomId: "R1" });
  assert.equal(script.sent[1].roomId, "R1");
  // Offline: nothing is sent.
  await assert.rejects(sender.send(request), (error) => error instanceof NotLiveError && /@host is not live/.test(error.message));
  assert.equal(script.sent.length, 2);
});

test("errors are explained in plain words without echoing secrets", () => {
  assert.match(explain(new UserOfflineError("x isn't online")), /not live/);
  assert.match(explain(Object.assign(new Error("Failed to sign a request: This endpoint requires a Business plan."), {})), /paid Euler Stream plan/);
  assert.equal(explain(new Error("x".repeat(400))).length, 300);
});

test("the TikFinity bridge relays events, and reconnects when TikFinity restarts", async () => {
  let server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const states = [];
  const events = [];
  const source = new TikfinitySource({ url: `ws://127.0.0.1:${port}/`, timers: { setTimeout, clearTimeout, setInterval, clearInterval }, log });
  source.onState((state) => states.push(state.state));
  source.onEvent((event) => events.push(event));
  try {
    const connected = new Promise((resolve) => server.once("connection", resolve));
    await source.start();
    const socket = await connected;
    socket.send(JSON.stringify({ event: "gift", data: { giftId: 5655, uniqueId: "ana" } }));
    socket.send("not json");
    await waitFor(() => events.length === 1);
    assert.deepEqual(events[0], { transport: "tikfinity", format: "tikfinity", type: "gift", data: { giftId: 5655, uniqueId: "ana" } });
    assert.ok(states.includes("connected"));

    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    await waitFor(() => states.at(-1) === "disconnected");
    server = new WebSocketServer({ port, host: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    await waitFor(() => states.at(-1) === "connected", 8000);
  } finally {
    await source.stop();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function waitFor(check, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
