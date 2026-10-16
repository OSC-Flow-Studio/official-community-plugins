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
    // The subathon start uses the native date field, which needs Studio 0.5.4.
    assert.equal(manifest.engines.oscFlowStudio, ">=0.5.4 <0.6.0");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
