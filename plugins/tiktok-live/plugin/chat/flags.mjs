// Remote switches for features that may have to be turned off after release. Sending chat
// is BETA: if TikTok starts suspending accounts for it, or the route breaks, the
// maintainers set "enabled": false in plugins/tiktok-live/feature-flags.json on the main
// branch and every installed copy stops sending within six hours, without an update.
//
// The copy shipped in the ZIP is the default. A copy fetched from GitHub replaces it, and
// is kept in the vault so a restart without network keeps the last known answer.
import shipped from "../feature-flags.json" with { type: "json" };
import { describe } from "../util.mjs";

export const FLAGS_URL = "https://raw.githubusercontent.com/OSC-Flow-Studio/official-community-plugins/main/plugins/tiktok-live/feature-flags.json";
export const REFRESH_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_KEY = "feature-flags-cache";

function clean(raw) {
  const chat = raw?.chat ?? {};
  return {
    version: 1,
    chat: { enabled: chat.enabled !== false, message: typeof chat.message === "string" ? chat.message.slice(0, 300) : "" },
  };
}

export class FeatureFlags {
  constructor({ secrets, fetchImpl = globalThis.fetch, timers, log, url = FLAGS_URL, signal }) {
    this.secrets = secrets;
    this.fetchImpl = fetchImpl;
    this.timers = timers;
    this.log = log;
    this.url = url;
    this.signal = signal;
    this.flags = clean(shipped);
    this.source = "shipped";
    this.timer = null;
    this.onChange = () => {};
  }

  async start() {
    try {
      const cached = await this.secrets.get(CACHE_KEY);
      if (cached) {
        this.flags = clean(JSON.parse(cached));
        this.source = "cache";
      }
    } catch {
      // A broken cache falls back to the shipped flags.
    }
    void this.refresh();
    this.timer = this.timers.setInterval(() => void this.refresh(), REFRESH_MS);
  }

  async refresh() {
    if (typeof this.fetchImpl !== "function") return;
    try {
      const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS), this.signal].filter(Boolean);
      const response = await this.fetchImpl(this.url, { signal: AbortSignal.any(signals), headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = clean(await response.json());
      const changed = next.chat.enabled !== this.flags.chat.enabled || next.chat.message !== this.flags.chat.message;
      this.flags = next;
      this.source = "remote";
      await this.secrets.set(CACHE_KEY, JSON.stringify(next));
      if (changed) this.onChange(next);
    } catch (error) {
      this.log.info(`Feature flags not refreshed (${describe(error)}); using the ${this.source} copy.`);
    }
  }

  get chat() {
    return this.flags.chat;
  }

  stop() {
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = null;
  }
}
