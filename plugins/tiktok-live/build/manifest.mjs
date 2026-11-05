// Generates plugin/manifest.json. Every block sits in one palette group, TikTok LIVE:
// the Studio names a group after its subcategory, so the blocks declare none.
//
// The 27 triggers share the same viewer and event fields,
// so they are written once here instead of by hand in JSON. Run
// `node plugins/tiktok-live/build/manifest.mjs` after editing; tests/manifest.test.mjs
// fails when the committed manifest and this file disagree.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const manifestPath = join(here, "..", "plugin", "manifest.json");
const connectorVersion = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).dependencies["tiktok-live-connector"];

const ID = "tiktok-live";
const CATEGORY = "TikTok LIVE";
const REPO = "https://github.com/OSC-Flow-Studio/official-community-plugins";

// ------------------------------------------------------------------ output fields

const out = (path, type, description) => ({ path, type, description });
const meta = (key, type, description) => out(`metadata.${key}`, type, description);

const EVENT_OUTPUTS = [
  meta("eventKey", "string", "Unique key of this event, for flows that must not count it twice."),
  meta("occurredAt", "string", "When it happened, ISO 8601 in UTC."),
  meta("transport", "string", "direct or tikfinity."),
  meta("roomId", "string", "TikTok room id of the LIVE."),
];

const VIEWER_OUTPUTS = [
  meta("userId", "string", "The viewer's numeric TikTok id. Stable even when they rename."),
  meta("uniqueId", "string", "The viewer's @handle, without the @."),
  meta("nickname", "string", "The viewer's display name."),
  meta("profilePictureUrl", "string", "Link to the viewer's profile picture."),
  meta("isModerator", "boolean", "True for a moderator of this LIVE."),
  meta("isSubscriber", "boolean", "True for a subscriber of the streamer."),
  meta("followStatus", "string", "none, follower or friend."),
  meta("gifterLevel", "number", "The viewer's TikTok gifter level, 0 when hidden."),
  meta("teamMemberLevel", "number", "The viewer's level in the streamer's team (fan club), 0 when none."),
  meta("topGifterRank", "number", "The viewer's place among this session's gifters, 0 when they have sent nothing."),
  out("actorDisplayName", "string", "The viewer's display name, or @handle when they have none."),
];

// ------------------------------------------------------------------ node fields

const yesNo = (key, label, helpText, yes = "Yes", no = "No") => ({
  key,
  label,
  kind: "select",
  helpText,
  options: [
    { value: "", label: "Either" },
    { value: "true", label: yes },
    { value: "false", label: no },
  ],
});
const choice = (key, label, helpText, options) => ({ key, label, kind: "select", helpText, options: [{ value: "", label: "Any" }, ...options.map(([value, text]) => ({ value, label: text }))] });
const minimum = (key, label, helpText, extra = {}) => ({ key, label, kind: "number", min: 0, helpText, ...extra });
const words = (key, label, helpText, placeholder) => ({ key, label, kind: "plain-text", helpText, ...(placeholder ? { placeholder } : {}) });
const followField = choice("followStatus", "Relationship", "Who the viewer is to the streamer.", [["none", "Not following"], ["follower", "Follower"], ["friend", "Friend (follows each other)"]]);

const match = (nodeField, eventField, mode = "equals", extra = {}) => ({ nodeField, eventField, mode, ...extra });
const followMatch = match("followStatus", "followStatus");

/** A trigger block. `viewer` adds the viewer outputs; `outputs` lists the kind's own fields. */
function trigger(kind, { label, icon, description, viewer = true, fields = [], matchFields = [], defaultData, outputs = [], actor }) {
  const outputSchema = [...(viewer ? VIEWER_OUTPUTS : actor ? [actor] : []), ...outputs, ...EVENT_OUTPUTS];
  return {
    type: `trigger.x.${ID}.${kind}`,
    label: `TikTok: ${label}`,
    category: CATEGORY,
    description,
    role: "trigger",
    appearance: { icon },
    ...(matchFields.length > 0 ? { matchFields } : {}),
    ...(fields.length > 0 ? { fields } : {}),
    ...(defaultData ? { defaultData } : fields.length > 0 ? { defaultData: Object.fromEntries(fields.map((field) => [field.key, field.kind === "number" ? (field.optional ? undefined : 0) : ""]).filter(([, value]) => value !== undefined)) } : {}),
    outputSchema,
  };
}

/** An action or input block. */
function block(name, { label, icon, description, role = "action", fields, defaultData, outputs }) {
  return {
    type: `action.x.${ID}.${name}`,
    label: `TikTok: ${label}`,
    category: CATEGORY,
    description,
    role,
    appearance: { icon },
    ...(fields ? { fields } : {}),
    ...(defaultData ? { defaultData } : {}),
    outputSchema: outputs.map(([path, type, description]) => out(path, type, description)),
  };
}

const ok = ["ok", "boolean", "False when the action could not do its job; error says why."];
const error = ["error", "string", "Why it failed, or empty."];

// ------------------------------------------------------------------ triggers

const triggers = [
  trigger("gift", {
    label: "gift received",
    icon: "gift",
    description: "A viewer sent a gift. Streakable gifts (the Rose and others you can tap repeatedly) count once, when the streak ends, with every tap in it. Pick a gift, or set a coin range, to react to specific gifts.",
    fields: [
      { key: "giftId", label: "Gift", kind: "resource-select", resourceKey: "gifts", optional: true, helpText: "Gifts appear here as the plugin sees them. Empty accepts every gift." },
      { key: "giftIdManual", label: "Gift id", kind: "number", min: 0, optional: true, helpText: "For a gift not in the list yet. Find ids with TikTok: gift lookup, or in metadata.giftId of an earlier gift." },
      minimum("minCoins", "Coins at least", "Coins of the whole gift (coins per gift times the count). 0 accepts any amount."),
      minimum("maxCoins", "Coins at most", "Empty accepts any amount. Use with Coins at least to make bands.", { optional: true }),
      minimum("minDiamondsPerGift", "Coins per gift at least", "Filters by the gift's own price, whatever the count. 0 accepts any gift."),
      yesNo("streakable", "Streakable gift", "Gifts that can be tapped repeatedly, like the Rose."),
      yesNo("toHostOnly", "Sent to the streamer", "In multi-guest LIVEs gifts can go to a guest. Yes keeps only gifts to the streamer.", "Yes", "To a guest"),
      yesNo("firstGiftOnly", "First gift of this viewer", "Yes fires only on a viewer's first gift of the session."),
    ],
    matchFields: [match("giftId", "giftId"), match("giftIdManual", "giftId"), match("minCoins", "coins", "gte"), match("maxCoins", "coins", "lte"), match("minDiamondsPerGift", "diamondsPerGift", "gte"), match("streakable", "streakable"), match("toHostOnly", "isToHost"), match("firstGiftOnly", "isFirstGiftThisSession")],
    defaultData: { giftId: "", minCoins: 0, minDiamondsPerGift: 0, streakable: "", toHostOnly: "", firstGiftOnly: "" },
    outputs: [
      meta("giftId", "number", "TikTok's id of the gift. The same in every language; match on this, not on the name."),
      meta("giftName", "string", "The gift's English name, for messages only."),
      meta("giftType", "number", "TikTok's gift type; 1 is streakable."),
      meta("streakable", "boolean", "True for gifts that can be tapped repeatedly."),
      meta("diamondsPerGift", "number", "Coins one of these gifts costs."),
      meta("repeatCount", "number", "How many were sent: the streak length, or 1."),
      meta("coins", "number", "Coins of the whole gift: coins per gift times the count."),
      meta("giftImageUrl", "string", "Link to the gift's picture."),
      meta("receiverUserId", "string", "Who received it in a multi-guest LIVE; empty for the streamer."),
      meta("isToHost", "boolean", "True when the streamer received the gift."),
      meta("isFirstGiftThisSession", "boolean", "True on the viewer's first gift of the session."),
      meta("senderSessionCoins", "number", "Coins this viewer has sent this session, this gift included."),
      meta("senderRank", "number", "This viewer's place among the session's gifters after this gift."),
      meta("sessionCoins", "number", "Coins received this session, this gift included."),
    ],
  }),
  trigger("gift-streak", {
    label: "gift streak",
    icon: "flame",
    description: "Every tap of a streakable gift while the viewer keeps sending, then once more when the streak ends. For counters and combos; use gift received to count coins.",
    fields: [
      choice("phase", "Phase", "progress fires on each tap, end once when the streak is over.", [["progress", "Each tap"], ["end", "Streak ended"]]),
      { key: "giftId", label: "Gift", kind: "resource-select", resourceKey: "gifts", optional: true, helpText: "Empty accepts every streakable gift." },
      minimum("minRepeat", "Count at least", "The streak's count so far. 0 accepts any."),
    ],
    matchFields: [match("phase", "phase"), match("giftId", "giftId"), match("minRepeat", "repeatCount", "gte")],
    defaultData: { phase: "", giftId: "", minRepeat: 0 },
    outputs: [
      meta("phase", "string", "progress or end."),
      meta("giftId", "number", "TikTok's id of the gift."),
      meta("giftName", "string", "The gift's English name, for messages only."),
      meta("repeatCount", "number", "The streak's count so far."),
      meta("diamondsPerGift", "number", "Coins one of these gifts costs."),
      meta("coinsSoFar", "number", "Coins in the streak so far."),
    ],
  }),
  trigger("coin-milestone", {
    label: "coin milestone",
    icon: "coins",
    description: "Coins passed a round number: the session's total (every 500 coins by default) or one viewer's total (every 100). Steps are set under Advanced. A big gift that passes several milestones fires once for each.",
    fields: [
      choice("scope", "Whose coins", "The session's total, or one viewer's.", [["session", "Session total"], ["gifter", "One viewer"]]),
      minimum("minMilestone", "Milestone at least", "0 accepts every milestone."),
    ],
    matchFields: [match("scope", "scope"), match("minMilestone", "milestone", "gte")],
    defaultData: { scope: "", minMilestone: 0 },
    outputs: [
      meta("scope", "string", "session or gifter."),
      meta("milestone", "number", "The round number passed."),
      meta("total", "number", "The total now."),
      meta("step", "number", "The milestone step in use."),
    ],
  }),
  trigger("top-gifter-change", {
    label: "top gifter changed",
    icon: "trophy",
    description: "Someone new holds first, second or third place among this session's gifters. The viewer fields describe the new holder.",
    fields: [minimum("maxRank", "Place at most", "1 fires only for first place. 0 or 3 fires for the top three.", { max: 3 })],
    matchFields: [match("maxRank", "rank", "lte")],
    defaultData: { maxRank: 1 },
    outputs: [
      meta("rank", "number", "The place that changed hands: 1, 2 or 3."),
      meta("previousUserId", "string", "Who held it before, or empty."),
      meta("previousNickname", "string", "Display name of who held it before, or empty."),
      meta("coins", "number", "The new holder's coins this session."),
    ],
  }),
  trigger("envelope", {
    label: "treasure chest",
    icon: "box",
    description: "A viewer dropped a treasure chest (an envelope of coins for the audience).",
    fields: [minimum("minCoins", "Coins at least", "0 accepts any chest.")],
    matchFields: [match("minCoins", "coins", "gte")],
    outputs: [meta("envelopeId", "string", "TikTok's id of the chest."), meta("coins", "number", "Coins in the chest."), meta("peopleCount", "number", "How many viewers can open it.")],
  }),
  trigger("member", {
    label: "viewer joined",
    icon: "users",
    description: "A viewer entered the LIVE. TikTok sends joins in samples on busy LIVEs, so not every entry arrives.",
    fields: [followField, yesNo("firstJoinOnly", "First time this session", "No fires on rejoins only."), yesNo("returningOnly", "Seen in an earlier LIVE", "Viewers the plugin remembers from your earlier LIVEs (the last 2000).")],
    matchFields: [followMatch, match("firstJoinOnly", "isFirstJoin"), match("returningOnly", "isReturning")],
    outputs: [
      meta("isFirstJoin", "boolean", "True the first time this viewer joins this session."),
      meta("isReturning", "boolean", "True when the plugin saw this viewer in one of your earlier LIVEs."),
      meta("userJoins", "number", "How often this viewer has joined this session."),
      meta("joinsThisSession", "number", "Joins seen this session."),
      meta("viewerCount", "number", "Viewers in the LIVE right now."),
    ],
  }),
  trigger("follow", {
    label: "new follower",
    icon: "heart",
    description: "A viewer followed the streamer during the LIVE.",
    fields: [yesNo("firstTimeOnly", "First follow this session", "Yes ignores the same viewer following again after unfollowing.")],
    matchFields: [match("firstTimeOnly", "isFirstFollowThisSession")],
    outputs: [meta("isFirstFollowThisSession", "boolean", "False when the viewer already followed earlier in this session."), meta("followsThisSession", "number", "Follows this session.")],
  }),
  trigger("share", {
    label: "LIVE shared",
    icon: "send",
    description: "A viewer shared the LIVE.",
    fields: [followField],
    matchFields: [followMatch],
    outputs: [meta("sharesThisSession", "number", "Shares this session.")],
  }),
  trigger("subscribe", {
    label: "new subscriber",
    icon: "star",
    description: "A viewer subscribed to the streamer, or renewed.",
    fields: [minimum("minMonths", "Months at least", "0 accepts any. TikTok does not always send the month count."), yesNo("renewalsOnly", "Renewal", "Yes for renewals only, No for first subscriptions only.")],
    matchFields: [match("minMonths", "months", "gte"), match("renewalsOnly", "isRenewal")],
    outputs: [meta("months", "number", "Months subscribed, 0 when TikTok did not say."), meta("isRenewal", "boolean", "True for a renewal."), meta("subscribesThisSession", "number", "Subscriptions this session.")],
  }),
  trigger("like", {
    label: "likes",
    icon: "heart-pulse",
    description: "A viewer tapped likes. TikTok groups taps, so one event can carry several likes, and busy LIVEs send only some of them.",
    fields: [minimum("minLikes", "Likes at least", "Likes in this event. 0 accepts any."), minimum("totalAtLeast", "LIVE total at least", "The LIVE's total likes. 0 accepts any.")],
    matchFields: [match("minLikes", "likeCount", "gte"), match("totalAtLeast", "totalLikes", "gte")],
    outputs: [
      meta("likeCount", "number", "Likes in this event."),
      meta("totalLikes", "number", "The LIVE's total likes, as TikTok counts them."),
      meta("userLikes", "number", "Likes from this viewer this session."),
      meta("likesThisSession", "number", "Likes seen this session."),
    ],
  }),
  trigger("like-milestone", {
    label: "like milestone",
    icon: "flame",
    description: "The LIVE's total likes passed a round number (every 1000 by default, set under Advanced). The viewer fields describe whose likes passed it.",
    fields: [minimum("minMilestone", "Milestone at least", "0 accepts every milestone.")],
    matchFields: [match("minMilestone", "milestone", "gte")],
    outputs: [meta("milestone", "number", "The round number passed."), meta("totalLikes", "number", "The LIVE's total likes now."), meta("step", "number", "The milestone step in use.")],
  }),
  trigger("viewer-count", {
    label: "viewer count changed",
    icon: "eye",
    viewer: false,
    description: "The number of viewers in the LIVE changed. TikTok updates it every few seconds.",
    fields: [
      minimum("minViewers", "Viewers at least", "0 accepts any."),
      minimum("maxViewers", "Viewers at most", "Empty accepts any.", { optional: true }),
      choice("direction", "Direction", "Only rises, or only drops.", [["up", "Going up"], ["down", "Going down"]]),
      yesNo("milestoneOnly", "Passed a milestone", "Yes fires only when the count rises past a step (every 50 viewers by default)."),
    ],
    matchFields: [match("minViewers", "viewerCount", "gte"), match("maxViewers", "viewerCount", "lte"), match("direction", "direction"), match("milestoneOnly", "crossedMilestone")],
    defaultData: { minViewers: 0, direction: "", milestoneOnly: "" },
    outputs: [
      meta("viewerCount", "number", "Viewers now."),
      meta("previous", "number", "Viewers at the last update."),
      meta("delta", "number", "Change since the last update."),
      meta("direction", "string", "up or down."),
      meta("peak", "number", "Most viewers this session."),
      meta("crossedMilestone", "boolean", "True when the count rose past a milestone."),
      meta("milestone", "number", "The milestone passed, or 0."),
      meta("totalViewers", "number", "Everyone who has watched this LIVE so far, as TikTok counts them (0 through TikFinity)."),
    ],
  }),
  trigger("chat", {
    label: "chat message",
    icon: "message-square",
    description: "A viewer wrote in the chat.",
    fields: [
      words("contains", "Message contains", "Case does not matter. Empty accepts every message.", "hello"),
      words("pattern", "Message matches", "A regular expression, for advanced filters.", "^!\\w+"),
      followField,
      yesNo("moderatorsOnly", "Moderator", "Yes keeps only moderators' messages."),
    ],
    matchFields: [match("contains", "message", "contains"), match("pattern", "message", "regex"), followMatch, match("moderatorsOnly", "isModerator")],
    outputs: [
      meta("message", "string", "What the viewer wrote."),
      meta("isCommand", "boolean", "True when the message starts with the command prefix."),
      meta("userChats", "number", "Messages from this viewer this session."),
      meta("chatsThisSession", "number", "Messages this session."),
    ],
  }),
  trigger("command", {
    label: "chat command",
    icon: "message-square",
    description: "A chat message that starts with the command prefix (! by default), like !dance fast. The word after the prefix is the command, the rest are its arguments.",
    fields: [words("commandName", "Command", "Without the prefix. Case does not matter. Empty accepts every command.", "dance"), followField],
    matchFields: [match("commandName", "command"), followMatch],
    outputs: [
      meta("command", "string", "The command, lowercase, without the prefix."),
      meta("args", "string", "Everything after the command."),
      meta("message", "string", "The whole message."),
      meta("prefix", "string", "The prefix in use."),
    ],
  }),
  trigger("question", {
    label: "question asked",
    icon: "message-square",
    description: "A viewer used TikTok's Q&A to ask a question.",
    fields: [words("contains", "Question contains", "Empty accepts every question.")],
    matchFields: [match("contains", "question", "contains")],
    outputs: [meta("questionId", "string", "TikTok's id of the question."), meta("question", "string", "The question.")],
  }),
  trigger("emote", {
    label: "emote sent",
    icon: "sparkles",
    description: "A subscriber sent one of the streamer's subscriber emotes.",
    fields: [words("emoteId", "Emote id", "Empty accepts every emote. The id is in metadata.emoteId of an earlier event.")],
    matchFields: [match("emoteId", "emoteId")],
    outputs: [meta("emoteId", "string", "TikTok's id of the emote."), meta("emoteImageUrl", "string", "Link to the emote's picture.")],
  }),
  trigger("pin", {
    label: "message pinned",
    icon: "bell",
    description: "The streamer or a moderator pinned a chat message, or removed the pin. The viewer fields describe who wrote the message.",
    fields: [choice("pinAction", "Action", "Pinned or unpinned.", [["pin", "Pinned"], ["unpin", "Unpinned"]]), words("contains", "Message contains", "Empty accepts every message.")],
    matchFields: [match("pinAction", "pinAction"), match("contains", "message", "contains")],
    outputs: [meta("pinAction", "string", "pin or unpin."), meta("message", "string", "The pinned message.")],
  }),
  trigger("moderation", {
    label: "messages removed",
    icon: "eye",
    viewer: false,
    description: "Chat messages were removed by TikTok or a moderator. Useful to take them off an overlay too.",
    outputs: [meta("action", "string", "delete."), meta("messageIds", "string", "Ids of the removed messages, comma separated; they match metadata.eventKey after tiktok:chat:."), meta("userIds", "string", "Ids of the viewers whose messages were removed, comma separated."), meta("count", "number", "How many messages were removed.")],
  }),
  trigger("super-fan", {
    label: "super fan",
    icon: "star",
    description: "Super fan activity: a viewer became a super fan, moved up, or a super fan box dropped.",
    fields: [choice("phase", "What happened", "", [["join", "Became a super fan"], ["upgrade", "Moved up"], ["box", "Super fan box"]]), minimum("minLevel", "Level at least", "0 accepts any.")],
    matchFields: [match("phase", "phase"), match("minLevel", "level", "gte")],
    outputs: [meta("phase", "string", "join, upgrade or box."), meta("level", "number", "The viewer's fan level, 0 when unknown.")],
  }),
  trigger("battle", {
    label: "battle",
    icon: "trophy",
    viewer: false,
    actor: out("actorDisplayName", "string", "The opponent's display name."),
    description: "A LIVE battle (PK) started, its score changed, the lead changed hands, or it ended. Scores are seen from the streamer's side. Score updates come at most every 2 seconds.",
    fields: [
      choice("phase", "Phase", "", [["start", "Started"], ["update", "Score changed"], ["lead-change", "Lead changed hands"], ["end", "Ended"]]),
      choice("result", "Result", "Set only when the battle ends.", [["win", "Won"], ["lose", "Lost"], ["draw", "Draw"]]),
      choice("leader", "Who leads", "", [["host", "The streamer"], ["opponent", "The opponent"], ["tied", "Tied"]]),
    ],
    matchFields: [match("phase", "phase"), match("result", "result"), match("leader", "leader")],
    outputs: [
      meta("battleId", "string", "TikTok's id of the battle."),
      meta("phase", "string", "start, update, lead-change or end."),
      meta("hostPoints", "number", "The streamer's points."),
      meta("opponentPoints", "number", "The opponent's points (the strongest one in a multi-way battle)."),
      meta("leader", "string", "host, opponent or tied."),
      meta("result", "string", "win, lose or draw when the battle ends; empty before."),
      meta("durationSeconds", "number", "Seconds since the battle started."),
      meta("plannedSeconds", "number", "How long TikTok set the battle to last, 0 when unknown."),
      meta("opponentUserId", "string", "The opponent's TikTok id."),
      meta("opponentUniqueId", "string", "The opponent's @handle."),
      meta("opponentNickname", "string", "The opponent's display name."),
      meta("participantCount", "number", "Creators in the battle."),
      meta("participants", "object", "Every creator with userId, uniqueId, nickname and points."),
    ],
  }),
  trigger("poll", {
    label: "poll",
    icon: "layers",
    viewer: false,
    description: "The streamer started a poll, the votes changed, or it ended.",
    fields: [choice("phase", "Phase", "", [["start", "Started"], ["update", "Votes changed"], ["end", "Ended"]])],
    matchFields: [match("phase", "phase")],
    outputs: [
      meta("pollId", "string", "TikTok's id of the poll."),
      meta("phase", "string", "start, update or end."),
      meta("title", "string", "The question."),
      meta("options", "object", "Each option with index, label and votes."),
      meta("leadingOption", "string", "The option with most votes."),
      meta("leadingVotes", "number", "Its votes."),
      meta("totalVotes", "number", "Votes in total."),
    ],
  }),
  trigger("goal", {
    label: "LIVE goal",
    icon: "target",
    viewer: false,
    description: "Progress on the streamer's LIVE goal changed.",
    fields: [yesNo("reachedOnly", "Goal reached", "Yes fires once the goal is complete."), minimum("minPercent", "Progress at least (%)", "0 accepts any.", { max: 100 })],
    matchFields: [match("reachedOnly", "isReached"), match("minPercent", "percent", "gte")],
    outputs: [
      meta("goalId", "string", "TikTok's id of the goal."),
      meta("description", "string", "The goal's text."),
      meta("current", "number", "Progress so far."),
      meta("target", "number", "The target."),
      meta("percent", "number", "Progress in percent, 0 to 100."),
      meta("isReached", "boolean", "True once the target is met."),
    ],
  }),
  trigger("rank", {
    label: "ranking update",
    icon: "star",
    viewer: false,
    description: "The LIVE's place in a TikTok ranking (hourly, daily, weekly) changed.",
    fields: [minimum("maxRank", "Place at most", "0 accepts any place."), choice("rankType", "Ranking", "", [["hourly", "Hourly"], ["daily", "Daily"], ["weekly", "Weekly"], ["daily-rookie", "Daily rookie"], ["weekly-rookie", "Weekly rookie"], ["other", "Other"]])],
    matchFields: [match("maxRank", "rank", "lte"), match("rankType", "rankType")],
    defaultData: { maxRank: 0, rankType: "" },
    outputs: [meta("rank", "number", "The LIVE's place."), meta("rankType", "string", "hourly, daily, weekly, daily-rookie, weekly-rookie or other."), meta("rankTypeId", "number", "TikTok's numeric id of the ranking.")],
  }),
  trigger("stream", {
    label: "stream state",
    icon: "radio-tower",
    viewer: false,
    description: "The plugin reached a new LIVE, or the stream was paused, resumed, ended or suspended by TikTok.",
    fields: [choice("phase", "State", "", [["live", "Live"], ["paused", "Paused"], ["resumed", "Resumed"], ["ended", "Ended"], ["suspended", "Suspended by TikTok"]])],
    matchFields: [match("phase", "phase")],
    outputs: [
      meta("phase", "string", "live, paused, resumed, ended or suspended."),
      meta("title", "string", "The LIVE's title, when known."),
      meta("startedAt", "string", "When the LIVE started, ISO 8601 in UTC, when known."),
      meta("durationSeconds", "number", "Seconds since the LIVE started, 0 when unknown."),
      meta("viewerCount", "number", "Viewers at that moment."),
      meta("totalLikes", "number", "The LIVE's total likes at that moment."),
      meta("sessionCoins", "number", "Coins received this session."),
    ],
  }),
  trigger("connection", {
    label: "connection changed",
    icon: "signal",
    viewer: false,
    description: "The plugin's connection changed: connecting, connected, waiting for the streamer to go live, disconnected, error or stopped. Use it to warn yourself in VR when events stop.",
    fields: [choice("state", "State", "", [["connected", "Connected"], ["waiting", "Waiting for the LIVE"], ["connecting", "Connecting"], ["disconnected", "Disconnected"], ["error", "Error"], ["stopped", "Stopped by a flow"]])],
    matchFields: [match("state", "state")],
    outputs: [
      meta("state", "string", "connecting, connected, waiting, disconnected, error or stopped."),
      meta("reason", "string", "Why, in plain words."),
      meta("attempt", "number", "Reconnection attempts since the last success."),
      meta("rateLimited", "boolean", "True when Euler Stream's rate limit is the reason."),
      meta("uniqueId", "string", "The username the plugin is watching."),
    ],
  }),
  trigger("chat-sent", {
    label: "chat sent (BETA)",
    icon: "send",
    viewer: false,
    description: "The result of TikTok: send chat message (BETA), so a flow can react when sending fails.",
    fields: [yesNo("okOnly", "Sent", "Yes for messages that went out, No for failures.", "Sent", "Failed")],
    matchFields: [match("okOnly", "ok")],
    outputs: [meta("message", "string", "The message."), meta("ok", "boolean", "True when TikTok accepted it."), meta("error", "string", "Why it failed, or empty.")],
  }),
  trigger("raw", {
    label: "other TikTok event (advanced)",
    icon: "database",
    viewer: false,
    description: "Every TikTok message the plugin does not turn into a block of its own, as TikTok sent it. Off unless Advanced > Pass other events is on. Field names can change when TikTok changes them.",
    fields: [words("eventName", "Message type", "For example WebcastLinkMicMethod. Empty accepts every type.")],
    matchFields: [match("eventName", "eventName")],
    outputs: [meta("eventName", "string", "TikTok's message type."), meta("data", "object", "The message, as decoded. Empty when larger than 32 KB."), meta("truncated", "boolean", "True when the message was too large to pass on.")],
  }),
];

// ------------------------------------------------------------------ actions and inputs

const actions = [
  block("connect", {
    label: "connect",
    icon: "plug",
    description: "Connects to the LIVE now, or reconnects at once instead of waiting for the next retry.",
    outputs: [ok, ["state", "string", "The connection state after the call."], error],
  }),
  block("disconnect", {
    label: "disconnect",
    icon: "power",
    description: "Stops listening to the LIVE until TikTok: connect runs or the plugin restarts. Triggers stop firing.",
    outputs: [ok, ["state", "string", "The connection state after the call."], error],
  }),
  block("wait-until-live", {
    label: "wait until live",
    icon: "timer",
    description: "Waits up to 25 seconds for the streamer to go live, then connects. Direct connection only.",
    fields: [{ key: "timeoutSeconds", label: "Wait at most (seconds)", kind: "number", min: 1, max: 25, helpText: "Flow actions may run for 30 seconds at most." }],
    defaultData: { timeoutSeconds: 20 },
    outputs: [ok, ["live", "boolean", "True when the streamer is live."], ["waitedSeconds", "number", "How long it waited."], error],
  }),
  block("refresh-gifts", {
    label: "refresh gift list",
    icon: "gift",
    description: "Loads the room's whole gift list into the gift picker. TikTok's list needs a signed request that Euler Stream serves on Business plans only; without one, gifts are learned as they arrive.",
    outputs: [ok, ["count", "number", "Gifts the plugin knows now."], error],
  }),
  block("reset-session", {
    label: "reset session",
    icon: "circle-stop",
    description: "Starts the session counters over: coins and gifters, likes, or everything. The plugin also does this by itself when a new LIVE starts, unless Reset per stream is off.",
    fields: [{ key: "scope", label: "Reset", kind: "select", helpText: "", options: [{ value: "all", label: "Everything" }, { value: "coins", label: "Coins and gifters" }, { value: "likes", label: "Likes" }] }],
    defaultData: { scope: "all" },
    outputs: [ok, ["scope", "string", "What was reset."], error],
  }),
  block("send-chat", {
    label: "send chat message (BETA)",
    icon: "send",
    description: "BETA, may be switched off by the plugin maintainers without notice. Posts a message in the LIVE's chat as the TikTok account in the plugin settings. It is set up in the settings, not in a flow: Chat (BETA) on, an Euler Stream API key with Euler's Webcast Premium add-on (Euler Stream is a separate, paid service; the free trial does not include it), and the account's two session cookies. It does not need TikTok: connect, only a streamer who is live. TikTok may suspend accounts that post automatically; use a secondary account.",
    fields: [{ key: "message", label: "Message", kind: "text", placeholder: "Thanks for the {{ $trigger.metadata.giftName }}!", helpText: "Up to 150 characters." }],
    defaultData: { message: "" },
    outputs: [ok, error, ["disabledReason", "string", "Why it did not try, as a fixed code: chat-off, deprecated, missing-username, missing-api-key, missing-cookies or invalid-cookies. error says the same in words and names the setting. Empty when it tried."]],
  }),
  block("status", {
    label: "connection status",
    icon: "activity",
    role: "input",
    description: "How the plugin is doing: connected or not, why, and whether chat sending is available.",
    outputs: [
      ["connected", "boolean", "True while connected to the LIVE."],
      ["state", "string", "connecting, connected, waiting, disconnected, error or stopped."],
      ["transport", "string", "direct or tikfinity."],
      ["uniqueId", "string", "The username being watched."],
      ["roomId", "string", "The current room id, or empty."],
      ["isLive", "boolean", "True while connected to a LIVE."],
      ["lastError", "string", "The last error, or empty."],
      ["attempt", "number", "Reconnection attempts since the last success."],
      ["rateLimited", "boolean", "True while Euler Stream's rate limit holds the connection back."],
      ["giftCatalogueSize", "number", "Gifts in the gift picker."],
      ["sessionStartedAt", "string", "When the session started, ISO 8601 in UTC."],
      ["eventsEmitted", "number", "Triggers fired since the plugin started."],
      ["duplicatesDropped", "number", "Repeated TikTok messages ignored since the plugin started."],
      ["chatAvailable", "boolean", "True when TikTok: send chat message can send right now."],
      ["chatDisabledReason", "string", "Why TikTok: send chat message would not try, with the same codes as its disabledReason, or empty."],
    ],
  }),
  block("room-stats", {
    label: "LIVE stats",
    icon: "gauge",
    role: "input",
    description: "The session's numbers: viewers, likes, coins and activity counts.",
    outputs: [
      ["viewerCount", "number", "Viewers now."],
      ["peakViewers", "number", "Most viewers this session."],
      ["totalLikes", "number", "The LIVE's total likes, as TikTok counts them."],
      ["sessionCoins", "number", "Coins received this session."],
      ["sessionGifts", "number", "Gifts received this session (a streak of 10 counts 10)."],
      ["likesThisSession", "number", "Likes seen this session."],
      ["chats", "number", "Chat messages this session."],
      ["follows", "number", "Follows this session."],
      ["shares", "number", "Shares this session."],
      ["joins", "number", "Joins seen this session."],
      ["subscribes", "number", "Subscriptions this session."],
      ["title", "string", "The LIVE's title, when known."],
      ["startedAt", "string", "When the LIVE started, ISO 8601 in UTC, when known."],
      ["durationSeconds", "number", "Seconds since the LIVE started, 0 when unknown."],
    ],
  }),
  block("gift-lookup", {
    label: "gift lookup",
    icon: "gift",
    role: "input",
    description: "Finds a gift the plugin knows, by id or by English name, to get its id and price.",
    fields: [
      { key: "giftId", label: "Gift id", kind: "number", min: 0, optional: true, helpText: "Takes priority over the name." },
      { key: "giftName", label: "Gift name", kind: "text", placeholder: "Rose", helpText: "The English name; case does not matter." },
    ],
    defaultData: { giftName: "" },
    outputs: [
      ["found", "boolean", "True when the gift is known."],
      ["giftId", "number", "The gift's id."],
      ["giftName", "string", "The gift's English name."],
      ["diamondCount", "number", "Coins one gift costs."],
      ["giftType", "number", "TikTok's gift type; 1 is streakable."],
      ["streakable", "boolean", "True for gifts that can be tapped repeatedly."],
    ],
  }),
  block("battle-state", {
    label: "battle score",
    icon: "trophy",
    role: "input",
    description: "The current battle's score from the streamer's side, or the last battle's result.",
    outputs: [
      ["active", "boolean", "True during a battle."],
      ["battleId", "string", "The current or last battle's id."],
      ["hostPoints", "number", "The streamer's points."],
      ["opponentPoints", "number", "The opponent's points."],
      ["leader", "string", "host, opponent or tied."],
      ["opponentUniqueId", "string", "The opponent's @handle."],
      ["durationSeconds", "number", "Seconds the battle has run (or ran)."],
      ["lastResult", "string", "win, lose or draw of the last finished battle, or empty."],
    ],
  }),
  block("top-gifters", {
    label: "top gifters",
    icon: "trophy",
    role: "input",
    description: "The session's gifters ranked by coins.",
    fields: [{ key: "limit", label: "How many", kind: "number", min: 1, max: 20, helpText: "1 to 20." }],
    defaultData: { limit: 5 },
    outputs: [
      ["count", "number", "Gifters in the list."],
      ["topUserId", "string", "First place's TikTok id."],
      ["topUniqueId", "string", "First place's @handle."],
      ["topNickname", "string", "First place's display name."],
      ["topCoins", "number", "First place's coins."],
      ["list", "object", "Each gifter with rank, userId, uniqueId, nickname, coins and gifts."],
      ["text", "string", "The list as one line, like 1. Ana 500, 2. Leo 120."],
    ],
  }),
  block("user-stats", {
    label: "viewer stats",
    icon: "user",
    role: "input",
    description: "What one viewer has done this session.",
    fields: [{ key: "uniqueId", label: "Viewer", kind: "text", placeholder: "{{ $trigger.metadata.uniqueId }}", helpText: "@handle or numeric TikTok id." }],
    defaultData: { uniqueId: { mode: "expression", expression: "{{ $trigger.metadata.uniqueId }}" } },
    outputs: [
      ["found", "boolean", "True when the viewer did something this session."],
      ["userId", "string", "The viewer's TikTok id."],
      ["uniqueId", "string", "The viewer's @handle."],
      ["nickname", "string", "The viewer's display name."],
      ["coins", "number", "Coins sent this session."],
      ["gifts", "number", "Gifts sent this session."],
      ["likes", "number", "Likes this session."],
      ["chats", "number", "Chat messages this session."],
      ["joins", "number", "Times joined this session."],
      ["rank", "number", "Place among the session's gifters, 0 when they sent nothing."],
      ["isReturning", "boolean", "True when the plugin saw the viewer in an earlier LIVE."],
    ],
  }),
];

// ------------------------------------------------------------------ config

const field = (key, type, label, description, tab, extra = {}) => ({ key, type, label, description, tab, ...extra });
const separator = (key, label, description, tab) => ({ key, type: "separator", label, description, tab });

const configSchema = {
  tabs: [
    { id: "general", label: "General", description: "The LIVE to watch and how to reach it." },
    { id: "euler", label: "Euler Stream", description: "A separate service: signatures for the direct connection, and the only way to send chat." },
    { id: "direct", label: "Direct connection", description: "Retries and live checks for the direct connection." },
    { id: "tikfinity", label: "TikFinity", description: "Listening to the TikFinity desktop app instead." },
    { id: "chat", label: "Chat (BETA)", description: "Sending chat messages. Unstable and off by default." },
    { id: "advanced", label: "Advanced", description: "Gift streaks, milestones and other events." },
    { id: "about", label: "About", description: "Third-party software this plugin is built on." },
  ],
  fields: [
    field("enabled", "boolean", "Plugin enabled", "Watches the LIVE while OSC Flow Studio is open.", "general", { default: true }),
    field("uniqueId", "string", "TikTok username", "The @handle of the account that goes live, with or without the @. The plugin waits when it is offline and connects when the LIVE starts.", "general", { default: "", pattern: "^\\s*@?[A-Za-z0-9_.]{2,24}\\s*$|^$" }),
    field("transport", "select", "Connect through", "Direct connects to TikTok itself. TikFinity listens to the TikFinity app on this computer, which has to be open and connected to your LIVE.", "general", { default: "direct", options: [{ value: "direct", label: "Direct connection" }, { value: "tikfinity", label: "TikFinity app" }] }),
    field("resetOnStreamStart", "boolean", "Reset per stream", "Starts the session counters (coins, likes, gifters, milestones) over when a new LIVE starts.", "general", { default: true }),
    field("commandPrefix", "string", "Command prefix", "Chat messages that start with this are also chat commands.", "general", { default: "!", pattern: "^\\S{1,3}$" }),
    separator("eulerSection", "Euler Stream is a separate service", "Euler Stream (https://www.eulerstream.com) is not part of TikTok or of this plugin, and its account and plans are yours. TikTok only accepts signed connections, and the direct connection gets its signatures from Euler. Without a key it shares Euler's free anonymous limit, which can make connecting wait a few minutes, and a free key raises that limit. Sending chat always needs a key with the Webcast Premium add-on, which Euler sells separately and leaves out of its free trial.", "euler"),
    field("signApiKey", "secret", "Euler Stream API key", "Optional for reading the LIVE, required for sending chat. Create it in your Euler Stream dashboard. Kept in the Studio's encrypted vault and sent only to Euler Stream.", "euler"),
    field("reconnectMinSeconds", "number", "First retry after (seconds)", "When the connection drops, the plugin waits this long, then twice as long after each failure.", "direct", { default: 5, min: 2, max: 60 }),
    field("reconnectMaxSeconds", "number", "Longest wait between retries (seconds)", "Waits after a rate limit are never shorter than 60 seconds.", "direct", { default: 300, min: 30, max: 900 }),
    field("offlinePollSeconds", "number", "Check if live every (seconds)", "While the streamer is offline. These checks do not use Euler Stream's quota.", "direct", { default: 60, min: 30, max: 600 }),
    separator("tikfinitySection", "TikFinity bridge", "Open TikFinity on this computer, connect it to your LIVE, and pick TikFinity app under General. Gifts, chat, likes, follows, shares, joins, subscriptions and battles arrive through it; the gift list, live checks and sending chat do not.", "tikfinity"),
    field("bridgeUrl", "string", "TikFinity address", "TikFinity's local WebSocket. Change it only if TikFinity tells you a different one.", "tikfinity", { default: "ws://localhost:21213/", pattern: "^wss?://[^\\s/]+(/[^\\s]*)?$" }),
    separator("chatSection", "Sending chat is BETA", "It may stop working, or be switched off by the plugin maintainers at any time. TikTok may suspend accounts that post automatically: use a secondary account. TikTok: send chat message needs three things, all set here: this switch on, an Euler Stream API key with the Webcast Premium add-on (Euler Stream tab), and the two cookies below. It works with either connection, and the plugin does not have to be connected.", "chat"),
    field("chatEnabled", "boolean", "Chat (BETA) enabled", "Allows TikTok: send chat message. While off, the block sends nothing and returns disabledReason chat-off.", "chat", { default: false }),
    separator("chatCookiesHelp", "Where to find the two cookies", "In your browser, sign in to tiktok.com with the account that will post. Press F12, open Application (Chrome, Edge) or Storage (Firefox), then Cookies, https://www.tiktok.com, and copy the values of sessionid and tt-target-idc. Pasting name=value or a whole cookie line also works. Signing out of TikTok in that browser ends the session, and then the cookies stop working.", "chat"),
    field("chatSessionId", "secret", "TikTok sessionid cookie", "Signs in as the account, so treat it like a password. Kept in the Studio's encrypted vault and sent only to Euler Stream, which posts each message.", "chat"),
    field("chatTargetIdc", "secret", "TikTok tt-target-idc cookie", "The account's TikTok data centre, such as useast2a. Kept in the vault with the sessionid.", "chat"),
    field("giftStreakMode", "select", "Count streakable gifts", "When a viewer taps a Rose 10 times, gift received fires once with 10, or ten times with 1.", "advanced", { default: "completed", options: [{ value: "completed", label: "Once, when the streak ends" }, { value: "each", label: "On every tap" }] }),
    field("coinMilestoneStep", "number", "Session coin milestone every", "Coins. 0 turns session coin milestones off.", "advanced", { default: 500, min: 0, max: 1000000 }),
    field("gifterMilestoneStep", "number", "Viewer coin milestone every", "Coins from one viewer. 0 turns them off.", "advanced", { default: 100, min: 0, max: 1000000 }),
    field("likeMilestoneStep", "number", "Like milestone every", "Likes on the LIVE's total. 0 turns them off.", "advanced", { default: 1000, min: 0, max: 10000000 }),
    field("viewerMilestoneStep", "number", "Viewer milestone every", "Viewers. 0 turns them off.", "advanced", { default: 50, min: 0, max: 100000 }),
    field("processInitialData", "boolean", "Replay recent messages on connect", "TikTok sends a few recent messages when the plugin connects. Off ignores them, so a reconnect does not fire old events again.", "advanced", { default: false }),
    field("emitRawEvents", "boolean", "Pass other events", "Fires TikTok: other TikTok event for every message type the plugin does not handle itself. For experiments; it can fire often.", "advanced", { default: false }),
    separator("aboutUnofficial", "Unofficial integration", "TikTok has no public API for LIVE events. This plugin reads the same events every LIVE alert tool reads, and is not affiliated with TikTok, Euler Stream or TikFinity.", "about"),
    separator("aboutConnector", `tiktok-live-connector ${connectorVersion}`, "The TikTok client the direct connection uses, by zerodytrash. AGPL-3.0 with additional permissions. https://github.com/zerodytrash/TikTok-Live-Connector", "about"),
    separator("aboutProto", "tiktok-live-proto", "TikTok's message definitions, by isaackogan. AGPL-3.0 with additional permissions. https://github.com/isaackogan/TikTok-Webcast-Protobuf", "about"),
    separator("aboutEuler", "Euler Stream", "A separate service: it signs the direct connection, and it posts chat for TikTok: send chat message. https://www.eulerstream.com", "about"),
    separator("aboutTikfinity", "TikFinity", "The desktop app behind the TikFinity bridge, not bundled. https://tikfinity.zerody.one", "about"),
    separator("aboutNotice", "Licenses", "Every bundled package and its license is listed in vendor/NOTICE.md inside the plugin, with full texts in vendor/THIRD_PARTY_LICENSES.txt. Source: https://github.com/OSC-Flow-Studio/official-community-plugins/tree/main/plugins/tiktok-live", "about"),
  ],
};

// ------------------------------------------------------------------ templates

const layout = (ids) => Object.fromEntries(ids.map((id, index) => [id, { x: index * 380, y: 0 }]));
const flow = (id, name, nodes, edges) => ({
  schemaVersion: 1,
  id: `tpl-${id}`,
  name,
  enabled: false,
  nodes,
  edges: edges.map(([source, target], index) => ({ id: `e-${index + 1}`, source, target })),
  layout: layout(nodes.map((node) => node.id)),
});
const log = (id, expression) => ({ type: "action.console.log", id, level: "info", message: { mode: "expression", expression } });

const templates = [
  {
    id: "tiktok-live-log-gifts",
    name: "TikTok LIVE: log every gift",
    description: "Writes each gift to the console. Turn it on to check the connection before wiring gifts to anything else.",
    flow: flow("tiktok-live-log-gifts", "TikTok LIVE: gifts in the console", [
      { type: `trigger.x.${ID}.gift`, id: "gift", giftId: "", minCoins: 0, minDiamondsPerGift: 0, streakable: "", toHostOnly: "", firstGiftOnly: "" },
      log("log-gift", "{{ $trigger.actorDisplayName }} sent {{ $trigger.metadata.repeatCount }}x {{ $trigger.metadata.giftName }} ({{ $trigger.metadata.coins }} coins)"),
    ], [["gift", "log-gift"]]),
  },
  {
    id: "tiktok-live-big-gifts",
    name: "TikTok LIVE: gifts of 100 coins or more",
    description: "A starting point for a reaction to big gifts: swap the console block for an avatar, OSC or device block.",
    flow: flow("tiktok-live-big-gifts", "TikTok LIVE: big gifts", [
      { type: `trigger.x.${ID}.gift`, id: "big-gift", giftId: "", minCoins: 100, minDiamondsPerGift: 0, streakable: "", toHostOnly: "", firstGiftOnly: "" },
      log("log-big-gift", "Big gift: {{ $trigger.metadata.coins }} coins from {{ $trigger.actorDisplayName }}, now {{ $trigger.metadata.senderRank }} in the ranking"),
    ], [["big-gift", "log-big-gift"]]),
  },
  {
    id: "tiktok-live-battles",
    name: "TikTok LIVE: battle start and result",
    description: "Logs when a battle starts and how it ends.",
    flow: flow("tiktok-live-battles", "TikTok LIVE: battles", [
      { type: `trigger.x.${ID}.battle`, id: "battle", phase: "", result: "", leader: "" },
      log("log-battle", "Battle {{ $trigger.metadata.phase }} against @{{ $trigger.metadata.opponentUniqueId }}: {{ $trigger.metadata.hostPoints }} to {{ $trigger.metadata.opponentPoints }} {{ $trigger.metadata.result }}"),
    ], [["battle", "log-battle"]]),
  },
];

// ------------------------------------------------------------------ manifest

export function buildManifest(version) {
  return {
    $schema: "../../../sdk/community-plugin-manifest.schema.json",
    id: ID,
    name: "TikTok LIVE",
    version,
    packageId: "io.github.osc-flow-studio.tiktok-live",
    engines: { oscFlowStudio: ">=1.0.0 <2.0.0" },
    author: { name: "OSC Flow Studio", url: "https://github.com/OSC-Flow-Studio" },
    license: "AGPL-3.0-only",
    repository: REPO,
    homepage: `${REPO}/tree/main/plugins/tiktok-live#readme`,
    changelogUrl: `${REPO}/blob/main/plugins/tiktok-live/CHANGELOG.md`,
    description: `Turns your TikTok LIVE into flow triggers: gifts by coins or by gift, battles, joins, follows, likes, chat and milestones, plus inputs about the stream. Unofficial; built on tiktok-live-connector ${connectorVersion}, with a TikFinity bridge as an alternative.`,
    capabilities: ["triggers", "actions", "templates", "secrets"],
    appearance: { icon: "gift", accent: "pink" },
    entry: "index.mjs",
    apiVersion: 2,
    permissions: { secrets: true, resources: true, haptics: false, processes: false, network: "any" },
    configSchema,
    nodeTypes: [...triggers, ...actions],
    templates,
  };
}

export function currentVersion() {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")).version;
  } catch {
    return "0.1.0";
  }
}

export const render = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(manifestPath, render(buildManifest(currentVersion())));
  console.log(`plugin/manifest.json written: ${triggers.length} triggers, ${actions.length} actions and inputs`);
}
