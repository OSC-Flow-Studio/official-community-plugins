# Bundled SDK

`ofs-package.mjs` and `community-plugin-manifest.schema.json` are unmodified copies of
`examples/plugins/tools/ofs-package.mjs` and `examples/plugins/community-plugin-manifest.schema.json`
from OSC Flow Studio 1.0.2, which speaks **plugin SDK 2**: plugins with code declare
`apiVersion: 2` and a `permissions` block (`secrets`, `resources`, `haptics`, `processes`,
`network`), run in a process of their own, and need Studio 1.0.0 or newer. The copies also
cover `appearance`, the `haptics` capability, duration fields, and the per-block
`delayBefore` and `cooldown` settings in templates. Every plugin in this repository is
validated and packed with them, and neither file goes into a plugin's ZIP.

When updating the SDK, replace both files, review each plugin's runtime contract and
`engines.oscFlowStudio`, and run `npm run check`.
