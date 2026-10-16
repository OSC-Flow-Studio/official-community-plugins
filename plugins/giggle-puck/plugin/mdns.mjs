// Finds Giggle Pucks on the local network with multicast DNS, without Bonjour or any
// other program. A Puck advertises an `_http._tcp` service whose name or host contains
// "giggletech" (or "gigglepuck" / "gigglespark") and answers for `giggletech.local`.
//
// Three ways are tried together, because which one works depends on the machine:
// 1. unicast: a query from an ordinary port. Responders answer it directly to that port
//    (RFC 6762 section 6.7), so this never competes for port 5353 with Windows' own mDNS.
// 2. multicast: a listener on port 5353, when the system lets another program share it.
// 3. resolver: the system's own lookup of `giggletech.local`.

export const MDNS_ADDRESS = "224.0.0.251";
export const MDNS_PORT = 5353;
export const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 };
const SERVICE = "_http._tcp.local";
const GENERIC_HOST = "giggletech.local";
const NAME_TOKENS = ["giggletech", "gigglepuck", "gigglespark"];
const MAX_PACKET_BYTES = 9000;
const MAX_RECORDS_PER_SECTION = 64;
const MAX_POINTER_JUMPS = 32;
const RESOLVER_TIMEOUT_MS = 4000;

export const isGiggleName = (name) =>
  typeof name === "string" && NAME_TOKENS.some((token) => name.toLowerCase().includes(token));

function encodeName(name) {
  const parts = name.split(".").filter(Boolean).map((label) => {
    const bytes = Buffer.from(label, "utf8");
    if (bytes.length > 63) throw new Error(`DNS label too long: ${label}`);
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

/** A DNS query. `unicastResponse` sets the QU bit; queries from port 5353 leave it clear. */
export function buildQuery({ id = 0, questions, unicastResponse = false }) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(questions.length, 4);
  const body = questions.map(({ name, type }) => {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(type, 0);
    tail.writeUInt16BE(unicastResponse ? 0x8001 : 0x0001, 2);
    return Buffer.concat([encodeName(name), tail]);
  });
  return Buffer.concat([header, ...body]);
}

function fail(message) {
  throw new Error(`malformed DNS packet: ${message}`);
}

/** A possibly compressed name at `offset`, and where the bytes after it start. */
function readName(buffer, offset) {
  const labels = [];
  let position = offset;
  let next = -1;
  let jumps = 0;
  let length = 0;
  for (;;) {
    if (position >= buffer.length) fail("name runs past the end");
    const size = buffer[position];
    if (size === 0) {
      position += 1;
      break;
    }
    if ((size & 0xc0) === 0xc0) {
      if (position + 1 >= buffer.length) fail("truncated pointer");
      if (next < 0) next = position + 2;
      if (++jumps > MAX_POINTER_JUMPS) fail("too many pointer jumps");
      position = ((size & 0x3f) << 8) | buffer[position + 1];
      continue;
    }
    if (size & 0xc0) fail("reserved label type");
    if (position + 1 + size > buffer.length) fail("label runs past the end");
    length += size + 1;
    if (length > 255) fail("name too long");
    labels.push(buffer.toString("utf8", position + 1, position + 1 + size));
    position += 1 + size;
  }
  return { name: labels.join("."), next: next >= 0 ? next : position };
}

function readRecord(buffer, offset) {
  const { name, next } = readName(buffer, offset);
  if (next + 10 > buffer.length) fail("truncated record header");
  const type = buffer.readUInt16BE(next);
  const recordClass = buffer.readUInt16BE(next + 2) & 0x7fff;
  const ttl = buffer.readUInt32BE(next + 4);
  const size = buffer.readUInt16BE(next + 8);
  const start = next + 10;
  const end = start + size;
  if (end > buffer.length) fail("record data runs past the end");
  let data = null;
  if (type === TYPE.A && size === 4) {
    data = [...buffer.subarray(start, end)].join(".");
  } else if (type === TYPE.PTR) {
    data = readName(buffer, start).name;
  } else if (type === TYPE.SRV && size >= 7) {
    data = {
      priority: buffer.readUInt16BE(start),
      weight: buffer.readUInt16BE(start + 2),
      port: buffer.readUInt16BE(start + 4),
      target: readName(buffer, start + 6).name,
    };
  } else if (type === TYPE.TXT) {
    data = [];
    for (let position = start; position < end;) {
      const length = buffer[position];
      if (position + 1 + length > end) fail("TXT string runs past the record");
      data.push(buffer.toString("utf8", position + 1, position + 1 + length));
      position += 1 + length;
    }
  }
  return { record: { name, type, class: recordClass, ttl, data }, next: end };
}

/** Parses a DNS message. Throws on anything malformed; callers drop that packet. */
export function parseMessage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) fail("shorter than a header");
  if (buffer.length > MAX_PACKET_BYTES) fail("larger than any mDNS packet");
  const counts = [4, 6, 8, 10].map((at) => buffer.readUInt16BE(at));
  if (counts.some((count) => count > MAX_RECORDS_PER_SECTION)) fail("too many records");
  let offset = 12;
  const questions = [];
  for (let i = 0; i < counts[0]; i++) {
    const { name, next } = readName(buffer, offset);
    if (next + 4 > buffer.length) fail("truncated question");
    questions.push({ name, type: buffer.readUInt16BE(next) });
    offset = next + 4;
  }
  const sections = [];
  for (const count of counts.slice(1)) {
    const records = [];
    for (let i = 0; i < count; i++) {
      const { record, next } = readRecord(buffer, offset);
      records.push(record);
      offset = next;
    }
    sections.push(records);
  }
  const [answers, authorities, additionals] = sections;
  return { id: buffer.readUInt16BE(0), flags: buffer.readUInt16BE(2), questions, answers, authorities, additionals };
}

const lower = (name) => String(name).toLowerCase();

/**
 * The Pucks a response names: `{ host, name, address }` for each one with an IPv4
 * address, plus the hosts that were named without an address, to be asked for next.
 * `knownHosts` maps hosts an earlier answer already tied to a Puck to its name, so the
 * answer to that follow-up question (an address record alone) is recognized.
 */
export function extractDevices(message, knownHosts = new Map()) {
  const records = [...message.answers, ...message.authorities, ...message.additionals];
  const addresses = new Map();
  for (const record of records) {
    if (record.type !== TYPE.A || typeof record.data !== "string") continue;
    const list = addresses.get(lower(record.name)) ?? [];
    list.push(record.data);
    addresses.set(lower(record.name), list);
  }
  const instances = new Set();
  for (const record of records) {
    if (record.type === TYPE.PTR && lower(record.name) === SERVICE && isGiggleName(record.data)) instances.add(lower(record.data));
  }
  const services = new Map();
  for (const record of records) {
    if (record.type !== TYPE.SRV || !record.data) continue;
    if (instances.has(lower(record.name)) || isGiggleName(record.name) || isGiggleName(record.data.target)) {
      instances.add(lower(record.name));
      services.set(lower(record.name), record.data);
    }
  }
  const devices = [];
  const needAddress = new Map();
  const seen = new Set();
  const add = (host, name, address) => {
    const key = `${lower(host)}|${address}`;
    if (seen.has(key)) return;
    seen.add(key);
    devices.push({ host: lower(host), name, address });
  };
  for (const instance of instances) {
    const service = services.get(instance);
    if (!service) continue;
    const label = instance.split(".")[0] || service.target;
    const found = addresses.get(lower(service.target));
    if (found) for (const address of found) add(service.target, label, address);
    else needAddress.set(lower(service.target), label);
  }
  for (const [host, list] of addresses) {
    const known = knownHosts.get(host);
    if (known || isGiggleName(host)) for (const address of list) add(host, known ?? host.split(".")[0], address);
  }
  return { devices, needAddress: [...needAddress].map(([host, name]) => ({ host, name })) };
}

/**
 * One key per Puck. The address, not the name: every Puck may answer as `giggletech.local`,
 * and the same Puck heard by two of the three ways must stay one entry with one motor.
 */
export const deviceKey = ({ address }) => `ip:${address}`;

const isMulticast = (address) => address === MDNS_ADDRESS;

function bind(socket, options) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    socket.once("error", onError);
    socket.bind(options, () => {
      socket.off("error", onError);
      resolve();
    });
  });
}

export class MdnsBrowser {
  /**
   * `onDevice({ key, host, name, address, source })` runs for every Puck a scan hears.
   * Tests point `target` at a fake responder and turn the other two ways off.
   */
  constructor({ onDevice, log, dgram, dns, interfaces, target = { address: MDNS_ADDRESS, port: MDNS_PORT }, listener = true, resolver = true }) {
    this.onDevice = onDevice;
    this.log = log;
    this.dgram = dgram;
    this.dns = dns;
    this.interfaces = interfaces;
    this.target = target;
    this.useListener = listener;
    this.useResolver = resolver;
    this.unicast = null;
    this.listener = null;
    this.resolving = false;
    this.closed = false;
    // Hosts a service answer tied to a Puck, waiting for (or refreshing) their address.
    this.pendingHosts = new Map();
    this.strategies = { unicast: "off", multicast: "off", resolver: resolver ? "ready" : "off" };
  }

  async start() {
    this.unicast = this.dgram.createSocket({ type: "udp4" });
    this.unicast.on("message", (message) => this.handle(message, "unicast"));
    this.unicast.on("error", (error) => this.log.warn(`mDNS query socket: ${error.message}`));
    await bind(this.unicast, { port: 0 });
    this.strategies.unicast = "ready";
    if (isMulticast(this.target.address)) this.unicast.setMulticastTTL(255);
    if (!this.useListener || !isMulticast(this.target.address)) return;
    const listener = this.dgram.createSocket({ type: "udp4", reuseAddr: true });
    listener.on("message", (message) => this.handle(message, "multicast"));
    listener.on("error", (error) => this.log.warn(`mDNS listener: ${error.message}`));
    try {
      await bind(listener, { port: MDNS_PORT, exclusive: false });
      let joined = 0;
      for (const address of this.interfaces) {
        try {
          listener.addMembership(MDNS_ADDRESS, address);
          joined += 1;
        } catch (error) {
          this.log.warn(`mDNS listener could not join on ${address}: ${error.message}`);
        }
      }
      if (joined === 0) throw new Error("no network interface accepted the multicast group");
      listener.setMulticastTTL(255);
      this.listener = listener;
      this.strategies.multicast = "ready";
    } catch (error) {
      // Port 5353 is usually held by the system's own responder. The other two ways remain.
      this.log.info(`mDNS listener unavailable (${error.code ?? error.message}); using unicast queries and the system resolver`);
      this.strategies.multicast = "unavailable";
      listener.close();
    }
  }

  /** Sends one round of queries. Answers arrive through `onDevice` as they come. */
  scan() {
    if (this.closed || !this.unicast) return;
    const questions = [{ name: SERVICE, type: TYPE.PTR }, { name: GENERIC_HOST, type: TYPE.A }];
    const query = buildQuery({ id: 1 + Math.floor(Math.random() * 0xfffe), questions });
    this.sendQuery(this.unicast, query);
    for (const host of this.pendingHosts.keys()) this.askAddress(host);
    if (this.listener) {
      this.listener.send(buildQuery({ id: 0, questions }), MDNS_PORT, MDNS_ADDRESS, () => {});
    }
    if (this.useResolver) void this.resolve(GENERIC_HOST);
  }

  sendQuery(socket, query) {
    if (!isMulticast(this.target.address)) {
      socket.send(query, this.target.port, this.target.address, () => {});
      return;
    }
    for (const address of this.interfaces) {
      try {
        socket.setMulticastInterface(address);
        socket.send(query, MDNS_PORT, MDNS_ADDRESS, () => {});
      } catch (error) {
        this.log.warn(`mDNS query on ${address}: ${error.message}`);
      }
    }
  }

  handle(buffer, source) {
    if (this.closed) return;
    let message;
    try {
      message = parseMessage(buffer);
    } catch {
      return;
    }
    if (!(message.flags & 0x8000)) return;
    const { devices, needAddress } = extractDevices(message, this.pendingHosts);
    for (const device of devices) this.onDevice({ ...device, key: deviceKey(device), source });
    for (const { host, name } of needAddress) {
      if (this.pendingHosts.has(host)) continue;
      this.pendingHosts.set(host, name);
      this.askAddress(host);
    }
  }

  askAddress(host) {
    if (!this.unicast) return;
    this.sendQuery(this.unicast, buildQuery({ id: 1 + Math.floor(Math.random() * 0xfffe), questions: [{ name: host, type: TYPE.A }] }));
  }

  async resolve(host) {
    if (this.resolving || this.closed) return;
    this.resolving = true;
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), RESOLVER_TIMEOUT_MS);
      });
      const results = await Promise.race([this.dns.lookup(host, { family: 4, all: true }), timeout]);
      if (this.closed) return;
      for (const { address } of results) {
        const device = { host: lower(host), name: lower(host).split(".")[0], address };
        this.onDevice({ ...device, key: deviceKey(device), source: "resolver" });
      }
    } catch {
      // Not found is the normal answer when no Puck is on, or the system cannot resolve .local.
    } finally {
      clearTimeout(timer);
      this.resolving = false;
    }
  }

  close() {
    this.closed = true;
    for (const socket of [this.unicast, this.listener]) {
      try {
        socket?.close();
      } catch {
        // Already closed.
      }
    }
    this.unicast = null;
    this.listener = null;
  }
}
