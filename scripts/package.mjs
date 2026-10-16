import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packPluginDir } from "../sdk/ofs-package.mjs";
import { root, selectPlugins } from "./plugins.mjs";

/** Packs `plugins/<id>/plugin/` into `dist/<packageId>-<version>.zip` plus its `.sha256`. */
export function packagePlugins(ids = [], outDir = join(root, "dist")) {
  return selectPlugins(ids).map(({ pluginDir }) => packPluginDir(pluginDir, outDir));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const packed of packagePlugins(process.argv.slice(2))) console.log(`${packed.path} ${packed.sha256}`);
}
