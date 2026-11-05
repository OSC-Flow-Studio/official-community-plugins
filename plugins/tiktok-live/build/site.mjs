// Builds the landing page into plugins/tiktok-live/site/ from site-src/. The block
// catalogue, counts and credits come from plugin/manifest.json, so the page never lists a
// block the plugin does not have. Run `npm run site:tiktok-live` from the repository root;
// add `-- --serve` to preview it on http://127.0.0.1:4417.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "site-src");
const out = join(here, "..", "site");
const modules = join(here, "node_modules");
const manifest = JSON.parse(readFileSync(join(here, "..", "plugin", "manifest.json"), "utf8"));
const versions = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const REPO = "https://github.com/OSC-Flow-Studio/official-community-plugins";

const escape = (value) => String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);

function icon(name) {
  const svg = readFileSync(join(modules, "lucide-static", "icons", `${name}.svg`), "utf8");
  return svg.replace(/<!--[\s\S]*?-->/g, "").replace("<svg", '<svg aria-hidden="true" focusable="false"').replace(/\s+/g, " ").trim();
}

const firstSentence = (text) => {
  // A period followed by a space ends the sentence; "(! by default)" does not.
  const match = /^.*?\.(\s|$)/.exec(text);
  return (match ? match[0] : text).trim();
};
const label = (item) => item.label.replace(/^TikTok: /, "");

function column(title, items, className) {
  const rows = items.map((item) => `<li>${escape(label(item))}<span>${escape(firstSentence(item.description))}</span></li>`).join("");
  return `<div class="${className}"><h3>${escape(title)}</h3><ul>${rows}</ul></div>`;
}

const triggers = manifest.nodeTypes.filter((item) => item.role === "trigger");
const actions = manifest.nodeTypes.filter((item) => item.role === "action");
const inputs = manifest.nodeTypes.filter((item) => item.role === "input");

const credits = [
  ["tiktok-live-connector", `${versions.dependencies["tiktok-live-connector"]}, by zerodytrash. The TikTok client behind the direct connection. AGPL-3.0 with additional permissions.`, "https://github.com/zerodytrash/TikTok-Live-Connector"],
  ["tiktok-live-proto", "By isaackogan. TikTok's message definitions. AGPL-3.0 with additional permissions.", "https://github.com/isaackogan/TikTok-Webcast-Protobuf"],
  ["Euler Stream", "The signing service the direct connection uses.", "https://www.eulerstream.com"],
  ["TikFinity", "The desktop app behind the optional bridge; not bundled.", "https://tikfinity.zerody.one"],
  ["This page", `GSAP ${versions.devDependencies.gsap}, Inter and JetBrains Mono (SIL Open Font License), Lucide icons (ISC).`, ""],
];

const replacements = {
  CATALOG_URL: `${REPO}/releases/latest/download/listing.json`,
  README_URL: `${REPO}/blob/main/plugins/tiktok-live/plugin/README.md`,
  SOURCE_URL: `${REPO}/tree/main/plugins/tiktok-live`,
  CHANGELOG_URL: manifest.changelogUrl,
  VERSION: manifest.version,
  TRIGGER_COUNT: String(triggers.length),
  ACTION_COUNT: String(actions.length),
  INPUT_COUNT: String(inputs.length),
  STREAK_TAPS: Array.from({ length: 10 }, () => '<span class="tap"></span>').join(""),
  CATALOGUE: [column("Triggers", triggers, "col-triggers"), column("Actions", actions, "col-actions"), column("Inputs", inputs, "col-inputs")].join(""),
  CREDITS: credits.map(([name, text, url]) => `<li>${url ? `<a href="${url}">${escape(name)}</a>` : escape(name)}<span>${escape(text)}</span></li>`).join(""),
};

export async function buildSite() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "assets"), { recursive: true });
  let html = readFileSync(join(src, "index.html"), "utf8");
  html = html.replace(/\{\{ICON:([a-z0-9-]+)\}\}/g, (_, name) => icon(name));
  html = html.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (!(key in replacements)) throw new Error(`site-src/index.html uses an unknown placeholder ${match}`);
    return replacements[key];
  });
  writeFileSync(join(out, "index.html"), html);
  copyFileSync(join(src, "styles.css"), join(out, "styles.css"));
  const fonts = [
    ["@fontsource-variable/inter", "inter-latin-wght-normal.woff2"],
    ["@fontsource-variable/inter", "inter-latin-ext-wght-normal.woff2"],
    ["@fontsource-variable/jetbrains-mono", "jetbrains-mono-latin-wght-normal.woff2"],
  ];
  for (const [pkg, file] of fonts) copyFileSync(join(modules, ...pkg.split("/"), "files", file), join(out, "assets", file));
  // Screenshots of the plugin in the real Studio, captured from the dev UI. Their .json sidecars record where each capture came from and stay out of the site.
  for (const file of readdirSync(join(src, "assets")).filter((name) => !name.endsWith(".json"))) copyFileSync(join(src, "assets", file), join(out, "assets", file));
  await build({ entryPoints: [join(src, "main.js")], bundle: true, minify: true, format: "iife", target: "es2020", outfile: join(out, "main.js"), legalComments: "eof", logLevel: "warning" });
  return out;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".png": "image/png", ".webp": "image/webp" };

function serve(port = 4417) {
  createServer((request, response) => {
    const path = normalize(decodeURIComponent((request.url ?? "/").split("?")[0])).replace(/^([/\\])+/, "");
    const file = join(out, path === "" || path.endsWith("\\") || path.endsWith("/") ? `${path}index.html` : path);
    if (!file.startsWith(out)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = readFileSync(file);
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404).end("Not found");
    }
  }).listen(port, "127.0.0.1", () => console.log(`Landing page on http://127.0.0.1:${port}/`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildSite();
  console.log(`site/ built: ${triggers.length} triggers, ${actions.length} actions, ${inputs.length} inputs`);
  if (process.argv.includes("--serve")) serve();
}
