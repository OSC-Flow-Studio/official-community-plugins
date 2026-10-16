import assert from "node:assert/strict";
import test from "node:test";
import dgram from "node:dgram";
import { MdnsBrowser, TYPE, buildQuery, deviceKey, extractDevices, isGiggleName, parseMessage } from "../plugin/mdns.mjs";
import { puckAnswer, rdata, record, response, until } from "./helpers/fakes.mjs";

test("a query asks for the http services and the Puck's host name", () => {
  const query = buildQuery({ id: 7, questions: [{ name: "_http._tcp.local", type: TYPE.PTR }, { name: "giggletech.local", type: TYPE.A }] });
  const parsed = parseMessage(query);
  assert.equal(parsed.id, 7);
  assert.equal(parsed.flags, 0);
  assert.deepEqual(parsed.questions, [{ name: "_http._tcp.local", type: TYPE.PTR }, { name: "giggletech.local", type: TYPE.A }]);
  assert.equal(query.readUInt16BE(query.length - 2), 1, "QM: the unicast-response bit is clear");
  const qu = buildQuery({ questions: [{ name: "giggletech.local", type: TYPE.A }], unicastResponse: true });
  assert.equal(qu.readUInt16BE(qu.length - 2), 0x8001);
});

test("a Puck's answer gives its address, through PTR, SRV and A", () => {
  const { answers, additionals } = puckAnswer("192.168.1.69");
  const message = parseMessage(response({ answers, additionals: [...additionals, record("giggletech.local", TYPE.TXT, rdata.txt("path=/"))] }));
  assert.deepEqual(message.additionals.at(-1).data, ["path=/"]);
  assert.deepEqual(extractDevices(message), {
    devices: [{ host: "giggletech.local", name: "giggletech", address: "192.168.1.69" }],
    needAddress: [],
  });
  assert.equal(deviceKey({ host: "giggletech.local", address: "192.168.1.69" }), "ip:192.168.1.69");
});

test("a service without an address asks for the host next; other services are ignored", () => {
  const message = parseMessage(response({
    answers: [
      record("_http._tcp.local", TYPE.PTR, rdata.ptr("GigglePuck-A1._http._tcp.local")),
      record("_http._tcp.local", TYPE.PTR, rdata.ptr("printer._http._tcp.local")),
    ],
    additionals: [
      record("GigglePuck-A1._http._tcp.local", TYPE.SRV, rdata.srv("puck-a1.local")),
      record("printer._http._tcp.local", TYPE.SRV, rdata.srv("printer.local")),
      record("printer.local", TYPE.A, rdata.a("192.168.1.20")),
    ],
  }));
  assert.deepEqual(extractDevices(message), { devices: [], needAddress: [{ host: "puck-a1.local", name: "gigglepuck-a1" }] });
  // The answer to the follow-up question is an address record alone, under a plain name.
  const followUp = parseMessage(response({ answers: [record("puck-a1.local", TYPE.A, rdata.a("192.168.1.40"))] }));
  assert.deepEqual(extractDevices(followUp).devices, []);
  assert.deepEqual(extractDevices(followUp, new Map([["puck-a1.local", "gigglepuck-a1"]])).devices,
    [{ host: "puck-a1.local", name: "gigglepuck-a1", address: "192.168.1.40" }]);
  assert.equal(isGiggleName("GiggleSpark-2.local"), true);
  assert.equal(isGiggleName("printer.local"), false);
});

test("compressed names are followed", () => {
  // Header, then "giggletech.local" A record, then a second A record whose name points back.
  const first = record("giggletech.local", TYPE.A, rdata.a("10.0.0.5"));
  const pointer = Buffer.from([0xc0, 12]);
  const second = Buffer.concat([pointer, first.subarray(first.length - 14)]);
  const message = parseMessage(response({ answers: [first, second] }));
  assert.deepEqual(message.answers.map((item) => [item.name, item.data]), [["giggletech.local", "10.0.0.5"], ["giggletech.local", "10.0.0.5"]]);
});

test("malformed packets throw instead of being half read", () => {
  const header = (answers) => {
    const buffer = Buffer.alloc(12);
    buffer.writeUInt16BE(0x8400, 2);
    buffer.writeUInt16BE(answers, 6);
    return buffer;
  };
  const cases = {
    "shorter than a header": Buffer.alloc(5),
    "pointer loop": Buffer.concat([header(1), Buffer.from([0xc0, 12])]),
    "truncated record": Buffer.concat([header(1), record("giggletech.local", TYPE.A, rdata.a("10.0.0.5")).subarray(0, 20)]),
    "record data past the end": (() => {
      const bad = Buffer.concat([header(1), record("giggletech.local", TYPE.A, rdata.a("10.0.0.5"))]);
      bad.writeUInt16BE(400, bad.length - 6);
      return bad;
    })(),
    "too many records": header(500),
    "oversized packet": Buffer.alloc(10_000),
    "label over 63 bytes": Buffer.concat([header(1), Buffer.from([64]), Buffer.alloc(64, 0x61), Buffer.from([0])]),
  };
  for (const [label, buffer] of Object.entries(cases)) {
    assert.throws(() => parseMessage(buffer), /malformed DNS packet/, label);
  }
});

test("a Puck whose host name says nothing about GiggleTech is found through the follow-up question", async () => {
  // Answers the service query with PTR and SRV only, and the address only when asked for the host.
  const responder = dgram.createSocket("udp4");
  responder.on("message", (message, from) => {
    const question = parseMessage(message).questions[0];
    const reply = question.type === TYPE.PTR
      ? response({ answers: [record("_http._tcp.local", TYPE.PTR, rdata.ptr("GigglePuck-A1._http._tcp.local"))],
        additionals: [record("GigglePuck-A1._http._tcp.local", TYPE.SRV, rdata.srv("esp32-ab12.local"))] })
      : question.name === "esp32-ab12.local" ? response({ answers: [record("esp32-ab12.local", TYPE.A, rdata.a("127.0.0.1"))] }) : null;
    if (reply) responder.send(reply, from.port, from.address);
  });
  await new Promise((resolve) => responder.bind(0, "127.0.0.1", resolve));
  const found = [];
  const log = { info() {}, warn() {} };
  const browser = new MdnsBrowser({
    onDevice: (device) => found.push(device), log, dgram, dns: null, interfaces: ["127.0.0.1"],
    target: { address: "127.0.0.1", port: responder.address().port }, listener: false, resolver: false,
  });
  try {
    await browser.start();
    browser.scan();
    await until(() => found.length > 0);
    assert.deepEqual(found[0], { host: "esp32-ab12.local", name: "gigglepuck-a1", address: "127.0.0.1", key: "ip:127.0.0.1", source: "unicast" });
  } finally {
    browser.close();
    await new Promise((resolve) => responder.close(resolve));
  }
});
