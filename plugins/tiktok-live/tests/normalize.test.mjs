import assert from "node:assert/strict";
import test from "node:test";
import { fromProto, fromTikfinity, socialKind, userFromProto } from "../plugin/normalize.mjs";
import { fixture, proto } from "./helpers/fakes.mjs";

const captured = fixture("captured-proto.json").messages;
const one = (type, key) => captured.find((item) => item.type === type && (!key || item.data.common?.displayText?.key === key));

test("captured TikTok messages become the events flows match on", () => {
  const [chat] = fromProto("WebcastChatMessage", one("WebcastChatMessage").data);
  assert.equal(chat.type, "chat");
  assert.equal(chat.message, "hello from the room");
  assert.equal(chat.user.uniqueId, "viewer_1");
  assert.equal(chat.createTime, 1793890417141);

  const [member] = fromProto("WebcastMemberMessage", one("WebcastMemberMessage").data);
  assert.equal(member.type, "member");
  assert.equal(member.viewerCount, 461);

  const [like] = fromProto("WebcastLikeMessage", one("WebcastLikeMessage").data);
  assert.deepEqual([like.type, like.likeCount, like.totalLikes, like.user.followStatus], ["like", 1, 40144, "follower"]);

  assert.equal(fromProto("WebcastSocialMessage", one("WebcastSocialMessage", "pm_mt_guidance_share").data)[0].type, "share");
  assert.equal(fromProto("WebcastSocialMessage", one("WebcastSocialMessage", "pm_main_follow_message_viewer_2").data)[0].type, "follow");
  assert.deepEqual(fromProto("WebcastSocialMessage", one("WebcastSocialMessage", "ttlive_repost_commentsArea_repostedUsername_im").data), []);

  const [gift] = fromProto("WebcastGiftMessage", one("WebcastGiftMessage").data);
  assert.deepEqual(
    { giftId: gift.giftId, giftType: gift.giftType, diamondCount: gift.diamondCount, repeatCount: gift.repeatCount, repeatEnd: gift.repeatEnd },
    { giftId: 7934, giftType: 4, diamondCount: 1, repeatCount: 1, repeatEnd: false },
  );

  const [viewers] = fromProto("WebcastRoomUserSeqMessage", one("WebcastRoomUserSeqMessage").data);
  assert.deepEqual([viewers.viewerCount, viewers.totalViewers, viewers.topViewers.length], [460, 62481, 2]);

  const [intro] = fromProto("WebcastLiveIntroMessage", one("WebcastLiveIntroMessage").data);
  assert.equal(intro.type, "intro");
  assert.ok(intro.host.userId);

  // A join animation barrage is not a super fan notice.
  assert.deepEqual(fromProto("WebcastBarrageMessage", one("WebcastBarrageMessage").data), []);
});

test("creation times in seconds and milliseconds both become milliseconds", () => {
  const [seconds] = fromProto("WebcastChatMessage", { common: { msgId: "1", createTime: "1793877825" }, user: proto.user(1), content: "x" });
  const [millis] = fromProto("WebcastChatMessage", { common: { msgId: "2", createTime: "1793877825000" }, user: proto.user(1), content: "x" });
  assert.equal(seconds.createTime, millis.createTime);
});

test("subscriptions, battles, chests, polls, goals and stream control are read from their protobuf fields", () => {
  assert.deepEqual(fromProto("WebcastSubNotifyMessage", { common: {}, user: proto.user(2), subMonth: "3", oldSubscribeStatus: 1 })[0], { msgId: "", createTime: 0, roomId: "", type: "subscribe", user: userFromProto(proto.user(2), null), months: 3, isRenewal: true });
  assert.equal(fromProto("WebcastMemberMessage", { common: {}, user: proto.user(2), action: 3 })[0].type, "subscribe");

  const [battle] = fromProto("WebcastLinkMicBattle", {
    common: { msgId: "9" },
    battleId: "b1",
    action: 4,
    battleSettings: { status: 1, startTimeMs: "1793890000000", duration: 300 },
    anchorsInfo: [
      { key: "100", value: { user: { userId: "100", displayId: "host", nickName: "Host", roomId: "R1" } } },
      { key: "200", value: { user: { userId: "200", displayId: "rival", nickName: "Rival", roomId: "R2" } } },
    ],
    battleResult: { 100: { result: 0, score: "55" } },
  });
  assert.equal(battle.anchors.length, 2);
  assert.equal(battle.results["100"].result, "win");
  assert.equal(battle.durationSeconds, 300);

  const [armies] = fromProto("WebcastLinkMicArmies", { common: {}, battleId: "b1", battleSettings: { status: 1 }, armies: { 100: { hostscore: "12" }, 200: { hostscore: "30" } } });
  assert.deepEqual(armies.points, { 100: 12, 200: 30 });
  const [wrapped] = fromProto("WebcastLinkMicArmies", { common: {}, armies: [{ key: "100", value: { hostscore: "4" } }] });
  assert.deepEqual(wrapped.points, { 100: 4 });

  const [chest] = fromProto("WebcastEnvelopeMessage", { common: {}, envelopeInfo: { envelopeId: "e1", diamondCount: 99, peopleCount: 20, sendUserId: "5", sendUserName: "Ana", businessType: 1 } });
  assert.deepEqual([chest.type, chest.coins, chest.user.nickname], ["envelope", 99, "Ana"]);
  assert.equal(fromProto("WebcastEnvelopeMessage", { common: {}, envelopeInfo: { businessType: 19 } })[0].type, "super-fan");

  const [poll] = fromProto("WebcastPollMessage", { common: {}, pollId: "p1", updateVotesContent: { optionList: [{ optionIdx: 0, displayContent: "Yes", votes: "4" }, { optionIdx: 1, displayContent: "No", votes: "9" }] } });
  assert.equal(poll.phase, "update");
  assert.equal(poll.options[1].votes, 9);

  const [goal] = fromProto("WebcastGoalUpdateMessage", { common: {}, goal: { idStr: "g1", description: "Roses", subGoals: [{ progress: "40", target: "100" }] } });
  assert.deepEqual([goal.current, goal.target], [40, 100]);

  assert.deepEqual(["1", "2", "3", "4"].map((action) => fromProto("WebcastControlMessage", { common: {}, action: Number(action) })[0].phase), ["paused", "resumed", "ended", "suspended"]);
  assert.deepEqual(fromProto("WebcastControlMessage", { common: {}, action: 0 }), []);
  assert.deepEqual(fromProto("WebcastSomethingNew", { common: {} }), []);
});

test("TikFinity events in the 1.x field names normalise to the same model", () => {
  const user = { userId: "42", uniqueId: "ana", nickname: "Ana", followRole: 2, isModerator: true, gifterLevel: 7 };
  const [gift] = fromTikfinity("gift", { ...user, msgId: "m1", createTime: "1793890000000", giftId: 5655, giftName: "Rose", giftType: 1, diamondCount: 1, repeatCount: 3, repeatEnd: true });
  assert.deepEqual([gift.giftId, gift.repeatCount, gift.repeatEnd, gift.user.followStatus, gift.user.isModerator, gift.user.gifterLevel], [5655, 3, true, "friend", true, 7]);
  assert.equal(fromTikfinity("chat", { ...user, comment: "hi" })[0].message, "hi");
  assert.equal(fromTikfinity("like", { ...user, likeCount: 5, totalLikeCount: 900 })[0].totalLikes, 900);
  assert.equal(fromTikfinity("social", { ...user, displayType: "pm_main_follow_message_viewer_2" })[0].type, "follow");
  assert.equal(fromTikfinity("roomUser", { viewerCount: 33, topViewers: [{ user, coinCount: 10 }] })[0].topViewers[0].user.uniqueId, "ana");
  assert.deepEqual(fromTikfinity("linkMicArmies", { battleStatus: 1, battleArmies: [{ hostUserId: "1", points: 5 }, { hostUserId: "2", points: 8 }] })[0].points, { 1: 5, 2: 8 });
  assert.equal(fromTikfinity("linkMicBattle", { battleUsers: [{ userId: "1", uniqueId: "a" }, { userId: "2", uniqueId: "b" }] })[0].anchors.length, 2);
  assert.equal(fromTikfinity("streamEnd", { action: 4 })[0].phase, "suspended");
  assert.deepEqual(fromTikfinity("unknownEvent", {}), []);
});

test("follow and share are told apart by TikTok's text key, never by the displayed words", () => {
  assert.equal(socialKind("pm_main_follow_message_viewer_2"), "follow");
  assert.equal(socialKind("pm_mt_guidance_share"), "share");
  assert.equal(socialKind("anything else"), "");
});
