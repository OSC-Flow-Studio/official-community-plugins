// How a contact proximity becomes a motor value, and how values reach one Puck.
//
// The Puck holds the last value it received until it gets another one, and it has no
// watchdog of its own. Everything that ends a buzz therefore lives here: an immediate 0
// with a short burst of repeats, a 0 every second while idle, and a timer that sets the
// motor to 0 when the avatar stops sending.

/** Scale every value is multiplied by, so the 3.3 V motor is never driven at full 5 V. */
export const MOTOR_SAFETY_SCALE = 0.66;
/** Lowest maximum speed the avatar may set, as a fraction. */
export const MIN_MAX_SPEED = 0.05;

const ZERO_BURST = 5;
const ZERO_BURST_GAP_MS = 30;
const ZERO_KEEPALIVE_MS = 1000;
const WATCHDOG_TICK_MS = 250;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** A number from a field that may arrive as text; `fallback` for anything else. */
export function toNumber(value, fallback) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** The motor settings from the plugin config, with every value clamped to its range. */
export function motorSettings(raw = {}) {
  const ceiling = clamp(toNumber(raw.maxSpeedCeilingPercent, 100), 5, 100) / 100;
  const outer = clamp(toNumber(raw.outerProximity, 0), 0, 1);
  const inner = clamp(toNumber(raw.innerProximity, 1), 0, 1);
  return {
    maxSpeed: Math.min(clamp(toNumber(raw.maxSpeedPercent, 25), 5, 100) / 100, ceiling),
    ceiling,
    speedScale: clamp(toNumber(raw.speedScalePercent, 100), 10, 100) / 100,
    startTx: Math.round(clamp(toNumber(raw.startTx, 20), 0, 255)),
    outer,
    inner,
    bandValid: inner > outer,
    inputTimeoutMs: Math.round(clamp(toNumber(raw.inputTimeoutSeconds, 5), 1, 60) * 1000),
    minSendIntervalMs: Math.round(clamp(toNumber(raw.minSendIntervalMs, 20), 0, 500)),
  };
}

/** The highest value sent at this maximum speed. */
export function maxTxFor(settings, maxSpeed) {
  return Math.round(maxSpeed * MOTOR_SAFETY_SCALE * settings.speedScale * 255);
}

/**
 * Proximity (0 to 1) to a motor value. Below the outer edge the motor is off; at or past
 * the inner edge it runs at the maximum. The first touch after the motor was off is raised
 * to the start pulse so the motor spins up, but never above the maximum.
 */
export function proximityToTx(value, settings, maxSpeed, wasOff) {
  const proximity = toNumber(value, 0);
  if (!settings.bandValid || proximity <= 0 || proximity < settings.outer) return { tx: 0, signal: 0 };
  const signal = clamp((proximity - settings.outer) / (settings.inner - settings.outer), 0, 1);
  const cap = maxTxFor(settings, maxSpeed);
  let tx = Math.round(maxSpeed * signal * MOTOR_SAFETY_SCALE * settings.speedScale * 255);
  if (wasOff && signal > 0) tx = Math.max(tx, Math.min(settings.startTx, cap));
  return { tx: clamp(tx, 0, cap), signal };
}

/** A maximum speed from the avatar (0 to 1), kept between 5 % and the configured ceiling. */
export function clampMaxSpeed(value, settings) {
  const requested = toNumber(value, Number.NaN);
  if (!Number.isFinite(requested)) return { valid: false, maxSpeed: settings.maxSpeed, clamped: false };
  const maxSpeed = clamp(requested, MIN_MAX_SPEED, settings.ceiling);
  return { valid: true, maxSpeed, clamped: maxSpeed !== requested };
}

const systemTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle),
};

/**
 * The motor of one Puck. Values are latest-wins: at most one send per
 * `minSendIntervalMs`, with one trailing send carrying the newest value, and never a
 * queue. A 0 always goes out at once.
 */
export class MotorChannel {
  constructor({ send, settings, maxSpeed = settings.maxSpeed, now = Date.now, timers = systemTimers, onSilence = () => {} }) {
    this.send = send;
    this.settings = settings;
    this.maxSpeed = maxSpeed;
    this.now = now;
    this.timers = timers;
    this.onSilence = onSilence;
    this.streamTx = 0;
    this.lastSignal = 0;
    this.lastInputAt = 0;
    this.vibration = null;
    this.vibrationTimer = null;
    this.lastSentTx = null;
    this.lastSentAt = Number.NEGATIVE_INFINITY;
    this.trailingTimer = null;
    this.zeroTimer = null;
    this.zeroBurstLeft = 0;
    this.disposed = false;
    this.watchdog = timers.setInterval(() => this.checkSilence(), WATCHDOG_TICK_MS);
    this.watchdog?.unref?.();
  }

  get effectiveTx() {
    return Math.max(this.streamTx, this.vibration?.tx ?? 0);
  }

  get maxTx() {
    return maxTxFor(this.settings, this.maxSpeed);
  }

  setProximity(value) {
    this.lastInputAt = this.now();
    const { tx, signal } = proximityToTx(value, this.settings, this.maxSpeed, this.lastSignal === 0);
    this.lastSignal = signal;
    this.streamTx = tx;
    this.push();
    return tx;
  }

  setMaxSpeed(value) {
    const result = clampMaxSpeed(value, this.settings);
    if (!result.valid) return result;
    this.maxSpeed = result.maxSpeed;
    if (this.streamTx > this.maxTx) {
      this.streamTx = this.maxTx;
      this.push();
    }
    return result;
  }

  /** A buzz on top of the contact stream for `durationMs`, as a share of the current maximum. */
  vibrate(intensityPercent, durationMs) {
    const share = clamp(toNumber(intensityPercent, 0), 0, 100) / 100;
    const duration = Math.round(clamp(toNumber(durationMs, 500), 50, 10_000));
    const tx = Math.round(share * this.maxTx);
    this.clearVibration();
    if (tx > 0) {
      this.vibration = { tx, endsAt: this.now() + duration };
      this.vibrationTimer = this.timers.setTimeout(() => {
        this.vibrationTimer = null;
        this.vibration = null;
        this.push();
      }, duration);
    }
    this.push();
    return { tx, durationMs: duration };
  }

  stop() {
    this.clearVibration();
    this.streamTx = 0;
    this.lastSignal = 0;
    this.push();
  }

  checkSilence() {
    if (this.streamTx > 0 && this.now() - this.lastInputAt > this.settings.inputTimeoutMs) {
      this.streamTx = 0;
      this.lastSignal = 0;
      this.onSilence();
      this.push();
    }
  }

  push() {
    if (this.disposed) return;
    const tx = this.effectiveTx;
    if (tx === 0) {
      this.startZero();
      return;
    }
    this.stopZero();
    if (tx === this.lastSentTx) return;
    const wait = this.lastSentAt + this.settings.minSendIntervalMs - this.now();
    if (wait <= 0) {
      this.emit(tx);
      return;
    }
    this.trailingTimer ??= this.timers.setTimeout(() => {
      this.trailingTimer = null;
      const latest = this.effectiveTx;
      if (latest > 0 && latest !== this.lastSentTx) this.emit(latest);
    }, wait);
  }

  startZero() {
    this.cancelTrailing();
    if (this.zeroTimer && this.lastSentTx === 0) return;
    this.emit(0);
    this.zeroBurstLeft = ZERO_BURST - 1;
    this.scheduleZero();
  }

  scheduleZero() {
    const gap = this.zeroBurstLeft > 0 ? ZERO_BURST_GAP_MS : ZERO_KEEPALIVE_MS;
    this.zeroTimer = this.timers.setTimeout(() => {
      if (this.disposed || this.effectiveTx !== 0) return;
      if (this.zeroBurstLeft > 0) this.zeroBurstLeft -= 1;
      this.emit(0);
      this.scheduleZero();
    }, gap);
    this.zeroTimer?.unref?.();
  }

  stopZero() {
    if (this.zeroTimer) this.timers.clearTimeout(this.zeroTimer);
    this.zeroTimer = null;
    this.zeroBurstLeft = 0;
  }

  cancelTrailing() {
    if (this.trailingTimer) this.timers.clearTimeout(this.trailingTimer);
    this.trailingTimer = null;
  }

  clearVibration() {
    if (this.vibrationTimer) this.timers.clearTimeout(this.vibrationTimer);
    this.vibrationTimer = null;
    this.vibration = null;
  }

  emit(tx) {
    this.lastSentTx = tx;
    this.lastSentAt = this.now();
    this.send(tx);
  }

  status() {
    return {
      lastTx: this.lastSentTx ?? 0,
      lastInputAt: this.lastInputAt,
      maxSpeedPercent: Math.round(this.maxSpeed * 100),
    };
  }

  dispose() {
    this.disposed = true;
    this.timers.clearInterval(this.watchdog);
    this.cancelTrailing();
    this.stopZero();
    this.clearVibration();
  }
}
