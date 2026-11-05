# OSC Flow Studio community plugins

Community plugins for [OSC Flow Studio](https://github.com/OSC-Flow-Studio), published
together through one catalog. Follow the catalog once and every plugin in it shows up
in the Studio; you install only the ones you want, and each one updates on its own.

| Plugin | Folder | Package id | Studio |
| --- | --- | --- | --- |
| LivePix | [plugins/livepix](plugins/livepix) | `io.github.osc-flow-studio.livepix` | `>=1.0.0 <2.0.0` |
| Giggle Puck | [plugins/giggle-puck](plugins/giggle-puck) | `io.github.osc-flow-studio.giggle-puck` | `>=1.0.0 <2.0.0` |
| TikTok LIVE | [plugins/tiktok-live](plugins/tiktok-live) | `io.github.osc-flow-studio.tiktok-live` | `>=1.0.0 <2.0.0` |

## Install a plugin

1. In OSC Flow Studio, open **Integrations → Sources** and add this catalog:

   ```text
   https://github.com/OSC-Flow-Studio/official-community-plugins/releases/latest/download/listing.json
   ```

2. Open **Catalog**, pick a plugin and review the install plan. The Studio verifies the
   ZIP's SHA-256 and size against the catalog before anything is written.
3. Configure and enable the plugin in **Integrations**. Each plugin's README covers its
   own setup.

New versions arrive through the same source. An update to a plugin that is running is
prepared and applied when you restart the backend from the Studio.

Giggle Puck replaces the GiggleTech router. Do not run both: they listen on the same OSC
port, and only one of them receives from VRChat.

## Repository layout

```text
plugins/<id>/
  plugin/          exactly what the ZIP contains, with manifest.json at its root
  tests/           node:test suites; tests/host/ needs a Studio checkout
  CHANGELOG.md     one "## <version>" section per release
  README.md        notes for maintainers
sdk/               the Studio's packer and manifest schema, shared by every plugin
scripts/           validate, package, catalog and release
tests/             rules every plugin and the catalog must keep
```

The folder name is the plugin `id`. Neither the folder, the tests nor the SDK end up in
a ZIP.

## Develop

Requires Node.js 22 or newer and npm. The Studio runs plugins on its own runtime; Node.js
is only needed here.

```powershell
npm ci
npm run check                 # schema, install rules and every test
npm run package -- livepix    # dist/<packageId>-<version>.zip and .sha256
npm run catalog -- livepix    # dist/listing.json, a local preview
```

Leave the plugin id out to act on every plugin. `npm run package` runs `npm run check`
first.

TikTok LIVE bundles an npm dependency, so it has a build tree of its own in
`plugins/tiktok-live/build/`. `npm run bundle:tiktok-live` installs it and regenerates
`plugin/vendor/`; `npm run manifest:tiktok-live` and `npm run site:tiktok-live` regenerate
its manifest and landing page. The outputs are committed, so `npm run check` needs none of
them; see [plugins/tiktok-live/README.md](plugins/tiktok-live/README.md).

`npm run test:host-contract` runs each plugin's flows through the real Studio flow engine.
It expects built `osc-flow-studio` and `catopanda-subathon` checkouts next to this
repository; set `OSC_FLOW_STUDIO_ROOT` and `CATOPANDA_SUBATHON_ROOT` to point elsewhere.
CI does not run it.

## What a plugin may do

Every plugin here is built for plugin SDK 2: `apiVersion: 2` and a `permissions` block in
its manifest. The Studio runs each plugin in a process of its own that can read only its
own folder, and hands it a key that carries exactly those permissions. The install dialog
lists them before the person agrees.

| Plugin | `secrets` | `resources` | `haptics` | `processes` | `network` |
|---|---|---|---|---|---|
| livepix | yes | no | no | no | `any` (LivePix and the dashboard address you configure) |
| giggle-puck | no | yes | yes | no | `local` (multicast DNS and OSC to the Pucks) |
| tiktok-live | yes | yes | no | no | `any` (TikTok and Euler Stream, or the local TikFinity app) |

The Studio cannot enforce `network`, so `npm run validate` does: a plugin whose code
imports a socket module, or calls `fetch` or `WebSocket`, cannot declare `"none"`, and
one that uses UDP or raw sockets must allow the local network. A new permission, or a
wider network level, is a reason for a major version and a changelog line that says so.

## Release a plugin

Owner: a maintainer with write access to this repository. The repository must stay
public so the Studio can download the catalog and the ZIPs, and GitHub Actions must be
enabled. The release workflow uses `GITHUB_TOKEN` with `contents: write` and no other
secret.

Each plugin has its own version, in `version` of `plugins/<id>/plugin/manifest.json`, and
is released by a tag made of its id, `-v`, and that version (`livepix-v2.0.1`). A
repository tag such as `v0.0.1` publishes nothing.

### Signing

Every release is signed, so OSC Flow Studio can show the package as published by the OSC
Flow Studio team instead of an unreviewed community plugin. The signature is an Ed25519
statement over the package id, the version and the SHA-256 and size of the ZIP; it proves
who published those exact bytes and grants the plugin nothing else.

The private key lives in `.env` on the maintainer's machine and is never committed. Create
it once:

```powershell
npm run keygen
```

That writes `OFS_SIGNING_KEY_ID` and `OFS_SIGNING_PRIVATE_KEY` to `.env` (see
`.env.example`) and adds the public key to `scripts/official-keys.json`, which is
committed. Keep a backup of `.env` somewhere safe. OSC Flow Studio only trusts keys
compiled into it (`OFFICIAL_PUBLISHER_KEYS` in
`apps/backend/src/packages/package-attestation.ts`), so a new key reaches users with an
app update. `keygen` never replaces a key that is already in `.env`.

The ZIP is reproducible. `npm run release` signs it locally and commits
`plugins/<id>/signatures/<version>.json`; the release workflow rebuilds the ZIP from the
tagged commit, refuses to publish when that signature is missing, made with an unknown
key, or covers other bytes, and publishes it next to the ZIP as `<zip>.sig`. The key never
reaches GitHub.

From a clean working tree on the branch you release from, run:

```powershell
npm run release
```

Pick the plugin and the version with the arrow keys and Enter: the current manifest
version when it was never published, the next patch, minor or major, or one you type.
When `CHANGELOG.md` has no section for that version, type its lines (Enter twice to
finish). It then sets the manifest version, adds the section, runs `npm run check`, and
shows the release plan with the exact git commands. Once you confirm, it commits
`🧹 Chore: Release <name> <version>`, creates the annotated tag and pushes the branch and
the tag together. Ctrl+C, a "No" or a failed check restores both files.

The same release without questions, for scripts and CI:

```powershell
npm run release -- --plugin livepix --version patch --notes "Fix the reconnect timer" --yes
npm run release -- --plugin livepix --version 2.1.0 --dry-run
```

`--version` takes `patch`, `minor`, `major`, `current` or an exact version, and `--notes`
can be repeated. Without a terminal, every answer must come as a flag, plus `--yes` or
`--dry-run`. `--dry-run` does everything except the git commands, and `--help` lists the
options.

To release by hand instead: set the version, add a `## <version>` section to the
plugin's `CHANGELOG.md` (its text becomes the release notes), sign the build, commit
everything, push, wait for **Validate plugins**, then push the tag:

```powershell
npm run sign -- livepix
git tag -a livepix-v2.0.2 -m "LivePix 2.0.2"
git push origin livepix-v2.0.2
```

**Release a community plugin** validates again, packs that one plugin, downloads
`listing.json` from the latest release (whichever plugin published it), adds the new
version and keeps every version already listed. It checks the signature against the ZIP
it built, creates a draft holding the ZIP, its SHA-256, its signature and the catalog,
then publishes the draft and marks it latest, so the stable
catalog URL serves the new catalog and never points at a missing ZIP. Releases share one
concurrency group, so two tags pushed together publish one after the other.

Stop if validation fails, the signature does not hold, the tag does not match the
manifest version, the latest release has no `listing.json`, or a release with the same tag
exists. Never replace a
published ZIP: bump the version and use a new tag. If the workflow stops after creating
the draft, check its four assets on GitHub and publish that draft by hand. Mark it
latest.

To rebuild the catalog by hand from a copy of the public one:

```powershell
npm run package -- livepix
npm run catalog -- livepix --previous path/to/listing.json
```

Without `--previous`, the result lists only what is in `dist/` and would drop every
earlier version and every other plugin.

## Add a plugin

1. Create `plugins/<id>/` with `plugin/manifest.json`, `CHANGELOG.md`, `README.md` and
   `tests/`. The `id` is dot-free (`^[a-z0-9][a-z0-9-]{1,40}$`) and names the folder.
2. In the manifest, set `packageId` (for example `io.github.osc-flow-studio.<id>`),
   `author`, a real `engines.oscFlowStudio` range, and `repository` to
   `https://github.com/OSC-Flow-Studio/official-community-plugins`. Point `homepage` and
   `changelogUrl` at the plugin's folder.
3. Run `npm run check`. It refuses a duplicate `packageId`, a prerelease version, a
   manifest whose `id` differs from its folder, or a `repository` that is not this one.
4. Release it with its first tag, `<id>-v<version>`.

The Studio refuses community plugins that drive shock hardware: the `safety-notice`
capability and any node type the hazard registry rates above `none` are rejected at
install.

A plugin moving here from a repository of its own keeps its `packageId` and `id`. A new
value of either is a different plugin to the Studio, with its own settings and secrets.
Installations made from the old repository's catalog stay bound to that catalog and do
not receive versions published here.
