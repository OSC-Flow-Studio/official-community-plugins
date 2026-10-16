# Changelog

## 0.1.0 (2026-10-16)

- First release. Drives GiggleTech Giggle Puck motors from VRChat avatar contacts and
  finds the Pucks on the network with multicast DNS, without the GiggleTech router.
- Blocks to set proximity, set the maximum speed, vibrate for a while, stop, read status,
  and a trigger for a Puck coming online or going offline.
- Template "Giggle Puck: avatar contact to vibration" with the router's parameter names
  (`proximity_01`, `max_speed`, `GigglePuck_online`), arriving switched off.
- Every buzz ends on the plugin's side: an immediate 0 with repeats, a 0 every second
  while idle, a stop after the avatar goes silent, and 0 on deactivate. The first-touch
  pulse never exceeds the maximum, and the avatar's `max_speed` is capped by a ceiling.
- Requires OSC Flow Studio 0.5.10 for the `haptics` capability, block icons and the
  duration field.
