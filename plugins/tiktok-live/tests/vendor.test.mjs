import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginDir = fileURLToPath(new URL("../plugin", import.meta.url));
const vendor = join(pluginDir, "vendor", "tiktok-live-connector.mjs");
const notice = readFileSync(join(pluginDir, "vendor", "NOTICE.md"), "utf8");
const buildPackage = JSON.parse(readFileSync(new URL("../build/package.json", import.meta.url), "utf8"));

test("NOTICE.md matches the bundle and the pinned connector version", () => {
  const sha256 = createHash("sha256").update(readFileSync(vendor)).digest("hex");
  assert.ok(notice.includes(`Bundle SHA-256: \`${sha256}\``), "rebuild with npm run bundle:tiktok-live");
  const pinned = buildPackage.dependencies["tiktok-live-connector"];
  assert.match(notice, new RegExp(`\\| tiktok-live-connector \\| ${pinned.replaceAll(".", "\\.")} \\| AGPL-3\\.0-only \\|`));
  assert.match(notice, /\| tiktok-live-proto \| [\d.]+ \| AGPL-3\.0-only \|/);
  const licenses = readFileSync(join(pluginDir, "vendor", "THIRD_PARTY_LICENSES.txt"), "utf8");
  assert.match(licenses, /Additional Permissions & Exceptions/);
});

test("the plugin loads inside the Studio's sandbox: read access to its own folder, nothing else", () => {
  const probe = `
    const url = ${JSON.stringify(pathToFileURL(join(pluginDir, "index.mjs")).href)};
    const plugin = (await import(url)).default;
    const lib = await import(${JSON.stringify(pathToFileURL(vendor).href)});
    const connection = new lib.TikTokLiveConnection("someone", { clientPresets: { ...lib.getRandomPresets(), location: lib.Locations[0] } });
    console.log(JSON.stringify({ activate: typeof plugin.activate, version: lib.VERSION, language: connection.clientParams.webcast_language }));
  `;
  const output = execFileSync(process.execPath, ["--permission", `--allow-fs-read=${pluginDir}${pluginDir.endsWith("\\") ? "" : process.platform === "win32" ? "\\" : "/"}*`, "--input-type=module", "-e", probe], { encoding: "utf8", timeout: 30_000 });
  const result = JSON.parse(output.trim().split("\n").at(-1));
  assert.deepEqual(result, { activate: "function", version: buildPackage.dependencies["tiktok-live-connector"], language: "en" });
});

test("only the plugin's own code is checked by hand; the bundle stays out of plugin modules", () => {
  const files = readdirSync(pluginDir, { recursive: true }).filter((file) => /\.(mjs|js|json|md|txt)$/.test(file));
  const total = files.reduce((sum, file) => sum + statSync(join(pluginDir, file)).size, 0);
  assert.ok(files.length < 40, `${files.length} files`);
  assert.ok(total < 8 * 1024 * 1024, `${total} bytes`);
});
