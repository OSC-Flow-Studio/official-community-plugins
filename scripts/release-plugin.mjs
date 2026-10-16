#!/usr/bin/env node
// Interactive release: pick a plugin, choose its next version, then commit, tag and push.
// The pushed `<id>-v<version>` tag starts the release workflow, which publishes the ZIP
// and the updated catalog. `--dry-run` asks the same questions, runs the checks and
// restores every file without touching git.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { catalogUrl, repository } from "./build-catalog.mjs";
import { listPlugins, root, tagFor } from "./plugins.mjs";
import {
  addChangelogSection,
  bumpOptions,
  hasChangelogSection,
  publishedVersions,
  setManifestVersion,
  versionProblem,
} from "./versioning.mjs";

const dryRun = process.argv.includes("--dry-run");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const say = (text = "") => process.stdout.write(`${text}\n`);

class Stop extends Error {}
const stop = (message) => { throw new Stop(message); };

const rl = createInterface({ input: process.stdin, terminal: process.stdin.isTTY });
const lines = rl[Symbol.asyncIterator]();
async function ask(question) {
  process.stdout.write(question);
  const { value, done } = await lines.next();
  if (done) stop("Input closed before the release was confirmed. Nothing was changed.");
  if (!process.stdin.isTTY) say(value);
  return value.trim();
}

async function choose(question, options) {
  options.forEach((option, index) => say(`  ${index + 1}) ${option.label}`));
  for (;;) {
    const answer = await ask(question);
    const picked = options[Number(answer) - 1] ?? options.find((option) => option.key === answer);
    if (picked) return picked;
    say(`  Type a number from 1 to ${options.length}.`);
  }
}

function assertGitReady() {
  if (git("status", "--porcelain")) stop("The working tree has uncommitted changes. Commit or stash them first.");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch === "HEAD") stop("HEAD is detached. Check out the branch you release from.");
  say("Fetching tags from origin...");
  git("fetch", "--quiet", "--tags", "origin");
  let upstream;
  try {
    upstream = git("rev-parse", "--abbrev-ref", "@{u}");
  } catch {
    stop(`${branch} has no upstream. Push it once with "git push -u origin ${branch}".`);
  }
  git("fetch", "--quiet", "origin");
  const behind = Number(git("rev-list", "--count", `HEAD..${upstream}`));
  if (behind > 0) stop(`${branch} is ${behind} commit(s) behind ${upstream}. Pull first.`);
  return branch;
}

function runChecks() {
  say("\nRunning npm run check (schema, install rules and tests)...");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["run", "check"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  return result.status === 0;
}

async function main() {
  const branch = assertGitReady();
  const tags = git("tag", "--list", "*-v*").split("\n").filter(Boolean);
  const plugins = listPlugins().map((plugin) => ({ ...plugin, published: publishedVersions(tags, plugin.id) }));

  say("\nPlugins in this repository:");
  const plugin = await choose("Which plugin are you releasing? ", plugins.map((entry) => ({
    ...entry,
    key: entry.id,
    label: `${entry.manifest.name} (${entry.id})  manifest ${entry.manifest.version}  published ${entry.published.at(-1) ?? "never"}`,
  })));

  const current = plugin.manifest.version;
  const latest = plugin.published.at(-1);
  const bumps = bumpOptions(current, latest);
  const versionOptions = [
    ...(versionProblem(current, plugin.published) ? [] : [{ key: current, label: `${current}  (the manifest's current version, not published yet)` }]),
    { key: bumps.patch, label: `${bumps.patch}  (patch: fixes)` },
    { key: bumps.minor, label: `${bumps.minor}  (minor: new features)` },
    { key: bumps.major, label: `${bumps.major}  (major: breaking changes)` },
    { key: "other", label: "Another version" },
  ];
  say(`\nWhich version of ${plugin.manifest.name} are you releasing?`);
  let version = (await choose("Version: ", versionOptions)).key;
  while (version === "other" || versionProblem(version, plugin.published)) {
    if (version !== "other") say(`  ${versionProblem(version, plugin.published)}.`);
    version = await ask("Version (X.Y.Z): ");
  }

  const manifestPath = join(plugin.pluginDir, "manifest.json");
  const changelogPath = join(plugin.dir, "CHANGELOG.md");
  const originals = new Map([[manifestPath, readFileSync(manifestPath, "utf8")], [changelogPath, readFileSync(changelogPath, "utf8")]]);
  const restore = () => { for (const [path, text] of originals) writeFileSync(path, text); };
  let committed = false;

  let changelog = originals.get(changelogPath);
  if (hasChangelogSection(changelog, version)) {
    say(`\nCHANGELOG.md already has a ${version} section; it becomes the release notes.`);
  } else {
    say(`\nWhat changed in ${version}? One line per item; an empty line finishes.`);
    const notes = [];
    for (;;) {
      const line = await ask("- ");
      if (!line) {
        if (notes.length > 0) break;
        say("  Add at least one line.");
        continue;
      }
      notes.push(line);
    }
    changelog = addChangelogSection(changelog, version, new Date().toISOString().slice(0, 10), notes);
  }

  try {
    if (version !== current) writeFileSync(manifestPath, setManifestVersion(originals.get(manifestPath), version));
    writeFileSync(changelogPath, changelog);
    if (!runChecks()) stop("npm run check failed. The files were restored; fix the plugin and run the release again.");

    const changed = [...originals].filter(([path, text]) => readFileSync(path, "utf8") !== text).map(([path]) => relative(root, path).split(sep).join("/"));
    const tag = tagFor({ id: plugin.id, version });
    const message = `🧹 Chore: Release ${plugin.manifest.name} ${version}`;
    const commands = [
      ...(changed.length > 0 ? [["add", "--", ...changed], ["commit", "-m", message]] : []),
      ["tag", "-a", tag, "-m", `${plugin.manifest.name} ${version}`],
      ["push", "--atomic", "origin", `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`],
    ];
    say(`\n${plugin.manifest.name} ${latest ?? "(unpublished)"} -> ${version} from ${branch}`);
    if (changed.length > 0) say(`Files: ${changed.join(", ")}`);
    else say("No file changes: the tag goes on the current commit.");
    for (const args of commands) say(`  git ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`);

    if (dryRun) {
      restore();
      say("\nDry run: nothing was committed, tagged or pushed, and the files were restored.");
      return;
    }
    if (!/^y(es)?$/i.test(await ask("\nCommit, tag and push? (y/N) "))) {
      restore();
      say("Cancelled. The files were restored.");
      return;
    }
    for (const args of commands) {
      try {
        git(...args);
        if (args[0] === "commit") committed = true;
      } catch (error) {
        const done = commands.slice(0, commands.indexOf(args)).map((step) => `git ${step[0]}`).join(", ") || "nothing";
        stop(`git ${args[0]} failed: ${error.stderr?.toString().trim() || error.message}\nAlready done: ${done}. Fix the cause and push again with:\n  git ${commands.at(-1).join(" ")}`);
      }
    }
    say(`\nPushed ${tag}. The release workflow publishes it in a minute or two:`);
    say(`  https://github.com/${repository}/actions`);
    say(`  ${catalogUrl}`);
  } catch (error) {
    // After the commit the new version is in history; before it, leave the tree as it was.
    if (!committed) {
      git("reset", "--quiet", "--", ...originals.keys());
      restore();
    }
    throw error;
  }
}

try {
  await main();
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  process.stderr.write(`\n${error.message}\n`);
  process.exitCode = 1;
} finally {
  rl.close();
}
