# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Plugin pages are plain HTML and CSS with no framework. The TikTok LIVE chat sign-in pages
are self-contained strings served from 127.0.0.1 by the plugin: inline CSS, no external
requests. The TikTok LIVE landing page (`plugins/tiktok-live/site/`) is static HTML and CSS
with GSAP bundled by esbuild from `plugins/tiktok-live/build/`; it has no deploy target yet.

## Users

Streamers who already run OSC Flow Studio (VRChat, OSC, avatars, haptics) and want their
TikTok LIVE to drive the flows they have: gifts, battles, joins and follows reacting on the
avatar, the overlay or a device. They configure the plugin once in the Studio, then live
with it during streams.

## Product Purpose

This repository publishes the official community plugins of OSC Flow Studio through one
signed catalog. The TikTok LIVE plugin turns events of a TikTok LIVE into Studio triggers,
gives flows actions and inputs about the stream, and keeps working across reconnects and
restarts. Success: a streamer builds a gift or battle reaction as a flow without scripts and
trusts it to fire once per event, on any computer, in any language.

## Positioning

First, TikTok LIVE events become visual Studio flows wired to OSC, avatars, haptics and the
Studio's other integrations, with no scripts. Second, each event carries more than the
usual alert tools give: the sender's session rank and coins, coin, like and viewer
milestones, battle scores from the host's side, returning viewers.

## Operating Context

- Configured in the Studio under Integrations; blocks are used in the Studio's flow editor.
- Two transports: a direct connection through the bundled tiktok-live-connector (signed by
  Euler Stream), or the TikFinity desktop app's local WebSocket.
- Used live, often in VR, where a streamer cannot debug; status lines and the connection
  trigger have to explain problems in plain words.

## Capabilities and Constraints

- Unofficial: TikTok has no public LIVE events API; the plugin reads the same Webcast
  protocol every alert tool uses. Not affiliated with TikTok.
- All plugin text is English. Matching never depends on the host locale or on TikTok's
  display text.
- The gift list endpoint and sending chat need paid Euler Stream plans; gifts are learned as
  they arrive. Sending chat is BETA, off by default, and can be switched off remotely.
- Third-party software is credited, with repository links, in the plugin settings, the
  READMEs and the landing page.

## Brand Commitments

- Follows OSC Flow Studio: same name and tone, the Studio's neutral palette and type, the
  plugin's catalog accent (pink for TikTok LIVE).
- No TikTok logo, stylised name or brand colours anywhere.

## Evidence on Hand

- No testimonials, customer names, usage numbers or press exist. Do not invent any.
- Real screenshots of the Studio flow editor can be captured from the dev UI.

## Product Principles

1. A flow fires once per real event, or says why it did not.
2. Nothing a streamer matches on changes with language or locale.
3. Say what is unofficial, paid or unstable before the person relies on it.
4. Credit the software the plugin is built on, where people look.
