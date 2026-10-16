#!/usr/bin/env node
// Releases one community plugin: pick it, choose its next version, then commit, tag and
// push. The pushed `<id>-v<version>` tag starts the release workflow, which publishes the
// ZIP and the updated catalog.
//
// In a terminal every question is a menu you move through with the arrow keys. Scripts
// and CI pass the answers as flags instead:
//
//   npm run release
//   npm run release -- --plugin livepix --version patch --notes "Fix the timer" --yes
//   npm run release -- --dry-run      everything except git; the files are restored
import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import * as prompts from "@clack/prompts";
import color from "picocolors";
import { catalogUrl, repository } from "./build-catalog.mjs";
import { listPlugins, root, tagFor } from "./plugins.mjs";
import {
  addChangelogSection,
  bumpOptions,
  hasChangelogSection,
  parseVersion,
  publishedVersions,
  setManifestVersion,
  versionProblem,
} from "./versioning.mjs";

const run = promisify(execFile);
const HELP = `Release a community plugin.

  npm run release [-- options]

Options:
  --plugin <id>        the plugin to release
  --version <version>  patch, minor, major, current, or an exact X.Y.Z
  --notes <line>       a CHANGELOG line; repeat it for more lines
  --yes                commit, tag and push without asking
  --dry-run            ask everything and run the checks, but touch no git
  --help               show this text

Without a terminal, --plugin and --version are required, and --yes or --dry-run.`;

/** Raised to end the release with a message; anything else is a bug and keeps its stack. */
export class Stop extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.exitCode = exitCode;
  }
}

async function git(...args) {
  try {
    const { stdout } = await run("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    return stdout.trim();
  } catch (error) {
    throw new Stop(`git ${args[0]} failed: ${error.stderr?.trim() || error.message}`);
  }
}

/** Runs `npm run check` and keeps its output for when it fails. */
function runChecks() {
  return new Promise((resolveRun) => {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(npm, ["run", "check"], { cwd: root, shell: process.platform === "win32", windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolveRun({ ok: code === 0, output }));
  });
}

const VERSION_KEYWORDS = new Set(["patch", "minor", "major", "current"]);

export async function releasePlugin({ argv = process.argv.slice(2), input = process.stdin, output = process.stdout } = {}) {
  let flags;
  try {
    ({ values: flags } = parseArgs({
      args: argv,
      options: {
        plugin: { type: "string" },
        version: { type: "string" },
        notes: { type: "string", multiple: true },
        yes: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: true,
    }));
  } catch (error) {
    throw new Stop(`${error.message.replace(/\.?$/, ".")} Run with --help for the options.`);
  }
  const io = { input, output };
  if (flags.help) {
    output.write(`${HELP}\n`);
    return;
  }
  const dryRun = flags["dry-run"];
  const interactive = Boolean(input.isTTY && output.isTTY);
  const ask = async (question, flagName) => {
    if (!interactive) throw new Stop(`No terminal to ask in: pass --${flagName}. Run with --help for the options.`);
    const answer = await question();
    if (prompts.isCancel(answer)) throw new Stop("Cancelled. Nothing was changed.", { exitCode: 0 });
    return answer;
  };

  prompts.intro(color.bgMagenta(color.black(" Release a community plugin ")) + (dryRun ? color.dim("  dry run") : ""), io);

  // 1. The tree must be clean and up to date, or the release would publish something else.
  const spin = prompts.spinner({ output });
  spin.start("Checking the working tree and fetching tags");
  let branch;
  let upstream;
  try {
    if (await git("status", "--porcelain")) throw new Stop("The working tree has uncommitted changes. Commit or stash them first.");
    branch = await git("rev-parse", "--abbrev-ref", "HEAD");
    if (branch === "HEAD") throw new Stop("HEAD is detached. Check out the branch you release from.");
    try {
      upstream = await git("rev-parse", "--abbrev-ref", "@{u}");
    } catch {
      throw new Stop(`${branch} has no upstream. Push it once with "git push -u origin ${branch}".`);
    }
    await git("fetch", "--quiet", "--tags", "origin");
    const behind = Number(await git("rev-list", "--count", `HEAD..${upstream}`));
    if (behind > 0) throw new Stop(`${branch} is ${behind} commit${behind === 1 ? "" : "s"} behind ${upstream}. Pull first.`);
  } catch (error) {
    spin.error("The tree is not ready to release from");
    throw error;
  }
  spin.stop(`On ${color.cyan(branch)}, up to date with ${upstream}`);

  // 2. Which plugin.
  const tags = (await git("tag", "--list", "*-v*")).split("\n").filter(Boolean);
  const plugins = listPlugins().map((plugin) => ({ ...plugin, published: publishedVersions(tags, plugin.id) }));
  let plugin = flags.plugin ? plugins.find((entry) => entry.id === flags.plugin) : undefined;
  if (flags.plugin && !plugin) throw new Stop(`There is no plugin "${flags.plugin}". Known: ${plugins.map((entry) => entry.id).join(", ")}.`);
  if (!plugin) {
    const id = await ask(() => prompts.select({
      ...io,
      message: "Which plugin are you releasing?",
      options: plugins.map((entry) => ({
        value: entry.id,
        label: entry.manifest.name,
        hint: `${entry.id}, manifest ${entry.manifest.version}, ${entry.published.length ? `published ${entry.published.at(-1)}` : "never published"}`,
      })),
    }), "plugin");
    plugin = plugins.find((entry) => entry.id === id);
  } else {
    prompts.log.step(`Plugin: ${plugin.manifest.name}`, io);
  }

  // 3. Which version.
  const current = plugin.manifest.version;
  const latest = plugin.published.at(-1);
  const bumps = bumpOptions(current, latest);
  const currentIsNew = !versionProblem(current, plugin.published);
  let version;
  if (flags.version) {
    const wanted = flags.version.trim();
    version = VERSION_KEYWORDS.has(wanted) ? (wanted === "current" ? current : bumps[wanted]) : wanted;
    const problem = versionProblem(version, plugin.published);
    if (problem) throw new Stop(`Cannot release ${plugin.manifest.name} ${version}: ${problem}.`);
    prompts.log.step(`Version: ${version}`, io);
  } else {
    const choice = await ask(() => prompts.select({
      ...io,
      message: `Which version of ${plugin.manifest.name}? ${color.dim(`(last published: ${latest ?? "none"})`)}`,
      initialValue: currentIsNew ? current : bumps.patch,
      options: [
        ...(currentIsNew ? [{ value: current, label: current, hint: "the manifest's version, not published yet" }] : []),
        { value: bumps.patch, label: bumps.patch, hint: "patch: fixes" },
        { value: bumps.minor, label: bumps.minor, hint: "minor: new features" },
        { value: bumps.major, label: bumps.major, hint: "major: breaking changes" },
        { value: "other", label: "Another version", hint: "type it" },
      ],
    }), "version");
    version = choice !== "other" ? choice : await ask(() => prompts.text({
      ...io,
      message: "Version",
      placeholder: "X.Y.Z",
      validate: (value) => {
        const problem = versionProblem((value ?? "").trim(), plugin.published);
        return problem ? `${problem[0].toUpperCase()}${problem.slice(1)}.` : undefined;
      },
    }), "version");
    version = version.trim();
  }
  if (!parseVersion(version)) throw new Stop(`${version} is not a stable X.Y.Z version.`);

  // 4. The release notes, unless CHANGELOG.md already has them.
  const manifestPath = join(plugin.pluginDir, "manifest.json");
  const changelogPath = join(plugin.dir, "CHANGELOG.md");
  const originals = new Map([[manifestPath, readFileSync(manifestPath, "utf8")], [changelogPath, readFileSync(changelogPath, "utf8")]]);
  const restore = () => { for (const [path, text] of originals) writeFileSync(path, text); };
  let changelog = originals.get(changelogPath);
  if (hasChangelogSection(changelog, version)) {
    prompts.log.info(`CHANGELOG.md already has a ${version} section; it becomes the release notes.`, io);
  } else {
    let notes = (flags.notes ?? []).map((line) => line.trim()).filter(Boolean);
    if (notes.length === 0) {
      const typed = await ask(() => prompts.multiline({
        ...io,
        message: `What changed in ${version}? ${color.dim("One change per line, Enter twice to finish.")}`,
        placeholder: "Fix the reconnect timer",
        validate: (value) => ((value ?? "").split(/\r?\n/).some((line) => line.trim()) ? undefined : "Add at least one line."),
      }), "notes");
      notes = typed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    }
    changelog = addChangelogSection(changelog, version, new Date().toISOString().slice(0, 10), notes);
  }

  // 5. Write, check, and only then touch git.
  let committed = false;
  try {
    if (version !== current) writeFileSync(manifestPath, setManifestVersion(originals.get(manifestPath), version));
    writeFileSync(changelogPath, changelog);

    spin.start("Running npm run check (schema, install rules and tests)");
    const checks = await runChecks();
    if (!checks.ok) {
      spin.error("npm run check failed");
      prompts.log.message(checks.output.trim().split(/\r?\n/).slice(-40).join("\n"), io);
      throw new Stop("The files were restored. Fix the plugin and run the release again.");
    }
    const passed = /# pass (\d+)/.exec(checks.output)?.[1];
    spin.stop(`Checks passed${passed ? ` (${passed} tests)` : ""}`);

    const changed = [...originals].filter(([path, text]) => readFileSync(path, "utf8") !== text).map(([path]) => relative(root, path).split(sep).join("/"));
    const tag = tagFor({ id: plugin.id, version });
    const message = `🧹 Chore: Release ${plugin.manifest.name} ${version}`;
    const steps = [
      ...(changed.length > 0 ? [{
        label: "Committing", done: `Committed ${color.dim(message)}`, commits: true,
        commands: [["add", "--", ...changed], ["commit", "-m", message]],
      }] : []),
      { label: "Tagging", done: `Tagged ${tag}`, commands: [["tag", "-a", tag, "-m", `${plugin.manifest.name} ${version}`]] },
      { label: "Pushing", done: `Pushed ${branch} and ${tag}`, commands: [["push", "--atomic", "origin", `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`]] },
    ];
    const shell = (args) => `git ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`;
    prompts.note([
      `${color.dim("Plugin ")}  ${plugin.manifest.name} ${color.dim(`(${plugin.id})`)}`,
      `${color.dim("Version")}  ${latest ?? "unpublished"} ${color.dim("->")} ${color.green(version)}`,
      `${color.dim("Branch ")}  ${branch}`,
      `${color.dim("Files  ")}  ${changed.length > 0 ? changed.join(", ") : "none (the tag goes on the current commit)"}`,
      "",
      ...steps.flatMap((step) => step.commands).map((args) => color.dim(shell(args))),
    ].join("\n"), "Release plan", io);

    if (dryRun) {
      restore();
      prompts.outro("Dry run: nothing was committed, tagged or pushed, and the files were restored.", io);
      return;
    }
    if (!flags.yes) {
      const go = await ask(() => prompts.confirm({ ...io, message: "Commit, tag and push?", initialValue: false }), "yes");
      if (!go) throw new Stop("Cancelled. The files were restored.", { exitCode: 0 });
    }

    for (const step of steps) {
      spin.start(step.label);
      try {
        for (const args of step.commands) await git(...args);
      } catch (error) {
        spin.error(`${step.label} failed`);
        if (committed) {
          throw new Stop(`${error.message}\nThe release commit is already in history. Fix the cause, then run:\n  ${shell(steps.at(-1).commands[0])}`);
        }
        throw error;
      }
      if (step.commits) committed = true;
      spin.stop(step.done);
    }
    prompts.note(`https://github.com/${repository}/actions\n${catalogUrl}`, "The release workflow publishes it in a minute or two", io);
    prompts.outro(`${color.green("Released")} ${tag}`, io);
  } catch (error) {
    // Before the commit, leave the tree as it was. After it, the new version is history.
    if (!committed) {
      await git("reset", "--quiet", "--", ...originals.keys()).catch(() => {});
      restore();
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await releasePlugin();
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    if (error.exitCode === 0) prompts.cancel(error.message);
    else prompts.log.error(error.message);
    process.exitCode = error.exitCode;
  }
}
