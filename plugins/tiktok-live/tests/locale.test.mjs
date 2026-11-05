import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginDir = fileURLToPath(new URL("../plugin", import.meta.url));
const scenario = pathToFileURL(fileURLToPath(new URL("./helpers/scenario.mjs", import.meta.url))).href;

// Plays the full scenario and prints every trigger and input, as JSON.
const runner = `
  const { boot, playEverything } = await import(${JSON.stringify(scenario)});
  const run = await boot({ emitRawEvents: true });
  playEverything(run);
  const inputs = { status: await run.actions.get("status")({}), stats: run.actions.get("room-stats")({}), top: run.actions.get("top-gifters")({ limit: 5 }), battle: run.actions.get("battle-state")({}) };
  await run.runtime.shutdown();
  console.log(JSON.stringify({ triggers: run.triggers, inputs, statuses: run.statuses, resources: run.resources }));
`;

function play(env) {
  return execFileSync(process.execPath, ["--input-type=module", "-e", runner], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 60_000 });
}

test("triggers and inputs are identical on a Brazilian, a German and an American computer", () => {
  const brazil = play({ LANG: "pt_BR.UTF-8", LC_ALL: "pt_BR.UTF-8", TZ: "America/Sao_Paulo" });
  const germany = play({ LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8", TZ: "Europe/Berlin" });
  const usa = play({ LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TZ: "UTC" });
  assert.equal(brazil, usa);
  assert.equal(germany, usa);
  const { triggers } = JSON.parse(usa);
  assert.ok(triggers.length > 30);
  for (const { payload } of triggers) assert.match(payload.occurredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("the plugin's own code never formats with the host locale", () => {
  const files = readdirSync(pluginDir, { recursive: true }).filter((file) => file.endsWith(".mjs") && !file.startsWith("vendor"));
  for (const file of files) {
    const source = readFileSync(join(pluginDir, file), "utf8");
    assert.doesNotMatch(source, /toLocale|Intl\.|localeCompare|getTimezoneOffset|\.getHours\(|\.getDate\(/, file);
  }
});
