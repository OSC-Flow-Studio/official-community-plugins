---
version: 1
slug: "plugins-tiktok-live-plugin-chat-pages-mjs"
primary_target: "plugins/tiktok-live/plugin/chat/pages.mjs"
related_targets: []
---

Scope: plugins/tiktok-live/plugin/chat/pages.mjs, the chat sign-in pages the plugin serves on 127.0.0.1 (form, saved, expired, error). Visitor mode: Operate.

Task: paste two TikTok session cookies once, understand the risk, and get back to the Studio. Frequency: once, rarely again. States: form (with invalid fields), saved, expired, error. Constraints: one self-contained HTML string, inline CSS only, no external requests (CSP default-src 'none'), system font stack, light and dark from the system, English.

## Direction contract

THESIS: a calm, single-column form that reads like a Studio settings sheet; it refuses the login-card-on-gradient look.
OWN-WORLD: Studio neutrals, pink accent only on the primary button and focus ring, an amber notice for the BETA risk, 10px radius, hairline borders.
STORY: the person learns what the page does and its risk, copies two cookies following three steps, saves, and knows they can close the tab.
FIRST VIEWPORT: plugin name and page title top-left, one risk notice, three numbered steps beside or above the two labelled fields, one Save button; minutes left shown quietly.
FORM: settings sheet; seed: none (unavailable).
SIGNATURE: none beyond a short fade of the result state; reduced motion disables it.
