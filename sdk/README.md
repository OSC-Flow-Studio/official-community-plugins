# Bundled SDK

`ofs-package.mjs` and `community-plugin-manifest.schema.json` are unmodified copies
from the OSC Flow Studio **0.5.10** source SDK, including `appearance`, the `haptics`
capability and duration fields for blocks. A plugin that still declares an older Studio
in `engines` validates against them as long as it uses none of the newer fields. Every plugin
in this repository is validated and packed with them, and neither file goes into a
plugin's ZIP.

When updating the SDK, replace both files, review each plugin's runtime contract and
`engines.oscFlowStudio`, and run `npm run check`.
