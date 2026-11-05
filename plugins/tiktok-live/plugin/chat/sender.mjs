// Sending chat (BETA). TikTok has no API for it, so the message goes through Euler Stream,
// a separate paid service, as the TikTok account whose session cookies are in the plugin
// settings. Each send builds its own short-lived client, so the connection that reads the
// LIVE stays anonymous and does not have to be up: when it is not, the sender asks TikTok
// whether the streamer is live and which room to post in.
import { ENGLISH_LOCATION } from "../sources/direct.mjs";

const loadVendor = () => import("../vendor/tiktok-live-connector.mjs");

export const SESSION_ID_PATTERN = /^[A-Za-z0-9%._~+/=-]{8,512}$/;
export const TARGET_IDC_PATTERN = /^[A-Za-z0-9_-]{2,64}$/;

/** Accepts the cookie as pasted: the bare value, `name=value`, or a whole Cookie header. */
export function extractCookie(raw, name) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  const looksLikeCookies = value.includes(";") || value.startsWith(`${name}=`);
  if (!looksLikeCookies) return value.replace(/^"|"$/g, "");
  for (const part of value.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=").trim().replace(/^"|"$/g, "");
  }
  return "";
}

export class NotLiveError extends Error {
  constructor(uniqueId) {
    super(`@${uniqueId} is not live right now. Chat can only be sent during a LIVE.`);
    this.name = "NotLiveError";
  }
}

export class ChatSender {
  constructor({ load = loadVendor } = {}) {
    this.load = load;
  }

  /**
   * Posts `message` in the LIVE of `uniqueId`. `roomId` is the room the plugin is connected
   * to, or empty; then the sender looks the room up itself. Throws when it fails.
   */
  async send({ uniqueId, apiKey, sessionId, ttTargetIdc, message, roomId = "" }) {
    const lib = await this.load();
    // The Euler client is a cached global inside the library; reset it so the key applies.
    lib.SignConfig.apiKey = apiKey || undefined;
    lib.SignConfig.cachedInstance = undefined;
    const client = new lib.TikTokLiveConnection(uniqueId, {
      fetchRoomInfoOnConnect: false,
      clientPresets: { ...lib.getRandomPresets(), location: ENGLISH_LOCATION },
      session: { cookie: { type: "cookie", value: { sessionId, ttTargetIdc } } },
    });
    let room = roomId;
    if (!room) {
      if (!(await client.fetchIsLive())) throw new NotLiveError(uniqueId);
      room = String((await client.fetchRoomId()) ?? "");
    }
    await client.sendMessage(message, room);
    return { roomId: room };
  }
}
