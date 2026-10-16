# LivePix

Every LivePix donation triggers a flow in OSC Flow Studio 0.5.x. Donations reach the
plugin through the **OSC LivePix Dashboard** (`https://livepix.maned.club`), which
receives the LivePix webhook, stores each donation and delivers it over WebSocket, with
the dashboard API as the fallback while the socket is down.

| Contract | Value |
| --- | --- |
| Package id | `io.github.osc-flow-studio.livepix` |
| Block and config id | `livepix` |
| OSC Flow Studio | `>=0.5.4 <0.6.0` (native date fields) |
| Runtime SDK | API 1 |
| Dashboard | [OSC-Flow-Studio/livepix-dashboard](https://github.com/OSC-Flow-Studio/livepix-dashboard) |

The user guide that ships inside the ZIP, in Portuguese, is
[plugin/README.md](plugin/README.md): setup, blocks, donation recovery and the upgrade
from 1.x.

## Moved from livepix-plugin

Versions up to 2.0.0 were published from `OSC-Flow-Studio/livepix-plugin`. The package
id, the plugin id, the block types, the trigger format and the `livepix-state-v1` vault
key are unchanged, so flows and the processed-donation ledger keep working. Versions from
2.0.1 on are published only through this repository's catalog.

## Tests

`npm test` at the repository root runs these suites against a fake dashboard with real
HTTP and WebSocket: the subathon start, deduplication by id across restarts, the API
fallback, reconnection, the 1.2.0 state migration, a refused token, and the WebSocket
client (fragmented, large and ping frames). None of them uses a LivePix account.

`npm run test:host-contract` runs the donation, sync and status outputs through the real
Studio flow engine and the bundled CatOPanda Subathon template, including replay after a
restart. It needs built `osc-flow-studio` and `catopanda-subathon` checkouts; see the
root [README](../../README.md#develop).
