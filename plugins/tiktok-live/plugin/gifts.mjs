// The gift catalogue behind the gift picker. TikTok's gift list endpoint needs a signed
// request that Euler Stream only serves on its paid plans, so the plugin learns gifts as
// they arrive and keeps them in the vault. With a Business key, "Refresh gift list" loads
// the whole list at once.
import { number, text } from "./util.mjs";

const MAX_GIFTS = 400;

// TikTok groups gifts by type; type 1 is the streakable kind (Rose, TikTok, ...).
const groupOf = (gift) => (gift.giftType === 1 ? "Streakable gifts" : "Other gifts");

export class GiftCatalogue {
  constructor() {
    this.gifts = new Map();
    this.dirty = false;
  }

  /** Adds or updates one gift; returns true when the picker needs to be published again. */
  learn(gift) {
    const giftId = number(gift.giftId, 0);
    if (giftId <= 0) return false;
    const before = this.gifts.get(giftId);
    const entry = {
      giftId,
      name: text(gift.giftName ?? gift.name) || before?.name || "",
      diamondCount: number(gift.diamondCount, before?.diamondCount ?? 0),
      giftType: number(gift.giftType, before?.giftType ?? 0),
    };
    if (before && before.name === entry.name && before.diamondCount === entry.diamondCount && before.giftType === entry.giftType) return false;
    this.gifts.delete(giftId);
    this.gifts.set(giftId, entry);
    while (this.gifts.size > MAX_GIFTS) this.gifts.delete(this.gifts.keys().next().value);
    this.dirty = true;
    return true;
  }

  /** Loads a list from TikTok's gift endpoint (snake_case fields). */
  learnList(list) {
    let changed = 0;
    for (const item of Array.isArray(list) ? list : []) {
      if (this.learn({ giftId: item.id, giftName: item.name, diamondCount: item.diamond_count ?? item.diamondCount, giftType: item.type })) changed += 1;
    }
    return changed;
  }

  get(giftId) {
    return this.gifts.get(number(giftId, 0)) ?? null;
  }

  findByName(name) {
    const wanted = text(name).trim().toLowerCase();
    if (!wanted) return null;
    for (const gift of this.gifts.values()) if (gift.name.toLowerCase() === wanted) return gift;
    return null;
  }

  /** Items for the "gifts" resource: value is the gift id, which is what the trigger matches. */
  resourceItems() {
    return [...this.gifts.values()]
      .sort((a, b) => a.diamondCount - b.diamondCount || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || a.giftId - b.giftId)
      .map((gift) => ({ value: String(gift.giftId), label: `${gift.name || `Gift ${gift.giftId}`} (${gift.diamondCount} coins)`, group: groupOf(gift) }));
  }

  toJSON() {
    return { version: 1, gifts: [...this.gifts.values()] };
  }

  restore(saved) {
    if (saved?.version !== 1 || !Array.isArray(saved.gifts)) return;
    for (const gift of saved.gifts) this.learn(gift);
    this.dirty = false;
  }

  get size() {
    return this.gifts.size;
  }
}
