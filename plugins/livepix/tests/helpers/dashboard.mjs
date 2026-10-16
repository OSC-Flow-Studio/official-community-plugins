import http from "node:http";
import { WebSocketServer } from "ws";

export const WEBHOOK = "Wh00kIdForTests0000000AB";
export const TOKEN = `olp_${WEBHOOK}_s3cretPartOfTheToken`;
export const START = "2026-09-21T12:00:00.000Z";

/**
 * A dashboard that behaves like the real one on the wire: the donations API with
 * `since`/`after`/`limit`, and the WebSocket that pushes new donations.
 */
export async function fakeDashboard({ rejectSocket = 0, rejectApi = 0 } = {}) {
  const donations = [];
  const sockets = new Set();
  const requests = [];
  const receipts = [];
  let seq = 0;
  const state = { rejectSocket, rejectApi, authorization: [] };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push(url.pathname + url.search);
    state.authorization.push(req.headers.authorization);
    if (req.headers.authorization !== "Bearer " + TOKEN) return reply(res, 401, { error: "unauthorized" });
    if (state.rejectApi) return reply(res, state.rejectApi, { error: "down" });
    if (req.method === "POST" && url.pathname === `/${WEBHOOK}/api/accounted`) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => { receipts.push(JSON.parse(body)); reply(res, 200, { ok: true }); });
      return;
    }
    if (url.pathname !== `/${WEBHOOK}/api/donations`) return reply(res, 404, { error: "not_found" });
    const since = Date.parse(url.searchParams.get("since"));
    const after = Number(url.searchParams.get("after") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 200);
    const matching = donations.filter((d) => Date.parse(d.occurredAt) >= since && Number(d.seq) > after);
    const page = matching.slice(0, limit);
    reply(res, 200, {
      donations: page,
      nextAfter: page.length ? page[page.length - 1].seq : url.searchParams.get("after"),
      hasMore: matching.length > limit,
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    if (req.headers.authorization !== "Bearer " + TOKEN) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    if (state.rejectSocket) {
      socket.end(`HTTP/1.1 ${state.rejectSocket} Nope\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
      ws.send(JSON.stringify({ type: "hello", webhook: { id: WEBHOOK } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    baseUrl,
    requests,
    receipts,
    sockets,
    state,
    /** Stores a donation; `push` also sends it down every open socket, like the real processor. */
    add(overrides = {}, { push = false } = {}) {
      seq += 1;
      const donation = {
        id: "E" + seq,
        seq: String(seq),
        amount: 500,
        currency: "BRL",
        username: "Ana",
        message: "vai!",
        hasMessage: true,
        flagged: false,
        livepixId: "lp" + seq,
        proof: "E" + seq,
        reference: "r" + seq,
        source: "message",
        occurredAt: "2026-09-21T13:00:00.000Z",
        receivedAt: "2026-09-21T13:00:01.000Z",
        ...overrides,
      };
      donations.push(donation);
      if (push) for (const ws of sockets) ws.send(JSON.stringify({ type: "donation", donation }));
      return donation;
    },
    dropSockets(code = 1011) {
      for (const ws of sockets) ws.close(code, "test");
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function context(overrides = {}, vault = new Map()) {
  const controller = new AbortController();
  const actions = new Map();
  const triggers = [];
  const statuses = [];
  const logs = [];
  const config = {
    enabled: true,
    baseUrl: "http://127.0.0.1:1",
    apiToken: TOKEN,
    startAt: START,
    pollSeconds: 2,
    currency: "BRL",
    ...overrides,
  };
  return {
    controller,
    actions,
    triggers,
    statuses,
    logs,
    vault,
    ctx: {
      signal: controller.signal,
      config: { get: async () => config },
      secrets: {
        get: async (key) => vault.get(key) ?? null,
        set: async (key, value) => { vault.set(key, value); },
        delete: async (key) => { vault.delete(key); },
      },
      registerAction: (name, handler) => actions.set(name, handler),
      emitTrigger: (name, payload) => triggers.push({ name, payload }),
      setStatus: (status) => statuses.push(status),
      setResource: () => {},
      onFlowsChanged: () => {},
      log: {
        info: (message) => logs.push("info " + message),
        warn: (message) => logs.push("warn " + message),
        error: (message) => logs.push("error " + message),
      },
    },
  };
}

export async function until(check, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

