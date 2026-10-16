# Giggle Puck

Drives the motor of GiggleTech Giggle Pucks from VRChat avatar contacts, and finds the
Pucks on the local network without the GiggleTech router. The user guide that ships in
the ZIP is [plugin/README.md](plugin/README.md).

| Contract | Value |
| --- | --- |
| Package id | `io.github.osc-flow-studio.giggle-puck` |
| Block and config id | `giggle-puck` |
| OSC Flow Studio | `>=0.5.10 <0.6.0` (`haptics`, `appearance`, `durationBaseUnit`) |
| Runtime SDK | API 1 |
| Capabilities | triggers, actions, templates, haptics, local-network |

## Protocol

Written from the Puck's network protocol. No code from the GiggleTech router is used
(that repository has no license), and the plugin is not affiliated with GiggleTech.

- **Motor:** OSC 1.0 over UDP to port 8888. Each update is one int32 from 0 to 255, sent
  to both `/avatar/parameters/motor` and `/motor`. There is no stop message: 0 stops the
  motor, and the Puck holds the last value it received, so every stop lives in
  `plugin/motor.mjs`.
- **Discovery:** multicast DNS. A `PTR _http._tcp.local` query, accepting services whose
  instance or host contains `giggletech`, `gigglepuck` or `gigglespark`, plus an `A`
  query for `giggletech.local`. Pucks are keyed by IPv4 address, because several may all
  answer as `giggletech.local`.
- **Mapping:** `tx = round(maxSpeed x n x 0.66 x speedScale x 255)`, where `n` is the
  proximity normalized between the outer and inner edges and clamped to 0..1. The first
  touch after 0 is raised to the start pulse, capped at the maximum. The avatar's
  `max_speed` is clamped to 5 % and the configured ceiling. The router's velocity mode is
  not implemented.

The Studio gives plugins no OSC access, so the avatar side is a flow: the template's
`trigger.osc` reads `proximity_01` and `max_speed` and feeds the plugin's actions, and
`action.osc.send` reports `GigglePuck_online` back.

## Files

```text
plugin/index.mjs     lifecycle, blocks, status, device picker
plugin/motor.mjs     proximity mapping and the per-Puck channel (latest-wins, stops, watchdog)
plugin/mdns.mjs      DNS packets and the three discovery strategies
plugin/devices.mjs   discovered and manual Pucks, liveness
plugin/osc.mjs       OSC int encoder
```

`plugin/index.mjs` exports `startRuntime(ctx, overrides)` for tests: a fake clock, a
fake responder as the mDNS target and the OSC port for discovered Pucks.

## Tests

`npm test` at the repository root runs these suites with real UDP sockets on 127.0.0.1:
a simulated Puck that decodes OSC, a simulated responder that answers like a Puck, and a
hand-driven clock. They cover the mapping, coalescing a 60 Hz burst, the stop burst and
keepalive, the silence watchdog, a buzz on top of a contact, discovery and the
offline transition, manual Pucks, bad input, deactivation, the DNS parser against
malformed packets, and that every action returns exactly its declared output.

`npm run test:host-contract` runs the template through the real Studio flow engine:
proximity and `max_speed` reach the Puck and every downstream `$json` / `$node` formula,
a packet with no value sets the Puck to 0, and a Puck coming online pulses
`GigglePuck_online`.

Not covered without hardware: discovery of a real Puck on Windows with the system mDNS
responder running, and which of the three strategies answers there.
