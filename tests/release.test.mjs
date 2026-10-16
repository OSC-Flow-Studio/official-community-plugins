import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishRelease, releaseNotes } from "../scripts/release.mjs";
import { repository } from "../scripts/build-catalog.mjs";
import { readPlugin } from "../scripts/plugins.mjs";

const { manifest } = readPlugin("livepix");
const tag = `livepix-v${manifest.version}`;
const environment = { GITHUB_REPOSITORY: repository, GITHUB_REF: `refs/tags/${tag}` };
const archive = { path: "dist/livepix.zip" };

function withOutDir(run) {
  const outDir = mkdtempSync(join(tmpdir(), "community-release-"));
  return Promise.resolve(run(outDir)).finally(() => rmSync(outDir, { recursive: true, force: true }));
}

test("the first release assembles every asset in a draft before making the catalog public", () => withOutDir(async (outDir) => {
  const calls = [];
  const url = await publishRelease({
    environment,
    outDir,
    gh: (...args) => { calls.push(args); return args[0] === "api" ? "[[]]" : ""; },
    pack: (ids) => { assert.deepEqual(ids, ["livepix"]); return [archive]; },
    createCatalog: ({ ids, previous }) => { assert.deepEqual(ids, ["livepix"]); assert.equal(previous, undefined); return "dist/listing.json"; },
    fetchPublic: () => { throw new Error("The first release must not fetch a previous catalog"); },
  });
  assert.equal(url, `https://github.com/${repository}/releases/tag/${tag}`);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].slice(0, 6), ["release", "create", tag, archive.path, `${archive.path}.sha256`, "dist/listing.json"]);
  assert.ok(calls[1].includes("--draft"));
  assert.ok(calls[1].includes("--verify-tag"));
  assert.equal(calls[1][calls[1].indexOf("--title") + 1], `LivePix ${manifest.version}`);
  const notes = readFileSync(calls[1][calls[1].indexOf("--notes-file") + 1], "utf8");
  const changelog = readFileSync(new URL("../plugins/livepix/CHANGELOG.md", import.meta.url), "utf8");
  assert.equal(notes, releaseNotes(changelog, manifest.version));
  assert.doesNotMatch(notes, /^## /m);
  assert.ok(calls[2].includes("--draft=false"));
  assert.ok(calls[2].includes("--latest"));
}));

test("a release builds on the latest public catalog, whichever plugin published it", () => withOutDir(async (outDir) => {
  const previous = { schemaVersion: 1, history: "kept" };
  const latest = { tag_name: "giggle-puck-v0.1.0", published_at: "2026-10-01T00:00:00Z", assets: [{ name: "listing.json", browser_download_url: "https://example.com/listing.json" }] };
  const older = { tag_name: "livepix-v2.0.0", published_at: "2026-09-01T00:00:00Z", assets: [] };
  const draft = { tag_name: "giggle-puck-v0.2.0", draft: true, published_at: null, assets: [] };
  let fetched;
  let mutations = 0;
  const dependencies = {
    environment,
    outDir,
    gh: (...args) => {
      if (args[0] === "api") return JSON.stringify([[older, draft], [latest]]);
      mutations++;
      return "";
    },
    pack: () => [archive],
    fetchPublic: async (url) => { fetched = url; return { ok: true, json: async () => previous }; },
    createCatalog: ({ previous: catalog }) => { assert.equal(catalog, previous); return "dist/listing.json"; },
  };
  await publishRelease(dependencies);
  assert.equal(fetched, "https://example.com/listing.json");
  assert.equal(mutations, 2);

  mutations = 0;
  await assert.rejects(publishRelease({ ...dependencies, gh: () => JSON.stringify([[{ tag_name: tag }]]) }), /already exists/);
  await assert.rejects(publishRelease({ ...dependencies, environment: { ...environment, GITHUB_REF: "refs/tags/livepix-v9.9.9" } }), /does not match/);
  await assert.rejects(publishRelease({ ...dependencies, environment: { ...environment, GITHUB_REF: `refs/tags/v${manifest.version}` } }), /needs a <plugin-id>-v<version> tag/);
  await assert.rejects(publishRelease({ ...dependencies, environment: { ...environment, GITHUB_REPOSITORY: "OSC-Flow-Studio/livepix-plugin" } }), /needs a <plugin-id>-v<version> tag/);
  await assert.rejects(publishRelease({ ...dependencies, environment: { ...environment, GITHUB_REF: "refs/tags/missing-v1.0.0" } }), /no plugin\/manifest\.json/);
  await assert.rejects(publishRelease({ ...dependencies, fetchPublic: async () => ({ ok: false, status: 404 }) }), /HTTP 404/);
  await assert.rejects(publishRelease({ ...dependencies, gh: () => JSON.stringify([[{ ...latest, assets: [] }]]) }), /has no listing\.json/);
  assert.equal(mutations, 0);
}));

test("release notes are the version's own CHANGELOG section", () => {
  const changelog = "# Changelog\n\n## 2.0.1 (2026-09-22)\n\n- New.\n\n## 2.0.0 (2026-09-21)\n\n- Old.\n";
  assert.equal(releaseNotes(changelog, "2.0.1"), "- New.\n");
  assert.equal(releaseNotes(changelog, "2.0.0"), "- Old.\n");
  assert.equal(releaseNotes("## 1.0.0\r\n\r\n- Only.\r\n", "1.0.0"), "- Only.\n");
  assert.throws(() => releaseNotes(changelog, "2.0.10"), /no "## 2\.0\.10" section/);
});
