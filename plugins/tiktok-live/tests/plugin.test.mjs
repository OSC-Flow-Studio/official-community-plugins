import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_ID_KEY, TARGET_IDC_KEY, extractCookie } from "../plugin/chat/signin.mjs";
import { fakeSource, proto } from "./helpers/fakes.mjs";
import { boot, flagsFetch } from "./helpers/scenario.mjs";

const chat = (n, content, extra = {}) => ["WebcastChatMessage", { common: proto.common("WebcastChatMessage", extra), user: proto.user(n), content }];

test("without a username the plugin explains what is missing and does not connect", async () => {
  const source = fakeSource();
  const run = await boot({ uniqueId: "" }, { source });
  try {
    assert.equal(source.started, 0);
    const status = run.statuses.at(-1);
    assert.equal(status.health, "error");
    assert.match(status.errors.join(" "), /TikTok username/);
    const result = await run.actions.get("connect")({});
    assert.equal(result.ok, false);
  } finally {
    await run.runtime.shutdown();
  }
});

test("a message TikTok repeats fires once, and the status says how many were dropped", async () => {
  const run = await boot();
  try {
    run.source.state("connected");
    const message = chat(1, "hello");
    run.source.proto(...message);
    run.source.proto(...message);
    assert.equal(run.of("chat").length, 1);
    assert.equal((await run.actions.get("status")({})).duplicatesDropped, 1);
  } finally {
    await run.runtime.shutdown();
  }
});

test("chat commands are split into command and arguments, with the configured prefix", async () => {
  const run = await boot({ commandPrefix: "?" });
  try {
    run.source.proto(...chat(1, "?Dance  slowly now"));
    run.source.proto(...chat(1, "? not a command"));
    run.source.proto(...chat(1, "!dance"));
    const [command] = run.of("command");
    assert.deepEqual([command.command, command.args, command.prefix], ["dance", "slowly now", "?"]);
    assert.equal(run.of("command").length, 1);
    assert.deepEqual(run.of("chat").map((item) => item.isCommand), [true, false, false]);
  } finally {
    await run.runtime.shutdown();
  }
});

test("a new room starts a new session and announces the stream; the same room keeps counting", async () => {
  const run = await boot();
  try {
    run.source.proto("WebcastGiftMessage", proto.gift(1, { type: 4, diamonds: 10 }));
    assert.equal(run.of("stream").at(-1).phase, "live");
    assert.equal(run.runtime.session.totals.coins, 10);
    const next = proto.gift(2, { type: 4, diamonds: 5 });
    next.common.roomId = "7700000000000000099";
    run.source.proto("WebcastGiftMessage", next);
    assert.equal(run.runtime.session.totals.coins, 5);
    assert.equal(run.of("stream").filter((item) => item.phase === "live").length, 2);
    assert.equal(run.of("gift").at(-1).isFirstGiftThisSession, true);
  } finally {
    await run.runtime.shutdown();
  }
  const keep = await boot({ resetOnStreamStart: false });
  try {
    keep.source.proto("WebcastGiftMessage", proto.gift(1, { type: 4, diamonds: 10 }));
    const next = proto.gift(2, { type: 4, diamonds: 5 });
    next.common.roomId = "7700000000000000099";
    keep.source.proto("WebcastGiftMessage", next);
    assert.equal(keep.runtime.session.totals.coins, 15);
  } finally {
    await keep.runtime.shutdown();
  }
});

test("the session and the gift picker survive a restart, and returning viewers are recognised", async () => {
  const vault = new Map();
  const first = await boot({}, { vault });
  first.source.proto("WebcastMemberMessage", { common: proto.common("WebcastMemberMessage"), user: proto.user(1), action: 1, memberCount: 10 });
  first.source.proto("WebcastGiftMessage", proto.gift(1, { type: 4, diamonds: 30, giftId: 5879, name: "Doughnut" }));
  first.source.proto("WebcastGiftMessage", proto.gift(1, { repeatCount: 4 }));
  await first.runtime.shutdown();
  assert.equal(JSON.parse(vault.get("session-state-v1")).totals.coins, 34, "an open streak counts when the plugin stops");
  assert.ok(first.resources.some(({ key, items }) => key === "gifts" && items.some((item) => item.value === "5879")));

  const second = await boot({}, { vault });
  try {
    assert.equal(second.runtime.session.totals.coins, 34);
    assert.deepEqual(second.resources[0].items.map((item) => item.value).sort(), ["5655", "5879"]);
    const room = proto.common("WebcastMemberMessage");
    room.roomId = "7700000000000000077";
    second.source.proto("WebcastMemberMessage", { common: room, user: proto.user(1), action: 1, memberCount: 3 });
    const join = second.of("member").at(-1);
    assert.deepEqual([join.isFirstJoin, join.isReturning], [true, true]);
  } finally {
    await second.runtime.shutdown();
  }
});

test("milestones start from what the plugin has seen, not from a stream joined late", async () => {
  const run = await boot({ likeMilestoneStep: 100, viewerMilestoneStep: 10 });
  try {
    const like = (total) => run.source.proto("WebcastLikeMessage", { common: proto.common("WebcastLikeMessage"), user: proto.user(1), count: 5, total: String(total) });
    const viewers = (total) => run.source.proto("WebcastRoomUserSeqMessage", { common: proto.common("WebcastRoomUserSeqMessage"), total: String(total), ranks: [] });
    like(40144);
    assert.equal(run.of("like-milestone").length, 0);
    like(40350);
    assert.deepEqual(run.of("like-milestone").map((item) => item.milestone), [40200, 40300]);
    viewers(95);
    viewers(95);
    viewers(112);
    viewers(108);
    const counts = run.of("viewer-count");
    assert.deepEqual(counts.map((item) => [item.viewerCount, item.direction, item.crossedMilestone, item.milestone]), [[95, "up", false, 0], [112, "up", true, 110], [108, "down", false, 0]]);
  } finally {
    await run.runtime.shutdown();
  }
});

test("the gift list needs a paid Euler plan; the plugin says so and keeps learning gifts", async () => {
  const source = fakeSource();
  source.giftError = Object.assign(new Error("This endpoint requires a Business plan."), { name: "PremiumFeatureError" });
  const run = await boot({}, { source });
  try {
    const failed = await run.actions.get("refresh-gifts")({});
    assert.equal(failed.ok, false);
    assert.match(failed.error, /paid Euler Stream plan/);
    source.giftError = null;
    source.gifts = [{ id: 5655, name: "Rose", diamond_count: 1, type: 1 }, { id: 5879, name: "Doughnut", diamond_count: 30, type: 1 }];
    assert.deepEqual(await run.actions.get("refresh-gifts")({}), { ok: true, count: 2, error: "" });
    assert.equal(run.actions.get("gift-lookup")({ giftName: "DOUGHNUT" }).giftId, 5879);
  } finally {
    await run.runtime.shutdown();
  }
  const bridge = await boot({ transport: "tikfinity" }, { source: fakeSource({ transport: "tikfinity", capabilities: { giftList: false, chat: false, isLive: false } }) });
  try {
    assert.match((await bridge.actions.get("refresh-gifts")({})).error, /TikFinity/);
    assert.match((await bridge.actions.get("wait-until-live")({})).error, /TikFinity/);
  } finally {
    await bridge.runtime.shutdown();
  }
});

test("disconnect stops listening until connect runs again", async () => {
  const source = fakeSource();
  const run = await boot({}, { source, createSource: () => source });
  try {
    assert.equal(source.started, 1);
    await run.actions.get("disconnect")({});
    assert.equal(source.stopped, 1);
    assert.equal(run.of("connection").at(-1).state, "stopped");
    await run.actions.get("connect")({});
    assert.equal(source.started, 2);
    await run.actions.get("connect")({});
    assert.equal(source.reconnects, 1);
  } finally {
    await run.runtime.shutdown();
  }
});

test("sending chat is refused, with the reason, until every condition holds", async () => {
  const vault = new Map();
  const off = await boot({}, { vault });
  try {
    assert.equal((await off.actions.get("send-chat")({ message: "hi" })).disabledReason, "disabled");
  } finally {
    await off.runtime.shutdown();
  }
  const noKey = await boot({ chatEnabled: true }, { vault });
  try {
    assert.match((await noKey.actions.get("send-chat")({ message: "hi" })).error, /Euler Stream API key/);
  } finally {
    await noKey.runtime.shutdown();
  }
  const ready = await boot({ chatEnabled: true, signApiKey: "euler_key" }, { vault });
  try {
    assert.match((await ready.actions.get("send-chat")({ message: "hi" })).error, /not signed in/);
    vault.set(SESSION_ID_KEY, "abcdef0123456789");
    vault.set(TARGET_IDC_KEY, "useast2a");
    assert.match((await ready.actions.get("send-chat")({ message: "x".repeat(151) })).error, /150 characters/);
    const sent = await ready.actions.get("send-chat")({ message: "  thanks   for the rose " });
    assert.deepEqual(sent, { ok: true, error: "", disabledReason: "" });
    assert.deepEqual(ready.source.sent[0], { message: "thanks for the rose", session: { sessionId: "abcdef0123456789", ttTargetIdc: "useast2a" } });
    assert.equal(ready.of("chat-sent").at(-1).ok, true);
    assert.equal((await ready.actions.get("status")({})).chatAvailable, true);
  } finally {
    await ready.runtime.shutdown();
  }
});

test("the maintainers' switch turns sending off as deprecated, without touching TikTok", async () => {
  const vault = new Map([[SESSION_ID_KEY, "abcdef0123456789"], [TARGET_IDC_KEY, "useast2a"]]);
  const run = await boot({ chatEnabled: true, signApiKey: "euler_key" }, { vault, fetchImpl: flagsFetch({ enabled: false, message: "TikTok is suspending accounts." }) });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const result = await run.actions.get("send-chat")({ message: "hi" });
    assert.equal(result.ok, false);
    assert.match(result.disabledReason, /^deprecated: .*suspending accounts/);
    assert.equal(run.source.sent.length, 0);
    assert.match(run.statuses.at(-1).errors.join(" "), /Send chat is deprecated/);
    assert.equal((await run.actions.get("chat-sign-in")({})).ok, false);
    assert.match(vault.get("feature-flags-cache"), /"enabled":false/);
  } finally {
    await run.runtime.shutdown();
  }
  // Offline next time: the cached answer holds.
  const offline = await boot({ chatEnabled: true, signApiKey: "euler_key" }, { vault, fetchImpl: async () => { throw new Error("offline"); } });
  try {
    assert.match((await offline.actions.get("send-chat")({ message: "hi" })).disabledReason, /^deprecated:/);
  } finally {
    await offline.runtime.shutdown();
  }
});

test("the sign-in page saves the cookies to the vault and nothing else accepts them", async () => {
  const vault = new Map();
  const run = await boot({ chatEnabled: true, signApiKey: "euler_key" }, { vault });
  try {
    const { ok, url, expiresInSeconds } = await run.actions.get("chat-sign-in")({});
    assert.equal(ok, true);
    assert.equal(expiresInSeconds, 600);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32}$/);
    assert.match(run.statuses.at(-1).errors.join(" "), /sign-in page is open/);

    const form = await fetch(url);
    assert.equal(form.status, 200);
    assert.match(form.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal((await fetch(`${new URL(url).origin}/wrong-token`)).status, 410);

    const post = (body, headers = {}) => fetch(url, { method: "POST", body: new URLSearchParams(body), headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });
    assert.equal((await post({ sessionId: "abc", ttTargetIdc: "useast2a" })).status, 400);
    assert.equal((await post({ sessionId: "abcdef0123456789", ttTargetIdc: "useast2a" }, { origin: "https://evil.example" })).status, 403);
    assert.equal(vault.has(SESSION_ID_KEY), false);
    assert.equal((await post({ sessionId: "sessionid=abcdef0123456789; other=1", ttTargetIdc: "tt-target-idc=useast2a" })).status, 200);
    assert.equal(vault.get(SESSION_ID_KEY), "abcdef0123456789");
    assert.equal(vault.get(TARGET_IDC_KEY), "useast2a");
    assert.ok(!run.logs.some(([, message]) => message.includes("abcdef0123456789")), "cookies never reach the log");
    assert.deepEqual(await run.actions.get("chat-sign-out")({}), { ok: true, error: "" });
    assert.equal(vault.has(SESSION_ID_KEY), false);
  } finally {
    await run.runtime.shutdown();
  }
});

test("pasted cookies are accepted as a value, as name=value or as a whole Cookie header", () => {
  assert.equal(extractCookie("abc123==", "sessionid"), "abc123==");
  assert.equal(extractCookie("sessionid=abc123", "sessionid"), "abc123");
  assert.equal(extractCookie("a=1; sessionid=abc123; b=2", "sessionid"), "abc123");
  assert.equal(extractCookie("a=1; b=2", "sessionid"), "");
});

test("stream end closes open streaks and the battle, and other TikTok messages pass only when asked", async () => {
  const run = await boot();
  try {
    run.source.proto("WebcastGiftMessage", proto.gift(1, { repeatCount: 7 }));
    run.source.proto("WebcastLinkMicMethod", { common: proto.common("WebcastLinkMicMethod") });
    run.source.proto("WebcastControlMessage", { common: proto.common("WebcastControlMessage"), action: 3 });
    assert.equal(run.of("gift").at(-1).repeatCount, 7);
    assert.equal(run.of("stream").at(-1).phase, "ended");
    assert.equal(run.of("raw").length, 0);
  } finally {
    await run.runtime.shutdown();
  }
});
