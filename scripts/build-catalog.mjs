import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildListingFromSource, readManifestFromZip } from "../sdk/ofs-package.mjs";
import { readPlugin, root, selectPlugins, tagFor, zipName } from "./plugins.mjs";

export const repository = "OSC-Flow-Studio/official-community-plugins";
export const catalogUrl = `https://github.com/${repository}/releases/latest/download/listing.json`;
export const catalogSource = {
  id: "osc-flow-studio-community",
  name: "OSC Flow Studio community plugins",
  url: catalogUrl,
  author: { name: "OSC Flow Studio", url: "https://github.com/OSC-Flow-Studio" },
};

export const artifactUrl = (manifest) =>
  `https://github.com/${repository}/releases/download/${tagFor(manifest)}/${zipName(manifest)}`;

/**
 * Builds the catalog for the given ZIPs. With `previous` (the public catalog), the new
 * versions are added to it and every version already published is kept as it was.
 */
export function buildCatalog({ zipPaths, previous, publishedAt = new Date().toISOString() }) {
  const packages = zipPaths.map((zip) => {
    const manifest = readManifestFromZip(readFileSync(resolve(root, zip)));
    const own = readPlugin(manifest.id).manifest;
    if (own.packageId !== manifest.packageId) {
      throw new Error(`${zip} is ${manifest.packageId}, but plugins/${manifest.id} publishes ${own.packageId}`);
    }
    return { zip, url: artifactUrl(manifest), publishedAt };
  });
  const listing = buildListingFromSource({ ...catalogSource, packages }, root);
  if (previous === undefined) return listing;

  if (previous?.schemaVersion !== 1 || previous.id !== listing.id || previous.url !== catalogUrl
    || typeof previous.packages !== "object" || previous.packages === null) {
    throw new Error("The previous catalog does not belong to this source");
  }
  const merged = structuredClone(previous.packages);
  for (const [packageId, bucket] of Object.entries(listing.packages)) {
    const versions = merged[packageId]?.versions ?? {};
    for (const [version, entry] of Object.entries(bucket.versions)) {
      if (versions[version]) throw new Error(`${packageId} ${version} is already published; bump the version`);
      versions[version] = entry;
    }
    merged[packageId] = { versions };
  }
  // The app refuses two installed packages with the same plugin id, so the catalog never offers them.
  const owners = new Map();
  for (const [packageId, bucket] of Object.entries(merged)) {
    for (const entry of Object.values(bucket.versions)) {
      const owner = owners.get(entry.manifest.id);
      if (owner && owner !== packageId) {
        throw new Error(`${packageId} and ${owner} both use the plugin id "${entry.manifest.id}"`);
      }
      owners.set(entry.manifest.id, packageId);
    }
  }
  return { ...listing, packages: merged };
}

/** Writes `dist/listing.json` from the ZIPs `npm run package` left in `dist/`. */
export function writeCatalog({ ids = [], previous } = {}) {
  const zipPaths = selectPlugins(ids).map(({ manifest }) => join(root, "dist", zipName(manifest)));
  const listing = buildCatalog({ zipPaths, previous });
  mkdirSync(join(root, "dist"), { recursive: true });
  const output = join(root, "dist", "listing.json");
  writeFileSync(output, JSON.stringify(listing, null, 2) + "\n");
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const index = args.indexOf("--previous");
  const previous = index >= 0 ? JSON.parse(readFileSync(args[index + 1], "utf8")) : undefined;
  const ids = index >= 0 ? args.filter((_, i) => i !== index && i !== index + 1) : args;
  console.log(writeCatalog({ ids, previous }));
}
