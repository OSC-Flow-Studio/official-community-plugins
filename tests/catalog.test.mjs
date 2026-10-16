import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZip } from "../sdk/ofs-package.mjs";
import { buildCatalog, catalogSource, catalogUrl, repository } from "../scripts/build-catalog.mjs";
import { packagePlugins } from "../scripts/package.mjs";
import { listPlugins, parseTag, readPlugin } from "../scripts/plugins.mjs";
import { validatePlugins } from "../scripts/validate.mjs";

function withPackedPlugins(run) {
  const out = mkdtempSync(join(tmpdir(), "community-catalog-"));
  try {
    return run(packagePlugins([], out), out);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test("every plugin passes the schema, the install rules and this repository's rules", () => {
  const results = validatePlugins();
  assert.ok(results.length > 0);
  assert.deepEqual(results.filter((result) => result.issues.length > 0), []);
});

test("one catalog lists every plugin, with the hash and size of the ZIP the release serves", () => {
  withPackedPlugins((packed) => {
    const listing = buildCatalog({ zipPaths: packed.map((zip) => zip.path) });
    assert.equal(listing.id, catalogSource.id);
    assert.equal(listing.url, catalogUrl);
    assert.equal(Object.keys(listing.packages).length, listPlugins().length);
    for (const zip of packed) {
      const entry = listing.packages[zip.manifest.packageId].versions[zip.manifest.version];
      assert.equal(entry.artifact.sha256, zip.sha256);
      assert.equal(entry.artifact.size, zip.size);
      assert.equal(entry.artifact.url,
        `https://github.com/${repository}/releases/download/${zip.manifest.id}-v${zip.manifest.version}/${zip.name}`);
    }
  });
});

test("a release adds its version and keeps every version and plugin already published", () => {
  withPackedPlugins(([zip]) => {
    const { packageId, version } = zip.manifest;
    const first = buildCatalog({ zipPaths: [zip.path] });
    assert.throws(() => buildCatalog({ zipPaths: [zip.path], previous: first }), /already published/);

    const previous = structuredClone(first);
    const versions = previous.packages[packageId].versions;
    versions["1.1.0"] = { ...versions[version], manifest: { ...versions[version].manifest, version: "1.1.0" } };
    delete versions[version];
    const other = { manifest: { id: "other-plugin", packageId: "io.github.osc-flow-studio.other", version: "0.1.0" } };
    previous.packages["io.github.osc-flow-studio.other"] = { versions: { "0.1.0": other } };

    const next = buildCatalog({ zipPaths: [zip.path], previous });
    assert.deepEqual(next.packages[packageId].versions["1.1.0"], versions["1.1.0"]);
    assert.deepEqual(Object.keys(next.packages[packageId].versions), ["1.1.0", version]);
    assert.deepEqual(next.packages["io.github.osc-flow-studio.other"], previous.packages["io.github.osc-flow-studio.other"]);
  });
});

test("a catalog from another source or with two packages sharing a plugin id is refused", () => {
  withPackedPlugins(([zip]) => {
    const first = buildCatalog({ zipPaths: [zip.path] });
    assert.throws(() => buildCatalog({ zipPaths: [zip.path], previous: { ...first, url: "https://example.com/listing.json" } }), /does not belong/);
    assert.throws(() => buildCatalog({ zipPaths: [zip.path], previous: { ...first, id: "osc-flow-studio-livepix" } }), /does not belong/);
    const twin = structuredClone(first);
    twin.packages = { "io.github.someone.twin": { versions: { "9.0.0": { manifest: { id: zip.manifest.id, version: "9.0.0" } } } } };
    assert.throws(() => buildCatalog({ zipPaths: [zip.path], previous: twin }), /both use the plugin id/);
  });
});

test("a ZIP is only listed under the package id its plugin folder publishes", () => {
  const out = mkdtempSync(join(tmpdir(), "community-foreign-"));
  try {
    const { manifest } = listPlugins()[0];
    const foreign = join(out, "foreign.zip");
    writeFileSync(foreign, buildZip([["manifest.json", Buffer.from(JSON.stringify({ ...manifest, packageId: "io.github.someone.else" }))]]));
    assert.throws(() => buildCatalog({ zipPaths: [foreign] }), /publishes io\.github/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("release tags name the plugin and its stable version", () => {
  assert.deepEqual(parseTag("livepix-v2.0.1"), { id: "livepix", version: "2.0.1" });
  assert.deepEqual(parseTag("giggle-puck-v0.1.0"), { id: "giggle-puck", version: "0.1.0" });
  assert.deepEqual(parseTag("some-viewer-v1.0.0"), { id: "some-viewer", version: "1.0.0" });
  for (const tag of ["v2.0.1", "livepix-2.0.1", "livepix-v2.0.1-beta.1", "Live-v1.0.0", "../x-v1.0.0"]) {
    assert.equal(parseTag(tag), null, tag);
  }
  assert.throws(() => readPlugin("../sdk"), /not a community plugin id/);
});
