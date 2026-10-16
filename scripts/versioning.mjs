import { isDeepStrictEqual } from "node:util";
import { parseTag } from "./plugins.mjs";

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** `"2.0.1"` -> `[2, 0, 1]`; anything but a stable X.Y.Z is `null`. */
export function parseVersion(version) {
  const match = STABLE.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) throw new Error(`Cannot compare ${a} with ${b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Versions published for one plugin, read from its `<id>-v<version>` tags, oldest first. */
export function publishedVersions(tags, id) {
  return tags.map(parseTag).filter((tag) => tag?.id === id)
    .map((tag) => tag.version).sort(compareVersions);
}

/** The next patch, minor and major after the highest of the given versions. */
export function bumpOptions(...versions) {
  const [major, minor, patch] = parseVersion(versions.filter(Boolean).sort(compareVersions).at(-1));
  return {
    patch: `${major}.${minor}.${patch + 1}`,
    minor: `${major}.${minor + 1}.0`,
    major: `${major + 1}.0.0`,
  };
}

/** Why `version` cannot be released next, or `null` when it can. */
export function versionProblem(version, published) {
  if (!parseVersion(version)) return "use a stable X.Y.Z version";
  if (published.includes(version)) return `${version} is already published`;
  const latest = published.at(-1);
  if (latest && compareVersions(version, latest) <= 0) return `${version} is not newer than ${latest}`;
  return null;
}

/** Changes only the manifest's top-level version, keeping every other byte as it was. */
export function setManifestVersion(text, version) {
  const before = JSON.parse(text);
  const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  const after = JSON.parse(next);
  if (after.version !== version || !isDeepStrictEqual({ ...after, version: before.version }, before)) {
    throw new Error("Could not change the manifest version without touching anything else");
  }
  return next;
}

export function hasChangelogSection(text, version) {
  return text.split(/\r?\n/).some((line) => line === `## ${version}` || line.startsWith(`## ${version} `));
}

/** Adds `## <version> (<date>)` with the given bullet lines above the newest section. */
export function addChangelogSection(text, version, date, notes) {
  if (notes.length === 0) throw new Error("A release needs at least one changelog line");
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((line) => line.startsWith("## "));
  const at = first >= 0 ? first : lines.length;
  const section = [`## ${version} (${date})`, "", ...notes.map((note) => `- ${note.replace(/^[-*]\s+/, "")}`), ""];
  const head = lines.slice(0, at);
  while (head.length > 0 && head.at(-1) === "") head.pop();
  return [...(head.length > 0 ? [...head, ""] : []), ...section, ...lines.slice(at)].join("\n");
}
