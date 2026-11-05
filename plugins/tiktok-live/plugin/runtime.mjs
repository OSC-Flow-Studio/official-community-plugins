// The TikTok LIVE runtime: receives events from a transport, keeps the session, and turns
// what happened into Studio triggers. Actions and inputs read and steer the same state.
import { BattleTracker } from "./battle.mjs";
import { FeatureFlags } from "./chat/flags.mjs";
import { ChatSignIn, clearChatSession, readChatSession } from "./chat/signin.mjs";
import { normalizeConfig } from "./config.mjs";
import { RecentKeys, eventKey } from "./dedup.mjs";
import { GiftCatalogue } from "./gifts.mjs";
import { fromProto, fromTikfinity } from "./normalize.mjs";
import { Session, crossedMilestones } from "./session.mjs";
import { DirectSource, explain } from "./sources/direct.mjs";
import { TikfinitySource } from "./sources/tikfinity.mjs";
import { GiftStreaks } from "./streaks.mjs";
import { clamp, describe, isoTime, number, text } from "./util.mjs";

const SESSION_KEY = "session-state-v1";
const GIFTS_KEY = "gift-catalogue-v1";
const VIEWERS_KEY = "known-viewers-v1";
const SAVE_EVERY_MS = 5000;
const SAVE_VIEWERS_EVERY_MS = 60_000;
const SUBSCRIBE_REPEAT_MS = 60_000;
const RAW_LIMIT = 32 * 1024;
const CHAT_LIMIT = 150;

// The protobuf types the plugin maps itself. Anything else can reach flows as a raw event.
const MAPPED_TYPES = new Set([
  "WebcastChatMessage", "WebcastMemberMessage", "WebcastSubNotifyMessage", "WebcastGiftMessage", "WebcastLikeMessage",
  "WebcastSocialMessage", "WebcastRoomUserSeqMessage", "WebcastLinkMicBattle", "WebcastLinkMicArmies", "WebcastEnvelopeMessage",
  "WebcastQuestionNewMessage", "WebcastEmoteChatMessage", "WebcastPollMessage", "WebcastGoalUpdateMessage", "WebcastRankUpdateMessage",
  "WebcastRoomPinMessage", "WebcastBarrageMessage", "WebcastImDeleteMessage", "WebcastControlMessage", "WebcastLiveIntroMessage",
]);

// ProfitRankType values with a name people use; the rest are reported as "other".
const RANK_TYPES = { 0: "hourly", 1: "weekly", 5: "weekly-rookie", 8: "daily", 14: "daily-rookie" };

const systemTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle),
};

const EMPTY_USER = { userId: "", uniqueId: "", nickname: "", profilePictureUrl: "", isModerator: false, isSubscriber: false, followStatus: "none", gifterLevel: 0, teamMemberLevel: 0 };

function safeJson(value) {
  try {
    const json = JSON.stringify(value, (key, item) => (typeof item === "bigint" ? item.toString() : item instanceof Uint8Array ? `<${item.length} bytes>` : item));
    if (json.length > RAW_LIMIT) return { data: {}, truncated: true };
    return { data: JSON.parse(json), truncated: false };
  } catch {
    return { data: {}, truncated: true };
  }
}

export class TikTokLiveRuntime {
  constructor(ctx, config, overrides = {}) {
    this.ctx = ctx;
    this.config = config;
    this.timers = overrides.timers ?? systemTimers;
    this.now = overrides.now ?? Date.now;
    this.overrides = overrides;
    this.session = new Session({ now: this.now });
    this.catalogue = new GiftCatalogue();
    this.recent = new RecentKeys();
    this.lastSubscribe = new Map();
    this.lastGoal = new Map();
    this.state = { state: "stopped", reason: "", attempt: 0, rateLimited: false };
    this.lastConnection = "";
    this.hostUserId = "";
    this.liveRoomId = "";
    this.roomId = "";
    this.userStopped = false;
    this.stopped = false;
    this.intervals = [];
    this.lastError = "";
    this.emitted = 0;
    this.streaks = new GiftStreaks({
      mode: config.giftStreakMode,
      now: this.now,
      timers: this.timers,
      onExpire: (result) => this.giftResult(result, "direct"),
    });
    this.battle = new BattleTracker({
      now: this.now,
      timers: this.timers,
      hostUserId: () => this.hostUserId,
      roomId: () => this.roomId,
      onEmit: (phase, snapshot) => this.emitBattle(snapshot),
    });
    this.flags = new FeatureFlags({ secrets: ctx.secrets, fetchImpl: overrides.fetchImpl ?? globalThis.fetch, timers: this.timers, log: ctx.log, signal: ctx.signal, url: overrides.flagsUrl });
    this.flags.onChange = (flags) => {
      if (!flags.chat.enabled) this.ctx.log.warn(`Sending chat was switched off by the plugin maintainers${flags.chat.message ? `: ${flags.chat.message}` : "."}`);
      this.publishStatus();
    };
    this.signIn = new ChatSignIn({ secrets: ctx.secrets, timers: this.timers, now: this.now, log: ctx.log, onSaved: () => this.publishStatus() });
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    await this.restore();
    this.publishGifts();
    await this.flags.start();
    this.intervals.push(this.timers.setInterval(() => void this.save(false), SAVE_EVERY_MS));
    this.intervals.push(this.timers.setInterval(() => void this.saveViewers(), SAVE_VIEWERS_EVERY_MS));
    if (!this.config.uniqueId) {
      this.setState({ state: "error", reason: this.config.rawUniqueId ? `"${this.config.rawUniqueId}" is not a TikTok username.` : "Add the TikTok username of the LIVE under General.", attempt: 0, rateLimited: false });
      return;
    }
    await this.startSource();
  }

  async restore() {
    try {
      const saved = await this.ctx.secrets.get(SESSION_KEY);
      if (saved) this.session.restore(JSON.parse(saved));
      this.roomId = this.session.roomId;
    } catch (error) {
      this.ctx.log.warn(`The saved session could not be read and starts fresh: ${describe(error)}`);
    }
    try {
      const gifts = await this.ctx.secrets.get(GIFTS_KEY);
      if (gifts) this.catalogue.restore(JSON.parse(gifts));
    } catch {
      // The catalogue refills as gifts arrive.
    }
    try {
      const viewers = await this.ctx.secrets.get(VIEWERS_KEY);
      if (viewers) this.session.restoreKnownViewers(JSON.parse(viewers));
    } catch {
      // Returning viewers are recognised again after the next join.
    }
  }

  createSource() {
    const deps = { timers: this.timers, log: this.ctx.log, now: this.now };
    if (this.overrides.createSource) return this.overrides.createSource(this.config, deps);
    if (this.config.transport === "tikfinity") {
      return new TikfinitySource({ url: this.config.bridgeUrl, ...deps, WebSocketImpl: this.overrides.WebSocketImpl ?? globalThis.WebSocket });
    }
    return new DirectSource({
      uniqueId: this.config.uniqueId,
      signApiKey: this.config.signApiKey,
      processInitialData: this.config.processInitialData,
      reconnectMinMs: this.config.reconnectMinMs,
      reconnectMaxMs: this.config.reconnectMaxMs,
      offlinePollMs: this.config.offlinePollMs,
      ...deps,
      load: this.overrides.loadVendor,
    });
  }

  async startSource() {
    if (this.source || this.stopped) return;
    const source = this.createSource();
    this.source = source;
    source.onEvent((raw) => this.receive(raw));
    source.onState((state) => this.setState(state));
    source.onRoom((room) => this.room(room));
    await source.start();
  }

  async stopSource(reason) {
    const source = this.source;
    this.source = null;
    await source?.stop();
    this.setState({ state: "stopped", reason, attempt: 0, rateLimited: false });
  }

  async shutdown() {
    if (this.stopped) return;
    this.stopped = true;
    for (const handle of this.intervals) this.timers.clearInterval(handle);
    this.intervals = [];
    this.flags.stop();
    this.battle.dispose();
    // Streaks still open when the Studio stops still count toward the session.
    for (const result of this.streaks.flush()) {
      const gift = result.counted;
      if (gift) this.session.recordGift(gift.user, gift.diamondCount * gift.repeatCount, gift.repeatCount);
    }
    await this.signIn.close();
    const source = this.source;
    this.source = null;
    try {
      await source?.stop();
    } catch (error) {
      this.ctx.log.warn(`Stopping the TikTok connection: ${describe(error)}`);
    }
    await this.save(true);
    await this.saveViewers(true);
  }

  async save(force) {
    try {
      if (force || this.session.dirty) {
        this.session.dirty = false;
        await this.ctx.secrets.set(SESSION_KEY, JSON.stringify(this.session.toJSON()));
      }
      if (force || this.catalogue.dirty) {
        this.catalogue.dirty = false;
        await this.ctx.secrets.set(GIFTS_KEY, JSON.stringify(this.catalogue.toJSON()));
      }
    } catch (error) {
      this.ctx.log.warn(`Could not save the session: ${describe(error)}`);
    }
    if (!this.stopped) this.publishStatus();
  }

  async saveViewers(force = false) {
    if (!force && !this.session.knownDirty) return;
    this.session.knownDirty = false;
    try {
      await this.ctx.secrets.set(VIEWERS_KEY, JSON.stringify([...this.session.knownViewers]));
    } catch (error) {
      this.ctx.log.warn(`Could not save returning viewers: ${describe(error)}`);
    }
  }

  // ---------------------------------------------------------------- state and status

  setState(next) {
    this.state = { state: next.state, reason: next.reason ?? "", attempt: next.attempt ?? 0, rateLimited: Boolean(next.rateLimited) };
    if (next.state === "error" && next.reason) this.lastError = next.reason;
    if (next.state === "connected") this.lastError = "";
    const signature = `${this.state.state}|${this.state.reason}`;
    if (signature !== this.lastConnection) {
      this.lastConnection = signature;
      this.emit("connection", {
        ...this.common({}, this.source?.transport ?? this.config.transport),
        state: this.state.state,
        reason: this.state.reason,
        attempt: this.state.attempt,
        rateLimited: this.state.rateLimited,
        uniqueId: this.config.uniqueId,
        actorId: "",
        actorDisplayName: "",
      });
    }
    this.publishStatus();
  }

  chatAvailability() {
    if (!this.config.chatEnabled) return { available: false, reason: "Chat (BETA) is off in the plugin settings." };
    if (!this.flags.chat.enabled) return { available: false, reason: `deprecated: Sending chat was switched off by the plugin maintainers${this.flags.chat.message ? `. ${this.flags.chat.message}` : "."}` };
    if (this.config.transport !== "direct") return { available: false, reason: "Sending chat needs the direct connection." };
    if (!this.config.signApiKey) return { available: false, reason: "Sending chat needs an Euler Stream API key on a plan that includes chat." };
    return { available: true, reason: "" };
  }

  publishStatus() {
    if (this.stopped) return;
    const user = this.config.uniqueId ? `@${this.config.uniqueId}` : "the LIVE";
    const errors = [];
    const chat = this.chatAvailability();
    if (this.config.chatEnabled && !chat.available) errors.push(chat.reason.replace(/^deprecated: /, "Send chat is deprecated: "));
    const signInLine = this.signIn.open ? `Chat sign-in: open ${this.signIn.url} in your browser` : "";
    const { state, reason } = this.state;
    let status;
    if (state === "connected") {
      const via = this.source?.transport === "tikfinity" ? " via TikFinity" : "";
      status = { health: "healthy", connectionState: `live: ${user}${via}, ${this.session.viewerCount} viewers` };
    } else if (state === "connecting") {
      status = { health: "unknown", connectionState: `connecting to ${user}` };
    } else if (state === "waiting") {
      status = { health: "degraded", connectionState: `waiting for ${user} to go live` };
    } else if (state === "stopped") {
      status = { health: "degraded", connectionState: "disconnected", errors: [reason || "Disconnected by a flow. Run TikTok LIVE: connect to reconnect."] };
    } else {
      status = { health: state === "error" ? "error" : "degraded", connectionState: state === "error" ? "not connected" : "reconnecting", errors: [reason || this.lastError || "Not connected."] };
    }
    if (errors.length > 0) status.errors = [...(status.errors ?? []), ...errors];
    // The Studio shows only the first line, and it cannot open a browser for a plugin.
    if (signInLine) status.errors = [signInLine, ...(status.errors ?? [])];
    this.ctx.setStatus(status);
  }

  publishGifts() {
    this.ctx.setResource("gifts", this.catalogue.resourceItems());
  }

  room(info) {
    if (info.hostUserId) this.hostUserId = info.hostUserId;
    if (info.roomId) this.noteRoom(info.roomId);
    if (info.title) this.session.title = info.title;
    if (info.startedAt > 0) this.session.streamStartedAt = info.startedAt;
    this.session.dirty = true;
  }

  noteRoom(roomId) {
    if (!roomId || roomId === "0" || roomId === this.roomId) return;
    const previous = this.session.roomId;
    this.roomId = roomId;
    if (previous && previous !== roomId && this.config.resetOnStreamStart) {
      for (const result of this.streaks.flush()) this.giftResult(result, this.source?.transport ?? this.config.transport);
      this.session.reset("all", roomId);
      this.lastGoal.clear();
    } else {
      this.session.roomId = roomId;
      this.session.dirty = true;
    }
    if (this.liveRoomId !== roomId) {
      this.liveRoomId = roomId;
      this.emitStream("live", {});
    }
  }

  // ---------------------------------------------------------------- events

  receive(raw) {
    if (this.stopped) return;
    if (raw.format === "proto" && !MAPPED_TYPES.has(raw.type)) {
      if (this.config.emitRawEvents) this.emitRaw(raw);
      return;
    }
    const events = raw.format === "proto" ? fromProto(raw.type, raw.data) : fromTikfinity(raw.type, raw.data);
    if (events.length === 0 && raw.format !== "proto" && this.config.emitRawEvents) this.emitRaw(raw);
    for (const event of events) {
      try {
        this.handle(event, raw.transport);
      } catch (error) {
        this.ctx.log.warn(`Could not handle a ${event.type} event: ${describe(error)}`);
      }
    }
  }

  emit(kind, payload) {
    this.emitted += 1;
    // Events the plugin makes up itself (connection changes, chat sent) get a key here.
    if (!payload.eventKey) payload.eventKey = `tiktok:${kind}:${this.now()}:${this.emitted}`;
    this.ctx.emitTrigger(kind, payload);
  }

  common(event, transport) {
    const at = event.createTime > 0 ? event.createTime : this.now();
    return { eventKey: event.eventKey ?? "", occurredAt: isoTime(at), transport, roomId: event.roomId && event.roomId !== "0" ? event.roomId : this.roomId };
  }

  actor(user) {
    const who = user ?? EMPTY_USER;
    return {
      userId: who.userId,
      uniqueId: who.uniqueId,
      nickname: who.nickname,
      profilePictureUrl: who.profilePictureUrl,
      isModerator: who.isModerator,
      isSubscriber: who.isSubscriber,
      followStatus: who.followStatus,
      gifterLevel: who.gifterLevel,
      teamMemberLevel: who.teamMemberLevel,
      topGifterRank: who.userId ? this.session.rankOf(who.userId) : 0,
      actorId: who.userId,
      actorDisplayName: who.nickname || who.uniqueId,
    };
  }

  handle(event, transport) {
    if (event.roomId && event.roomId !== "0") this.noteRoom(event.roomId);
    const keyKind = event.type === "gift" ? `gift:${event.repeatCount}` : event.type;
    event.eventKey = eventKey(keyKind, event, this.now());
    if (!this.recent.add(event.eventKey)) return;
    // Gift ticks share one key per streak step; flows get the gift's own key without the step.
    if (event.type === "gift") event.eventKey = eventKey("gift", event, this.now());
    const base = () => ({ ...this.common(event, transport), ...this.actor(event.user) });
    switch (event.type) {
      case "chat": return this.chat(event, base());
      case "member": {
        const { isFirstJoin, isReturning } = this.session.recordJoin(event.user);
        if (event.viewerCount > 0) this.session.setViewers(event.viewerCount);
        const joins = this.session.users.get(event.user?.userId ?? "")?.joins ?? 0;
        return this.emit("member", { ...base(), isFirstJoin, isReturning, joinsThisSession: this.session.totals.joins, userJoins: joins, viewerCount: this.session.viewerCount });
      }
      case "follow": {
        const { isFirstFollowThisSession } = this.session.recordFollow(event.user);
        return this.emit("follow", { ...base(), isFirstFollowThisSession, followsThisSession: this.session.totals.follows });
      }
      case "share":
        this.session.count(event.user, "shares", "shares");
        return this.emit("share", { ...base(), sharesThisSession: this.session.totals.shares });
      case "subscribe": {
        const id = event.user?.userId ?? "";
        const last = this.lastSubscribe.get(id) ?? 0;
        if (id && this.now() - last < SUBSCRIBE_REPEAT_MS) return;
        this.lastSubscribe.set(id, this.now());
        this.session.count(event.user, null, "subscribes");
        return this.emit("subscribe", { ...base(), months: event.months, isRenewal: event.isRenewal, subscribesThisSession: this.session.totals.subscribes });
      }
      case "like": return this.like(event, base);
      case "gift": return this.gift(event, transport);
      case "viewers": return this.viewers(event, transport);
      case "battle": return this.battle.battleEvent(event);
      case "armies": return this.battle.armiesEvent(event);
      case "envelope":
        this.session.count(null, null, "envelopes");
        return this.emit("envelope", { ...base(), envelopeId: event.envelopeId, coins: event.coins, peopleCount: event.peopleCount });
      case "question":
        return this.emit("question", { ...base(), questionId: event.questionId, question: event.question });
      case "emote":
        return this.emit("emote", { ...base(), emoteId: event.emoteId, emoteImageUrl: event.emoteImageUrl });
      case "poll": return this.poll(event, transport);
      case "goal": return this.goal(event, transport);
      case "rank":
        return this.emit("rank", { ...this.common(event, transport), rank: event.rank, rankType: RANK_TYPES[event.rankType] ?? "other", rankTypeId: event.rankType, actorId: "", actorDisplayName: "" });
      case "pin":
        return this.emit("pin", { ...base(), message: event.message, pinAction: event.pinAction === 2 ? "unpin" : "pin" });
      case "super-fan":
        return this.emit("super-fan", { ...base(), phase: event.phase, level: event.level });
      case "moderation":
        return this.emit("moderation", { ...this.common(event, transport), action: event.action, messageIds: event.messageIds.join(","), userIds: event.userIds.join(","), count: event.messageIds.length, actorId: "", actorDisplayName: "" });
      case "stream":
        if (event.phase === "ended" || event.phase === "suspended") {
          for (const result of this.streaks.flush()) this.giftResult(result, transport);
          this.battle.finish({});
        }
        return this.emitStream(event.phase, event);
      case "intro":
        if (event.host?.userId) this.hostUserId = event.host.userId;
        return undefined;
      default:
        return undefined;
    }
  }

  chat(event, payload) {
    const entry = this.session.count(event.user, "chats", "chats");
    const message = event.message;
    const prefix = this.config.commandPrefix;
    const isCommand = message.startsWith(prefix) && message.length > prefix.length && !/\s/.test(message[prefix.length]);
    this.emit("chat", { ...payload, message, isCommand, userChats: entry?.chats ?? 0, chatsThisSession: this.session.totals.chats });
    if (isCommand) {
      const body = message.slice(prefix.length).trim();
      const space = body.search(/\s/);
      const command = (space < 0 ? body : body.slice(0, space)).toLowerCase();
      const args = space < 0 ? "" : body.slice(space + 1).trim();
      this.emit("command", { ...payload, eventKey: `${payload.eventKey}:command`, command, args, message, prefix });
    }
  }

  like(event, base) {
    const entry = this.session.count(event.user, "likes", "likes", event.likeCount);
    const previous = this.session.totalLikes;
    const total = Math.max(previous, event.totalLikes);
    this.session.totalLikes = total;
    const payload = base();
    this.emit("like", { ...payload, likeCount: event.likeCount, totalLikes: total, userLikes: entry?.likes ?? event.likeCount, likesThisSession: this.session.totals.likes });
    // The first total seen is a baseline: a stream joined late has passed many milestones already.
    if (previous > 0) {
      for (const milestone of crossedMilestones(previous, total, this.config.likeMilestoneStep)) {
        this.emit("like-milestone", { ...payload, eventKey: `tiktok:like-milestone:${this.roomId}:${milestone}`, milestone, totalLikes: total, step: this.config.likeMilestoneStep });
      }
    }
  }

  gift(event, transport) {
    if (this.catalogue.learn(event)) this.publishGifts();
    this.giftResult(this.streaks.add(event), transport);
  }

  giftResult({ progress, counted }, transport) {
    if (progress) {
      this.emit("gift-streak", {
        ...this.common(progress, transport),
        ...this.actor(progress.user),
        eventKey: `${eventKey("gift-streak", progress, this.now())}:${progress.repeatCount}`,
        phase: progress.phase,
        giftId: progress.giftId,
        giftName: progress.giftName,
        repeatCount: progress.repeatCount,
        diamondsPerGift: progress.diamondCount,
        coinsSoFar: progress.diamondCount * progress.repeatCount,
      });
    }
    if (!counted) return;
    const coins = counted.diamondCount * counted.repeatCount;
    const topBefore = this.session.topIds(3);
    const result = this.session.recordGift(counted.user, coins, counted.repeatCount);
    const payload = { ...this.common(counted, transport), ...this.actor(counted.user) };
    this.emit("gift", {
      ...payload,
      giftId: counted.giftId,
      giftName: counted.giftName,
      giftType: counted.giftType,
      streakable: counted.streakable,
      diamondsPerGift: counted.diamondCount,
      repeatCount: counted.repeatCount,
      coins,
      giftImageUrl: counted.giftImageUrl,
      receiverUserId: counted.receiverUserId,
      isToHost: !counted.receiverUserId || counted.receiverUserId === "0" || counted.receiverUserId === this.hostUserId,
      isFirstGiftThisSession: result.isFirstGiftThisSession,
      senderSessionCoins: result.senderCoins,
      senderRank: result.senderRank,
      sessionCoins: result.sessionCoins,
    });
    for (const milestone of crossedMilestones(result.sessionBefore, result.sessionCoins, this.config.coinMilestoneStep)) {
      this.emit("coin-milestone", { ...payload, eventKey: `tiktok:coin-milestone:session:${this.roomId}:${milestone}`, scope: "session", milestone, total: result.sessionCoins, step: this.config.coinMilestoneStep });
    }
    for (const milestone of crossedMilestones(result.senderBefore, result.senderCoins, this.config.gifterMilestoneStep)) {
      this.emit("coin-milestone", { ...payload, eventKey: `tiktok:coin-milestone:gifter:${this.roomId}:${counted.user?.userId ?? ""}:${milestone}`, scope: "gifter", milestone, total: result.senderCoins, step: this.config.gifterMilestoneStep });
    }
    const topAfter = this.session.topIds(3);
    topAfter.forEach((userId, index) => {
      if (topBefore[index] === userId) return;
      const previous = topBefore[index] ? this.session.users.get(topBefore[index]) : null;
      const holder = this.session.users.get(userId);
      this.emit("top-gifter-change", {
        ...payload,
        ...this.actor({ ...EMPTY_USER, ...(userId === counted.user?.userId ? counted.user : {}), userId, uniqueId: holder?.uniqueId ?? "", nickname: holder?.nickname ?? "" }),
        eventKey: `tiktok:top-gifter-change:${this.roomId}:${index + 1}:${userId}:${result.sessionCoins}`,
        rank: index + 1,
        previousUserId: previous?.userId ?? "",
        previousNickname: previous?.nickname ?? "",
        coins: holder?.coins ?? 0,
      });
    });
  }

  viewers(event, transport) {
    const previous = this.session.setViewers(event.viewerCount);
    if (event.viewerCount === previous) return;
    const step = this.config.viewerMilestoneStep;
    const crossed = previous > 0 ? crossedMilestones(previous, event.viewerCount, step) : [];
    this.emit("viewer-count", {
      ...this.common(event, transport),
      viewerCount: event.viewerCount,
      previous,
      delta: event.viewerCount - previous,
      direction: event.viewerCount > previous ? "up" : "down",
      peak: this.session.totals.peakViewers,
      crossedMilestone: crossed.length > 0,
      milestone: crossed.at(-1) ?? 0,
      totalViewers: event.totalViewers,
      actorId: "",
      actorDisplayName: "",
    });
    this.publishStatus();
  }

  poll(event, transport) {
    const leading = [...event.options].sort((a, b) => b.votes - a.votes)[0];
    this.emit("poll", {
      ...this.common(event, transport),
      eventKey: `${event.eventKey}:${event.phase}`,
      pollId: event.pollId,
      phase: event.phase,
      title: event.title,
      options: event.options,
      leadingOption: leading?.label ?? "",
      leadingVotes: leading?.votes ?? 0,
      totalVotes: event.options.reduce((sum, option) => sum + option.votes, 0),
      actorId: "",
      actorDisplayName: "",
    });
  }

  goal(event, transport) {
    const signature = `${event.current}/${event.target}`;
    if (this.lastGoal.get(event.goalId) === signature) return;
    this.lastGoal.set(event.goalId, signature);
    const percent = event.target > 0 ? Math.min(100, Math.floor((event.current * 100) / event.target)) : 0;
    this.emit("goal", {
      ...this.common(event, transport),
      goalId: event.goalId,
      description: event.description,
      current: event.current,
      target: event.target,
      percent,
      isReached: event.target > 0 && event.current >= event.target,
      actorId: "",
      actorDisplayName: "",
    });
  }

  emitBattle(snapshot) {
    this.emit("battle", {
      ...this.common({}, this.source?.transport ?? this.config.transport),
      eventKey: `tiktok:battle:${snapshot.battleId}:${snapshot.phase}:${snapshot.hostPoints}:${snapshot.opponentPoints}`,
      ...snapshot,
      actorId: snapshot.opponentUserId,
      actorDisplayName: snapshot.opponentNickname || snapshot.opponentUniqueId,
    });
  }

  emitStream(phase, event) {
    const startedAt = this.session.streamStartedAt;
    this.emit("stream", {
      ...this.common(event, this.source?.transport ?? this.config.transport),
      eventKey: `tiktok:stream:${this.roomId}:${phase}:${event.msgId ?? this.now()}`,
      phase,
      title: this.session.title,
      startedAt: isoTime(startedAt),
      durationSeconds: startedAt > 0 ? Math.max(0, Math.round((this.now() - startedAt) / 1000)) : 0,
      viewerCount: this.session.viewerCount,
      totalLikes: this.session.totalLikes,
      sessionCoins: this.session.totals.coins,
      actorId: "",
      actorDisplayName: "",
    });
  }

  emitRaw(raw) {
    const { data, truncated } = safeJson(raw.data);
    this.emit("raw", {
      ...this.common({ msgId: text(raw.data?.common?.msgId) }, raw.transport),
      eventKey: `tiktok:raw:${raw.type}:${text(raw.data?.common?.msgId) || this.now()}`,
      eventName: raw.type,
      data,
      truncated,
      actorId: "",
      actorDisplayName: "",
    });
  }

  // ---------------------------------------------------------------- actions

  async connect() {
    if (!this.config.uniqueId) return { ok: false, state: this.state.state, error: "Add the TikTok username of the LIVE under General." };
    try {
      this.userStopped = false;
      if (this.source) this.source.reconnectNow?.();
      else await this.startSource();
      return { ok: true, state: this.state.state, error: "" };
    } catch (error) {
      return { ok: false, state: this.state.state, error: describe(error) };
    }
  }

  async disconnect() {
    this.userStopped = true;
    try {
      await this.stopSource("Disconnected by a flow. Run TikTok LIVE: connect to reconnect.");
      return { ok: true, state: this.state.state, error: "" };
    } catch (error) {
      return { ok: false, state: this.state.state, error: describe(error) };
    }
  }

  async refreshGifts() {
    if (!this.source?.capabilities?.giftList) {
      return { ok: false, count: this.catalogue.size, error: "The TikFinity bridge has no gift list. Gifts are learned as they arrive." };
    }
    try {
      const list = await this.source.fetchGifts();
      this.catalogue.learnList(list);
      this.publishGifts();
      return { ok: true, count: this.catalogue.size, error: "" };
    } catch (error) {
      return { ok: false, count: this.catalogue.size, error: `${explain(error)} Gifts are still learned as they arrive.` };
    }
  }

  resetSession(data) {
    const scope = ["all", "coins", "likes", "gifters"].includes(data?.scope) ? data.scope : "all";
    this.session.reset(scope, this.roomId);
    if (scope === "all") this.lastGoal.clear();
    this.publishStatus();
    return { ok: true, scope, error: "" };
  }

  async waitUntilLive(data) {
    const timeoutMs = Math.round(clamp(number(data?.timeoutSeconds, 20), 1, 25) * 1000);
    const startedAt = this.now();
    const waited = () => Math.round((this.now() - startedAt) / 1000);
    if (this.state.state === "connected") return { ok: true, live: true, waitedSeconds: 0, error: "" };
    if (!this.source?.capabilities?.isLive) return { ok: false, live: false, waitedSeconds: 0, error: "The TikFinity bridge cannot check whether a stream is live." };
    while (this.now() - startedAt < timeoutMs && !this.stopped) {
      try {
        if (await this.source.fetchIsLive()) {
          this.source.reconnectNow?.();
          return { ok: true, live: true, waitedSeconds: waited(), error: "" };
        }
      } catch (error) {
        return { ok: false, live: false, waitedSeconds: waited(), error: explain(error) };
      }
      await new Promise((resolve) => this.timers.setTimeout(resolve, Math.min(5000, Math.max(0, timeoutMs - (this.now() - startedAt)))));
    }
    return { ok: true, live: false, waitedSeconds: waited(), error: "" };
  }

  async sendChat(data) {
    const message = text(data?.message).replace(/\s+/g, " ").trim();
    const fail = (error, disabledReason = "") => {
      this.emit("chat-sent", { ...this.common({}, this.config.transport), message, ok: false, error, actorId: "", actorDisplayName: "" });
      return { ok: false, error, disabledReason };
    };
    const chat = this.chatAvailability();
    if (!chat.available) return fail(chat.reason.replace(/^deprecated: /, ""), chat.reason.startsWith("deprecated:") ? chat.reason : "disabled");
    if (!message) return fail("The message is empty.");
    if (message.length > CHAT_LIMIT) return fail(`TikTok chat messages are at most ${CHAT_LIMIT} characters.`);
    const session = await readChatSession(this.ctx.secrets);
    if (!session) return fail("Chat is not signed in. Run TikTok LIVE: chat sign-in.");
    try {
      await this.source.sendChat(message, session);
      this.emit("chat-sent", { ...this.common({}, this.config.transport), message, ok: true, error: "", actorId: "", actorDisplayName: "" });
      return { ok: true, error: "", disabledReason: "" };
    } catch (error) {
      return fail(explain(error));
    }
  }

  async chatSignIn() {
    const chat = this.chatAvailability();
    if (!this.config.chatEnabled || !this.flags.chat.enabled) return { ok: false, url: "", expiresInSeconds: 0, error: chat.reason.replace(/^deprecated: /, "") };
    try {
      const { url, expiresInSeconds } = await this.signIn.start();
      this.ctx.log.info(`Chat sign-in: open ${url} in your browser within ${expiresInSeconds / 60} minutes.`);
      this.publishStatus();
      return { ok: true, url, expiresInSeconds, error: "" };
    } catch (error) {
      return { ok: false, url: "", expiresInSeconds: 0, error: describe(error) };
    }
  }

  async chatSignOut() {
    try {
      await this.signIn.close();
      await clearChatSession(this.ctx.secrets);
      this.publishStatus();
      return { ok: true, error: "" };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  }

  // ---------------------------------------------------------------- inputs

  async status() {
    const chat = this.chatAvailability();
    const signedIn = Boolean(await readChatSession(this.ctx.secrets).catch(() => null));
    return {
      connected: this.state.state === "connected",
      state: this.state.state,
      transport: this.source?.transport ?? this.config.transport,
      uniqueId: this.config.uniqueId,
      roomId: this.roomId,
      isLive: this.state.state === "connected",
      lastError: this.lastError,
      attempt: this.state.attempt,
      rateLimited: this.state.rateLimited,
      giftCatalogueSize: this.catalogue.size,
      sessionStartedAt: isoTime(this.session.startedAt),
      eventsEmitted: this.emitted,
      duplicatesDropped: this.recent.dropped,
      chatAvailable: chat.available && signedIn,
      chatSignedIn: signedIn,
      chatDisabledReason: chat.available ? (signedIn ? "" : "Chat is not signed in.") : chat.reason,
    };
  }

  roomStats() {
    const totals = this.session.totals;
    const startedAt = this.session.streamStartedAt;
    return {
      viewerCount: this.session.viewerCount,
      peakViewers: totals.peakViewers,
      totalLikes: this.session.totalLikes,
      sessionCoins: totals.coins,
      sessionGifts: totals.gifts,
      likesThisSession: totals.likes,
      chats: totals.chats,
      follows: totals.follows,
      shares: totals.shares,
      joins: totals.joins,
      subscribes: totals.subscribes,
      title: this.session.title,
      startedAt: isoTime(startedAt),
      durationSeconds: startedAt > 0 ? Math.max(0, Math.round((this.now() - startedAt) / 1000)) : 0,
    };
  }

  giftLookup(data) {
    const byId = number(data?.giftId, 0);
    const gift = (byId > 0 ? this.catalogue.get(byId) : null) ?? this.catalogue.findByName(data?.giftName);
    return {
      found: Boolean(gift),
      giftId: gift?.giftId ?? 0,
      giftName: gift?.name ?? "",
      diamondCount: gift?.diamondCount ?? 0,
      giftType: gift?.giftType ?? 0,
      streakable: gift?.giftType === 1,
    };
  }

  battleState() {
    return this.battle.state();
  }

  topGifters(data) {
    const limit = Math.round(clamp(number(data?.limit, 5), 1, 20));
    const list = this.session.gifters().slice(0, limit).map((entry, index) => ({ rank: index + 1, userId: entry.userId, uniqueId: entry.uniqueId, nickname: entry.nickname, coins: entry.coins, gifts: entry.gifts }));
    const top = list[0];
    return {
      count: list.length,
      topUserId: top?.userId ?? "",
      topUniqueId: top?.uniqueId ?? "",
      topNickname: top?.nickname ?? "",
      topCoins: top?.coins ?? 0,
      list,
      text: list.map((entry) => `${entry.rank}. ${entry.nickname || entry.uniqueId} ${entry.coins}`).join(", "),
    };
  }

  userStats(data) {
    const entry = this.session.userStats(data?.uniqueId);
    return {
      found: Boolean(entry),
      userId: entry?.userId ?? "",
      uniqueId: entry?.uniqueId ?? "",
      nickname: entry?.nickname ?? "",
      coins: entry?.coins ?? 0,
      gifts: entry?.gifts ?? 0,
      likes: entry?.likes ?? 0,
      chats: entry?.chats ?? 0,
      joins: entry?.joins ?? 0,
      rank: entry ? this.session.rankOf(entry.userId) : 0,
      isReturning: entry ? this.session.knownViewers.has(entry.userId) : false,
    };
  }
}

/**
 * Starts a runtime and registers its blocks. The default export uses the real transports;
 * tests pass `overrides` (createSource, timers, now, fetchImpl, WebSocketImpl).
 */
export async function startRuntime(ctx, overrides = {}) {
  const runtime = new TikTokLiveRuntime(ctx, normalizeConfig(await ctx.config.get()), overrides);
  const register = (name, handler) => ctx.registerAction(name, (data) => handler(data ?? {}));
  register("connect", () => runtime.connect());
  register("disconnect", () => runtime.disconnect());
  register("refresh-gifts", () => runtime.refreshGifts());
  register("reset-session", (data) => runtime.resetSession(data));
  register("wait-until-live", (data) => runtime.waitUntilLive(data));
  register("send-chat", (data) => runtime.sendChat(data));
  register("chat-sign-in", () => runtime.chatSignIn());
  register("chat-sign-out", () => runtime.chatSignOut());
  register("status", () => runtime.status());
  register("room-stats", () => runtime.roomStats());
  register("gift-lookup", (data) => runtime.giftLookup(data));
  register("battle-state", () => runtime.battleState());
  register("top-gifters", (data) => runtime.topGifters(data));
  register("user-stats", (data) => runtime.userStats(data));
  try {
    await runtime.start();
  } catch (error) {
    await runtime.shutdown();
    throw error;
  }
  return runtime;
}
