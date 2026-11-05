// Direct connection: the plugin talks to TikTok itself through the bundled
// tiktok-live-connector, with WebSocket URLs signed by Euler Stream.
//
// The loop connects, and when that fails it decides how long to wait:
// - the streamer is offline (or the stream just ended): check every offlinePollSeconds
//   whether they are live again, with an unsigned request that costs no Euler quota;
// - Euler Stream rate-limited the signature: wait what Euler asks, never less than 60 s;
// - anything else: back off from reconnectMinSeconds, doubling up to reconnectMaxSeconds.
import { describe } from "../util.mjs";

const RATE_LIMIT_FLOOR_MS = 60_000;
// Requests go out with one fixed English location so TikTok's texts (gift names, notice
// patterns) are the same on every computer. Matching never depends on them anyway.
const ENGLISH_LOCATION = { lang_country: "en-US", lang: "en", country: "US", tz_name: "America/New_York" };

const loadVendor = () => import("../vendor/tiktok-live-connector.mjs");

function offline(error) {
  return error?.constructor?.name === "UserOfflineError" || /isn't online|is not live|offline/i.test(describe(error));
}

function rateLimit(error) {
  if (error?.constructor?.name === "SignatureRateLimitError" || /rate limit|too many connections|429/i.test(describe(error))) {
    return Math.max(RATE_LIMIT_FLOOR_MS, Number(error?.retryAfter) || 0);
  }
  return 0;
}

function premium(error) {
  return error?.constructor?.name === "PremiumFeatureError" || /business plan|paid plan|requires an api key/i.test(describe(error));
}

/** A short, plain reason for the status line; never includes cookies or keys. */
export function explain(error) {
  if (offline(error)) return "The streamer is not live right now.";
  if (rateLimit(error)) return "Euler Stream rate limit reached. Add an Euler Stream API key to raise it.";
  if (premium(error)) return "This needs a paid Euler Stream plan.";
  const message = describe(error).replace(/\s+/g, " ").trim();
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

export class DirectSource {
  constructor({ uniqueId, signApiKey = "", processInitialData = false, session = null, reconnectMinMs, reconnectMaxMs, offlinePollMs, timers, log, load = loadVendor }) {
    this.uniqueId = uniqueId;
    this.signApiKey = signApiKey;
    this.processInitialData = processInitialData;
    this.session = session;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.offlinePollMs = offlinePollMs;
    this.timers = timers;
    this.log = log;
    this.load = load;
    this.transport = "direct";
    this.capabilities = { giftList: true, chat: true, isLive: true, roomInfo: true };
    this.handlers = { event: () => {}, state: () => {}, room: () => {} };
    this.connection = null;
    this.stopped = true;
    this.wake = null;
    this.timer = null;
    this.attempt = 0;
    this.backoffMs = reconnectMinMs;
    this.rateLimited = false;
  }

  onEvent(handler) { this.handlers.event = handler; }
  onState(handler) { this.handlers.state = handler; }
  onRoom(handler) { this.handlers.room = handler; }

  setState(state, reason = "") {
    this.handlers.state({ state, reason, attempt: this.attempt, rateLimited: this.rateLimited });
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    try {
      this.lib = await this.load();
    } catch (error) {
      this.stopped = true;
      this.setState("error", `The bundled TikTok client could not load: ${describe(error)}`);
      return;
    }
    this.loop = this.run();
  }

  /** Waits `ms`, or less when stop() or reconnectNow() is called. */
  sleep(ms) {
    return new Promise((resolve) => {
      this.wake = () => {
        this.timers.clearTimeout(this.timer);
        this.wake = null;
        resolve();
      };
      this.timer = this.timers.setTimeout(() => this.wake?.(), ms);
    });
  }

  reconnectNow() {
    this.backoffMs = this.reconnectMinMs;
    this.wake?.();
  }

  createConnection() {
    const lib = this.lib;
    // The Euler client is a cached global inside the library; reset it so a changed key applies.
    lib.SignConfig.apiKey = this.signApiKey || undefined;
    lib.SignConfig.cachedInstance = undefined;
    const presets = lib.getRandomPresets();
    const connection = new lib.TikTokLiveConnection(this.uniqueId, {
      processInitialData: this.processInitialData,
      fetchRoomInfoOnConnect: true,
      // The gift list is a paid Euler feature; gifts are learned as they arrive instead.
      enableExtendedGiftInfo: false,
      clientPresets: { ...presets, location: ENGLISH_LOCATION },
      ...(this.session ? { session: this.session } : {}),
    });
    connection.on("decodedData", (method, decoded) => {
      if (this.connection !== connection || !decoded?.type) return;
      try {
        this.handlers.event({ transport: "direct", format: "proto", type: decoded.type, data: decoded.data });
      } catch (error) {
        this.log.warn(`Could not handle a ${decoded.type}: ${describe(error)}`);
      }
    });
    connection.on("streamEnd", () => {
      if (this.connection === connection) this.streamEnded = true;
    });
    connection.on("error", (error) => {
      if (this.connection !== connection) return;
      const message = explain(error?.exception ?? error);
      if (message && message !== this.lastLoggedError) {
        this.lastLoggedError = message;
        this.log.warn(`TikTok: ${error?.info ? `${error.info}: ` : ""}${message}`);
      }
    });
    return connection;
  }

  async run() {
    while (!this.stopped) {
      this.streamEnded = false;
      this.setState("connecting");
      const connection = this.createConnection();
      this.connection = connection;
      let waitMs = 0;
      try {
        const closed = new Promise((resolve) => connection.once("disconnected", resolve));
        await connection.connect();
        if (this.stopped) break;
        this.attempt = 0;
        this.backoffMs = this.reconnectMinMs;
        this.rateLimited = false;
        this.lastLoggedError = "";
        this.setState("connected");
        void this.readRoom(connection);
        await Promise.race([closed, new Promise((resolve) => { this.closeWaiter = resolve; })]);
        if (this.stopped) break;
        if (this.streamEnded) {
          this.setState("waiting", "The stream ended. Waiting for the next one.");
          await this.waitUntilLive(connection);
          continue;
        }
        this.setState("disconnected", "The connection to TikTok dropped.");
        waitMs = this.backoffMs;
      } catch (error) {
        if (this.stopped) break;
        if (offline(error)) {
          this.setState("waiting", "Waiting for the streamer to go live.");
          await this.waitUntilLive(connection);
          continue;
        }
        const limited = rateLimit(error);
        this.rateLimited = limited > 0;
        waitMs = limited > 0 ? Math.max(limited, this.backoffMs) : this.backoffMs;
        this.setState("error", explain(error));
      } finally {
        this.closeWaiter = null;
        if (this.connection === connection) this.connection = null;
        connection.removeAllListeners?.();
        try {
          await connection.disconnect();
        } catch {
          // Already closed.
        }
      }
      if (this.stopped) break;
      this.attempt += 1;
      await this.sleep(waitMs);
      this.backoffMs = Math.min(this.reconnectMaxMs, this.backoffMs * 2);
    }
  }

  async readRoom(connection) {
    try {
      const info = await connection.fetchRoomInfo();
      const data = info?.data ?? {};
      if (this.connection !== connection) return;
      this.handlers.room({
        roomId: String(connection.roomId ?? data.id_str ?? ""),
        hostUserId: String(data.owner?.id_str ?? data.owner?.id ?? ""),
        hostUniqueId: String(data.owner?.display_id ?? this.uniqueId),
        title: String(data.title ?? ""),
        startedAt: Number(data.create_time ?? 0) * 1000,
        isLive: Number(data.status) === 2,
      });
    } catch (error) {
      this.log.info(`Room details are not available: ${explain(error)}`);
    }
  }

  async waitUntilLive(connection) {
    while (!this.stopped) {
      await this.sleep(this.offlinePollMs);
      if (this.stopped) return;
      try {
        if (await connection.fetchIsLive()) return;
      } catch (error) {
        this.log.info(`Could not check whether @${this.uniqueId} is live: ${explain(error)}`);
      }
    }
  }

  async fetchIsLive() {
    const connection = this.connection ?? this.createConnection();
    return Boolean(await connection.fetchIsLive());
  }

  /** The room's gift list. Needs an Euler Stream Business key; throws otherwise. */
  async fetchGifts() {
    if (!this.connection) throw new Error("Not connected to a LIVE right now.");
    return this.connection.fetchAvailableGifts();
  }

  /**
   * Sends one chat message as the signed-in account. A separate client carries the session
   * cookies, so the connection that reads the LIVE stays anonymous.
   */
  async sendChat(content, session) {
    const roomId = this.connection?.roomId;
    if (!roomId) throw new Error("Not connected to a LIVE right now.");
    if (!session?.sessionId || !session?.ttTargetIdc) throw new Error("Chat is not signed in.");
    const lib = this.lib;
    lib.SignConfig.apiKey = this.signApiKey || undefined;
    lib.SignConfig.cachedInstance = undefined;
    const sender = new lib.TikTokLiveConnection(this.uniqueId, {
      fetchRoomInfoOnConnect: false,
      clientPresets: { ...lib.getRandomPresets(), location: ENGLISH_LOCATION },
      session: { cookie: { type: "cookie", value: { sessionId: session.sessionId, ttTargetIdc: session.ttTargetIdc } } },
    });
    return sender.sendMessage(content, roomId);
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.wake?.();
    this.closeWaiter?.();
    const connection = this.connection;
    this.connection = null;
    try {
      await connection?.disconnect();
    } catch {
      // Already closed.
    }
    await this.loop?.catch(() => {});
  }
}
