import dgram from "node:dgram";
import { TYPE } from "../../plugin/mdns.mjs";

/** Timers driven by hand: `advance(ms)` runs everything due, in order. */
export function fakeClock(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const pending = new Map();
  const schedule = (callback, ms, every) => {
    const id = nextId++;
    pending.set(id, { at: now + Math.max(0, ms), callback, every });
    return id;
  };
  const clock = {
    now: () => now,
    timers: {
      setTimeout: (callback, ms) => schedule(callback, ms, 0),
      clearTimeout: (id) => pending.delete(id),
      setInterval: (callback, ms) => schedule(callback, ms, ms),
      clearInterval: (id) => pending.delete(id),
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of pending) if (timer.at <= until && (!due || timer.at < due[1].at)) due = [id, timer];
        if (!due) break;
        const [id, timer] = due;
        now = timer.at;
        if (timer.every > 0) timer.at += timer.every;
        else pending.delete(id);
        timer.callback();
      }
      now = until;
    },
  };
  return clock;
}

function readOscString(buffer, offset) {
  const end = buffer.indexOf(0, offset);
  return { text: buffer.toString("ascii", offset, end), next: Math.ceil((end + 1) / 4) * 4 };
}

/** Decodes one OSC message with int, float, string and bool arguments. */
export function decodeOsc(buffer) {
  const address = readOscString(buffer, 0);
  const tags = readOscString(buffer, address.next);
  let offset = tags.next;
  const args = [];
  for (const tag of tags.text.slice(1)) {
    if (tag === "i") { args.push(buffer.readInt32BE(offset)); offset += 4; }
    else if (tag === "f") { args.push(buffer.readFloatBE(offset)); offset += 4; }
    else if (tag === "s") { const value = readOscString(buffer, offset); args.push(value.text); offset = value.next; }
    else if (tag === "T") args.push(true);
    else if (tag === "F") args.push(false);
    else throw new Error(`unsupported OSC tag ${tag}`);
  }
  return { address: address.text, args };
}

/** A Puck on 127.0.0.1 that records every motor value it receives. */
export async function fakePuck() {
  const socket = dgram.createSocket("udp4");
  const received = [];
  socket.on("message", (message) => {
    const { address, args } = decodeOsc(message);
    received.push({ address, value: args[0], at: Date.now() });
  });
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return {
    port: socket.address().port,
    received,
    values: (address = "/motor") => received.filter((item) => item.address === address).map((item) => item.value),
    close: () => new Promise((resolve) => socket.close(resolve)),
  };
}

function encodeName(name) {
  return Buffer.concat([...name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);
}

/** One resource record; `data` is already the encoded RDATA. */
export function record(name, type, data, ttl = 120) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(0x8001, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([encodeName(name), head, data]);
}

export const rdata = {
  a: (address) => Buffer.from(address.split(".").map(Number)),
  ptr: (name) => encodeName(name),
  srv: (target, port = 80) => {
    const head = Buffer.alloc(6);
    head.writeUInt16BE(port, 4);
    return Buffer.concat([head, encodeName(target)]);
  },
  txt: (...strings) => Buffer.concat(strings.map((text) => Buffer.concat([Buffer.from([text.length]), Buffer.from(text)]))),
};

/** A response message carrying `answers` and `additionals` (arrays of encoded records). */
export function response({ id = 0, answers = [], additionals = [] }) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(additionals.length, 10);
  return Buffer.concat([header, ...answers, ...additionals]);
}

/** The records a Puck at `address` sends for `_http._tcp.local`. */
export function puckAnswer(address, { instance = "giggletech", host = "giggletech.local" } = {}) {
  return {
    answers: [record("_http._tcp.local", TYPE.PTR, rdata.ptr(`${instance}._http._tcp.local`))],
    additionals: [
      record(`${instance}._http._tcp.local`, TYPE.SRV, rdata.srv(host)),
      record(host, TYPE.A, rdata.a(address)),
    ],
  };
}

/**
 * A responder on 127.0.0.1 standing in for the network: it answers each query to the port
 * it came from, the way an mDNS responder answers a unicast query. `pucks` lists the
 * addresses it reports, and can be changed while it runs.
 */
export async function fakeResponder(pucks = []) {
  const socket = dgram.createSocket("udp4");
  const state = { pucks: [...pucks], queries: 0 };
  socket.on("message", (message, from) => {
    state.queries += 1;
    for (const address of state.pucks) {
      const { answers, additionals } = puckAnswer(address, { instance: `giggletech-${address.replaceAll(".", "-")}`, host: `gigglepuck-${address.replaceAll(".", "-")}.local` });
      socket.send(response({ id: message.readUInt16BE(0), answers, additionals }), from.port, from.address);
    }
  });
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return { target: { address: "127.0.0.1", port: socket.address().port }, state, close: () => new Promise((resolve) => socket.close(resolve)) };
}

/** A plugin context like the one the Studio hands to `activate`. */
export function context(config = {}) {
  const controller = new AbortController();
  const actions = new Map();
  const triggers = [];
  const statuses = [];
  const resources = [];
  const logs = [];
  const values = { enabled: true, discovery: false, devices: [], ...config };
  return {
    controller,
    actions,
    triggers,
    statuses,
    resources,
    logs,
    ctx: {
      pluginId: "giggle-puck",
      apiVersion: 1,
      signal: controller.signal,
      config: { get: async () => values },
      secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
      registerAction: (name, handler) => actions.set(name, handler),
      emitTrigger: (kind, payload) => triggers.push({ kind, payload }),
      setStatus: (status) => statuses.push(status),
      setResource: (key, items) => resources.push({ key, items }),
      onFlowsChanged: () => {},
      log: {
        info: (message) => logs.push(["info", message]),
        warn: (message) => logs.push(["warn", message]),
        error: (message) => logs.push(["error", message]),
      },
    },
  };
}

/** Polls `check` until it is truthy or `ms` pass. */
export async function until(check, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met in time");
}
