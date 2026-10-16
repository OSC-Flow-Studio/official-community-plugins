import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  addChangelogSection,
  bumpOptions,
  compareVersions,
  hasChangelogSection,
  publishedVersions,
  setManifestVersion,
  versionProblem,
} from "../scripts/versioning.mjs";

test("published versions come from the plugin's own tags, oldest first", () => {
  const tags = ["livepix-v2.0.10", "v0.0.1", "livepix-v2.0.2", "giggle-puck-v0.1.0", "livepix-v2.0.1-beta", "livepix-v1.9.0"];
  assert.deepEqual(publishedVersions(tags, "livepix"), ["1.9.0", "2.0.2", "2.0.10"]);
  assert.deepEqual(publishedVersions(tags, "giggle-puck"), ["0.1.0"]);
  assert.deepEqual(publishedVersions(tags, "unknown"), []);
  assert.ok(compareVersions("2.0.10", "2.0.9") > 0);
});

test("the offered bumps start from the highest of the manifest and the last release", () => {
  assert.deepEqual(bumpOptions("2.0.1", "2.0.1"), { patch: "2.0.2", minor: "2.1.0", major: "3.0.0" });
  assert.deepEqual(bumpOptions("2.0.1", undefined), { patch: "2.0.2", minor: "2.1.0", major: "3.0.0" });
  assert.deepEqual(bumpOptions("1.0.0", "1.4.2"), { patch: "1.4.3", minor: "1.5.0", major: "2.0.0" });
});

test("a release version is stable, unpublished and newer than the last release", () => {
  const published = ["2.0.0", "2.0.1"];
  assert.equal(versionProblem("2.0.2", published), null);
  assert.equal(versionProblem("0.1.0", []), null);
  assert.match(versionProblem("2.0.1", published), /already published/);
  assert.match(versionProblem("1.9.9", published), /not newer than 2\.0\.1/);
  for (const bad of ["2.0", "v2.0.2", "2.0.2-beta.1", "02.0.0", ""]) assert.match(versionProblem(bad, published), /stable X\.Y\.Z/, bad);
});

test("bumping the manifest changes only its version", () => {
  const text = readFileSync(new URL("../plugins/livepix/plugin/manifest.json", import.meta.url), "utf8");
  const next = setManifestVersion(text, "9.8.7");
  assert.equal(JSON.parse(next).version, "9.8.7");
  assert.deepEqual(next.split("\n").filter((line, i) => line !== text.split("\n")[i]), ['  "version": "9.8.7",']);
  assert.throws(() => setManifestVersion('{ "id": "x" }', "1.0.0"), /without touching anything else/);
});

test("a new changelog section goes above the newest one", () => {
  const text = "# Changelog\n\n## 2.0.1 (2026-09-22)\n\n- Old.\n";
  const next = addChangelogSection(text, "2.0.2", "2026-10-16", ["Fix the thing.", "- Already a bullet."]);
  assert.equal(next, "# Changelog\n\n## 2.0.2 (2026-10-16)\n\n- Fix the thing.\n- Already a bullet.\n\n## 2.0.1 (2026-09-22)\n\n- Old.\n");
  assert.ok(hasChangelogSection(next, "2.0.2"));
  assert.ok(!hasChangelogSection(next, "2.0.20"));
  assert.equal(addChangelogSection("# Changelog\n", "0.1.0", "2026-10-16", ["First."]), "# Changelog\n\n## 0.1.0 (2026-10-16)\n\n- First.\n");
  assert.throws(() => addChangelogSection(text, "2.0.2", "2026-10-16", []), /at least one/);
});
