import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { validatePluginDir } from "../sdk/ofs-package.mjs";
import { repository } from "./build-catalog.mjs";
import { root, selectPlugins } from "./plugins.mjs";

const repositoryUrl = `https://github.com/${repository}`;

/** Node modules that open a socket, and the network level each one implies at least. */
const NETWORK_MODULES = {
  "node:dgram": "local",
  "node:net": "local",
  "node:tls": "internet",
  "node:http": "local",
  "node:https": "internet",
  "node:dns": "local",
};

function codeFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...codeFiles(full));
    else if (/\.(mjs|js|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * The app shows `permissions.network` to the person but cannot enforce it, so the catalog
 * checks it: a plugin that imports a socket module, or calls fetch or WebSocket, must not
 * declare "none", and a plugin that uses UDP or raw sockets must allow the local network.
 */
export function networkIssues(pluginDir, manifest) {
  const declared = manifest.permissions?.network ?? "none";
  const used = new Set();
  for (const file of codeFiles(pluginDir)) {
    const source = readFileSync(file, "utf8");
    for (const name of Object.keys(NETWORK_MODULES)) {
      if (source.includes(`"${name}"`) || source.includes(`'${name}'`)) used.add(name);
    }
    if (/\bfetch\s*\(/.test(source)) used.add("fetch");
    if (/\bnew\s+WebSocket\s*\(/.test(source)) used.add("WebSocket");
  }
  const issues = [];
  if (used.size > 0 && declared === "none") {
    issues.push(`permissions.network is "none" but the code uses ${[...used].sort().join(", ")}`);
  }
  const local = [...used].some((name) => NETWORK_MODULES[name] === "local" && name !== "node:http" && name !== "node:dns");
  if (local && declared === "internet") {
    issues.push(`the code uses ${[...used].filter((name) => NETWORK_MODULES[name] === "local").join(", ")}; declare "local" or "any"`);
  }
  return issues;
}

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
      issues.push(...networkIssues(pluginDir, manifest));
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
