# Changelog

## 0.0.1 (2026-11-05)

- First commit. New plugin

## 0.1.0

- First release. TikTok LIVE events as 27 triggers: gifts by gift or by coins, gift streaks, coin, like and viewer milestones, top gifter changes, treasure chests, joins with returning viewers, follows, shares, subscriptions, likes, viewer count, chat and chat commands, questions, emotes, pins, removed messages, super fans, battles from the streamer's side, polls, LIVE goals, rankings, stream state and connection state.
- 8 actions and 6 inputs: connect, disconnect, wait until live, refresh gift list, reset session, and reading status, LIVE stats, battle score, top gifters, viewer stats and gifts.
- Direct connection through tiktok-live-connector 2.5.0 with Euler Stream signing, or the TikFinity app's local bridge.
- Matching never depends on the computer's language or time zone.
- Sending chat is BETA, off by default, and can be switched off remotely by the maintainers.
- New permissions: `secrets`, `resources` and network `any`.

## 0.1.1

- Fix: Let the TikTok LIVE chat sign-in page save its own form
- The page sent Referrer-Policy: no-referrer, so Chrome posted the form with
"Origin: null" and the origin check refused every save with "Nothing was saved".The page now uses same-origin, and the check trusts Sec-Fetch-Site first, falling back to Origin only when a client sends no fetch metadata.
- The plugin SDK cannot open a browser, so the sign-in address is now the first line of the plugin's status, which is the only line the Studio shows. The block, the setting and the user guide say to open it yourself instead of promising it opens.

## 0.1.2

♻️ Refactor: Set up TikTok LIVE chat in the plugin settings, not with sign-in blocks

The chat sign-in and sign-out blocks and their 127.0.0.1 page are removed. The
sessionid and tt-target-idc cookies are now secret settings in the Chat (BETA) tab,
with steps to copy them, and the Euler Stream key has its own tab that says Euler is
a separate, paid service. Cookies saved by the old page are deleted from the vault.

Sending chat no longer needs a connection or the direct transport. A short-lived
client with the cookies checks that the streamer is live, looks up the room and
posts, reusing the room when the plugin is already connected. disabledReason is
now a fixed code (chat-off, deprecated, missing-username, missing-api-key,
missing-cookies, invalid-cookies), and error names the setting to change. Euler
refuses chat without its Webcast Premium add-on, and the messages say so.

Breaking: flows that use the chat sign-in or sign-out blocks lose those nodes.
