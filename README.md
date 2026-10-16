# OSC Flow Studio community plugins

Community plugins for [OSC Flow Studio](https://github.com/OSC-Flow-Studio), published
together through one catalog. Follow the catalog once and every plugin in it shows up
in the Studio; you install only the ones you want, and each one updates on its own.

| Plugin | Folder | Package id | Studio |
| --- | --- | --- | --- |
| LivePix | [plugins/livepix](plugins/livepix) | `io.github.osc-flow-studio.livepix` | `>=0.5.4 <0.6.0` |
| Giggle Puck | [plugins/giggle-puck](plugins/giggle-puck) | `io.github.osc-flow-studio.giggle-puck` | `>=0.5.10 <0.6.0` |

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

`npm run test:host-contract` runs each plugin's flows through the real Studio flow engine.
It expects built `osc-flow-studio` and `catopanda-subathon` checkouts next to this
repository; set `OSC_FLOW_STUDIO_ROOT` and `CATOPANDA_SUBATHON_ROOT` to point elsewhere.
CI does not run it.

## Release a plugin

Owner: a maintainer with write access to this repository. The repository must stay
public so the Studio can download the catalog and the ZIPs, and GitHub Actions must be
enabled. The release workflow uses `GITHUB_TOKEN` with `contents: write` and no other
secret.

Each plugin has its own version, in `version` of `plugins/<id>/plugin/manifest.json`, and
is released by a tag made of its id, `-v`, and that version (`livepix-v2.0.1`). A
repository tag such as `v0.0.1` publishes nothing.

From a clean working tree on the branch you release from, run:

```powershell
npm run release
```

It lists the plugins with their manifest and last published versions, asks which plugin
and which version (the current manifest version when it was never published, the next
patch, minor or major, or one you type), and asks for the changelog lines when
`CHANGELOG.md` has no section for that version. Then it sets the manifest version, adds
the section, runs `npm run check`, shows the git commands and, once you confirm, commits
`🧹 Chore: Release <name> <version>`, creates the annotated tag and pushes the branch and
the tag together. A failed check, a cancel or closed input restores both files.
`npm run release -- --dry-run` does everything except the git commands.

To release by hand instead: set the version, add a `## <version>` section to the
plugin's `CHANGELOG.md` (its text becomes the release notes), push, wait for **Validate
plugins**, then push the tag:

```powershell
git tag -a livepix-v2.0.2 -m "LivePix 2.0.2"
git push origin livepix-v2.0.2
```

**Release a community plugin** validates again, packs that one plugin, downloads
`listing.json` from the latest release (whichever plugin published it), adds the new
version and keeps every version already listed. It creates a draft holding the ZIP, its
SHA-256 and the catalog, then publishes the draft and marks it latest, so the stable
catalog URL serves the new catalog and never points at a missing ZIP. Releases share one
concurrency group, so two tags pushed together publish one after the other.

Stop if validation fails, the tag does not match the manifest version, the latest
release has no `listing.json`, or a release with the same tag exists. Never replace a
published ZIP: bump the version and use a new tag. If the workflow stops after creating
the draft, check its three assets on GitHub and publish that draft by hand. Mark it
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
