// Giggle Puck for OSC Flow Studio. Drives the motor of GiggleTech Giggle Pucks from VRChat
// avatar contacts and finds the Pucks on the network by itself.
//
// Written from the Puck's network protocol (OSC over UDP port 8888, an int 0 to 255 sent
// to /avatar/parameters/motor and /motor). No code from the GiggleTech router is used, and
// this plugin is not affiliated with GiggleTech.
import dgram from "node:dgram";
import { promises as dnsPromises } from "node:dns";
import os from "node:os";
import { DeviceRegistry, isIpv4 } from "./devices.mjs";
import { MdnsBrowser } from "./mdns.mjs";
import { MotorChannel, clampMaxSpeed, motorSettings, toNumber } from "./motor.mjs";
import { encodeOscInt } from "./osc.mjs";

const MOTOR_ADDRESSES = ["/avatar/parameters/motor", "/motor"];
const FIRST_SCAN_QUERIES_MS = [0, 2000, 4000, 6000];
const FIRST_SCAN_WINDOW_MS = 7500;
const SCAN_QUERIES_MS = [0, 2000];
const SCAN_WINDOW_MS = 4000;
const STOP_REPEATS = 3;
const STOP_GAP_MS = 30;
const SEND_WAIT_MS = 1000;
const RESOLVE_TIMEOUT_MS = 4000;

const systemTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle),
};

let activeRuntime = null;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const describe = (error) => (error instanceof Error ? error.message : String(error));

export function normalizeConfig(raw = {}) {
  return {
    discovery: raw.discovery !== false,
    rescanMs: Math.round(clamp(toNumber(raw.rescanSeconds, 30), 10, 600) * 1000),
    devices: Array.isArray(raw.devices) ? raw.devices : [],
    motor: motorSettings(raw),
  };
}

/** IPv4 addresses of this PC's network interfaces, the ones mDNS queries go out on. */
function lanInterfaces() {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class GigglePuckRuntime {
  constructor(ctx, config, overrides) {
    this.ctx = ctx;
    this.config = config;
    this.timers = overrides.timers ?? systemTimers;
    this.now = overrides.now ?? Date.now;
    this.dgram = overrides.dgram ?? dgram;
    this.dns = overrides.dns ?? dnsPromises;
    this.discoveryOptions = overrides.discovery ?? {};
    this.channels = new Map();
    this.defaultMaxSpeed = config.motor.maxSpeed;
    this.foundBy = new Set();
    this.timeouts = new Set();
    this.firstScanDone = !config.discovery;
    this.browser = null;
    this.osc = null;
    this.stopped = false;
    this.lastError = "";
    this.registry = new DeviceRegistry({
      onChange: (change, device) => this.deviceChanged(change, device),
      discoveredPort: overrides.discoveredPort,
    });
  }

  async start() {
    this.osc = this.dgram.createSocket({ type: "udp4" });
    this.osc.on("error", (error) => this.ctx.log.warn(`OSC socket: ${error.message}`));
    this.registry.setManual(this.config.devices);
    void this.resolveManualHosts();
    if (this.config.discovery) {
      this.browser = new MdnsBrowser({
        onDevice: (device) => this.discovered(device),
        log: this.ctx.log,
        dgram: this.dgram,
        dns: this.dns,
        interfaces: this.discoveryOptions.interfaces ?? lanInterfaces(),
        target: this.discoveryOptions.target,
        listener: this.discoveryOptions.listener ?? true,
        resolver: this.discoveryOptions.resolver ?? true,
      });
      try {
        await this.browser.start();
      } catch (error) {
        this.lastError = `Network discovery could not start: ${describe(error)}`;
        this.ctx.log.warn(this.lastError);
      }
      this.runScan(true);
    }
    this.publish();
  }

  later(callback, ms) {
    const handle = this.timers.setTimeout(() => {
      this.timeouts.delete(handle);
      if (!this.stopped) callback();
    }, ms);
    this.timeouts.add(handle);
  }

  runScan(first) {
    const scan = this.registry.beginScan();
    for (const delay of first ? FIRST_SCAN_QUERIES_MS : SCAN_QUERIES_MS) this.later(() => this.browser?.scan(), delay);
    const window = first ? FIRST_SCAN_WINDOW_MS : SCAN_WINDOW_MS;
    this.later(() => {
      this.registry.endScan(scan);
      this.firstScanDone = true;
      this.publish();
      this.later(() => {
        void this.resolveManualHosts();
        this.runScan(false);
      }, Math.max(0, this.config.rescanMs - window));
    }, window);
  }

  async resolveManualHosts() {
    const pending = this.registry.list().filter((device) => device.source === "manual" && !isIpv4(device.host));
    await Promise.all(pending.map(async (device) => {
      try {
        const result = await withTimeout(this.dns.lookup(device.host, { family: 4 }), RESOLVE_TIMEOUT_MS);
        if (!this.stopped) this.registry.setAddress(device.id, result?.address ?? null);
      } catch {
        if (!this.stopped) this.registry.setAddress(device.id, null);
      }
    }));
  }

  discovered(device) {
    if (this.stopped) return;
    this.foundBy.add(device.source);
    this.registry.seen(device);
  }

  deviceChanged(change, device) {
    if (this.stopped) return;
    this.ctx.log.info(`${device.name} is ${change} (${device.address ?? device.host})`);
    this.publish();
    this.ctx.emitTrigger("device-status", {
      change,
      deviceId: device.id,
      name: device.name,
      address: device.address ?? "",
      source: device.source,
      onlineCount: this.registry.onlineCount,
      actorId: device.id,
      actorDisplayName: device.name,
    });
  }

  channel(device) {
    let channel = this.channels.get(device.id);
    if (!channel) {
      channel = new MotorChannel({
        send: (tx) => this.sendMotor(device, tx),
        settings: this.config.motor,
        maxSpeed: this.defaultMaxSpeed,
        now: this.now,
        timers: this.timers,
        onSilence: () => this.ctx.log.info(
          `No proximity from the avatar for ${this.config.motor.inputTimeoutMs / 1000} s; ${device.name} set to 0`,
        ),
      });
      this.channels.set(device.id, channel);
    }
    return channel;
  }

  sendMotor(device, tx) {
    if (!device.address || !this.osc) return Promise.resolve();
    return Promise.all(MOTOR_ADDRESSES.map((address) => new Promise((resolve) => {
      try {
        this.osc.send(encodeOscInt(address, tx), device.port, device.address, (error) => {
          if (error) this.noteSendError(device, error);
          resolve();
        });
      } catch (error) {
        this.noteSendError(device, error);
        resolve();
      }
    })));
  }

  noteSendError(device, error) {
    const message = `Could not send to ${device.name} (${device.address}): ${describe(error)}`;
    if (message === this.lastError) return;
    this.lastError = message;
    this.ctx.log.warn(message);
  }

  noTarget(selection) {
    const value = typeof selection === "string" ? selection.trim() : "";
    return !value || value === "all" ? "No Giggle Puck is online." : "That Puck is not known or has no address yet.";
  }

  setProximity(data) {
    const targets = this.registry.targets(data?.device);
    if (this.stopped || targets.length === 0) return { ok: false, tx: 0, devices: 0, error: this.stopped ? "The plugin is stopping." : this.noTarget(data?.device) };
    const valid = Number.isFinite(toNumber(data?.proximity, Number.NaN));
    let tx = 0;
    for (const device of targets) tx = this.channel(device).setProximity(valid ? data.proximity : 0);
    return { ok: valid, tx, devices: targets.length, error: valid ? "" : "Proximity is not a number, so the Puck was set to 0." };
  }

  setMaxSpeed(data) {
    const result = clampMaxSpeed(data?.maxSpeed, this.config.motor);
    const current = Math.round(this.defaultMaxSpeed * 100);
    if (!result.valid) return { ok: false, maxSpeedPercent: current, clamped: false, devices: 0, error: "Maximum speed is not a number." };
    const selection = typeof data?.device === "string" ? data.device.trim() : "";
    if (!selection || selection === "all") this.defaultMaxSpeed = result.maxSpeed;
    const targets = this.registry.targets(data?.device);
    for (const device of targets) this.channel(device).setMaxSpeed(result.maxSpeed);
    return { ok: true, maxSpeedPercent: Math.round(result.maxSpeed * 100), clamped: result.clamped, devices: targets.length, error: "" };
  }

  vibrate(data) {
    const targets = this.registry.targets(data?.device);
    if (this.stopped || targets.length === 0) return { ok: false, tx: 0, durationMs: 0, devices: 0, error: this.stopped ? "The plugin is stopping." : this.noTarget(data?.device) };
    let result = { tx: 0, durationMs: 0 };
    for (const device of targets) result = this.channel(device).vibrate(data?.intensity, data?.durationMs);
    return { ok: true, tx: result.tx, durationMs: result.durationMs, devices: targets.length, error: "" };
  }

  stop(data) {
    const selection = typeof data?.device === "string" ? data.device.trim() : "";
    // A stop reaches every Puck with an address, online or not.
    const targets = !selection || selection === "all"
      ? this.registry.list().filter((device) => device.address)
      : this.registry.targets(selection);
    for (const device of targets) this.channel(device).stop();
    return { ok: targets.length > 0, devices: targets.length, error: targets.length > 0 ? "" : this.noTarget(selection) };
  }

  discoveryLabel() {
    if (!this.config.discovery) return "off";
    if (this.foundBy.size > 0) return [...this.foundBy].sort().join(", ");
    return this.firstScanDone ? "nothing found" : "searching";
  }

  getStatus() {
    const devices = this.registry.list();
    const online = devices.filter((device) => device.online);
    const channels = [...this.channels.values()].map((channel) => channel.status());
    const lastInputAt = Math.max(0, ...channels.map((status) => status.lastInputAt));
    return {
      onlineCount: online.length,
      knownCount: devices.length,
      names: online.map((device) => device.name).join(", "),
      discovery: this.discoveryLabel(),
      maxSpeedPercent: Math.round(this.defaultMaxSpeed * 100),
      lastTx: Math.max(0, ...channels.map((status) => status.lastTx)),
      lastInputAt: lastInputAt > 0 ? new Date(lastInputAt).toISOString() : "",
      error: this.lastError,
    };
  }

  publish() {
    if (this.stopped) return;
    this.ctx.setResource("devices", this.registry.resourceItems());
    const online = this.registry.onlineCount;
    if (online > 0) {
      this.ctx.setStatus({ health: "healthy", connectionState: `${online} Puck${online === 1 ? "" : "s"} online` });
    } else if (!this.config.discovery && this.registry.list().length === 0) {
      this.ctx.setStatus({ health: "degraded", connectionState: "no Pucks", errors: ["Discovery is off and no Puck is added under Devices."] });
    } else if (!this.firstScanDone) {
      this.ctx.setStatus({ health: "unknown", connectionState: "searching for Pucks" });
    } else {
      this.ctx.setStatus({
        health: "degraded",
        connectionState: "no Puck found",
        errors: ["No Giggle Puck found yet. Check that it is on and on the same network as this PC, or add its address under Devices."],
      });
    }
  }

  /** Sets every Puck to 0, a few times over, then closes the sockets. */
  async shutdown() {
    if (this.stopped) return;
    this.stopped = true;
    for (const handle of this.timeouts) this.timers.clearTimeout(handle);
    this.timeouts.clear();
    this.browser?.close();
    for (const channel of this.channels.values()) channel.dispose();
    const devices = this.registry.list().filter((device) => device.address);
    for (let attempt = 0; attempt < STOP_REPEATS; attempt++) {
      await withTimeout(Promise.all(devices.map((device) => this.sendMotor(device, 0))), SEND_WAIT_MS);
      if (attempt < STOP_REPEATS - 1) await new Promise((resolve) => setTimeout(resolve, STOP_GAP_MS));
    }
    try {
      this.osc?.close();
    } catch {
      // Already closed.
    }
    this.osc = null;
  }
}

/**
 * Starts a runtime and registers its blocks. The default export uses it with the real
 * network; tests pass `overrides` to point discovery at a fake responder.
 */
export async function startRuntime(ctx, overrides = {}) {
  const runtime = new GigglePuckRuntime(ctx, normalizeConfig(await ctx.config.get()), overrides);
  ctx.registerAction("set-proximity", (data) => runtime.setProximity(data));
  ctx.registerAction("set-max-speed", (data) => runtime.setMaxSpeed(data));
  ctx.registerAction("vibrate", (data) => runtime.vibrate(data));
  ctx.registerAction("stop", (data) => runtime.stop(data));
  ctx.registerAction("get-status", () => runtime.getStatus());
  try {
    await runtime.start();
  } catch (error) {
    await runtime.shutdown();
    throw error;
  }
  return runtime;
}

export default {
  async activate(ctx) {
    if (activeRuntime) throw new Error("Giggle Puck is already running");
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
