// The landing page's one motion idea: the page is a battle the visitor scores by reading.
// The scoreboard fills with scroll progress, the streak counts its taps, and the battle
// steps through its phases. Everything is visible and correct without this script.
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
// Thousands with a thin space, the same on every computer.
const group = (value) => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

// --- Copy the catalog URL
for (const button of $$("[data-copy]")) {
  button.addEventListener("click", async () => {
    const url = button.dataset.copy;
    const label = $("[data-copy-label]", button);
    const note = $("[data-copy-note]");
    try {
      await navigator.clipboard.writeText(url);
      label.textContent = "Copied";
      if (note) note.textContent = "Paste it under Integrations, then Sources, in OSC Flow Studio.";
    } catch {
      if (note) note.textContent = url;
      label.textContent = "Copy it from below";
    }
    setTimeout(() => { label.textContent = "Copy catalog URL"; }, 2400);
  });
}

// --- Scoreboard: host leads by the end of the page, as in the example battle.
const hostScore = $('[data-score="host"]');
const rivalScore = $('[data-score="rival"]');
const hostBar = $('[data-bar="host"]');
const rivalBar = $('[data-bar="rival"]');
const FINAL = { host: 1240, rival: 880 };

function setScore(progress) {
  // The rival leads early, the host takes over past the middle: a battle, not a progress bar.
  const host = FINAL.host * Math.pow(progress, 1.35);
  const rival = FINAL.rival * Math.min(1, Math.pow(progress, 0.8) * 1.05);
  hostScore.textContent = group(host);
  rivalScore.textContent = group(rival);
  const total = host + rival || 1;
  hostBar.style.flexGrow = String(host / total || 1);
  rivalBar.style.flexGrow = String(rival / total || 1);
}

// --- Current round in the board
const links = new Map($$("[data-round]").map((link) => [link.dataset.round, link]));
for (const section of $$("[data-round-section]")) {
  ScrollTrigger.create({
    trigger: section,
    start: "top 45%",
    end: "bottom 45%",
    onToggle: (self) => {
      const link = links.get(section.dataset.roundSection);
      if (link) link.setAttribute("aria-current", self.isActive ? "true" : "false");
    },
  });
}

// --- Battle phases: the current phase lights up as the section is read.
const phases = $$(".phases li");
function lightPhase(index) {
  phases.forEach((phase, i) => phase.classList.toggle("is-live", i === index));
}

if (reduced) {
  setScore(1);
  lightPhase(phases.length - 1);
} else {
  setScore(0);
  ScrollTrigger.create({
    start: 0,
    end: "max",
    onUpdate: (self) => setScore(self.progress),
  });

  // Streak: taps fill in, the count climbs, the gift counts once at the end.
  const taps = $$(".tap");
  const count = $("[data-streak-count]");
  const coins = $("[data-streak-coins]");
  const streak = { taps: 0 };
  gsap.set(taps, { opacity: 0.18, scale: 0.86 });
  gsap.timeline({ scrollTrigger: { trigger: ".streak", start: "top 80%", end: "bottom 35%", scrub: 0.6 } })
    .to(streak, {
      taps: taps.length,
      ease: "none",
      onUpdate: () => {
        const n = Math.round(streak.taps);
        taps.forEach((tap, i) => gsap.set(tap, { opacity: i < n ? 1 : 0.18, scale: i < n ? 1 : 0.86 }));
        count.textContent = String(Math.max(1, n));
        coins.textContent = n >= taps.length ? String(taps.length) : "0";
      },
    });

  // Battle: pin the section and step through start, update, lead-change, end.
  const media = gsap.matchMedia();
  media.add("(min-width: 861px)", () => {
    lightPhase(0);
    const trigger = ScrollTrigger.create({
      trigger: ".battle-pin",
      start: "top top+=96",
      end: "+=900",
      pin: true,
      scrub: true,
      onUpdate: (self) => lightPhase(Math.min(phases.length - 1, Math.floor(self.progress * phases.length))),
    });
    return () => trigger.kill();
  });
  media.add("(max-width: 860px)", () => {
    const triggers = phases.map((phase, i) => ScrollTrigger.create({ trigger: phase, start: "top 70%", onEnter: () => lightPhase(i), onEnterBack: () => lightPhase(i) }));
    return () => triggers.forEach((trigger) => trigger.kill());
  });

  // One entrance, on the hero's event panel: it arrives like an event does.
  gsap.from(".event", { y: 18, opacity: 0, filter: "blur(6px)", duration: 0.9, ease: "expo.out", delay: 0.15, clearProps: "all" });
}
