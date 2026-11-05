// Boots the runtime against a fake transport, and plays a stream that fires every trigger.
import { startRuntime } from "../../plugin/runtime.mjs";
import { context, fakeChatSender, fakeClock, fakeSource, fixture, proto } from "./fakes.mjs";

export const flagsFetch = (chat = { enabled: true, message: "" }) => async () => ({ ok: true, json: async () => ({ version: 1, chat }) });

export async function boot(config = {}, { vault, source = fakeSource(), clock = fakeClock(), fetchImpl = flagsFetch(), chatSender = fakeChatSender(), ...overrides } = {}) {
  const fixtureCtx = context(config, vault);
  const runtime = await startRuntime(fixtureCtx.ctx, { createSource: () => source, timers: clock.timers, now: clock.now, fetchImpl, chatSender, ...overrides });
  await new Promise((resolve) => setImmediate(resolve));
  return { ...fixtureCtx, runtime, source, clock, chatSender };
}

const anchors = [
  { key: "100", value: { user: { userId: "100", displayId: "some_streamer", nickName: "Host", roomId: "7700000000000000001" } } },
  { key: "200", value: { user: { userId: "200", displayId: "rival", nickName: "Rival", roomId: "7700000000000000002" } } },
];

/** Feeds a little of everything, so every trigger kind fires at least once. */
export function playEverything({ source, clock }) {
  source.state("connected");
  source.room({ roomId: "7700000000000000001", hostUserId: "100", hostUniqueId: "some_streamer", title: "Test stream", startedAt: clock.now() - 60_000, isLive: true });
  for (const message of fixture("captured-proto.json").messages) source.proto(message.type, message.data);
  const c = (method) => proto.common(method);
  source.proto("WebcastChatMessage", { common: c("WebcastChatMessage"), user: proto.user(3), content: "!dance fast please" });
  source.proto("WebcastSubNotifyMessage", { common: c("WebcastSubNotifyMessage"), user: proto.user(4), subMonth: "2", oldSubscribeStatus: 1 });
  source.proto("WebcastLikeMessage", { common: c("WebcastLikeMessage"), user: proto.user(5), count: 15, total: "41010" });
  source.proto("WebcastRoomUserSeqMessage", { common: c("WebcastRoomUserSeqMessage"), total: "510", totalUser: "62600", ranks: [] });
  source.proto("WebcastGiftMessage", proto.gift(6, { repeatCount: 1 }));
  source.proto("WebcastGiftMessage", proto.gift(6, { repeatCount: 120, repeatEnd: true }));
  source.proto("WebcastGiftMessage", proto.gift(7, { giftId: 6427, name: "Hat and Mustache", type: 4, diamonds: 99, groupId: "0" }));
  source.proto("WebcastGiftMessage", proto.gift(8, { giftId: 7934, name: "Heart Me", type: 4, diamonds: 500, groupId: "0" }));
  source.proto("WebcastLinkMicBattle", { common: c("WebcastLinkMicBattle"), battleId: "b1", action: 4, battleSettings: { status: 1, duration: 300 }, anchorsInfo: anchors });
  source.proto("WebcastLinkMicArmies", { common: c("WebcastLinkMicArmies"), battleId: "b1", battleSettings: { status: 1 }, armies: { 100: { hostscore: "10" }, 200: { hostscore: "4" } } });
  clock.advance(3000);
  source.proto("WebcastLinkMicBattle", { common: c("WebcastLinkMicBattle"), battleId: "b1", action: 5, battleSettings: { status: 2 }, battleResult: { 100: { result: 0, score: "10" }, 200: { result: 1, score: "4" } } });
  source.proto("WebcastEnvelopeMessage", { common: c("WebcastEnvelopeMessage"), envelopeInfo: { envelopeId: "e1", diamondCount: 200, peopleCount: 10, sendUserId: "9", sendUserName: "Viewer 9" } });
  source.proto("WebcastQuestionNewMessage", { common: c("WebcastQuestionNewMessage"), data: { questionId: "q1", content: "Where are you?", user: proto.user(10) } });
  source.proto("WebcastEmoteChatMessage", { common: c("WebcastEmoteChatMessage"), user: proto.user(11), emoteList: [{ emoteId: "em1", image: { urlList: ["https://example.invalid/e.webp"] } }] });
  source.proto("WebcastPollMessage", { common: c("WebcastPollMessage"), pollId: "p1", startContent: { title: "Next game?", optionList: [{ optionIdx: 0, displayContent: "A", votes: "0" }, { optionIdx: 1, displayContent: "B", votes: "0" }] } });
  source.proto("WebcastGoalUpdateMessage", { common: c("WebcastGoalUpdateMessage"), goal: { idStr: "g1", description: "100 roses", subGoals: [{ progress: "100", target: "100" }] } });
  source.proto("WebcastRankUpdateMessage", { common: c("WebcastRankUpdateMessage"), updates: [{ rankType: 0, ownRank: "12" }] });
  source.proto("WebcastRoomPinMessage", { common: c("WebcastRoomPinMessage"), action: 1, chatMessage: { content: "Welcome!", user: proto.user(12) } });
  source.proto("WebcastBarrageMessage", { common: c("WebcastBarrageMessage"), user: proto.user(13), content: { key: "ttlive_superfan_commentnotif_superfanjoined" } });
  source.proto("WebcastImDeleteMessage", { common: c("WebcastImDeleteMessage"), deleteMsgIds: ["111", "222"], deleteUserIds: ["3"] });
  source.proto("WebcastLinkMicMethod", { common: c("WebcastLinkMicMethod"), something: 1 });
  source.proto("WebcastControlMessage", { common: c("WebcastControlMessage"), action: 3 });
}
