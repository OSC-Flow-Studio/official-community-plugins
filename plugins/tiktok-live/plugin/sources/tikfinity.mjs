// TikFinity bridge: the TikFinity desktop app keeps its own connection to TikTok and
// relays every event over a local WebSocket. The plugin only listens, so it needs no
// Euler Stream quota and keeps working if the bundled TikTok client breaks. TikFinity
// must run on the same computer and be connected to the LIVE.
//
// Messages are JSON `{ "event": "<name>", "data": { ... } }` with the event names and
// fields of tiktok-live-connector 1.x.
import { describe } from "../util.mjs";

const MIN_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30_000;

export class TikfinitySource {
  constructor({ url, timers, log, WebSocketImpl = globalThis.WebSocket }) {
    this.url = url;
    this.timers = timers;
    this.log = log;
    this.WebSocketImpl = WebSocketImpl;
    this.transport = "tikfinity";
    this.capabilities = { giftList: false, chat: false, isLive: false, roomInfo: false };
    this.handlers = { event: () => {}, state: () => {}, room: () => {} };
    this.socket = null;
    this.stopped = true;
    this.timer = null;
    this.attempt = 0;
    this.backoffMs = MIN_BACKOFF_MS;
    this.warned = "";
  }

  onEvent(handler) { this.handlers.event = handler; }
  onState(handler) { this.handlers.state = handler; }
  onRoom(handler) { this.handlers.room = handler; }

  setState(state, reason = "") {
    this.handlers.state({ state, reason, attempt: this.attempt, rateLimited: false });
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    if (typeof this.WebSocketImpl !== "function") {
      this.setState("error", "This runtime has no WebSocket client.");
      return;
    }
    this.open();
  }

  open() {
    if (this.stopped) return;
    this.setState("connecting");
    let socket;
    try {
      socket = new this.WebSocketImpl(this.url);
    } catch (error) {
      this.retry(`The TikFinity address is not valid: ${describe(error)}`);
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.backoffMs = MIN_BACKOFF_MS;
      this.warned = "";
      this.setState("connected");
    });
    socket.addEventListener("message", (message) => {
      if (this.socket !== socket) return;
      this.receive(message.data);
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.retry("TikFinity is not reachable. Open TikFinity on this computer and connect it to your LIVE.");
    });
    socket.addEventListener("error", () => {
      // A close event always follows, and it schedules the retry.
    });
  }

  receive(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    } catch {
      return;
    }
    if (!message || typeof message.event !== "string") return;
    try {
      this.handlers.event({ transport: "tikfinity", format: "tikfinity", type: message.event, data: message.data ?? {} });
    } catch (error) {
      this.log.warn(`Could not handle a TikFinity ${message.event} event: ${describe(error)}`);
    }
  }

  retry(reason) {
    if (this.stopped) return;
    if (reason !== this.warned) {
      this.warned = reason;
      this.log.info(reason);
    }
    this.setState("disconnected", reason);
    this.attempt += 1;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.open();
    }, wait);
  }

  reconnectNow() {
    if (this.stopped || this.socket) return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.backoffMs = MIN_BACKOFF_MS;
    this.open();
  }

  async fetchIsLive() {
    throw new Error("The TikFinity bridge cannot check whether a stream is live.");
  }

  async fetchGifts() {
    throw new Error("The TikFinity bridge has no gift list; gifts are learned as they arrive.");
  }

  async sendChat() {
    throw new Error("Sending chat is not available through the TikFinity bridge.");
  }

  async stop() {
    this.stopped = true;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      // Already closed.
    }
  }
}
