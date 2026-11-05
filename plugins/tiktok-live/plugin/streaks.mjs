// Gift streaks. A streakable gift (gift type 1, like the Rose) arrives once per tap while
// the viewer keeps tapping, each time with a higher repeatCount, and once more with
// repeatEnd set when the streak is over. Every other gift arrives once, already final.
//
// The tracker reports each tick as progress and decides when the gift counts:
// - "completed" (default): once, when the streak ends, with every tap in it.
// - "each": on every tick, with the taps added since the previous tick.
// A streak that stops sending ticks for STALE_MS is closed with the last count seen,
// because TikTok occasionally drops the final message.

export const STALE_MS = 15_000;

export class GiftStreaks {
  constructor({ mode = "completed", now = Date.now, timers, onExpire }) {
    this.mode = mode === "each" ? "each" : "completed";
    this.now = now;
    this.timers = timers;
    this.onExpire = onExpire;
    this.open = new Map();
  }

  key(gift) {
    return `${gift.user?.userId ?? ""}:${gift.giftId}:${gift.groupId ?? ""}`;
  }

  /**
   * Feeds one gift message. Returns `{ progress, counted }`:
   * `progress` describes the streak for the gift-streak trigger (null for one-off gifts),
   * `counted` is the gift to emit now, with `repeatCount` taps (null when nothing counts yet).
   */
  add(gift) {
    const streakable = gift.giftType === 1;
    if (!streakable) return { progress: null, counted: { ...gift, streakable: false } };
    const key = this.key(gift);
    const previous = this.open.get(key);
    if (previous) this.timers.clearTimeout(previous.timer);
    // A count lower than the last tick means a new streak reused the group.
    const lastCount = previous && gift.repeatCount >= previous.repeatCount ? previous.repeatCount : 0;
    const countedSoFar = previous && gift.repeatCount >= previous.repeatCount ? previous.counted : 0;
    const progress = { ...gift, streakable: true, phase: gift.repeatEnd ? "end" : "progress" };
    let counted = null;
    if (this.mode === "each") {
      const delta = gift.repeatCount - lastCount;
      if (delta > 0) counted = { ...gift, streakable: true, repeatCount: delta };
    } else if (gift.repeatEnd) {
      counted = { ...gift, streakable: true };
    }
    if (gift.repeatEnd) {
      this.open.delete(key);
    } else {
      const entry = { gift, repeatCount: gift.repeatCount, counted: this.mode === "each" ? gift.repeatCount : countedSoFar, timer: null };
      entry.timer = this.timers.setTimeout(() => this.expire(key), STALE_MS);
      this.open.set(key, entry);
    }
    return { progress, counted };
  }

  expire(key) {
    const entry = this.open.get(key);
    if (!entry) return;
    this.open.delete(key);
    const gift = { ...entry.gift, repeatEnd: true, streakable: true };
    const progress = { ...gift, phase: "end" };
    const counted = this.mode === "each" ? null : gift;
    this.onExpire?.({ progress, counted });
  }

  /** Closes every open streak, as if each had ended, and returns what that counts. */
  flush() {
    const out = [];
    for (const key of [...this.open.keys()]) {
      const entry = this.open.get(key);
      this.timers.clearTimeout(entry.timer);
      this.open.delete(key);
      const gift = { ...entry.gift, repeatEnd: true, streakable: true };
      out.push({ progress: { ...gift, phase: "end" }, counted: this.mode === "each" ? null : gift });
    }
    return out;
  }

  get size() {
    return this.open.size;
  }
}
