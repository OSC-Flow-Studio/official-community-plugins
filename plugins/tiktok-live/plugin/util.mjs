// Small helpers shared by the plugin's modules. Nothing here depends on the host locale:
// numbers are parsed with Number(), times are ISO-8601 in UTC, and nothing is formatted
// with the computer's language or time zone.

/** Reads a dotted path ("gift.diamondCount") from an object; undefined when any step is missing. */
export function read(value, path) {
  let current = value;
  for (const key of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }
  return current;
}

/** The first path in `paths` that holds something other than undefined, null or "". */
export function first(value, paths) {
  for (const path of paths) {
    const found = read(value, path);
    if (found !== undefined && found !== null && found !== "") return found;
  }
  return undefined;
}

export function text(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  return fallback;
}

/** A finite number from a number, a numeric string or a bigint; `fallback` otherwise. */
export function number(value, fallback = 0) {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

export function bool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value === "true" || value === "1";
  return false;
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * TikTok sends creation times as strings, in milliseconds on most messages and in seconds
 * on a few. Returns milliseconds, or 0 when the value is missing.
 */
export function toMillis(value) {
  const raw = number(value, 0);
  if (raw <= 0) return 0;
  return raw < 100_000_000_000 ? raw * 1000 : raw;
}

export function isoTime(ms) {
  return ms > 0 ? new Date(ms).toISOString() : "";
}

export const describe = (error) => (error instanceof Error ? error.message : String(error));

/** The handle without "@", lowercased, or "" when it is not a valid TikTok username. */
export function normalizeUniqueId(value) {
  const raw = text(value).trim().replace(/^https?:\/\/(www\.)?tiktok\.com\//i, "").replace(/\/live\/?$/i, "").replace(/^@/, "");
  return /^[A-Za-z0-9_.]{2,24}$/.test(raw) ? raw.toLowerCase() : "";
}
