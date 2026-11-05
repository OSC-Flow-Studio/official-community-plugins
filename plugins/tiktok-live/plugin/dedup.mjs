// TikTok repeats messages: the first batch after a reconnect replays recent ones, and
// TikFinity can relay one notice both as "social" and as "follow". Each event gets a key,
// and a key seen recently is dropped.

const DEFAULT_SIZE = 4000;

export class RecentKeys {
  constructor(size = DEFAULT_SIZE) {
    this.size = size;
    this.keys = new Set();
    this.dropped = 0;
  }

  /** True the first time a key is seen; false (and counted) for a repeat. */
  add(key) {
    if (!key) return true;
    if (this.keys.has(key)) {
      this.dropped += 1;
      return false;
    }
    this.keys.add(key);
    if (this.keys.size > this.size) this.keys.delete(this.keys.values().next().value);
    return true;
  }
}

let counter = 0;

/**
 * The event's key for deduplication and for flows that need one: "tiktok:<kind>:<msgId>"
 * when TikTok gave the message an id, otherwise built from the sender and the time.
 */
export function eventKey(kind, event, now = Date.now()) {
  if (event.msgId && event.msgId !== "0") return `tiktok:${kind}:${event.msgId}`;
  const userId = event.user?.userId ?? "";
  if (userId && event.createTime > 0) return `tiktok:${kind}:${userId}:${event.createTime}`;
  counter = (counter + 1) % 1_000_000;
  return `tiktok:${kind}:${now}:${counter}`;
}
