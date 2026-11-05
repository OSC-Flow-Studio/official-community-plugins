import assert from "node:assert/strict";
import test from "node:test";
import { BattleTracker, UPDATE_THROTTLE_MS } from "../plugin/battle.mjs";
import { RecentKeys, eventKey } from "../plugin/dedup.mjs";
import { GiftCatalogue } from "../plugin/gifts.mjs";
import { Session, crossedMilestones } from "../plugin/session.mjs";
import { GiftStreaks, STALE_MS } from "../plugin/streaks.mjs";
import { fakeClock } from "./helpers/fakes.mjs";

const viewer = (n) => ({ userId: String(n), uniqueId: `v${n}`, nickname: `Viewer ${n}` });
const rose = (repeatCount, repeatEnd = false, n = 1) => ({ user: viewer(n), giftId: 5655, giftName: "Rose", giftType: 1, diamondCount: 1, repeatCount, repeatEnd, groupId: "g" });

test("a streak counts once, when it ends, with every tap in it", () => {
  const clock = fakeClock();
  const streaks = new GiftStreaks({ mode: "completed", now: clock.now, timers: clock.timers });
  assert.equal(streaks.add(rose(1)).counted, null);
  assert.equal(streaks.add(rose(4)).progress.phase, "progress");
  const end = streaks.add(rose(10, true));
  assert.equal(end.progress.phase, "end");
  assert.equal(end.counted.repeatCount, 10);
  assert.equal(streaks.size, 0);
});

test("in tap mode every tick counts the taps added since the last one", () => {
  const clock = fakeClock();
  const streaks = new GiftStreaks({ mode: "each", now: clock.now, timers: clock.timers });
  const counts = [rose(1), rose(4), rose(10, true)].map((gift) => streaks.add(gift).counted?.repeatCount ?? 0);
  assert.deepEqual(counts, [1, 3, 6]);
});

test("gifts that are not streakable count at once, and a silent streak closes after 15 s", () => {
  const clock = fakeClock();
  const expired = [];
  const streaks = new GiftStreaks({ mode: "completed", now: clock.now, timers: clock.timers, onExpire: (result) => expired.push(result) });
  const heart = streaks.add({ ...rose(1), giftId: 7934, giftType: 4 });
  assert.equal(heart.progress, null);
  assert.equal(heart.counted.repeatCount, 1);
  streaks.add(rose(6));
  clock.advance(STALE_MS - 1);
  assert.equal(expired.length, 0);
  clock.advance(1);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].counted.repeatCount, 6);
  assert.equal(expired[0].progress.phase, "end");
});

test("a battle starts, follows the score from the host's side, changes leader and ends with a result", () => {
  const clock = fakeClock();
  const emitted = [];
  const tracker = new BattleTracker({ now: clock.now, timers: clock.timers, hostUserId: () => "", roomId: () => "R1", onEmit: (phase, snapshot) => emitted.push(snapshot) });
  const anchors = [{ userId: "100", uniqueId: "host", nickname: "Host", roomId: "R1" }, { userId: "200", uniqueId: "rival", nickname: "Rival", roomId: "R2" }];
  tracker.battleEvent({ battleId: "b1", action: 4, status: 1, anchors, points: {}, results: {}, durationSeconds: 300, startedAtMs: 0 });
  tracker.armiesEvent({ battleId: "b1", status: 1, points: { 100: 5, 200: 0 } });
  tracker.armiesEvent({ battleId: "b1", status: 1, points: { 100: 6, 200: 0 } });
  clock.advance(UPDATE_THROTTLE_MS);
  tracker.armiesEvent({ battleId: "b1", status: 1, points: { 100: 6, 200: 40 } });
  clock.advance(10_000);
  tracker.battleEvent({ battleId: "b1", action: 5, status: 2, anchors: [], points: {}, results: { 100: { result: "lose", score: 30 }, 200: { result: "win", score: 40 } } });
  assert.deepEqual(emitted.map((item) => item.phase), ["start", "lead-change", "update", "lead-change", "end"]);
  const end = emitted.at(-1);
  assert.deepEqual([end.result, end.hostPoints, end.opponentPoints, end.opponentUniqueId, end.leader], ["lose", 30, 40, "rival", "opponent"]);
  assert.equal(tracker.state().lastResult, "lose");
  assert.equal(tracker.state().active, false);
});

test("a battle seen only through score updates still starts and ends, and its result is computed", () => {
  const clock = fakeClock();
  const emitted = [];
  const tracker = new BattleTracker({ now: clock.now, timers: clock.timers, hostUserId: () => "1", roomId: () => "", onEmit: (phase, snapshot) => emitted.push(snapshot) });
  tracker.armiesEvent({ battleId: "", status: 1, points: { 1: 10, 2: 3 } });
  tracker.armiesEvent({ battleId: "", status: 2, points: { 1: 12, 2: 3 } });
  assert.equal(emitted[0].phase, "start");
  assert.equal(emitted.at(-1).phase, "end");
  assert.equal(emitted.at(-1).result, "win");
  tracker.dispose();
});

test("session totals, ranking, milestones and persistence", () => {
  let now = 1000;
  const session = new Session({ now: () => now });
  const first = session.recordGift(viewer(1), 50, 1);
  assert.equal(first.isFirstGiftThisSession, true);
  now += 1;
  session.recordGift(viewer(2), 120, 2);
  now += 1;
  const again = session.recordGift(viewer(1), 80, 1);
  assert.equal(again.isFirstGiftThisSession, false);
  assert.equal(again.senderCoins, 130);
  assert.equal(again.senderRank, 1);
  assert.deepEqual(session.topIds(), ["1", "2"]);
  assert.deepEqual(crossedMilestones(950, 2100, 500), [1000, 1500, 2000]);
  assert.deepEqual(crossedMilestones(10, 9, 5), []);
  assert.deepEqual(crossedMilestones(0, 10, 0), []);

  const joined = session.recordJoin(viewer(3));
  assert.deepEqual(joined, { isFirstJoin: true, isReturning: false });
  assert.equal(session.recordJoin(viewer(3)).isFirstJoin, false);

  const restored = new Session({ now: () => now });
  assert.ok(restored.restore(JSON.parse(JSON.stringify(session.toJSON()))));
  assert.equal(restored.totals.coins, 250);
  assert.equal(restored.rankOf("2"), 2);
  restored.restoreKnownViewers(["3"]);
  restored.reset("all", "R2");
  assert.deepEqual(restored.recordJoin(viewer(3)), { isFirstJoin: true, isReturning: true });
  restored.reset("coins");
  assert.equal(restored.totals.coins, 0);
  assert.equal(restored.userStats("@V3").uniqueId, "v3");
});

test("repeated messages are dropped and every event has a key", () => {
  const recent = new RecentKeys(2);
  assert.equal(recent.add("a"), true);
  assert.equal(recent.add("a"), false);
  recent.add("b");
  recent.add("c");
  assert.equal(recent.add("a"), true, "the oldest key falls out of the window");
  assert.equal(recent.dropped, 1);
  assert.equal(eventKey("chat", { msgId: "123" }), "tiktok:chat:123");
  assert.equal(eventKey("chat", { msgId: "0", user: { userId: "9" }, createTime: 5 }), "tiktok:chat:9:5");
  assert.match(eventKey("chat", {}, 77), /^tiktok:chat:77:\d+$/);
});

test("the gift catalogue learns gifts, lists them by price and finds them by id or name", () => {
  const catalogue = new GiftCatalogue();
  assert.equal(catalogue.learn({ giftId: 7934, giftName: "Heart Me", diamondCount: 1, giftType: 4 }), true);
  assert.equal(catalogue.learn({ giftId: 7934, giftName: "Heart Me", diamondCount: 1, giftType: 4 }), false);
  catalogue.learnList([{ id: 5655, name: "Rose", diamond_count: 1, type: 1 }, { id: 6064, name: "GG", diamond_count: 1, type: 1 }, { id: 5879, name: "Doughnut", diamond_count: 30, type: 1 }]);
  assert.deepEqual(catalogue.resourceItems().map((item) => item.value), ["6064", "7934", "5655", "5879"]);
  assert.equal(catalogue.resourceItems()[0].label, "GG (1 coins)");
  assert.equal(catalogue.findByName("rose").giftId, 5655);
  const copy = new GiftCatalogue();
  copy.restore(JSON.parse(JSON.stringify(catalogue.toJSON())));
  assert.equal(copy.size, 4);
  assert.equal(copy.dirty, false);
});
