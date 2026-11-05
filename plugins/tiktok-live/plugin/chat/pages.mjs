// The pages of the BETA chat sign-in, served from 127.0.0.1 by signin.mjs. Each page is one
// self-contained HTML string: the response's Content-Security-Policy allows inline styles
// and nothing else, so there are no scripts, fonts or images to fetch.

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: oklch(0.985 0 0);
  --surface: oklch(1 0 0 / 0.72);
  --text: oklch(0.205 0 0);
  --muted: oklch(0.47 0 0);
  --line: oklch(0.9 0 0);
  --field: oklch(1 0 0);
  --accent: oklch(0.52 0.2 358);
  --on-accent: oklch(0.99 0 0);
  --ring: oklch(0.62 0.22 358 / 0.45);
  --notice-bg: oklch(0.96 0.05 85);
  --notice-line: oklch(0.83 0.11 80);
  --notice-text: oklch(0.36 0.07 70);
  --danger: oklch(0.5 0.19 27);
  --ok: oklch(0.5 0.13 155);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: oklch(0.16 0 0);
    --surface: oklch(0.2 0 0);
    --text: oklch(0.96 0 0);
    --muted: oklch(0.72 0 0);
    --line: oklch(1 0 0 / 0.11);
    --field: oklch(0.14 0 0);
    --accent: oklch(0.78 0.14 355);
    --on-accent: oklch(0.2 0.05 355);
    --ring: oklch(0.78 0.14 355 / 0.45);
    --notice-bg: oklch(0.27 0.05 75);
    --notice-line: oklch(0.45 0.08 75);
    --notice-text: oklch(0.9 0.07 85);
    --danger: oklch(0.75 0.15 27);
    --ok: oklch(0.78 0.13 155);
  }
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body {
  margin: 0;
  min-height: 100dvh;
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--text);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
}
::selection { background: var(--ring); color: var(--text); }
main { width: min(100% - 32px, 34rem); margin: 0 auto; padding: 56px 0 48px; }
.app { margin: 0 0 28px; font-size: 13px; font-weight: 600; color: var(--muted); letter-spacing: 0.01em; }
.app b { color: var(--text); font-weight: 600; }
h1 { margin: 0 0 8px; font-size: 26px; line-height: 1.2; letter-spacing: -0.02em; font-weight: 650; text-wrap: balance; }
.lead { margin: 0 0 24px; color: var(--muted); max-width: 60ch; }
.notice { margin: 0 0 28px; padding: 12px 14px; border: 1px solid var(--notice-line); border-radius: 10px; background: var(--notice-bg); color: var(--notice-text); font-size: 14px; }
.notice strong { font-weight: 650; }
ol { margin: 0 0 28px; padding: 0; list-style: none; counter-reset: step; display: grid; gap: 14px; }
ol li { counter-increment: step; display: grid; grid-template-columns: 26px 1fr; gap: 10px; align-items: start; }
ol li::before { content: counter(step); display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--line); font-size: 13px; font-weight: 600; color: var(--muted); font-variant-numeric: tabular-nums; }
code { font: 13px/1.4 ui-monospace, "Cascadia Mono", Consolas, monospace; padding: 1px 5px; border-radius: 5px; background: var(--line); white-space: nowrap; }
form { display: grid; gap: 20px; padding: 20px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
.field { display: grid; gap: 6px; }
label { font-weight: 600; font-size: 14px; }
input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--field);
  color: var(--text);
  font: 14px/1.4 ui-monospace, "Cascadia Mono", Consolas, monospace;
  caret-color: var(--accent);
  transition: border-color 160ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 160ms cubic-bezier(0.16, 1, 0.3, 1);
}
input:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--ring); }
input[aria-invalid="true"] { border-color: var(--danger); }
.help { margin: 0; font-size: 13px; color: var(--muted); }
.error { margin: 0; font-size: 13px; font-weight: 600; color: var(--danger); }
button {
  justify-self: start;
  padding: 10px 18px;
  border: 0;
  border-radius: 8px;
  background: var(--accent);
  color: var(--on-accent);
  font: 600 14px/1.2 inherit;
  cursor: pointer;
  transition: transform 120ms cubic-bezier(0.16, 1, 0.3, 1), filter 160ms ease-out;
}
button:hover { filter: brightness(1.06); }
button:active { transform: translateY(1px); }
button:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring); }
.foot { margin: 20px 0 0; font-size: 13px; color: var(--muted); }
.result { padding-top: 8px; }
@media (prefers-reduced-motion: no-preference) {
  .result { animation: settle 360ms cubic-bezier(0.16, 1, 0.3, 1) both; }
  @keyframes settle { from { opacity: 0; transform: translateY(6px); } }
}
`;


function shell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escape(title)} · TikTok LIVE</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="app"><b>OSC Flow Studio</b> · TikTok LIVE chat sign-in</p>
${body}
</main>
</body>
</html>`;
}

function field({ name, label, help, invalid, problem }) {
  const helpId = `${name}-help`;
  const errorId = `${name}-error`;
  return `<div class="field">
<label for="${name}">${label}</label>
<input id="${name}" name="${name}" type="password" required autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="${helpId}${invalid ? ` ${errorId}` : ""}"${invalid ? ' aria-invalid="true"' : ""}>
<p class="help" id="${helpId}">${help}</p>
${invalid ? `<p class="error" id="${errorId}">${problem}</p>` : ""}
</div>`;
}

function formPage({ action, invalid = [], minutesLeft }) {
  const bad = new Set(invalid);
  return shell("Sign in to send chat", `
<h1>Sign in to send chat</h1>
<p class="lead">The TikTok: send chat message block writes as a TikTok account. Paste that account's two session cookies here and the plugin keeps them in the Studio's encrypted vault.</p>
<p class="notice" role="note"><strong>Beta.</strong> TikTok may suspend accounts that post automatically, so use a secondary account. The cookies sign in as that account: they go only to Euler Stream, which posts each message for you. The plugin maintainers can switch sending off at any time.</p>
<ol>
<li><span>On this computer, open <code>tiktok.com</code> and log in with the account that should write in the chat.</span></li>
<li><span>Press F12. In Chrome or Edge open Application, then Cookies, then <code>https://www.tiktok.com</code>. In Firefox open Storage, then Cookies.</span></li>
<li><span>Copy the Value of <code>sessionid</code> and of <code>tt-target-idc</code> into the fields below.</span></li>
</ol>
<form method="post" action="${escape(action)}" autocomplete="off">
${field({ name: "sessionId", label: "sessionid", help: "The value alone, <code>sessionid=…</code>, or a whole copied Cookie header all work.", invalid: bad.has("sessionId"), problem: "That does not look like a sessionid value. Copy the Value column of the sessionid row." })}
${field({ name: "ttTargetIdc", label: "tt-target-idc", help: "A short region code, for example <code>useast2a</code>.", invalid: bad.has("ttTargetIdc"), problem: "That does not look like a tt-target-idc value. Copy the Value column of the tt-target-idc row." })}
<button type="submit">Save to the Studio</button>
</form>
<p class="foot">This page works only on this computer and closes in ${escape(minutesLeft)} minute${minutesLeft === 1 ? "" : "s"}. The fields are hidden in case your screen is live.</p>`);
}

/**
 * Renders one state of the sign-in: "form", "saved", "expired" or "error".
 * `details`: `action` (form target), `invalid` (field names), `message` (error text), `minutesLeft`.
 */
export function renderSignInPage(state, details = {}) {
  if (state === "form") return formPage(details);
  if (state === "saved") {
    return shell("Chat is signed in", `<section class="result">
<h1>Chat is signed in</h1>
<p class="lead">You can close this tab and go back to OSC Flow Studio. Try it with the TikTok: send chat message block while you are live. To remove the cookies, run TikTok: chat sign-out.</p>
</section>`);
  }
  if (state === "expired") {
    return shell("This sign-in page has closed", `<section class="result">
<h1>This sign-in page has closed</h1>
<p class="lead">Sign-in pages stay open for ten minutes and accept one save. Run TikTok: chat sign-in in the Studio again to open a new one.</p>
</section>`);
  }
  return shell("Nothing was saved", `<section class="result">
<h1>Nothing was saved</h1>
<p class="lead">${escape(details.message || "Something went wrong while saving.")} Go back to the form and try again, or run TikTok: chat sign-in in the Studio for a new page.</p>
</section>`);
}
