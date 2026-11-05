// The BETA chat sign-in. Sending chat needs the two TikTok session cookies of the account
// that will speak (sessionid and tt-target-idc). The plugin cannot read a browser's
// cookies, so "Chat: sign in" opens a page on this computer (127.0.0.1 only) that explains
// where to find them and saves what the person pastes straight into the Studio's encrypted
// vault. The values never reach the flow, the config file or the log.
//
// The page lives at a random path, accepts one save, and closes after ten minutes.
import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { renderSignInPage } from "./pages.mjs";

export const SIGN_IN_TTL_MS = 10 * 60 * 1000;
const MAX_BODY = 8 * 1024;
const COOKIE_VALUE = /^[A-Za-z0-9%._~+/=-]{8,512}$/;
const IDC_VALUE = /^[A-Za-z0-9_-]{2,64}$/;

export const SESSION_ID_KEY = "chat-session-id";
export const TARGET_IDC_KEY = "chat-tt-target-idc";

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

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
  return value.startsWith(`${name}=`) ? value.slice(name.length + 1) : "";
}

function sameToken(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class ChatSignIn {
  constructor({ secrets, timers, now = Date.now, log, onSaved }) {
    this.secrets = secrets;
    this.timers = timers;
    this.now = now;
    this.log = log;
    this.onSaved = onSaved;
    this.server = null;
    this.token = "";
    this.expiresAt = 0;
    this.timer = null;
    this.saved = false;
  }

  get open() {
    return Boolean(this.server);
  }

  get url() {
    if (!this.server) return "";
    return `http://127.0.0.1:${this.server.address().port}/${this.token}`;
  }

  async start() {
    await this.close();
    this.token = randomBytes(24).toString("base64url");
    this.expiresAt = this.now() + SIGN_IN_TTL_MS;
    this.saved = false;
    const server = http.createServer((request, response) => void this.handle(request, response));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    this.server = server;
    this.timer = this.timers.setTimeout(() => void this.close(), SIGN_IN_TTL_MS);
    return { url: this.url, expiresInSeconds: Math.round(SIGN_IN_TTL_MS / 1000) };
  }

  send(response, status, state, details = {}) {
    response.writeHead(status, HEADERS);
    response.end(renderSignInPage(state, { ...details, minutesLeft: Math.max(0, Math.ceil((this.expiresAt - this.now()) / 60_000)) }));
  }

  async handle(request, response) {
    const path = (request.url ?? "/").split("?")[0].slice(1);
    // Browsers ask for this on their own; it is not the page.
    if (path === "favicon.ico") {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (!this.token || !sameToken(path, this.token) || this.now() > this.expiresAt) {
      this.send(response, 410, "expired");
      return;
    }
    if (this.saved) {
      this.send(response, 200, "saved");
      return;
    }
    if (request.method === "GET") {
      this.send(response, 200, "form", { action: `/${this.token}` });
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "GET, POST" });
      response.end();
      return;
    }
    // A form posted from another site carries its own Origin; only this page may save.
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (origin && origin !== `http://${host}`) {
      this.send(response, 403, "error", { message: "This form only accepts answers from its own page." });
      return;
    }
    let body = "";
    try {
      body = await new Promise((resolve, reject) => {
        let text = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          text += chunk;
          if (text.length > MAX_BODY) reject(new Error("too large"));
        });
        request.on("end", () => resolve(text));
        request.on("error", reject);
      });
    } catch {
      this.send(response, 413, "error", { message: "That was more text than the two cookies need." });
      return;
    }
    const form = new URLSearchParams(body);
    const sessionId = extractCookie(form.get("sessionId"), "sessionid");
    const ttTargetIdc = extractCookie(form.get("ttTargetIdc"), "tt-target-idc");
    const problems = [];
    if (!COOKIE_VALUE.test(sessionId)) problems.push("sessionId");
    if (!IDC_VALUE.test(ttTargetIdc)) problems.push("ttTargetIdc");
    if (problems.length > 0) {
      this.send(response, 400, "form", { action: `/${this.token}`, invalid: problems });
      return;
    }
    try {
      await this.secrets.set(SESSION_ID_KEY, sessionId);
      await this.secrets.set(TARGET_IDC_KEY, ttTargetIdc);
    } catch (error) {
      this.send(response, 500, "error", { message: "The Studio could not save the cookies. Try again, or restart the Studio." });
      this.log.warn(`Chat sign-in could not save to the vault: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.saved = true;
    this.send(response, 200, "saved");
    this.log.info("Chat sign-in saved. Sending chat is available while chat is enabled.");
    this.onSaved?.();
    // Leave the page up briefly so a reload still shows the result, then close.
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => void this.close(), 60_000);
  }

  async close() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    const server = this.server;
    this.server = null;
    this.token = "";
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

export async function readChatSession(secrets) {
  const [sessionId, ttTargetIdc] = await Promise.all([secrets.get(SESSION_ID_KEY), secrets.get(TARGET_IDC_KEY)]);
  return sessionId && ttTargetIdc ? { sessionId, ttTargetIdc } : null;
}

export async function clearChatSession(secrets) {
  await Promise.all([secrets.delete(SESSION_ID_KEY), secrets.delete(TARGET_IDC_KEY)]);
}
