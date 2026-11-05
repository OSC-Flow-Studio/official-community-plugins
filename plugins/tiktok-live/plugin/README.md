# TikTok LIVE

Turns a TikTok LIVE into OSC Flow Studio triggers. Gifts, battles, joins, follows, likes,
chat and milestones start flows, and actions and inputs let a flow read or steer the
connection and the session.

This is an unofficial integration. TikTok has no public API for LIVE events, so the plugin
reads the same events that LIVE alert tools read. It is not affiliated with TikTok, Euler
Stream or TikFinity.

## Set it up

1. Under **General**, type the TikTok username of the account that goes live. The `@` is
   optional.
2. Pick how to connect:
   - **Direct connection** (default): the plugin talks to TikTok itself. TikTok accepts
     only signed connections, and the signatures come from Euler Stream. Without a key the
     plugin shares Euler's free anonymous limit, which can make it wait a few minutes before
     connecting. A free key from eulerstream.com, pasted in the **Euler Stream** tab,
     raises that limit.
   - **TikFinity app**: open TikFinity on this computer and connect it to your LIVE. The
     plugin listens to TikFinity's local connection and needs nothing from Euler Stream.
3. Save. The plugin waits while the account is offline and connects when the LIVE starts.
   The status line under Integrations says what it is doing.

All blocks are in the **TikTok LIVE** group of the block palette. The three templates log
gifts, big gifts and battles to the console, which is a quick way to check the connection.

## Matching that works on any computer

Triggers match on ids, numbers and fixed values, never on displayed text. A gift is matched
by its gift id, which is the same in every language. Times are ISO 8601 in UTC. A flow built
on a Brazilian computer fires the same way on a Korean one.

The gift picker lists gifts the plugin has seen, so it fills up as gifts arrive and keeps
them between restarts. TikTok's full gift list needs a request that Euler Stream signs only
on its paid Business plans; with such a key, **TikTok: refresh gift list** loads it at once.
For a gift that is not listed yet, type its id in **Gift id**. **TikTok: gift lookup** and
`metadata.giftId` of an earlier gift both show it.

## Triggers

Every trigger with a viewer carries the viewer's `userId`, `uniqueId` (the @handle),
`nickname`, `followStatus` (none, follower or friend), `isModerator`, `isSubscriber`,
`gifterLevel`, `teamMemberLevel` and `topGifterRank`, plus `eventKey`, `occurredAt`,
`transport` and `roomId`.

| Trigger | When it fires |
| --- | --- |
| gift received | A gift counts. Streakable gifts count once, when the streak ends. Filter by gift, coins, coins per gift, streakable or not, whether it went to the streamer, and first gift of the viewer. |
| gift streak | Each tap of a streakable gift, then once at the end. |
| coin milestone | The session's coins, or one viewer's, pass a round number. |
| top gifter changed | Someone new holds first, second or third place. |
| treasure chest | A viewer drops a chest of coins. |
| viewer joined | A viewer enters. Tells a first visit from a rejoin and from a viewer of an earlier LIVE. |
| new follower, LIVE shared, new subscriber | What the names say. |
| likes, like milestone | Likes, and the LIVE's total passing a round number. |
| viewer count changed | The viewer count moves, with direction and milestones. |
| chat message, chat command | Chat, and messages that start with the command prefix (`!` by default) split into command and arguments. |
| question asked, emote sent, message pinned, messages removed | Q&A, subscriber emotes, pins and moderation. |
| super fan | A viewer becomes a super fan, moves up, or drops a super fan box. |
| battle | A battle starts, its score changes, the lead changes hands, or it ends. Scores and the result are from the streamer's side. |
| poll, LIVE goal, ranking update | The streamer's poll, LIVE goal and ranking places. |
| stream state | A new LIVE is reached, or the stream pauses, resumes, ends or is suspended. |
| connection changed | Connecting, connected, waiting for the LIVE, disconnected, error or stopped. |
| chat sent (BETA) | The result of sending a chat message. |
| other TikTok event | Off by default. Any TikTok message the plugin does not handle, as TikTok sent it. |

TikTok sends joins and likes in samples on busy LIVEs, so not every one arrives. A flow that
is still running drops the next trigger, so give frequent triggers (likes, viewer count,
gift streak) flows of their own.

## Actions and inputs

- **connect**, **disconnect**, **wait until live**: steer the connection.
- **refresh gift list**: load the full list (needs an Euler Stream Business key).
- **reset session**: start counters over. A new LIVE does this by itself unless
  **Reset per stream** is off.
- **connection status**, **LIVE stats**, **battle score**, **top gifters**, **viewer stats**,
  **gift lookup**: read the plugin's state.

## Sending chat (BETA)

Sending chat is BETA and off by default. It may stop working, and the plugin maintainers
can switch it off for every installed copy at any time. TikTok may suspend accounts that
post automatically, so use a secondary account.

TikTok has no API for sending chat. The plugin sends it through
[Euler Stream](https://www.eulerstream.com), a separate service with its own account and
prices. Sending needs Euler's Webcast Premium add-on, which the free trial does not include.
Everything is set up in the plugin settings, not in a flow:

1. **Euler Stream** tab: paste an API key that has the Webcast Premium add-on.
2. **Chat (BETA)** tab: turn on **Chat (BETA) enabled**.
3. Same tab: paste the `sessionid` and `tt-target-idc` cookies of the TikTok account that
   will post. To find them, sign in to tiktok.com in your browser with that account, press
   F12, open Application (Chrome, Edge) or Storage (Firefox), then Cookies,
   https://www.tiktok.com. Pasting `name=value` or a whole cookie line also works.

The two cookies sign in as the account, so treat them like a password. The Studio keeps them
in its encrypted vault and sends them only to Euler Stream, which posts each message. Signing
out of TikTok in that browser ends the session, and then the cookies stop working.

**TikTok: send chat message** does not need **TikTok: connect**. It only needs the streamer to
be live, and it works with either connection. When it does not try, `disabledReason` says why
with a fixed code, and `error` says the same in words and names the setting:

| `disabledReason` | What to change |
| --- | --- |
| `chat-off` | Turn on **Chat (BETA) enabled**. |
| `deprecated` | Nothing: the maintainers switched sending off, and `error` carries their note. |
| `missing-username` | Add the TikTok username under **General**. |
| `missing-api-key` | Add the Euler Stream API key. |
| `missing-cookies` | Add both cookies. |
| `invalid-cookies` | Copy the cookie values again. |

An empty `disabledReason` with `ok` false means it tried and failed. Examples are a streamer
who is not live, or a key without the add-on.

## What the plugin stores

In the Studio's encrypted vault: the session counters and gifter ranking, the gifts it has
learned, the ids of the last 2000 viewers (to recognise returning viewers), the last
feature switches it downloaded. The chat cookies and the Euler key are settings, which the
Studio also keeps in that vault.

## Third-party software

The direct connection uses tiktok-live-connector by zerodytrash
(https://github.com/zerodytrash/TikTok-Live-Connector) and tiktok-live-proto by isaackogan
(https://github.com/isaackogan/TikTok-Webcast-Protobuf), both AGPL-3.0 with additional
permissions, bundled in `vendor/`. Signatures come from Euler Stream
(https://www.eulerstream.com). The bridge listens to TikFinity
(https://tikfinity.zerody.one), which is not bundled. `vendor/NOTICE.md` lists every bundled
package with its license, and `vendor/THIRD_PARTY_LICENSES.txt` holds the full texts.

This plugin is licensed AGPL-3.0. Source:
https://github.com/OSC-Flow-Studio/official-community-plugins/tree/main/plugins/tiktok-live
