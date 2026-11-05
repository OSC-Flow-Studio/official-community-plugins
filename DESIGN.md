---
name: OSC Flow Studio community plugins
description: Pages the community plugins ship, in the Studio's own neutral world with each plugin's catalog accent.
colors:
  paper: "oklch(0.985 0 0)"
  paper-raised: "oklch(0.965 0 0)"
  panel: "oklch(1 0 0)"
  ink: "oklch(0.2 0 0)"
  ink-muted: "oklch(0.46 0 0)"
  ink-faint: "oklch(0.5 0 0)"
  hairline: "oklch(0.9 0 0)"
  hairline-strong: "oklch(0.82 0 0)"
  host-pink: "oklch(0.56 0.21 358)"
  host-pink-soft: "oklch(0.95 0.035 358)"
  rival-grey: "oklch(0.6 0 0)"
  night: "oklch(0.155 0 0)"
  night-raised: "oklch(0.185 0 0)"
  night-panel: "oklch(0.205 0 0)"
  night-ink: "oklch(0.96 0 0)"
  night-host-pink: "oklch(0.76 0.15 355)"
  notice-amber: "oklch(0.96 0.05 85)"
typography:
  display:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "clamp(2.5rem, 4.6vw, 4.1rem)"
    fontWeight: 720
    lineHeight: 1.04
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "clamp(2rem, 3.6vw, 3.1rem)"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.6
  data:
    fontFamily: "JetBrains Mono, ui-monospace, Consolas, monospace"
    fontSize: "14px"
    fontWeight: 500
    fontFeature: "\"tnum\""
rounded:
  chip: "6px"
  control: "10px"
  panel: "14px"
spacing:
  gutter: "clamp(16px, 4vw, 40px)"
  section: "clamp(96px, 14vh, 160px)"
  cell: "26px"
components:
  button-primary:
    backgroundColor: "{colors.host-pink}"
    textColor: "{colors.panel}"
    rounded: "{rounded.control}"
    height: "48px"
    padding: "0 8px 0 20px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "48px"
  chip-field:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.chip}"
    padding: "4px 8px"
  panel-event:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "20px 22px"
---

# Design System: OSC Flow Studio community plugins

## Overview

**Creative North Star: "The Studio's own instrument panel"**

Plugin pages look like they came out of OSC Flow Studio itself: neutral greys from the app's
shadcn palette, Inter for words, and one accent per plugin, the same accent the catalog
gives it. The TikTok LIVE pages use pink, and pink always means "the streamer's side".
Data is shown as data, in a monospace face with tabular numbers, because what the plugin
sells is the exact field a flow will read.

Density is low on the landing page and moderate on operational pages. Depth is quiet: a
hairline, or a soft shadow on the one panel that holds data, never both on the same
element. Motion is a single idea per page, driven by scroll, and every page reads correctly
with motion off.

**Key Characteristics:**
- Neutral ground, one plugin accent, light and dark from the system.
- Field names and numbers in JetBrains Mono with tabular figures.
- Hairline dividers between sections instead of card grids.
- No TikTok (or other third-party) logos or brand colours.

## Colors

Achromatic greys with a single saturated accent; nothing is tinted except what the accent marks.

### Primary
- **Host Pink** (oklch(0.56 0.21 358), dark oklch(0.76 0.15 355)): the primary button, the host's score, the current battle phase, focus rings and selection. Its soft tint (oklch(0.95 0.035 358)) is the ground of the streak panel.

### Neutral
- **Paper** (oklch(0.985 0 0)) and **Night** (oklch(0.155 0 0)): page grounds. Never pure white or black.
- **Panel** (oklch(1 0 0) / oklch(0.205 0 0)): the one raised data panel and bento cells.
- **Ink, Muted, Faint** (0.2 / 0.46 / 0.5 lightness, inverted in dark): text levels. Faint stays at 4.5:1 or better on every ground.
- **Rival Grey** (oklch(0.6 0 0)): the opponent's side of a score.
- **Notice Amber** (oklch(0.96 0.05 85)): BETA and risk notices only.

### Named Rules
**The Host Rule.** Pink marks the streamer's side or the one action that matters. It never decorates.

## Typography

**Display Font:** Inter (self-hosted variable)
**Body Font:** Inter
**Data Font:** JetBrains Mono (self-hosted variable)

Inter is a brand commitment: the Studio's interface is set in it.

### Hierarchy
- **Display** (720, clamp(2.5rem, 4.6vw, 4.1rem), 1.04, -0.035em): the hero headline, two lines at desktop.
- **Headline** (700, clamp(2rem, 3.6vw, 3.1rem), 1.08, -0.03em): section headlines.
- **Title** (600, 19px, -0.015em): cell and step titles.
- **Body** (400, 17px, 1.6): paragraphs, 46 to 54ch.
- **Data** (500, 14px, tabular): field names, values and scores.

### Named Rules
**The Field Rule.** Anything a flow reads (`metadata.coins`, `giftId`) is set in the data face, exactly as the flow spells it.

## Layout

Content sits in a 1240px column with a fluid gutter. Sections are separated by a hairline
and generous vertical space; the hero fills the first viewport minus the board. Desktop
layouts are asymmetric two-column splits and one 3-column bento with dense flow; everything
collapses to one column below 860px. The block catalogue is grouped in columns rather than
listed in one long run.

## Elevation & Depth

Flat by default. One soft, two-layer shadow lifts the hero's event panel and the Studio
screenshot; everything else is separated by hairlines or a tonal step.

## Shapes

10px for controls and rows (the Studio's radius), 14px for panels and bento cells, 6px for
chips. Pills are not used.

## Components

### Buttons
Primary: Host Pink fill, 48px tall, label plus a trailing icon in its own tinted square that
nudges up and right on hover; presses down 1px. Quiet: transparent with a strong hairline.
Both say what they do ("Copy catalog URL"); one label per intent.

### Chips
Field-name chips in the data face, 6px radius, raised-paper ground (panel ground inside a
tinted cell).

### Cards / Containers
Bento cells: 14px radius, hairline, 26px padding, one tinted cell and one Host Pink cell per
grid. The event panel lists fields as dashed-separated rows of name and value.

### Navigation
A sticky board at the top: the brand, an example battle score that fills with reading
progress, and section links whose current one carries a pink underline.

### Battle board (signature)
Score left (pink) and right (grey) around a two-colour split bar. Labelled as an example in
its accessible name. Static at its final value with reduced motion.

## Do's and Don'ts

### Do:
- **Do** show real field names and label example values as examples.
- **Do** credit third-party software with links wherever the plugin is described.
- **Do** keep every page complete with motion off and in both colour schemes.

### Don't:
- **Don't** use TikTok's logo, stylised name or brand colours.
- **Don't** put an eyebrow label above a heading, or number sections.
- **Don't** use em or en dashes in page copy.
- **Don't** build fake product UI from divs; use a real Studio screenshot or real data.
