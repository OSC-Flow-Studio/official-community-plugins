// TikTok LIVE for OSC Flow Studio. Turns the events of a TikTok LIVE (gifts, battles,
// joins, follows, likes, chat and more) into Studio triggers, and gives flows actions and
// inputs about the stream.
//
// Unofficial: TikTok has no public API for LIVE events. The direct connection uses
// tiktok-live-connector (https://github.com/zerodytrash/TikTok-Live-Connector), bundled in
// vendor/ with its license; the alternative is the TikFinity app's local bridge. This
// plugin is not affiliated with TikTok, Euler Stream or TikFinity.
import { startRuntime } from "./runtime.mjs";

let activeRuntime = null;

export { startRuntime };

export default {
  async activate(ctx) {
    if (activeRuntime) throw new Error("TikTok LIVE is already running");
    const runtime = await startRuntime(ctx);
    activeRuntime = runtime;
    ctx.signal?.addEventListener("abort", () => void runtime.shutdown(), { once: true });
  },

  async deactivate() {
    const runtime = activeRuntime;
    activeRuntime = null;
    await runtime?.shutdown();
  },
};
