# Changelog

## 0.1.0

- First release. TikTok LIVE events as 27 triggers: gifts by gift or by coins, gift streaks, coin, like and viewer milestones, top gifter changes, treasure chests, joins with returning viewers, follows, shares, subscriptions, likes, viewer count, chat and chat commands, questions, emotes, pins, removed messages, super fans, battles from the streamer's side, polls, LIVE goals, rankings, stream state and connection state.
- 8 actions and 6 inputs: connect, disconnect, wait until live, refresh gift list, reset session, and reading status, LIVE stats, battle score, top gifters, viewer stats and gifts.
- Direct connection through tiktok-live-connector 2.5.0 with Euler Stream signing, or the TikFinity app's local bridge.
- Matching never depends on the computer's language or time zone.
- Sending chat is BETA, off by default, and can be switched off remotely by the maintainers.
- New permissions: `secrets`, `resources` and network `any`.
