// Turns what a transport receives into one event model the runtime understands.
//
// Two shapes arrive here:
// - `fromProto(type, data)`: messages decoded by tiktok-live-connector 2.x, named after
//   their protobuf type (WebcastGiftMessage, ...) with camelCase fields and int64 values
//   as strings.
// - `fromTikfinity(event, data)`: the JSON the TikFinity desktop app relays, which uses
//   the flat field names of tiktok-live-connector 1.x (uniqueId, giftId, diamondCount, ...).
//
// Every field used for matching in a flow is an id, an enum value, a number or a boolean.
// Display text (nicknames, gift names, comments) is passed through and never compared.
import { bool, first, number, read, text, toMillis } from "./util.mjs";

const FOLLOW_STATUS = ["none", "follower", "friend"];

function followStatus(code, identity) {
  if (identity?.isMutualFollowingWithAnchor) return "friend";
  if (identity?.isFollowerOfAnchor) return "follower";
  return FOLLOW_STATUS[number(code, 0)] ?? "none";
}

const emptyUser = (fields) => ({
  userId: "",
  uniqueId: "",
  nickname: "",
  profilePictureUrl: "",
  isModerator: false,
  isSubscriber: false,
  followStatus: "none",
  gifterLevel: 0,
  teamMemberLevel: 0,
  ...fields,
});

/** The person behind a protobuf message. `identity` is the message's userIdentity, when it has one. */
export function userFromProto(user, identity) {
  if (!user || (!user.id && !user.displayId && !user.nickname)) return null;
  return {
    userId: text(first(user, ["idStr", "id"])),
    uniqueId: text(first(user, ["displayId", "specialId"])),
    nickname: text(user.nickname),
    profilePictureUrl: text(read(user, "avatarThumb.urlList.0")),
    isModerator: Boolean(identity?.isModeratorOfAnchor || read(user, "userAttr.isAdmin") || read(user, "userAttr.isSuperAdmin")),
    isSubscriber: Boolean(identity?.isSubscriberOfAnchor || user.isSubscribe),
    followStatus: followStatus(first(user, ["followInfo.followStatus", "followStatus"]), identity),
    gifterLevel: number(read(user, "payGrade.level"), 0),
    teamMemberLevel: number(read(user, "fansClub.data.level"), 0),
  };
}

/** The person behind a TikFinity (1.x shaped) event, whose user fields sit at the top level. */
export function userFromFlat(data) {
  if (!data || (!data.userId && !data.uniqueId)) return null;
  return {
    userId: text(data.userId),
    uniqueId: text(data.uniqueId),
    nickname: text(data.nickname),
    profilePictureUrl: text(data.profilePictureUrl),
    isModerator: bool(data.isModerator),
    isSubscriber: bool(data.isSubscriber),
    followStatus: FOLLOW_STATUS[number(data.followRole, 0)] ?? "none",
    gifterLevel: number(data.gifterLevel, 0),
    teamMemberLevel: number(data.teamMemberLevel, 0),
  };
}

const imageUrl = (image) => text(read(image, "urlList.0"));

function battleAnchorsFromProto(data) {
  return (data.anchorsInfo ?? [])
    .map((entry) => entry?.value?.user)
    .filter(Boolean)
    .map((user) => ({
      userId: text(user.userId),
      uniqueId: text(user.displayId),
      nickname: text(user.nickName),
      roomId: text(user.roomId),
    }));
}

function battlePointsFromProto(armies) {
  const points = {};
  if (Array.isArray(armies)) {
    for (const entry of armies) if (entry?.key) points[entry.key] = number(entry.value?.hostscore, 0);
  } else if (armies && typeof armies === "object") {
    for (const [key, value] of Object.entries(armies)) points[key] = number(value?.hostscore, 0);
  }
  return points;
}

// BattleResult.result is WIN = 0, LOSE = 1, DRAW = 2.
const BATTLE_RESULT = ["win", "lose", "draw"];

function battleResultsFromProto(results) {
  const out = {};
  for (const [userId, value] of Object.entries(results ?? {})) {
    out[userId] = { result: BATTLE_RESULT[number(value?.result, -1)] ?? "", score: number(value?.score, 0) };
  }
  return out;
}

function pollFromProto(data) {
  const content = data.endContent ?? data.updateVotesContent ?? data.startContent;
  const phase = data.endContent ? "end" : data.updateVotesContent ? "update" : data.startContent ? "start" : "";
  if (!phase) return null;
  return {
    pollId: text(first(data, ["pollId", "pollBasicInfo.pollIdStr"])),
    phase,
    title: text(first(data, ["startContent.title", "pollBasicInfo.title"])),
    options: (content.optionList ?? []).map((option) => ({
      index: number(option.optionIdx, 0),
      label: text(option.displayContent),
      votes: number(option.votes, 0),
    })),
  };
}

function goalFromProto(data) {
  const goal = data.goal;
  if (!goal) return null;
  const sub = (goal.subGoals ?? [])[0] ?? data.contributeSubgoal;
  return {
    goalId: text(first(goal, ["idStr", "id"])),
    description: text(goal.description),
    current: number(sub?.progress, 0),
    target: number(sub?.target, 0),
  };
}

/** Follow and share notices arrive as one message type; TikTok's text key tells them apart in any language. */
export function socialKind(key) {
  const value = text(key).toLowerCase();
  if (value.includes("follow")) return "follow";
  if (value.includes("share")) return "share";
  return "";
}

const superFanLevel = (data) => number(first(data, ["fansLevelParam.level", "user.fansClub.data.level"]), 0);

/** Returns a list of events (usually one, sometimes none) for one decoded protobuf message. */
export function fromProto(type, data) {
  if (!data || typeof data !== "object") return [];
  const common = {
    msgId: text(first(data, ["common.msgId", "msgId"])),
    createTime: toMillis(read(data, "common.createTime")),
    roomId: text(read(data, "common.roomId")),
  };
  const event = (fields) => [{ ...common, ...fields }];
  switch (type) {
    case "WebcastChatMessage":
      return event({ type: "chat", user: userFromProto(data.user, data.userIdentity), message: text(data.content) });
    case "WebcastMemberMessage": {
      const user = userFromProto(data.user, null);
      // MemberMessageAction: JOINED = 1, SUBSCRIBED = 3.
      if (number(data.action) === 3) return event({ type: "subscribe", user, months: 0, isRenewal: false });
      if (number(data.action) !== 1) return [];
      return event({ type: "member", user, viewerCount: number(data.memberCount, 0) });
    }
    case "WebcastSubNotifyMessage":
      // OldSubscribeStatus: FIRST = 0, RESUB = 1.
      return event({ type: "subscribe", user: userFromProto(data.user, null), months: number(data.subMonth, 0), isRenewal: number(data.oldSubscribeStatus, 0) === 1 });
    case "WebcastGiftMessage": {
      const gift = data.gift ?? {};
      return event({
        type: "gift",
        user: userFromProto(data.user, data.userIdentity),
        giftId: number(first(data, ["giftId", "gift.id"]), 0),
        giftName: text(gift.name),
        giftType: number(gift.type, 0),
        diamondCount: number(gift.diamondCount, 0),
        repeatCount: Math.max(1, number(data.repeatCount, 1)),
        repeatEnd: bool(data.repeatEnd),
        groupId: text(data.groupId),
        giftImageUrl: imageUrl(gift.image) || imageUrl(gift.icon),
        receiverUserId: text(first(data, ["toUser.idStr", "toUser.id", "toMemberId"])),
      });
    }
    case "WebcastLikeMessage":
      return event({ type: "like", user: userFromProto(data.user, null), likeCount: number(data.count, 0), totalLikes: number(data.total, 0) });
    case "WebcastSocialMessage": {
      const kind = socialKind(read(data, "common.displayText.key"));
      return kind ? event({ type: kind, user: userFromProto(data.user, null) }) : [];
    }
    case "WebcastRoomUserSeqMessage":
      return event({
        type: "viewers",
        viewerCount: number(data.total, 0),
        totalViewers: number(data.totalUser, 0),
        topViewers: (data.ranks ?? []).map((rank) => ({ user: userFromProto(rank.user, null), coins: number(rank.score, 0), rank: number(rank.rank, 0) })),
      });
    case "WebcastLinkMicBattle":
      return event({
        type: "battle",
        battleId: text(first(data, ["battleId", "battleSettings.battleId"])),
        // LinkMicBattleBattleAction: OPEN = 4, FINISH = 5, CUT_SHORT = 6.
        action: number(data.action, 0),
        // BattleSettingsBattleStatus: STARTED = 1, FINISHED = 2.
        status: number(read(data, "battleSettings.status"), 0),
        startedAtMs: toMillis(read(data, "battleSettings.startTimeMs")),
        durationSeconds: number(read(data, "battleSettings.duration"), 0),
        anchors: battleAnchorsFromProto(data),
        points: battlePointsFromProto(data.armies),
        results: battleResultsFromProto(data.battleResult),
      });
    case "WebcastLinkMicArmies":
      return event({
        type: "armies",
        battleId: text(first(data, ["battleId", "battleSettings.battleId"])),
        status: number(read(data, "battleSettings.status"), 0),
        points: battlePointsFromProto(data.armies),
      });
    case "WebcastEnvelopeMessage": {
      const info = data.envelopeInfo ?? {};
      const sender = info.sendUserId ? emptyUser({ userId: text(info.sendUserId), nickname: text(info.sendUserName), profilePictureUrl: imageUrl(info.sendUserAvatar) }) : null;
      // EnvelopeBusinessType.SUPER_FAN_BOX = 19.
      const superFanBox = number(info.businessType, 0) === 19 || text(read(data, "common.displayText.key")).toLowerCase().includes("ttlive_superfanbox");
      if (superFanBox) return event({ type: "super-fan", phase: "box", user: sender, level: 0 });
      return event({ type: "envelope", user: sender, envelopeId: text(info.envelopeId), coins: number(info.diamondCount, 0), peopleCount: number(info.peopleCount, 0) });
    }
    case "WebcastQuestionNewMessage":
      return event({ type: "question", user: userFromProto(read(data, "data.user"), null), questionId: text(read(data, "data.questionId")), question: text(read(data, "data.content")) });
    case "WebcastEmoteChatMessage": {
      const emote = (data.emoteList ?? [])[0];
      return emote ? event({ type: "emote", user: userFromProto(data.user, data.userIdentity), emoteId: text(emote.emoteId), emoteImageUrl: imageUrl(emote.image) }) : [];
    }
    case "WebcastPollMessage": {
      const poll = pollFromProto(data);
      return poll ? event({ type: "poll", ...poll }) : [];
    }
    case "WebcastGoalUpdateMessage": {
      const goal = goalFromProto(data);
      return goal ? event({ type: "goal", ...goal }) : [];
    }
    case "WebcastRankUpdateMessage":
      return (data.updates ?? [])
        .map((update, index) => ({ ...common, msgId: common.msgId ? `${common.msgId}:${index}` : "", type: "rank", rankType: number(update.rankType, 0), rank: number(update.ownRank, 0) }))
        .filter((update) => update.rank > 0);
    case "WebcastRoomPinMessage":
      return event({ type: "pin", user: userFromProto(read(data, "chatMessage.user"), null), message: text(read(data, "chatMessage.content")), pinAction: number(data.action, 0) });
    case "WebcastBarrageMessage": {
      const keys = [read(data, "content.key"), read(data, "commonBarrageContent.key")].map((key) => text(key).toLowerCase());
      if (keys.some((key) => key.includes("ttlive_superfan_commentnotif_superfanjoined"))) return event({ type: "super-fan", phase: "join", user: userFromProto(data.user, null), level: superFanLevel(data) });
      if (keys.some((key) => key.includes("ttlive_superfan"))) return event({ type: "super-fan", phase: "upgrade", user: userFromProto(data.user, null), level: superFanLevel(data) });
      return [];
    }
    case "WebcastImDeleteMessage":
      return event({ type: "moderation", action: "delete", messageIds: (data.deleteMsgIds ?? []).map(String), userIds: (data.deleteUserIds ?? []).map(String) });
    case "WebcastControlMessage": {
      // ControlAction: PAUSED = 1, UNPAUSED = 2, ENDED = 3, SUSPENDED = 4.
      const phase = { 1: "paused", 2: "resumed", 3: "ended", 4: "suspended" }[number(data.action, 0)];
      return phase ? event({ type: "stream", phase }) : [];
    }
    case "WebcastLiveIntroMessage":
      return event({ type: "intro", host: userFromProto(data.user, null) });
    default:
      return [];
  }
}

// TikFinity relays tiktok-live-connector 1.x events. The field names follow that library's
// README; TikFinity publishes no schema of its own, so shapes it changes are read as empty.
export function fromTikfinity(name, data) {
  if (!data || typeof data !== "object") return [];
  const common = {
    msgId: text(data.msgId),
    createTime: toMillis(first(data, ["createTime", "timestamp"])),
    roomId: text(data.roomId),
  };
  const user = userFromFlat(data);
  const event = (fields) => [{ ...common, ...fields }];
  switch (name) {
    case "chat":
      return event({ type: "chat", user, message: text(data.comment) });
    case "member":
      return event({ type: "member", user, viewerCount: 0 });
    case "subscribe":
      return event({ type: "subscribe", user, months: number(data.subMonth, 0), isRenewal: number(data.subMonth, 0) > 1 });
    case "gift":
      return event({
        type: "gift",
        user,
        giftId: number(data.giftId, 0),
        giftName: text(first(data, ["giftName", "extendedGiftInfo.name"])),
        giftType: number(first(data, ["giftType", "extendedGiftInfo.type"]), 0),
        diamondCount: number(first(data, ["diamondCount", "extendedGiftInfo.diamond_count"]), 0),
        repeatCount: Math.max(1, number(data.repeatCount, 1)),
        repeatEnd: bool(data.repeatEnd),
        groupId: text(data.groupId),
        giftImageUrl: text(data.giftPictureUrl),
        receiverUserId: text(data.receiverUserId),
      });
    case "like":
      return event({ type: "like", user, likeCount: number(data.likeCount, 0), totalLikes: number(data.totalLikeCount, 0) });
    case "follow":
    case "share":
      return event({ type: name, user });
    case "social": {
      const kind = socialKind(data.displayType);
      return kind ? event({ type: kind, user }) : [];
    }
    case "roomUser":
      return event({
        type: "viewers",
        viewerCount: number(data.viewerCount, 0),
        totalViewers: 0,
        topViewers: (data.topViewers ?? []).map((entry, index) => ({ user: userFromFlat(entry.user ?? entry), coins: number(entry.coinCount, 0), rank: index + 1 })),
      });
    case "linkMicBattle":
      // 1.x sends this when a battle starts, with the creators taking part.
      return event({
        type: "battle",
        battleId: text(data.battleId),
        action: 4,
        status: 1,
        startedAtMs: 0,
        durationSeconds: 0,
        anchors: (data.battleUsers ?? []).map((item) => ({ userId: text(item.userId), uniqueId: text(item.uniqueId), nickname: text(item.nickname), roomId: "" })),
        points: {},
        results: {},
      });
    case "linkMicArmies": {
      const points = {};
      for (const army of data.battleArmies ?? []) if (army?.hostUserId) points[text(army.hostUserId)] = number(army.points, 0);
      // 1.x battleStatus: 1 while the battle runs, 2 once it has ended.
      return event({ type: "armies", battleId: text(data.battleId), status: number(data.battleStatus, 0), points });
    }
    case "envelope":
      return event({ type: "envelope", user, envelopeId: text(data.envelopeId), coins: number(data.coins, 0), peopleCount: 0 });
    case "questionNew":
      return event({ type: "question", user, questionId: text(data.questionId), question: text(data.questionText) });
    case "emote":
      return event({ type: "emote", user, emoteId: text(data.emoteId), emoteImageUrl: text(data.emoteImageUrl) });
    case "streamEnd":
      return event({ type: "stream", phase: number(data.action, 3) === 4 ? "suspended" : "ended" });
    case "liveIntro":
      return event({ type: "intro", host: userFromFlat(data) });
    default:
      return [];
  }
}
