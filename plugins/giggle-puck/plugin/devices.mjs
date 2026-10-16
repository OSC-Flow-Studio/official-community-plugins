// The Pucks the plugin knows: the ones discovery hears and the ones added by address.

export const OSC_PORT = 8888;
/** A discovered Puck that misses this many scans in a row counts as offline. */
const MISSED_SCANS_OFFLINE = 2;
const GENERIC_NAME = "giggletech";

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
export const isIpv4 = (value) => typeof value === "string" && IPV4.test(value);

export class DeviceRegistry {
  /** `onChange(change, device)` runs when a Puck comes online or goes offline. */
  constructor({ onChange, discoveredPort = OSC_PORT }) {
    this.onChange = onChange;
    this.discoveredPort = discoveredPort;
    this.devices = new Map();
    this.scan = 0;
  }

  /** Puck rows from the Devices tab. A row whose host is a `.local` name waits for `setAddress`. */
  setManual(rows) {
    for (const row of rows) {
      if (row?.enabled === false || typeof row?.name !== "string" || typeof row?.host !== "string") continue;
      const name = row.name.trim();
      const host = row.host.trim();
      if (!name || !host) continue;
      const port = Number.isInteger(Number(row.port)) && Number(row.port) > 0 && Number(row.port) <= 65_535 ? Number(row.port) : OSC_PORT;
      const device = { id: `manual:${name}`, name, host, address: isIpv4(host) ? host : null, port, source: "manual", online: false };
      this.devices.set(device.id, device);
      if (device.address) this.setOnline(device, true);
    }
  }

  /** The address a manual `.local` row resolved to; `null` when it did not resolve. */
  setAddress(id, address) {
    const device = this.devices.get(id);
    if (!device || device.source !== "manual") return;
    device.address = address;
    this.setOnline(device, Boolean(address));
  }

  beginScan() {
    this.scan += 1;
    return this.scan;
  }

  /** A Puck heard by discovery during the current scan. */
  seen({ key, name, address, source }) {
    // A Puck already added by address stays that one entry: one Puck, one motor.
    if (this.list().some((device) => device.source === "manual" && device.address === address)) return;
    let device = this.devices.get(key);
    if (!device) {
      device = { id: key, name, host: address, address, port: this.discoveredPort, source, online: false, lastScan: this.scan };
      this.devices.set(key, device);
    }
    if (device.name === GENERIC_NAME && name && name !== GENERIC_NAME) device.name = name;
    device.source = source;
    device.lastScan = this.scan;
    this.setOnline(device, true);
  }

  /** Marks the discovered Pucks the last scans did not hear as offline. */
  endScan(scan) {
    for (const device of this.devices.values()) {
      if (device.source === "manual") continue;
      if (scan - device.lastScan >= MISSED_SCANS_OFFLINE) this.setOnline(device, false);
    }
  }

  setOnline(device, online) {
    if (device.online === online) return;
    device.online = online;
    this.onChange(online ? "online" : "offline", device);
  }

  list() {
    return [...this.devices.values()];
  }

  get onlineCount() {
    return this.list().filter((device) => device.online).length;
  }

  /** The Pucks a block's device field points at: every online Puck for "all", or that one. */
  targets(selection) {
    const value = typeof selection === "string" ? selection.trim() : "";
    if (!value || value === "all") return this.list().filter((device) => device.online && device.address);
    const device = this.devices.get(value);
    return device?.address ? [device] : [];
  }

  /** The device picker the blocks show. */
  resourceItems() {
    return [
      { value: "all", label: "All Pucks" },
      ...this.list().map((device) => ({
        value: device.id,
        label: `${device.name} (${device.address ?? device.host})`,
        connected: device.online,
        group: device.source === "manual" ? "Added by address" : "Found on the network",
      })),
    ];
  }
}
