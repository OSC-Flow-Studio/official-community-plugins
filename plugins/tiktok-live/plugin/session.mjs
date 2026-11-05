// What happened in the current LIVE session: totals, per-viewer counters, the gifter
// ranking and milestones. A session starts when the plugin first sees a room and, with
// "Reset per stream" on, again whenever the room changes.
//
// It is saved in the plugin's vault (the only storage a plugin has) as one JSON value, so
// it survives a backend restart in the middle of a stream. Only gifters are saved per
// viewer; everyone else is kept in memory for the current run.
import { isoTime, number, text } from "./util.mjs";

export const SESSION_VERSION = 1;
const MAX_USERS = 5000;
const SAVED_GIFTERS = 100;
const MAX_KNOWN_VIEWERS = 2000;

const TOTAL_KEYS = ["coins", "gifts", "likes", "chats", "follows", "shares", "joins", "subscribes", "envelopes", "peakViewers"];
const zeroTotals = () => Object.fromEntries(TOTAL_KEYS.map((key) => [key, 0]));

function blankUser(user) {
  return { userId: user.userId, uniqueId: user.uniqueId ?? "", nickname: user.nickname ?? "", coins: 0, gifts: 0, likes: 0, chats: 0, follows: 0, shares: 0, joins: 0, lastAt: 0 };
}

/** Milestones crossed when a running total moves from `before` to `after` in steps of `step`. */
export function crossedMilestones(before, after, step, limit = 10) {
  if (!(step > 0) || after <= before) return [];
  const out = [];
  for (let milestone = (Math.floor(before / step) + 1) * step; milestone <= after && out.length < limit; milestone += step) out.push(milestone);
  return out;
}

export class Session {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.reset("all");
    this.knownViewers = new Set();
    this.knownDirty = false;
  }

  reset(scope = "all", roomId = this.roomId ?? "") {
    if (scope === "all") {
      this.startedAt = this.now();
      this.roomId = roomId;
      this.totals = zeroTotals();
      this.users = new Map();
      this.seenThisSession = new Set();
      this.followedThisSession = new Set();
      this.viewerCount = 0;
      this.totalLikes = 0;
      this.title = "";
      this.streamStartedAt = 0;
      this.dirty = true;
      return;
    }
    if (scope === "coins" || scope === "gifters") {
      this.totals.coins = 0;
      this.totals.gifts = 0;
      for (const user of this.users.values()) {
        user.coins = 0;
        user.gifts = 0;
      }
    }
    if (scope === "likes") {
      this.totals.likes = 0;
      this.totalLikes = 0;
      for (const user of this.users.values()) user.likes = 0;
    }
    this.dirty = true;
  }

  user(user) {
    if (!user?.userId) return null;
    let entry = this.users.get(user.userId);
    if (!entry) {
      if (this.users.size >= MAX_USERS) this.evict();
      entry = blankUser(user);
      this.users.set(user.userId, entry);
    }
    if (user.uniqueId) entry.uniqueId = user.uniqueId;
    if (user.nickname) entry.nickname = user.nickname;
    entry.lastAt = this.now();
    return entry;
  }

  evict() {
    let oldest = null;
    for (const entry of this.users.values()) {
      if (entry.coins > 0) continue;
      if (!oldest || entry.lastAt < oldest.lastAt) oldest = entry;
    }
    if (oldest) this.users.delete(oldest.userId);
  }

  /** Gifters, highest coins first; ties go to whoever reached the amount first. */
  gifters() {
    return [...this.users.values()].filter((entry) => entry.coins > 0).sort((a, b) => b.coins - a.coins || a.lastAt - b.lastAt);
  }

  rankOf(userId) {
    const index = this.gifters().findIndex((entry) => entry.userId === userId);
    return index < 0 ? 0 : index + 1;
  }

  topIds(count = 3) {
    return this.gifters().slice(0, count).map((entry) => entry.userId);
  }

  recordGift(user, coins, gifts) {
    const entry = this.user(user);
    const wasGifter = (entry?.coins ?? 0) > 0;
    const sessionBefore = this.totals.coins;
    const senderBefore = entry?.coins ?? 0;
    this.totals.coins += coins;
    this.totals.gifts += gifts;
    if (entry) {
      entry.coins += coins;
      entry.gifts += gifts;
    }
    this.dirty = true;
    return {
      sessionBefore,
      sessionCoins: this.totals.coins,
      sessionGifts: this.totals.gifts,
      senderBefore,
      senderCoins: entry?.coins ?? coins,
      senderGifts: entry?.gifts ?? gifts,
      senderRank: entry ? this.rankOf(entry.userId) : 0,
      isFirstGiftThisSession: !wasGifter,
    };
  }

  recordJoin(user) {
    const entry = this.user(user);
    const id = user?.userId ?? "";
    const isFirstJoin = id ? !this.seenThisSession.has(id) : true;
    const isReturning = id ? this.knownViewers.has(id) && isFirstJoin : false;
    if (id) {
      this.seenThisSession.add(id);
      this.rememberViewer(id);
    }
    if (entry) entry.joins += 1;
    this.totals.joins += 1;
    this.dirty = true;
    return { isFirstJoin, isReturning };
  }

  rememberViewer(id) {
    if (this.knownViewers.has(id)) this.knownViewers.delete(id);
    this.knownViewers.add(id);
    while (this.knownViewers.size > MAX_KNOWN_VIEWERS) this.knownViewers.delete(this.knownViewers.values().next().value);
    this.knownDirty = true;
  }

  recordFollow(user) {
    const entry = this.user(user);
    const id = user?.userId ?? "";
    const first = id ? !this.followedThisSession.has(id) : true;
    if (id) this.followedThisSession.add(id);
    if (entry) entry.follows += 1;
    this.totals.follows += 1;
    this.dirty = true;
    return { isFirstFollowThisSession: first };
  }

  count(user, field, total, amount = 1) {
    const entry = this.user(user);
    if (entry && field) entry[field] += amount;
    if (total) this.totals[total] += amount;
    this.dirty = true;
    return entry;
  }

  setViewers(count) {
    const previous = this.viewerCount;
    this.viewerCount = count;
    if (count > this.totals.peakViewers) this.totals.peakViewers = count;
    if (count !== previous) this.dirty = true;
    return previous;
  }

  userStats(uniqueIdOrId) {
    const wanted = text(uniqueIdOrId).trim().replace(/^@/, "").toLowerCase();
    if (!wanted) return null;
    for (const entry of this.users.values()) {
      if (entry.userId === wanted || entry.uniqueId.toLowerCase() === wanted) return entry;
    }
    return null;
  }

  toJSON() {
    return {
      version: SESSION_VERSION,
      startedAt: isoTime(this.startedAt),
      roomId: this.roomId,
      title: this.title,
      streamStartedAt: isoTime(this.streamStartedAt),
      totals: this.totals,
      totalLikes: this.totalLikes,
      viewerCount: this.viewerCount,
      gifters: this.gifters().slice(0, SAVED_GIFTERS),
      followed: [...this.followedThisSession].slice(-500),
      seen: [...this.seenThisSession].slice(-2000),
    };
  }

  restore(saved) {
    if (!saved || saved.version !== SESSION_VERSION) return false;
    this.startedAt = Date.parse(saved.startedAt) || this.now();
    this.roomId = text(saved.roomId);
    this.title = text(saved.title);
    this.streamStartedAt = Date.parse(saved.streamStartedAt) || 0;
    this.totals = { ...zeroTotals(), ...Object.fromEntries(TOTAL_KEYS.map((key) => [key, number(saved.totals?.[key], 0)])) };
    this.totalLikes = number(saved.totalLikes, 0);
    this.viewerCount = number(saved.viewerCount, 0);
    this.users = new Map();
    for (const item of Array.isArray(saved.gifters) ? saved.gifters : []) {
      if (!item?.userId) continue;
      this.users.set(String(item.userId), { ...blankUser({ userId: String(item.userId) }), ...item, userId: String(item.userId) });
    }
    this.followedThisSession = new Set(Array.isArray(saved.followed) ? saved.followed.map(String) : []);
    this.seenThisSession = new Set(Array.isArray(saved.seen) ? saved.seen.map(String) : []);
    this.dirty = false;
    return true;
  }

  restoreKnownViewers(list) {
    this.knownViewers = new Set(Array.isArray(list) ? list.map(String).slice(-MAX_KNOWN_VIEWERS) : []);
    this.knownDirty = false;
  }
}
