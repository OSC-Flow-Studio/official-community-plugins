import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { packPluginDir, readManifestFromZip } from "../../../sdk/ofs-package.mjs";

test("the bundled SDK builds a reproducible installable LivePix ZIP", () => {
  const out = mkdtempSync(join(tmpdir(), "livepix-package-"));
  try {
    const pluginDir = fileURLToPath(new URL("../plugin", import.meta.url));
    const first = packPluginDir(pluginDir, join(out, "first"));
    const second = packPluginDir(pluginDir, join(out, "second"));
    assert.equal(first.sha256, second.sha256);
    const bytes = readFileSync(first.path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), first.sha256);
    const manifest = readManifestFromZip(bytes);
    assert.equal(manifest.id, "livepix");
    // The package and plugin ids are what installed flows, configs and the vault are keyed by.
    assert.equal(manifest.packageId, "io.github.osc-flow-studio.livepix");
    // Plugin SDK 2 (apiVersion 2 and permissions) needs Studio 1.0.0.
    assert.equal(manifest.engines.oscFlowStudio, ">=1.0.0 <2.0.0");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
