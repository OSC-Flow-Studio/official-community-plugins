/**
 * LivePix for OSC Flow Studio.
 *
 * Donations come from the OSC LivePix Dashboard, which receives the LivePix
 * webhook, reads each donation from the LivePix API and keeps every one of
 * them. The plugin holds one WebSocket to the dashboard for real-time delivery
 * and reads the dashboard API when the socket is down, after every reconnect
 * and every few minutes as a safety net.
 *
 * Both paths share a persistent ID ledger. Re-enabling reconciles from the
 * selected start without forgetting IDs from previous runs or date selections.
 * Trigger delivery has no consumer acknowledgment, so downstream accounting
 * also uses the stable donation key.
 */

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { loadIdLedger } from "./id-ledger.mjs";

const STATE_KEY = "livepix-state-v1";
const STATE_VERSION = 4;
const DEFAULT_BASE_URL = "https://livepix.maned.club";
const PAGE_LIMIT = 500;
const REQUEST_TIMEOUT_MS = 10_000;
/** While the socket is up, a full read from the subathon start still runs this often. */
const RECONCILE_MS = 5 * 60_000;
/** The dashboard sends a heartbeat every 25 s; this much silence means the socket is dead. */
const SOCKET_SILENCE_MS = 70_000;
const MAX_RECONNECT_MS = 60_000;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

let activeRuntime = null;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function asNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function asText(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asSecret(value) {
  return typeof value === "string" && value !== "***" ? value.trim() : "";
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the subathon start typed by the user, in the machine's local time.
 * Accepts `2026-09-21 18:00`, `2026-09-21T18:00`, `21/09/2026 18:00`, a date
 * alone (midnight) or a full ISO timestamp. Returns NaN when it cannot.
 */
export function parseStartAt(raw) {
  const text = (typeof raw === "string" ? raw.trim() : "")
    .replace(/^(\d{2})\/(\d{2})\/(\d{4})(.*)$/, "$3-$2-$1$4");
  if (!text) return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(text);
  if (!match) return NaN;
  const [, y, m, d, h = "0", min = "0", sec = "0", fraction = "", zone] = match;
  const [year, month, day, hour, minute, second] = [y, m, d, h, min, sec].map(Number);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return NaN;
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return NaN;
  if (zone) return Date.parse(text.replace(" ", "T"));
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second, Number(fraction || 0) * 1000);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour) return NaN;
  return date.getTime();
}

/** `olp_<webhookId>_<secret>`: the token names the webhook it opens. */
export function webhookIdFromToken(token) {
  const match = /^olp_([A-Za-z0-9]{8,64})_[A-Za-z0-9_-]+$/.exec(token);
  return match ? match[1] : "";
}

function normalizeBaseUrl(raw) {
  const text = asText(raw, DEFAULT_BASE_URL).replace(/\/+$/, "");
  let url;
  try {
    url = new URL(text);
  } catch {
    return { value: "", error: "URL base inválida: " + text };
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return { value: "", error: "A URL base precisa usar https:// (http só é aceito para localhost)." };
  }
  return { value: url.origin + url.pathname.replace(/\/+$/, ""), error: "" };
}

function normalizeConfig(raw) {
  const base = normalizeBaseUrl(raw.baseUrl);
  const apiToken = asSecret(raw.apiToken);
  const startAtText = asText(raw.startAt, "");
  return {
    enabled: raw.enabled !== false,
    baseUrl: base.value,
    baseUrlError: base.error,
    apiToken,
    webhookId: webhookIdFromToken(apiToken),
    startAtText,
    startAtMs: startAtText ? parseStartAt(startAtText) : NaN,
    pollSeconds: Math.round(asNumber(raw.pollSeconds, 10, 2, 300)),
    currency: asText(raw.currency, "BRL").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10) || "BRL",
  };
}

/** Why the plugin cannot run with this configuration, or "" when it can. */
function configProblem(config) {
  if (config.baseUrlError) return config.baseUrlError;
  if (!config.apiToken) return "Informe o token gerado no OSC LivePix Dashboard.";
  if (!config.webhookId) return "O token não tem o formato do OSC LivePix Dashboard. Copie-o de novo.";
  if (config.startAtText && Number.isNaN(config.startAtMs)) {
    return "Início do subathon inválido. Use AAAA-MM-DD HH:mm ou DD/MM/AAAA HH:mm.";
  }
  return "";
}

// ---------------------------------------------------------------------------
// Persisted state: which donations already fired
// ---------------------------------------------------------------------------

function initialState() {
  return { version: STATE_VERSION, processed: [], autoStartAt: 0, lastSeq: "0", lastSyncAt: "" };
}

function hydrateState(raw, log) {
  if (!raw) return initialState();
  try {
    const parsed = JSON.parse(raw);
    const next = initialState();
    if (Number(parsed.version) === 2) {
      // 1.2.0 kept `livepix:<proof>` keys from its own polling. The dashboard delivers the
      // same proof as the donation id, so those donations stay counted after the update.
      const now = Date.now();
      next.processed = (Array.isArray(parsed.seen) ? parsed.seen : [])
        .filter((key) => typeof key === "string" && key.startsWith("livepix:"))
        .map((key) => [key.slice("livepix:".length), now]);
      log.info(String(next.processed.length) + " doação(ões) da versão anterior mantidas como já processadas");
      return next;
    }
    if (![3, STATE_VERSION].includes(Number(parsed.version))) throw new Error("Unsupported persisted LivePix state version");
    if (Number(parsed.version) === STATE_VERSION && !parsed.idLedger) throw new Error("Missing persisted LivePix ID ledger");
    next.idLedger = parsed.idLedger;
    next.processed = Array.isArray(parsed.processed)
      ? parsed.processed.filter((entry) => Array.isArray(entry) && typeof entry[0] === "string" && Number.isFinite(entry[1]))
      : [];
    next.autoStartAt = Number.isFinite(parsed.autoStartAt) ? parsed.autoStartAt : 0;
    next.lastSeq = typeof parsed.lastSeq === "string" && /^\d+$/.test(parsed.lastSeq) ? parsed.lastSeq : "0";
    next.lastSyncAt = typeof parsed.lastSyncAt === "string" ? parsed.lastSyncAt : "";
    return next;
  } catch (error) {
    throw new Error("Cannot restore LivePix state: " + describe(error));
  }
}

async function persist(runtime) {
  try {
    await runtime.ctx.secrets.set(STATE_KEY, JSON.stringify(runtime.state));
  } catch (error) {
    runtime.ctx.log.warn("não foi possível persistir o estado: " + describe(error));
    throw error;
  }
}

/** The subathon start in effect: the configured one, else the first activation without one. */
function startAtMs(runtime) {
  return Number.isFinite(runtime.config.startAtMs) ? runtime.config.startAtMs : runtime.state.autoStartAt;
}

// ---------------------------------------------------------------------------
// Donations
// ---------------------------------------------------------------------------

function formatAmount(cents, currency) {
  const value = cents / 100;
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(value);
  } catch {
    return value.toFixed(2) + " " + currency;
  }
}

function buildPayload(donation) {
  const amount = Math.round(Number(donation.amount));
  const currency = asText(donation.currency, "BRL");
  const username = asText(donation.username, "");
  const message = asText(donation.message, "");
  return {
    amount,
    amountFormatted: formatAmount(amount, currency),
    currency,
    username,
    message,
    hasMessage: message.length > 0,
    flagged: donation.flagged === true,
    id: asText(donation.livepixId, ""),
    proof: asText(donation.proof, ""),
    reference: asText(donation.reference, ""),
    createdAt: asText(donation.occurredAt, new Date().toISOString()),
    eventKey: "livepix:donation:" + donation.id,
    actorId: username,
    actorDisplayName: username,
  };
}

function seqAbove(a, b) {
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return false;
  }
}

/**
 * Takes donations from either path. Each new one is marked as processed and the
 * ledger is written to the vault before any trigger fires.
 */
function accept(runtime, donations, replay = false, requestId = "") {
  const work = queueMutation(runtime, () => acceptNow(runtime, donations, replay, requestId));
  runtime.inFlight.add(work);
  return work.finally(() => runtime.inFlight.delete(work));
}

function queueMutation(runtime, callback) {
  const work = runtime.queue.then(callback);
  runtime.queue = work.catch(() => {});
  return work;
}

async function acceptNow(runtime, donations, replay, requestId) {
  if (runtime.stopped) return 0;
  if (requestId && runtime.replayRequests.has(requestId)) return 0;
  const start = startAtMs(runtime);
  const fresh = [];
  const addedIds = new Set();
  const previousSeq = runtime.state.lastSeq;
  const previousLedger = runtime.state.idLedger;
  for (const donation of donations) {
    if (!donation || typeof donation !== "object" || typeof donation.id !== "string" || !donation.id) continue;
    if (typeof donation.seq === "string" && seqAbove(donation.seq, runtime.state.lastSeq)) {
      runtime.state.lastSeq = donation.seq;
    }
    if ((!replay && runtime.processed.has(donation.id)) || addedIds.has(donation.id)) continue;
    const at = Date.parse(donation.occurredAt);
    if (!Number.isFinite(at) || at < start) continue;
    addedIds.add(donation.id);
    const amount = Number(donation.amount);
    const currency = String(donation.currency || "").toUpperCase();
    if (!(amount > 0) || currency !== runtime.config.currency) continue;
    fresh.push({ donation, at });
  }
  if (addedIds.size === 0 && previousSeq === runtime.state.lastSeq) return 0;
  try {
    runtime.state.idLedger = await runtime.idLedger.prepare(addedIds);
    await persist(runtime);
  } catch (error) {
    runtime.state.idLedger = previousLedger;
    runtime.state.lastSeq = previousSeq;
    throw error;
  }
  if (runtime.stopped) {
    // Deactivated between the write and the triggers: forget them again, so the final
    // write in deactivate() leaves them unprocessed and the next activation fires them.
    runtime.state.idLedger = previousLedger;
    runtime.state.lastSeq = previousSeq;
    return 0;
  }
  runtime.idLedger.commit(runtime.state.idLedger, addedIds);
  if (requestId) rememberReplay(runtime, requestId);
  fresh.sort((a, b) => a.at - b.at);
  for (const { donation } of fresh) {
    runtime.ctx.emitTrigger("donation", buildPayload(donation));
    runtime.emittedSinceStart += 1;
  }
  return fresh.length;
}

// ---------------------------------------------------------------------------
// Dashboard API (fallback and reconciliation)
// ---------------------------------------------------------------------------

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

function authHeaders(runtime) {
  return { authorization: "Bearer " + runtime.config.apiToken, accept: "application/json" };
}

async function fetchPage(runtime, since, after) {
  const url = new URL(runtime.config.baseUrl + "/" + runtime.config.webhookId + "/api/donations");
  url.searchParams.set("since", since);
  url.searchParams.set("limit", String(PAGE_LIMIT));
  if (after && after !== "0") url.searchParams.set("after", after);
  const response = await fetch(url, {
    headers: authHeaders(runtime),
    signal: AbortSignal.any([runtime.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  if (response.status === 401) throw new AuthError("Token recusado pelo dashboard. Gere outro e cole no plugin.");
  if (response.status === 403) throw new AuthError("O webhook está inativo no OSC LivePix Dashboard.");
  if (!response.ok) throw new Error("OSC LivePix Dashboard respondeu HTTP " + String(response.status));
  const payload = await response.json();
  runtime.controller.signal.throwIfAborted();
  return {
    donations: Array.isArray(payload && payload.donations) ? payload.donations : [],
    nextAfter: typeof payload?.nextAfter === "string" ? payload.nextAfter : after,
    hasMore: payload?.hasMore === true,
  };
}

/**
 * Reads the dashboard. `full` walks every donation since the subathon start and
 * is what makes a restart or a long outage safe; otherwise it continues after
 * the last sequence number seen.
 */
function sync(runtime, reason, full) {
  if (runtime.stopped || !runtime.config.enabled) {
    return Promise.resolve({ ok: false, fetched: 0, emitted: 0, error: "plugin desativado" });
  }
  if (runtime.syncPromise) {
    if (full) runtime.fullSyncQueued = true;
    return runtime.syncPromise;
  }
  runtime.syncPromise = runSync(runtime, reason, full).finally(() => {
    runtime.syncPromise = null;
    if (runtime.fullSyncQueued && !runtime.stopped) {
      runtime.fullSyncQueued = false;
      void sync(runtime, reason, true);
    }
  });
  return runtime.syncPromise;
}

async function runSync(runtime, reason, full, replay = false) {
  let fetched = 0;
  let emitted = 0;
  try {
    const since = new Date(startAtMs(runtime)).toISOString();
    let after = full ? "0" : runtime.state.lastSeq;
    while (!runtime.stopped) {
      const result = await fetchPage(runtime, since, after);
      fetched += result.donations.length;
      emitted += await accept(runtime, result.donations, replay);
      if (!result.hasMore) break;
      if (!seqAbove(result.nextAfter, after)) throw new Error("Dashboard pagination did not advance");
      after = result.nextAfter;
    }
    runtime.controller.signal.throwIfAborted();
    await queueMutation(runtime, async () => {
      runtime.state.lastSyncAt = new Date().toISOString();
      await persist(runtime);
    });
    if (full) runtime.lastFullSyncAt = Date.now();
    runtime.apiError = "";
    runtime.lastSyncOk = true;
    if (emitted > 0) runtime.ctx.log.info(String(emitted) + " gatilho(s) disparado(s) pela API (" + reason + ")");
    publishStatus(runtime);
    return { ok: true, fetched, emitted, error: "" };
  } catch (error) {
    if (runtime.stopped) return { ok: false, fetched, emitted, error: "consulta cancelada" };
    runtime.apiError = describe(error);
    runtime.lastSyncOk = false;
    runtime.ctx.log.warn("consulta ao dashboard falhou: " + runtime.apiError);
    publishStatus(runtime);
    return { ok: false, fetched, emitted, error: runtime.apiError };
  }
}

function rememberReplay(runtime, requestId) {
  runtime.replayRequests.add(requestId);
  if (runtime.replayRequests.size > 1000) runtime.replayRequests.delete(runtime.replayRequests.values().next().value);
}

/** Explicit recovery retries delivery. The downstream ledger decides whether it was accounted. */
function recover(runtime) {
  const problem = configProblem(runtime.config);
  if (runtime.stopped || !runtime.config.enabled || problem) {
    return Promise.resolve({ ok: false, fetched: 0, emitted: 0, error: problem || "plugin desativado" });
  }
  if (!runtime.recoveryPromise) {
    runtime.recoveryPromise = (async () => {
      await runtime.syncPromise;
      return runSync(runtime, "recuperação manual", true, true);
    })().finally(() => { runtime.recoveryPromise = null; });
  }
  return runtime.recoveryPromise;
}

async function confirmAccounted(runtime, data) {
  const eventKey = asText(data.eventKey, "");
  const problem = configProblem(runtime.config);
  if (problem || runtime.stopped || !runtime.config.enabled) return { ok: false, error: problem || "plugin desativado" };
  if (data.accounted !== true) return { ok: false, error: "A contabilização não foi confirmada pelo bloco anterior." };
  if (!eventKey.startsWith("livepix:donation:") || eventKey.length <= "livepix:donation:".length) return { ok: false, error: "Chave de doação inválida." };
  try {
    const response = await fetch(runtime.config.baseUrl + "/" + runtime.config.webhookId + "/api/accounted", {
      method: "POST", headers: { ...authHeaders(runtime), "content-type": "application/json" }, body: JSON.stringify({ eventKey }),
      signal: AbortSignal.any([runtime.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error("OSC LivePix Dashboard respondeu HTTP " + response.status);
    const result = await response.json();
    if (result?.ok !== true) throw new Error("Invalid accounting receipt response");
    return { ok: true, error: "" };
  } catch (error) { return { ok: false, error: describe(error) }; }
}

function scheduleSync(runtime, delayMs) {
  if (runtime.stopped) return;
  if (runtime.syncTimer) clearTimeout(runtime.syncTimer);
  const delay = delayMs ?? (runtime.socketOpen ? RECONCILE_MS : runtime.config.pollSeconds * 1000);
  runtime.syncTimer = setTimeout(() => {
    runtime.syncTimer = null;
    // Between full passes only what came after the cursor is read. A full pass from the
    // subathon start runs every few minutes whatever the transport, and catches anything the
    // cursor could have stepped over.
    const full = Date.now() - runtime.lastFullSyncAt >= RECONCILE_MS;
    void sync(runtime, runtime.socketOpen ? "verificação periódica" : "fallback", full)
      .finally(() => scheduleSync(runtime));
  }, delay);
}

// ---------------------------------------------------------------------------
// WebSocket (RFC 6455 client over node:http, since Node 20 has no global WebSocket)
// ---------------------------------------------------------------------------

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? "", "utf8");
  const mask = randomBytes(4);
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | data.length;
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/**
 * Opens a client socket. Calls `onMessage(text)` per text message and `onClose(code, reason)`
 * exactly once, whether the handshake failed (401 → 4001, 403 → 4003, else 1006) or the
 * connection ended.
 */
export function connectWebSocket(target, headers, { onOpen, onMessage, onClose }) {
  const url = new URL(target);
  const secure = url.protocol === "wss:" || url.protocol === "https:";
  const key = randomBytes(16).toString("base64");
  let socket = null;
  let closed = false;
  let buffer = Buffer.alloc(0);
  let fragments = [];

  function finish(code, reason) {
    if (closed) return;
    closed = true;
    try {
      socket?.destroy();
    } catch {
      // Already gone.
    }
    onClose(code, reason);
  }

  const request = (secure ? https : http).request({
    hostname: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port || (secure ? 443 : 80),
    path: url.pathname + url.search,
    headers: {
      ...headers,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": key,
    },
    timeout: REQUEST_TIMEOUT_MS,
  });
  request.on("timeout", () => request.destroy(new Error("tempo esgotado ao conectar")));
  request.on("error", (error) => finish(1006, describe(error)));
  request.on("response", (response) => {
    response.resume();
    const status = response.statusCode ?? 0;
    finish(status === 401 ? 4001 : status === 403 ? 4003 : 1006, "HTTP " + String(status));
  });
  request.on("upgrade", (response, upgraded, head) => {
    if (closed) { upgraded.destroy(); return; }
    socket = upgraded;
    const expected = createHash("sha1").update(key + WS_GUID).digest("base64");
    if (response.headers["sec-websocket-accept"] !== expected) {
      finish(1006, "handshake inválido");
      return;
    }
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      parse();
    });
    socket.on("close", () => finish(1006, "conexão encerrada"));
    socket.on("error", (error) => finish(1006, describe(error)));
    onOpen?.();
    if (head && head.length > 0) {
      buffer = Buffer.concat([buffer, head]);
      parse();
    }
  });
  request.end();

  function parse() {
    while (!closed && buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      // Servers never mask; a masked frame is a protocol error, but the length math still holds.
      const masked = (buffer[1] & 0x80) !== 0;
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
      }
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.subarray(2).toString("utf8");
        try {
          socket.write(encodeFrame(0x8, payload.subarray(0, 2)));
        } catch {
          // The peer may already be gone.
        }
        finish(code, reason);
        return;
      }
      if (opcode === 0x9) {
        socket.write(encodeFrame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(fragments).toString("utf8");
          fragments = [];
          onMessage(text);
        }
      }
    }
  }

  return {
    send(text) {
      if (!closed && socket) socket.write(encodeFrame(0x1, text));
    },
    close(code = 1000) {
      if (closed) return;
      if (socket) {
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(code, 0);
        try {
          socket.write(encodeFrame(0x8, payload));
        } catch {
          // Closing anyway.
        }
      } else {
        request.destroy();
      }
      finish(code, "encerrado pelo plugin");
    },
  };
}

function websocketUrl(runtime) {
  return runtime.config.baseUrl.replace(/^http/, "ws") + "/" + runtime.config.webhookId + "/websocket";
}

function openSocket(runtime) {
  if (runtime.stopped || runtime.socket) return;
  runtime.socket = connectWebSocket(websocketUrl(runtime), { authorization: "Bearer " + runtime.config.apiToken }, {
    onOpen() {
      if (runtime.stopped) return;
      runtime.socketOpen = true;
      runtime.reconnectMs = 0;
      runtime.socketError = "";
      armSilenceTimer(runtime);
      publishStatus(runtime);
      // Whatever arrived while the socket was down is read now, from the subathon start.
      void sync(runtime, "reconexão", true).finally(() => scheduleSync(runtime));
    },
    onMessage(text) {
      if (runtime.stopped) return;
      armSilenceTimer(runtime);
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message?.type === "donations.recover" && typeof message.requestId === "string" && message.requestId) {
        if (runtime.replayRequests.has(message.requestId)) return;
        rememberReplay(runtime, message.requestId);
        void recover(runtime);
      }
      if (message && ["donation", "donation.replay"].includes(message.type) && message.donation) {
        const replay = message.type === "donation.replay";
        if (replay && (typeof message.requestId !== "string" || !message.requestId)) return;
        void accept(runtime, [message.donation], replay, replay ? message.requestId : "").then((emitted) => {
          if (emitted > 0) runtime.ctx.log.info("doação recebida em tempo real");
          publishStatus(runtime);
        }).catch((error) => {
          if (runtime.stopped) return;
          runtime.apiError = describe(error);
          runtime.lastSyncOk = false;
          runtime.lastFullSyncAt = 0;
          runtime.ctx.log.warn("Donation could not be saved: " + runtime.apiError);
          publishStatus(runtime);
          scheduleSync(runtime, runtime.config.pollSeconds * 1000);
        });
      }
    },
    onClose(code, reason) {
      const wasOpen = runtime.socketOpen;
      runtime.socket = null;
      runtime.socketOpen = false;
      if (runtime.silenceTimer) clearTimeout(runtime.silenceTimer);
      runtime.silenceTimer = null;
      if (runtime.stopped) return;
      runtime.socketError = code === 4001
        ? "token recusado"
        : code === 4003
          ? "webhook inativo"
          : code === 4004
            ? "webhook removido"
            : reason;
      if (wasOpen) runtime.ctx.log.warn("WebSocket desconectado (" + runtime.socketError + "); usando a API até reconectar");
      publishStatus(runtime);
      // The API takes over at the configured interval until the socket is back.
      scheduleSync(runtime, runtime.config.pollSeconds * 1000);
      const auth = code === 4001 || code === 4003 || code === 4004;
      runtime.reconnectMs = auth
        ? MAX_RECONNECT_MS
        : Math.min(MAX_RECONNECT_MS, Math.max(1000, runtime.reconnectMs * 2));
      runtime.reconnectTimer = setTimeout(() => {
        runtime.reconnectTimer = null;
        openSocket(runtime);
      }, runtime.reconnectMs);
    },
  });
}

function armSilenceTimer(runtime) {
  if (runtime.silenceTimer) clearTimeout(runtime.silenceTimer);
  runtime.silenceTimer = setTimeout(() => {
    runtime.silenceTimer = null;
    runtime.socket?.close(4000);
  }, SOCKET_SILENCE_MS);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function clock(iso) {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";
}

function transport(runtime) {
  if (runtime.socketOpen) return "websocket";
  if (runtime.lastSyncOk) return "polling";
  return "offline";
}

function publishStatus(runtime) {
  if (runtime.stopped) return;
  const problem = configProblem(runtime.config);
  if (problem) {
    runtime.ctx.setStatus({ health: "degraded", connectionState: "aguardando configuração", errors: [problem] });
    return;
  }
  const mode = transport(runtime);
  if (runtime.apiError) {
    runtime.ctx.setStatus({ health: "degraded", connectionState: "com erro",
      errors: [runtime.apiError, runtime.socketError && "WebSocket: " + runtime.socketError].filter(Boolean) });
    return;
  }
  if (mode === "websocket") {
    runtime.ctx.setStatus({ health: "healthy", connectionState: "tempo real (WebSocket)" });
    return;
  }
  if (mode === "polling") {
    const at = clock(runtime.state.lastSyncAt);
    runtime.ctx.setStatus({
      health: "degraded",
      connectionState: "consultando a API a cada " + String(runtime.config.pollSeconds) + " s" + (at ? "; última " + at : ""),
      errors: ["WebSocket indisponível" + (runtime.socketError ? " (" + runtime.socketError + ")" : "")],
    });
    return;
  }
  const errors = [runtime.apiError, runtime.socketError && "WebSocket: " + runtime.socketError].filter(Boolean);
  runtime.ctx.setStatus({
    health: errors.length > 0 ? "degraded" : "unknown",
    connectionState: errors.length > 0 ? "com erro" : "conectando",
    ...(errors.length > 0 ? { errors } : {}),
  });
}

function statusSnapshot(runtime) {
  return {
    connected: runtime.socketOpen || runtime.lastSyncOk,
    transport: transport(runtime),
    lastPollAt: runtime.state.lastSyncAt,
    lastError: runtime.apiError || runtime.socketError,
    seen: runtime.processed.size,
    emittedSinceStart: runtime.emittedSinceStart,
    startAt: new Date(startAtMs(runtime)).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function stopRuntime(runtime) {
  runtime.stopped = true;
  runtime.socketOpen = false;
  for (const timer of ["syncTimer", "reconnectTimer", "silenceTimer"]) {
    if (runtime[timer]) clearTimeout(runtime[timer]);
    runtime[timer] = null;
  }
  runtime.socket?.close(1001);
  runtime.socket = null;
  runtime.controller.abort();
}

export default {
  async activate(ctx) {
    if (activeRuntime) throw new Error("LivePix já está ativo");
    const config = normalizeConfig(await ctx.config.get());
    const persisted = await ctx.secrets.get(STATE_KEY);
    const state = hydrateState(persisted, ctx.log);
    const idLedger = await loadIdLedger(ctx.secrets, "livepix-ids", state.idLedger, state.processed.map(([id]) => id));
    state.idLedger = idLedger.descriptor;
    delete state.processed;
    const runtime = {
      ctx,
      config,
      state,
      idLedger,
      processed: idLedger.ids,
      controller: new AbortController(),
      stopped: false,
      socket: null,
      socketOpen: false,
      socketError: "",
      apiError: "",
      lastSyncOk: false,
      syncPromise: null,
      recoveryPromise: null,
      replayRequests: new Set(),
      fullSyncQueued: false,
      lastFullSyncAt: 0,
      inFlight: new Set(),
      queue: Promise.resolve(),
      syncTimer: null,
      reconnectTimer: null,
      silenceTimer: null,
      reconnectMs: 0,
      emittedSinceStart: 0,
    };
    activeRuntime = runtime;
    runtime.onAbort = () => stopRuntime(runtime);
    ctx.signal?.addEventListener("abort", runtime.onAbort, { once: true });
    if (ctx.signal?.aborted) stopRuntime(runtime);

    ctx.registerAction("poll-now", async () => {
      const problem = configProblem(runtime.config);
      if (problem) return { ok: false, fetched: 0, emitted: 0, error: problem };
      return sync(runtime, "ação", true);
    });
    ctx.registerAction("status", async () => statusSnapshot(runtime));
    ctx.registerAction("recover", async () => recover(runtime));
    ctx.registerAction("confirm-accounted", async (data) => confirmAccounted(runtime, data));

    if (runtime.stopped) return;
    if (!config.enabled) {
      ctx.setStatus({ health: "healthy", connectionState: "desativado" });
      return;
    }
    const problem = configProblem(config);
    if (problem) {
      publishStatus(runtime);
      ctx.log.warn("LivePix não iniciado: " + problem);
      return;
    }
    if (!Number.isFinite(config.startAtMs) && !state.autoStartAt) {
      // No subathon start configured: count from now on, never the history.
      state.autoStartAt = Date.now();
      ctx.log.info("sem início do subathon configurado; contando doações a partir de agora");
    }
    try {
      await persist(runtime);
    } catch (error) {
      stopRuntime(runtime);
      ctx.signal?.removeEventListener("abort", runtime.onAbort);
      activeRuntime = null;
      throw error;
    }
    publishStatus(runtime);
    openSocket(runtime);
    void sync(runtime, "ativação", true).finally(() => scheduleSync(runtime));
  },

  async deactivate() {
    const runtime = activeRuntime;
    if (!runtime) return;
    stopRuntime(runtime);
    runtime.ctx.signal?.removeEventListener("abort", runtime.onAbort);
    try {
      await runtime.syncPromise;
      await runtime.recoveryPromise;
      await Promise.allSettled([...runtime.inFlight]);
      await runtime.queue;
      await persist(runtime);
    } finally {
      activeRuntime = null;
    }
  },
};
