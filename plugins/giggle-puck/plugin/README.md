# Giggle Puck 0.1.0

Makes a GiggleTech Giggle Puck vibrate when something touches a contact on your VRChat
avatar. The plugin finds the Pucks on your network by itself; you do not need the
GiggleTech router, Bonjour or any other program running.

This plugin is not made by GiggleTech. It talks to the Puck through the Puck's network
protocol.

## What you need

- OSC Flow Studio 0.5.10 or newer, with VRChat sending OSC to it (the default port 9001).
- A Giggle Puck set up on the same network as your PC. To set one up, power it on, join
  the `Giggletech_haptics` Wi-Fi (password `giggletech`), open `http://192.168.4.1` and
  enter your own Wi-Fi.
- An avatar you can edit in Unity.

Close the GiggleTech router before you start: it listens on the same port as OSC Flow
Studio, and only one of them receives from VRChat.

## Set up OSC Flow Studio

1. Install **Giggle Puck** from the community catalog in **Integrations**, and switch it on.
2. Within a few seconds the card says how many Pucks are online. If it says none was
   found, check that the Puck is on and on the same network, or add its IP address in
   the **Devices** tab.
3. On the card, import **Giggle Puck: avatar contact to vibration**. The flow arrives
   switched off. Open it, check it, and turn it on.

## Set up the avatar in Unity

The template uses the same parameter names as the GiggleTech router, so an avatar
already set up for the router works as it is.

1. Add a **VRC Contact Receiver** where you want to feel touches (the head, for
   headpats). Set **Receiver Type** to **Proximity**, choose the collision tags that
   should count (for example Hand and Finger), and set **Parameter** to `proximity_01`.
2. In the avatar's **Expression Parameters**, add `proximity_01` as a **Float**.
3. Optional: add `max_speed` as a **Float** with a radial menu control, to change the
   speed from the Action Menu (0 to 1).
4. Optional: add `GigglePuck_online` as a **Bool**. The flow switches it off and on again
   whenever a Puck comes online, which you can use to show an indicator.
5. Upload the avatar. If you changed parameters on an avatar VRChat already knows, reset
   its OSC config (Action Menu, Options, OSC, Reset Config).

## Blocks

| Block | What it does |
|---|---|
| Giggle Puck: online or offline | Trigger. Runs when a Puck is found or stops answering. |
| Giggle Puck: set proximity | Turns a proximity from 0 to 1 into motor speed. 0 stops the motor. |
| Giggle Puck: set maximum speed | Changes the speed at full contact, for example from `max_speed`. |
| Giggle Puck: vibrate | Buzzes for a while, from 50 ms to 10 s, then goes back to what the contact asks for. |
| Giggle Puck: stop | Sets the motor to 0 and ends any buzz. |
| Giggle Puck: read status | Reads how many Pucks are online and the last value sent. |

Each block has a **Puck** field. **All Pucks** reaches every Puck that is online. To give
two Pucks two contacts, copy the trigger and the action, change the parameter name in the
copy (for example `proximity_02`), and pick a Puck in each action.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Maximum speed | 25 % | Speed at full contact. A 66 % motor protection scale is always applied on top, so 25 % sends 42 out of 255. |
| Highest speed the avatar may ask for | 100 % | Caps `max_speed` from the avatar. |
| Start pulse | 20 | Sent on the first touch so the motor spins up, never above the maximum. |
| Outer and inner proximity | 0 and 1 | The motor starts past the outer value and reaches the maximum at the inner one. |
| Stop after silence | 5 s | With no proximity for this long, the Puck is set to 0. |
| Minimum time between updates | 20 ms | Faster changes are merged and the newest value is sent. |

## How it stops

A Puck keeps the last value it received until it gets another one, so the plugin is the
one that ends every buzz:

- A proximity of 0 sends 0 at once, four more times right after, then once a second.
- When the avatar stops sending for the time set in **Stop after silence**, the Puck is
  set to 0. VRChat only sends a contact when it moves, so a hand held perfectly still also
  stops after that time.
- Switching the plugin off, or closing OSC Flow Studio normally, sets every Puck to 0 at
  once.
- Turning the flow off, or the panic button (which switches every flow off), stops the
  input. Each Puck is then set to 0 within the silence time.

## Finding Pucks

The plugin asks the network the way the GiggleTech router does (multicast DNS, for
`giggletech.local` and for web services named GiggleTech, GigglePuck or GiggleSpark). It
tries three ways at once and uses whichever answers: a direct question, a listener on
the mDNS port when Windows lets another program share it, and Windows' own name lookup.
**Read status** tells which one found your Puck. A Puck that misses two searches in a
row is shown as offline.

When discovery cannot see a Puck, for example on another subnet, add it under
**Devices** with its IP address. Turn **Find Pucks on the network** off to use only
those.
