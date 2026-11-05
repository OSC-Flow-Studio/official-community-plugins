# TikTok LIVE

TikTok LIVE events become OSC Flow Studio 1.x triggers. TikTok has no public LIVE API, so the
plugin reads the Webcast protocol through the bundled
[tiktok-live-connector](https://github.com/zerodytrash/TikTok-Live-Connector), signed by
[Euler Stream](https://www.eulerstream.com), or listens to the
[TikFinity](https://tikfinity.zerody.one) desktop app's local WebSocket.

| Contract | Value |
| --- | --- |
| Package id | `io.github.osc-flow-studio.tiktok-live` |
| Block and config id | `tiktok-live` |
| OSC Flow Studio | `>=1.0.0 <2.0.0` (plugin SDK 2) |
| Runtime SDK | API 2, permissions `secrets` and `resources`, network `any` |
| License | AGPL-3.0-only, because the bundled client is AGPL-3.0 |

The user guide that ships inside the ZIP is [plugin/README.md](plugin/README.md).
[PLAN.md](PLAN.md) is the design plan, with the research behind it.

## Layout

```text
plugin/                 the ZIP
  index.mjs             activate and deactivate
  runtime.mjs           events to triggers, actions, inputs, status
  normalize.mjs         protobuf (direct) and 1.x JSON (TikFinity) to one event model
  streaks.mjs battle.mjs session.mjs dedup.mjs gifts.mjs config.mjs util.mjs
  sources/              direct.mjs (tiktok-live-connector), tikfinity.mjs
  chat/                 BETA chat: flags.mjs (remote switch), sender.mjs (Euler Stream)
  vendor/               generated bundle, NOTICE.md, THIRD_PARTY_LICENSES.txt
  feature-flags.json    shipped defaults for the remote switches
build/                  not in the ZIP
  manifest.mjs          generates plugin/manifest.json
  bundle.mjs entry.mjs  build plugin/vendor/
  site.mjs site-src/    build site/, the landing page
site/                   generated landing page, committed
feature-flags.json      the switches every installed copy reads from main
tests/                  node:test suites and fixtures
```

## Commands

From the repository root:

```powershell
npm run bundle:tiktok-live      # npm ci in build/, then plugin/vendor/
npm run manifest:tiktok-live    # plugin/manifest.json from build/manifest.mjs
npm run site:tiktok-live        # site/ (after bundle, which installs build/) ; -- --serve for :4417
npm run check                   # every plugin's tests, these included
```

`plugin/manifest.json`, `plugin/vendor/` and `site/` are generated and committed. The tests
fail when the manifest and its generator disagree, when `vendor/NOTICE.md` names another
hash or version than the bundle, and when the landing page misses a block of the manifest.

### Updating tiktok-live-connector

Change the version in `build/package.json`, run `npm run bundle:tiktok-live` and
`npm run check`, and add a CHANGELOG line. `tests/vendor.test.mjs` loads the bundle under
`node --permission` with read access to `plugin/` only, as the Studio runs it. If the bundle
ever stops loading there, the TikFinity transport keeps working without it.

## Switching chat off for everyone

Sending chat is BETA. To disable it in every installed copy without a release, set
`"enabled": false` (and a short `message`) under `chat` in
[feature-flags.json](feature-flags.json) on `main`. Copies pick it up within six hours, or
at their next start, and keep the last answer when offline. `send-chat` then returns
`disabledReason: "deprecated"` with the message in `error`, and the plugin's status says so.

## Things measured on 2026-11-05

- Connecting without an Euler key works on the anonymous limit. Euler refuses the gift list
  (`enableExtendedGiftInfo`, `fetchAvailableGifts`) without a Business plan, so the plugin
  never asks for it at connect time and learns gifts instead.
- Request language comes from the connector's location preset; the plugin pins `en-US`.
- Real payloads behind `tests/fixtures/captured-proto.json` came from two public LIVEs and
  were anonymised. Battles, polls and goals did not occur there; their fixtures are built
  from the `tiktok-live-proto` 0.2.4 definitions.
- In a running Studio (dev build), the plugin installed from its ZIP, connected to a real
  LIVE, fired chat triggers into a flow, and its 41 blocks showed as one palette group.

## Tests

`npm test` runs these suites without a TikTok account or network: normalisation of real and
built messages, streaks, battles, the session and its persistence, the runtime with a fake
transport, the direct transport with a fake library, the TikFinity bridge against a real
WebSocket server, sending chat with and without a connection, the manifest contract (every
trigger fires with exactly its declared fields, every action returns exactly its outputs),
the bundle in the sandbox, and identical output under pt-BR, de-DE and en-US locales.
