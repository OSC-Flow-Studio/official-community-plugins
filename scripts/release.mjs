// Called only by the tag workflow. Running this script publishes a GitHub release.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repository, writeCatalog } from "./build-catalog.mjs";
import { packagePlugins } from "./package.mjs";
import { parseTag, readPlugin, root } from "./plugins.mjs";

const runGh = (...args) => execFileSync("gh", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

/** The `## <version>` section of a plugin's CHANGELOG.md, without its heading. */
export function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `## ${version}` || line.startsWith(`## ${version} `));
  if (start < 0) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim() + "\n";
}

export async function publishRelease({
  environment = process.env,
  gh = runGh,
  fetchPublic = fetch,
  pack = packagePlugins,
  createCatalog = writeCatalog,
  outDir = join(root, "dist"),
} = {}) {
  const tag = environment.GITHUB_REF?.startsWith("refs/tags/") ? environment.GITHUB_REF.slice("refs/tags/".length) : "";
  const parsed = parseTag(tag);
  if (environment.GITHUB_REPOSITORY !== repository || !parsed) {
    throw new Error(`A release needs a <plugin-id>-v<version> tag in ${repository}`);
  }
  const { manifest, dir } = readPlugin(parsed.id);
  if (manifest.version !== parsed.version) {
    throw new Error(`${tag} does not match plugins/${parsed.id} version ${manifest.version}`);
  }
  const notes = releaseNotes(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), manifest.version);
  const releases = JSON.parse(gh("api", `repos/${repository}/releases`, "--paginate", "--slurp")).flat();
  if (releases.some((release) => release.tag_name === tag)) {
    throw new Error(`${tag} already exists. Never overwrite artifacts; bump the version or finish the existing draft.`);
  }
  // Every release carries the whole catalog, so the latest one is the catalog of every plugin.
  const latest = releases.filter((release) => !release.draft && !release.prerelease)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  let previous;
  if (latest) {
    const asset = latest.assets.find((item) => item.name === "listing.json");
    if (!asset) throw new Error(`${latest.tag_name} has no listing.json; restore the catalog before publishing`);
    const response = await fetchPublic(asset.browser_download_url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Could not read the public catalog: HTTP ${response.status}`);
    previous = await response.json();
  }
  const [archive] = pack([parsed.id]);
  const catalog = createCatalog({ ids: [parsed.id], previous });
  mkdirSync(outDir, { recursive: true });
  const notesFile = join(outDir, "release-notes.md");
  writeFileSync(notesFile, notes);
  // The catalog and ZIP become public together: no public catalog points at a missing ZIP.
  gh("release", "create", tag, archive.path, `${archive.path}.sha256`, catalog,
    "--repo", repository, "--verify-tag", "--draft", "--title", `${manifest.name} ${manifest.version}`,
    "--notes-file", notesFile);
  gh("release", "edit", tag, "--repo", repository, "--draft=false", "--latest");
  return `https://github.com/${repository}/releases/tag/${tag}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Published: ${await publishRelease()}`);
}
