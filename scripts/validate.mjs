import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { validatePluginDir } from "../sdk/ofs-package.mjs";
import { repository } from "./build-catalog.mjs";
import { root, selectPlugins } from "./plugins.mjs";

const repositoryUrl = `https://github.com/${repository}`;

/** Returns the problems per plugin; an empty list means every selected plugin passed. */
export function validatePlugins(ids = []) {
  const schema = JSON.parse(readFileSync(join(root, "sdk/community-plugin-manifest.schema.json"), "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const plugins = selectPlugins(ids);
  const problems = [];
  const packageIds = new Map();
  for (const { id, pluginDir, manifest } of plugins) {
    const issues = validatePluginDir(pluginDir);
    if (!validate(manifest)) issues.push(ajv.errorsText(validate.errors, { separator: "\n" }));
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) issues.push("this catalog publishes stable versions only");
    // A manifest copied from a discontinued repository would send users to the wrong place.
    if (manifest.repository !== repositoryUrl) issues.push(`repository must be ${repositoryUrl}`);
    if (packageIds.has(manifest.packageId)) issues.push(`packageId ${manifest.packageId} is also used by plugins/${packageIds.get(manifest.packageId)}`);
    packageIds.set(manifest.packageId, id);
    if (manifest.entry) {
      try {
        execFileSync(process.execPath, ["--check", join(pluginDir, manifest.entry)], { stdio: ["ignore", "ignore", "pipe"] });
      } catch (error) {
        issues.push(`${manifest.entry} does not parse:\n${error.stderr?.toString().trim()}`);
      }
    }
    problems.push({ id, version: manifest.version, issues });
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const { id, version, issues } of validatePlugins(process.argv.slice(2))) {
    if (issues.length > 0) {
      console.error(`${id} ${version}:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
      process.exitCode = 1;
    } else {
      console.log(`${id} ${version}: schema and package rules passed`);
    }
  }
}
