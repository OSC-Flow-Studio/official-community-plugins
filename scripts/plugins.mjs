import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const pluginsDir = join(root, "plugins");

// The app's rule for community ids: dot-free, so no plugin can mint a core vault id.
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** One plugin of this repository: `plugins/<id>/plugin/` is exactly what its ZIP contains. */
export function readPlugin(id) {
  if (!PLUGIN_ID.test(id)) throw new Error(`"${id}" is not a community plugin id`);
  const dir = join(pluginsDir, id);
  const pluginDir = join(dir, "plugin");
  const manifestPath = join(pluginDir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`plugins/${id} has no plugin/manifest.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.id !== id) throw new Error(`plugins/${id} holds the manifest of "${manifest.id}"; the folder must be named after the plugin id`);
  return { id, dir, pluginDir, manifest };
}

export function listPlugins() {
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map(readPlugin);
}

/** The plugins named on the command line, or every plugin when none is named. */
export function selectPlugins(ids) {
  return ids.length > 0 ? ids.map(readPlugin) : listPlugins();
}

export const zipName = (manifest) => `${manifest.packageId}-${manifest.version}.zip`;
export const tagFor = (manifest) => `${manifest.id}-v${manifest.version}`;

const TAG = /^([a-z0-9][a-z0-9-]{1,40})-v(\d+\.\d+\.\d+)$/;

/** `livepix-v2.0.1` -> `{ id: "livepix", version: "2.0.1" }`; anything else is not a release tag. */
export function parseTag(tag) {
  const match = TAG.exec(tag);
  return match ? { id: match[1], version: match[2] } : null;
}
