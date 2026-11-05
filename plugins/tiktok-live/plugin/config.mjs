// Reads the settings the person saved in Integrations, with every bound applied, so the
// rest of the plugin never sees a missing or out-of-range value.
import { clamp, normalizeUniqueId, number, text } from "./util.mjs";

const seconds = (value, fallback, min, max) => Math.round(clamp(number(value, fallback), min, max) * 1000);
const step = (value, fallback) => Math.max(0, Math.round(number(value, fallback)));

export function normalizeConfig(raw = {}) {
  const transport = raw.transport === "tikfinity" ? "tikfinity" : "direct";
  const signApiKey = text(raw.signApiKey).trim();
  const bridgeUrl = text(raw.bridgeUrl).trim() || "ws://localhost:21213/";
  return {
    enabled: raw.enabled !== false,
    uniqueId: normalizeUniqueId(raw.uniqueId),
    rawUniqueId: text(raw.uniqueId).trim(),
    transport,
    resetOnStreamStart: raw.resetOnStreamStart !== false,
    commandPrefix: text(raw.commandPrefix, "!").trim().slice(0, 3) || "!",
    // The Studio shows a stored secret as "***" in some paths; that is never a real key.
    signApiKey: signApiKey === "***" ? "" : signApiKey,
    reconnectMinMs: seconds(raw.reconnectMinSeconds, 5, 2, 60),
    reconnectMaxMs: Math.max(seconds(raw.reconnectMinSeconds, 5, 2, 60), seconds(raw.reconnectMaxSeconds, 300, 30, 900)),
    offlinePollMs: seconds(raw.offlinePollSeconds, 60, 30, 600),
    bridgeUrl: /^wss?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(bridgeUrl) ? bridgeUrl : "ws://localhost:21213/",
    chatEnabled: raw.chatEnabled === true,
    processInitialData: raw.processInitialData === true,
    giftStreakMode: raw.giftStreakMode === "each" ? "each" : "completed",
    likeMilestoneStep: step(raw.likeMilestoneStep, 1000),
    coinMilestoneStep: step(raw.coinMilestoneStep, 500),
    gifterMilestoneStep: step(raw.gifterMilestoneStep, 100),
    viewerMilestoneStep: step(raw.viewerMilestoneStep, 50),
    emitRawEvents: raw.emitRawEvents === true,
  };
}
