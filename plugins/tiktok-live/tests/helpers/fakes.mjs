import { readFileSync } from "node:fs";

/** Timers driven by hand: `advance(ms)` runs everything due, in order. */
export function fakeClock(start = Date.parse("2026-11-05T12:00:00.000Z")) {
  let now = start;
  let nextId = 1;
  const pending = new Map();
  const schedule = (callback, ms, every) => {
    const id = nextId++;
    pending.set(id, { at: now + Math.max(0, ms), callback, every });
    return id;
  };
  return {
    now: () => now,
    timers: {
      setTimeout: (callback, ms) => schedule(callback, ms, 0),
      clearTimeout: (id) => pending.delete(id),
      setInterval: (callback, ms) => schedule(callback, ms, ms),
      clearInterval: (id) => pending.delete(id),
    },
    pending: () => pending.size,
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
}

/** A plugin context like the one the Studio hands to `activate`, with a vault in memory. */
export function context(config = {}, vault = new Map()) {
  const controller = new AbortController();
  const actions = new Map();
  const triggers = [];
  const statuses = [];
  const resources = [];
  const logs = [];
  const values = { enabled: true, uniqueId: "some_streamer", transport: "direct", ...config };
  return {
    controller,
    actions,
    triggers,
    statuses,
    resources,
    logs,
    vault,
    kinds: () => triggers.map((item) => item.kind),
    of: (kind) => triggers.filter((item) => item.kind === kind).map((item) => item.payload),
    ctx: {
      pluginId: "tiktok-live",
      apiVersion: 2,
      signal: controller.signal,
      config: { get: async () => values },
      secrets: {
        get: async (key) => vault.get(key) ?? null,
        set: async (key, value) => void vault.set(key, String(value)),
        delete: async (key) => void vault.delete(key),
      },
      registerAction: (name, handler) => actions.set(name, handler),
      emitTrigger: (kind, payload) => triggers.push({ kind, payload: structuredClone(payload) }),
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

/** Records what TikTok: send chat message asks to send; `error` makes the next sends fail. */
export function fakeChatSender() {
  const sender = {
    sent: [],
    error: null,
    async send(request) {
      if (sender.error) throw sender.error;
      sender.sent.push(request);
      return { roomId: request.roomId || "7700000000000000009" };
    },
  };
  return sender;
}

/** A transport that delivers whatever the test pushes, and records what flows ask of it. */
export function fakeSource({ transport = "direct", capabilities } = {}) {
  const handlers = {};
  const source = {
    transport,
    capabilities: capabilities ?? { giftList: true, isLive: true, roomInfo: true },
    started: 0,
    stopped: 0,
    reconnects: 0,
    gifts: [],
    live: false,
    giftError: null,
    onEvent: (handler) => { handlers.event = handler; },
    onState: (handler) => { handlers.state = handler; },
    onRoom: (handler) => { handlers.room = handler; },
    async start() { source.started += 1; },
    async stop() { source.stopped += 1; },
    reconnectNow() { source.reconnects += 1; },
    async fetchIsLive() { return source.live; },
    async fetchGifts() {
      if (source.giftError) throw source.giftError;
      return source.gifts;
    },
    proto: (type, data) => handlers.event({ transport, format: "proto", type, data }),
    tikfinity: (type, data) => handlers.event({ transport: "tikfinity", format: "tikfinity", type, data }),
    state: (state, reason = "") => handlers.state({ state, reason, attempt: 0, rateLimited: false }),
    room: (info) => handlers.room(info),
  };
  return source;
}

export const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

let msg = 7_800_000_000_000_000_000n;
const nextMsgId = () => String(++msg);

/** Builders for protobuf-shaped messages, in the same shape the connector decodes. */
export const proto = {
  user: (n, extra = {}) => ({ id: `71000000000000000${String(n).padStart(2, "0")}`, nickname: `Viewer ${n}`, displayId: `viewer_${n}`, avatarThumb: { urlList: [`https://example.invalid/${n}.webp`] }, followInfo: { followStatus: "0" }, payGrade: { level: 0 }, ...extra }),
  common: (method, extra = {}) => ({ method, msgId: nextMsgId(), roomId: "7700000000000000001", createTime: "1793890000000", ...extra }),
  gift: (n, { giftId = 5655, name = "Rose", type = 1, diamonds = 1, repeatCount = 1, repeatEnd = false, groupId = "1", toUser } = {}) => ({
    common: proto.common("WebcastGiftMessage"),
    user: proto.user(n),
    giftId: String(giftId),
    repeatCount,
    repeatEnd: repeatEnd ? 1 : 0,
    groupId,
    toUser,
    gift: { id: String(giftId), name, type, diamondCount: diamonds, image: { urlList: [`https://example.invalid/gift/${giftId}.webp`] } },
  }),
};
