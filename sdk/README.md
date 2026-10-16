# Bundled SDK

`ofs-package.mjs` and `community-plugin-manifest.schema.json` are unmodified copies
from the OSC Flow Studio **0.5.4** source SDK, including native date fields. Every plugin
in this repository is validated and packed with them, and neither file goes into a
plugin's ZIP.

When updating the SDK, replace both files, review each plugin's runtime contract and
`engines.oscFlowStudio`, and run `npm run check`.
