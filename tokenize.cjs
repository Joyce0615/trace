/**
 * One-shot tokenizer: rewrite every literal colour in styles.css as a custom
 * property, then emit the derived light and high-contrast palettes. Run once;
 * kept out of the shipped source.
 */
const fs = require("fs");

const FOREGROUND = /^(color|fill|stroke|accent-color|caret-color|text-decoration-color|-webkit-text-fill-color)$/;
const DECLARATION = /(^|[;{}])\s*(--?[-a-zA-Z0-9]*|[-a-zA-Z][-a-zA-Z0-9]*)\s*:\s*([^;{}]*)/g;

/**
 * The dozen named variables the stylesheet defines for itself. They are
 * tokenized by hand because a `var()` hides the role: `--text` is assigned in a
 * custom-property declaration, which looks like a surface, and is then consumed
 * by every `color:` in the file.
 */
const NAMED_ROLES = {
  "--bg": "surface", "--panel": "surface", "--panel-2": "surface", "--panel-3": "surface",
  "--line": "surface", "--line-soft": "surface",
  "--text": "foreground", "--muted": "foreground", "--dim": "foreground",
  "--green": "foreground", "--purple": "foreground", "--blue": "foreground",
};

(async () => {
  const theme = await import("./electron/theme.mjs");
  let css = fs.readFileSync("src/styles.css", "utf8");

  // Pass one: which roles does each colour serve? A colour used as both a
  // foreground and a surface gets two tokens, because a light theme has to move
  // it in two different directions.
  const roles = new Map();
  let match;
  const named = {};
  while ((match = DECLARATION.exec(css))) {
    const property = match[2].toLowerCase();
    if (property.startsWith("--")) {
      // The app's own variables are re-derived by name in the theme blocks.
      const hex = /#[0-9a-fA-F]{3,8}\b/.exec(match[3]);
      if (hex && NAMED_ROLES[property]) named[property] = hex[0].toLowerCase();
      continue;
    }
    const kind = FOREGROUND.test(property) ? "foreground" : "surface";
    for (const hexMatch of match[3].matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      const hex = hexMatch[0].toLowerCase();
      if (!roles.has(hex)) roles.set(hex, new Set());
      roles.get(hex).add(kind);
    }
  }

  const tokens = [];
  const nameOf = new Map();
  for (const hex of [...roles.keys()].sort()) {
    for (const kind of ["foreground", "surface"]) {
      if (!roles.get(hex).has(kind)) continue;
      const name = `--p${String(tokens.length).padStart(3, "0")}${kind === "foreground" ? "f" : "s"}`;
      tokens.push({ name, hex, kind });
      nameOf.set(`${hex}|${kind}`, name);
    }
  }

  // Pass two: substitute, choosing the token by the property it sits in.
  DECLARATION.lastIndex = 0;
  css = css.replace(DECLARATION, (full, _pre, property, value) => {
    if (property.startsWith("--")) return full;
    const kind = FOREGROUND.test(property.toLowerCase()) ? "foreground" : "surface";
    const replaced = value.replace(/#[0-9a-fA-F]{3,8}\b/g, (hex) => {
      const name = nameOf.get(`${hex.toLowerCase()}|${kind}`);
      return name ? `var(${name})` : hex;
    });
    return full.slice(0, full.length - value.length) + replaced;
  });

  const block = (selector, options) => {
    const lines = tokens.map(({ name, hex, kind }) => `  ${name}: ${options ? theme.deriveColor(hex, { ...options, kind }) : hex};`);
    // The named variables are only overridden in the derived blocks, and those
    // blocks are qualified with `html` so they out-specify the stylesheet's own
    // `:root`, which is written further down the file. Equal specificity plus
    // source order is why the first attempt silently kept the dark values.
    if (options) {
      for (const [property, hex] of Object.entries(named)) {
        lines.push(`  ${property}: ${theme.deriveColor(hex, { ...options, kind: NAMED_ROLES[property] })};`);
      }
    }
    // The ink used on an accent surface has to flip with the accent itself: in
    // the dark theme `--green` is a light green and its text is near-black; in
    // the light theme the same token derives dark and its text must be white.
    const accent = options ? theme.deriveColor(named["--green"] ?? "#9ee66f", { ...options, kind: NAMED_ROLES["--green"] }) : (named["--green"] ?? "#9ee66f");
    lines.push(`  --accent-ink: ${theme.luminance(theme.hexToRgb(accent)) > 0.4 ? "#0b0e14" : "#ffffff"};`);
    return `${selector} {\n${lines.join("\n")}\n}\n`;
  };

  const header = `/*
 * Item 49: the palette, as tokens.
 *
 * Every colour in this stylesheet is a custom property, and the blocks below are
 * *derived* from the dark values by \`electron/theme.mjs\` rather than written by
 * hand: hundreds of hand-written colours would be hundreds of chances to ship
 * one that cannot be read. Each token records the role it was used in —
 * foreground (\`f\`) or surface (\`s\`) — because the two must move in opposite
 * directions when the theme flips, and a colour used as both gets one token of
 * each. Regenerate with \`node tokenize.cjs\`.
 */
${block(":root")}
${block('html[data-theme="light"]', { theme: "light", contrast: "normal" })}
${block('html[data-contrast="high"]', { theme: "dark", contrast: "high" })}
${block('html[data-theme="light"][data-contrast="high"]', { theme: "light", contrast: "high" })}
/* --- generated palette ends; everything below is authored --- */
`;

  const visionBlocks = Object.entries(theme.GRAPH_PALETTES).map(([vision, palette]) => {
    const selector = vision === "default" ? ":root" : `[data-vision="${vision}"]`;
    return `${selector} {\n${theme.GRAPH_CATEGORIES.map((category) => `  --cat-${category.id}: ${palette[category.id]};`).join("\n")}\n}`;
  }).join("\n");

  const footer = `
/* --- generated modes begin --- */
/*
 * Item 49: colour-vision modes, reduced motion, and redundant encoding.
 *
 * The category colours are generated from \`electron/theme.mjs\`, where a test
 * measures the distance between every pair *after* simulating the deficiency
 * each palette is for. That measurement is necessary and not sufficient: a
 * reader on a monochrome display, a projector, or a printout has no hue at all,
 * so every category also carries a glyph and a border pattern. Colour is never
 * the only channel.
 */
${visionBlocks}

/*
 * Text sitting on an accent surface follows the accent rather than the theme:
 * \`--green\` is a light green in the dark theme and a dark green in the light
 * one, so its ink has to flip with it. \`!important\` is deliberate — each of
 * these components sets its own literal ink, and the accent has to win.
 */
.repo-entry button, .featured-demo em, .font-size-control button.active, .mastered .skill-orb,
.skill-node em, .lesson-state.complete, .agent-orb, .guide-primary, button.primary,
.diagnostic-questions legend span { color: var(--accent-ink) !important; }

.skill-legend i::after { content: attr(data-glyph); }
.skill-legend i { position: relative; width: auto; min-width: 6px; height: auto; border-radius: 0; background: none; color: var(--cat-available); font-style: normal; }
.skill-legend i.mastered { background: none; color: var(--cat-mastered); }
.skill-legend i.recommended { border: 0; box-shadow: none; background: none; color: var(--cat-recommended); }
.skill-legend i.locked { color: var(--cat-locked); }
.skill-legend i.stale { color: var(--cat-stale); }
.skill-node .skill-orb { position: relative; }
.skill-node.mastered .skill-orb { box-shadow: inset 0 0 0 2px var(--cat-mastered); }
.skill-node.recommended .skill-orb { box-shadow: inset 0 0 0 2px var(--cat-recommended); }
.skill-node.locked .skill-orb { box-shadow: inset 0 0 0 2px var(--cat-locked); }
.skill-node.stale .skill-orb { box-shadow: inset 0 0 0 2px var(--cat-stale); }
/* The border pattern is the second channel: solid, dashed, dotted, and double
   survive any colour-vision deficiency, a greyscale display, and a printout. */
.skill-node.mastered { border-style: solid; }
.skill-node.recommended { border-style: dashed; }
.skill-node.locked { border-style: dotted; }
.skill-node.stale { border-style: double; }
.skill-status-glyph { font-style: normal; margin-right: 4px; }

/*
 * Reduced motion. Both the system preference and the explicit setting are
 * honoured, because a learner may want the animation off on this machine
 * without changing the whole operating system, and may equally have already
 * said so at the operating-system level and expect to be believed.
 */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}
[data-motion="reduced"] *, [data-motion="reduced"] *::before, [data-motion="reduced"] *::after {
  animation-duration: 0.001ms !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0.001ms !important;
  scroll-behavior: auto !important;
}

.display-settings { display: flex; align-items: center; gap: 6px; }
.display-settings label { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: calc(8px + var(--font-boost)); text-transform: uppercase; letter-spacing: .08em; }
.display-settings select { min-height: 24px; padding: 2px 6px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--text); font-size: calc(9px + var(--font-boost)); }
`;

  fs.writeFileSync("src/styles.css", `${header}\n${css}\n${footer}`);
  const counts = tokens.reduce((totals, entry) => ({ ...totals, [entry.kind]: (totals[entry.kind] ?? 0) + 1 }), {});
  console.log(`tokenized ${tokens.length} tokens over ${roles.size} colours`, counts);
})();
