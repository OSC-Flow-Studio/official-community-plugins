// LIVE battles (TikTok calls them LinkMic battles, viewers call them PK). Two message
// types describe one: WebcastLinkMicBattle when a battle opens or finishes, and
// WebcastLinkMicArmies whenever the points change. The tracker folds both into one
// battle with start, update, lead-change and end phases, seen from the host's side.

export const UPDATE_THROTTLE_MS = 2000;

// LinkMicBattleBattleAction OPEN = 4, FINISH = 5, CUT_SHORT = 6.
const OPEN = 4;
const ENDING_ACTIONS = new Set([5, 6]);
// BattleSettingsBattleStatus STARTED = 1; FINISHED = 2 and both punishment phases come after scoring.
const STARTED = 1;
const ended = (status) => status >= 2;

export class BattleTracker {
  /**
   * `hostUserId()` returns the streamer's user id when known; `roomId()` the connected room.
   * `onEmit(phase, snapshot)` receives every phase.
   */
  constructor({ now = Date.now, timers, hostUserId, roomId, onEmit }) {
    this.now = now;
    this.timers = timers;
    this.hostUserId = hostUserId;
    this.roomId = roomId;
    this.onEmit = onEmit;
    this.active = null;
    this.lastResult = "";
    this.lastBattle = null;
    this.pendingUpdate = null;
    this.lastUpdateAt = 0;
  }

  battleEvent(event) {
    const ending = ENDING_ACTIONS.has(event.action) || ended(event.status);
    if (this.active && event.battleId && this.active.battleId && event.battleId !== this.active.battleId) this.finish({});
    if (!this.active) {
      if (ending && !(event.anchors?.length > 0)) return;
      if (!ending && !(event.action === OPEN || event.status === STARTED || event.anchors?.length > 0)) return;
      this.begin(event);
    }
    this.merge(event);
    if (ending) this.finish(event.results ?? {});
  }

  armiesEvent(event) {
    if (this.active && event.battleId && this.active.battleId && event.battleId !== this.active.battleId) this.finish({});
    if (!this.active) {
      if (ended(event.status)) return;
      this.begin(event);
    }
    const before = this.leader();
    this.merge(event);
    if (ended(event.status)) {
      this.finish({});
      return;
    }
    const after = this.leader();
    if (before !== after && before !== "tied-start") {
      this.emitNow(after === "tied" ? "update" : "lead-change");
    } else {
      this.scheduleUpdate();
    }
  }

  begin(event) {
    this.active = {
      battleId: event.battleId || `battle-${this.now()}`,
      startedAtMs: event.startedAtMs > 0 ? event.startedAtMs : this.now(),
      plannedSeconds: event.durationSeconds ?? 0,
      anchors: new Map(),
      points: new Map(),
      started: false,
    };
    this.merge(event);
    this.active.started = true;
    this.emitNow("start");
  }

  merge(event) {
    const battle = this.active;
    if (!battle) return;
    for (const anchor of event.anchors ?? []) {
      if (!anchor.userId) continue;
      battle.anchors.set(anchor.userId, { ...battle.anchors.get(anchor.userId), ...anchor });
    }
    for (const [userId, points] of Object.entries(event.points ?? {})) {
      battle.points.set(userId, points);
      if (!battle.anchors.has(userId)) battle.anchors.set(userId, { userId, uniqueId: "", nickname: "", roomId: "" });
    }
    if (event.durationSeconds > 0) battle.plannedSeconds = event.durationSeconds;
  }

  /** The user id of the host's side of the battle, or "" when it cannot be told. */
  hostSide() {
    const battle = this.active ?? this.lastBattle;
    if (!battle) return "";
    const host = this.hostUserId?.() ?? "";
    if (host && battle.anchors.has(host)) return host;
    const room = this.roomId?.() ?? "";
    if (room) for (const anchor of battle.anchors.values()) if (anchor.roomId === room) return anchor.userId;
    return battle.anchors.keys().next().value ?? "";
  }

  scores(battle = this.active ?? this.lastBattle) {
    const host = this.hostSide();
    let hostPoints = 0;
    let opponentPoints = 0;
    let opponent = null;
    for (const [userId, anchor] of battle?.anchors ?? []) {
      const points = battle.points.get(userId) ?? 0;
      if (userId === host) hostPoints = points;
      else if (!opponent || points > opponentPoints) {
        opponent = anchor;
        opponentPoints = points;
      }
    }
    return { host, hostPoints, opponentPoints, opponent };
  }

  leader() {
    if (!this.active) return "tied-start";
    const { hostPoints, opponentPoints } = this.scores();
    if (hostPoints === opponentPoints) return "tied";
    return hostPoints > opponentPoints ? "host" : "opponent";
  }

  snapshot(phase, result = "") {
    const battle = this.active ?? this.lastBattle;
    const { hostPoints, opponentPoints, opponent } = this.scores(battle);
    const leader = hostPoints === opponentPoints ? "tied" : hostPoints > opponentPoints ? "host" : "opponent";
    return {
      battleId: battle.battleId,
      phase,
      hostPoints,
      opponentPoints,
      leader,
      result,
      durationSeconds: Math.max(0, Math.round((this.now() - battle.startedAtMs) / 1000)),
      plannedSeconds: battle.plannedSeconds,
      opponentUserId: opponent?.userId ?? "",
      opponentUniqueId: opponent?.uniqueId ?? "",
      opponentNickname: opponent?.nickname ?? "",
      participantCount: battle.anchors.size,
      participants: [...battle.anchors.values()].map((anchor) => ({
        userId: anchor.userId,
        uniqueId: anchor.uniqueId ?? "",
        nickname: anchor.nickname ?? "",
        points: battle.points.get(anchor.userId) ?? 0,
      })),
    };
  }

  emitNow(phase, result = "") {
    if (this.pendingUpdate) {
      this.timers.clearTimeout(this.pendingUpdate);
      this.pendingUpdate = null;
    }
    this.lastUpdateAt = this.now();
    this.onEmit(phase, this.snapshot(phase, result));
  }

  scheduleUpdate() {
    if (this.pendingUpdate) return;
    const wait = Math.max(0, UPDATE_THROTTLE_MS - (this.now() - this.lastUpdateAt));
    this.pendingUpdate = this.timers.setTimeout(() => {
      this.pendingUpdate = null;
      if (this.active) this.emitNow("update");
    }, wait);
  }

  finish(results) {
    if (!this.active) return;
    const host = this.hostSide();
    let result = results?.[host]?.result ?? "";
    for (const [userId, value] of Object.entries(results ?? {})) if (value?.score !== undefined) this.active.points.set(userId, value.score);
    if (!result) {
      const { hostPoints, opponentPoints } = this.scores();
      result = hostPoints === opponentPoints ? "draw" : hostPoints > opponentPoints ? "win" : "lose";
    }
    this.emitNow("end", result);
    this.lastResult = result;
    this.lastBattle = this.active;
    this.active = null;
  }

  state() {
    if (!this.active) {
      const last = this.lastBattle ? this.snapshot("end", this.lastResult) : null;
      return { active: false, battleId: last?.battleId ?? "", hostPoints: last?.hostPoints ?? 0, opponentPoints: last?.opponentPoints ?? 0, leader: last?.leader ?? "", opponentUniqueId: last?.opponentUniqueId ?? "", durationSeconds: last?.durationSeconds ?? 0, lastResult: this.lastResult };
    }
    const now = this.snapshot("update");
    return { active: true, battleId: now.battleId, hostPoints: now.hostPoints, opponentPoints: now.opponentPoints, leader: now.leader, opponentUniqueId: now.opponentUniqueId, durationSeconds: now.durationSeconds, lastResult: this.lastResult };
  }

  dispose() {
    if (this.pendingUpdate) this.timers.clearTimeout(this.pendingUpdate);
    this.pendingUpdate = null;
  }
}
