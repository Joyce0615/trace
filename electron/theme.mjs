/**
 * Themes, contrast levels, and colour-vision-safe categorical palettes.
 *
 * Three separate problems get solved here, and the reason they share a module
 * is that all three are colour arithmetic that must be *checked* rather than
 * eyeballed.
 *
 *   - **Theme.** The authored palette is the dark one. A light theme is derived
 *     from it rather than hand-written, because 425 hand-written colours is 425
 *     chances to ship one that cannot be read. The derivation is a documented
 *     transform per colour *role*: a foreground and a surface must move in
 *     opposite directions when the theme flips, so `styles.css` records which
 *     each colour is and this module moves it accordingly.
 *
 *   - **Contrast.** High contrast is not "a bit darker". It is a target ratio:
 *     foregrounds are pushed until they clear 7:1 (WCAG AAA) against the
 *     surfaces they sit on, and surfaces are pushed away from them.
 *
 *   - **Colour vision.** A graph that distinguishes "mastered" from "locked" by
 *     hue alone is unreadable for roughly one man in twelve. Two things fix
 *     that and only together: palettes whose members stay far apart *after* a
 *     simulated deficiency, and a second, non-colour channel on every category
 *     — a shape and a pattern — so colour is never the only carrier of meaning.
 *     `paletteSeparation` measures the first; the categories declare the second.
 *
 * Node-free, so the desktop app, the browser demo, and the tests all compute the
 * same colours.
 */

export const THEME_VERSION = 1;
export const THEMES = ["dark", "light"];
export const CONTRAST_LEVELS = ["normal", "high"];
export const MOTION_LEVELS = ["full", "reduced"];
export const VISION_MODES = ["default", "deuteranopia", "protanopia", "tritanopia", "monochrome"];

/** Ratios the derivation aims for; stated here so the cost of changing one is visible. */
export const CONTRAST_TARGETS = {
  // `surfaceLuminance` is the *worst* surface a foreground may land on, not an
  // average one. Computing against a typical background produced text that
  // cleared 4.5:1 on most panels and 3.1:1 on the darkest, which is exactly the
  // failure the ratio exists to prevent.
  normal: { text: 4.5, surfaceLuminance: { dark: 0.06, light: 0.74 } },
  // AAA for body text. High contrast is a promise about a number, not a mood.
  high: { text: 7, surfaceLuminance: { dark: 0.02, light: 0.86 } },
};

/** The floor a light surface is raised to, and the ceiling a dark one is pushed under. */
export const SURFACE_BOUNDS = { light: { normal: 0.74, high: 0.86 }, dark: { normal: 0.55, high: 0.35 } };

/**
 * Parse `#rgb`, `#rgba`, `#rrggbb`, or `#rrggbbaa`.
 *
 * The alpha is kept separate and put back untouched, because a translucent
 * scrim is translucent in every theme: deriving it as though it were opaque
 * produced `#NaNNaNNaN` for every four-digit colour in the stylesheet.
 */
export function parseHex(hex) {
  let value = String(hex).replace("#", "").toLowerCase();
  if (value.length === 3 || value.length === 4) value = value.split("").map((channel) => channel + channel).join("");
  const alpha = value.length === 8 ? value.slice(6, 8) : "";
  return { rgb: [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)), alpha };
}

export function hexToRgb(hex) {
  return parseHex(hex).rgb;
}

export function rgbToHex(rgb, alpha = "") {
  return `#${rgb.map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0")).join("")}${alpha}`;
}

const toLinear = (channel) => {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (channel) => {
  const clamped = Math.max(0, Math.min(1, channel));
  return 255 * (clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055);
};

export function luminance(rgb) {
  const [r, g, b] = rgb.map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(foreground, background) {
  const first = luminance(foreground);
  const second = luminance(background);
  return Number(((Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)).toFixed(3));
}

/**
 * Move a colour to a target luminance by blending toward black or white.
 *
 * Blending rather than rewriting the channels keeps the hue recognisable, which
 * matters: a theme that changes what "the green one" means has not been themed,
 * it has been replaced.
 */
export function withLuminance(rgb, target) {
  const current = luminance(rgb);
  if (Math.abs(current - target) < 0.001) return rgb;
  const toward = target > current ? [255, 255, 255] : [0, 0, 0];
  let low = 0;
  let high = 1;
  let best = rgb;
  for (let step = 0; step < 30; step += 1) {
    const mix = (low + high) / 2;
    const candidate = rgb.map((channel, index) => channel + (toward[index] - channel) * mix);
    const value = luminance(candidate);
    best = candidate;
    if ((target > current && value < target) || (target < current && value > target)) low = mix;
    else high = mix;
  }
  return best;
}

/** The luminance a foreground needs to clear `ratio` against a background luminance. */
export function luminanceForContrast(backgroundLuminance, ratio, lighter) {
  return lighter
    ? ratio * (backgroundLuminance + 0.05) - 0.05
    : (backgroundLuminance + 0.05) / ratio - 0.05;
}

/**
 * Derive one colour for a theme and contrast level.
 *
 * `kind` is the colour's role as recorded when the stylesheet was tokenized:
 * "foreground" for text and icons, "surface" for backgrounds, borders, and
 * shadows. A colour used as both is treated as a foreground, because unreadable
 * text is a worse failure than a slightly wrong panel.
 */
export function deriveColor(hex, { kind = "foreground", theme = "dark", contrast: level = "normal" } = {}) {
  const { rgb, alpha } = parseHex(hex);
  if (theme === "dark" && level === "normal") return rgbToHex(rgb, alpha);
  const target = CONTRAST_TARGETS[level] ?? CONTRAST_TARGETS.normal;
  const base = target.surfaceLuminance[theme] ?? 0.02;
  const current = luminance(rgb);

  if (kind === "surface") {
    if (theme === "light") {
      // Surfaces mirror: the darkest panel becomes the lightest, and the
      // separation between panels is preserved rather than flattened.
      const mirrored = 1 - current;
      const floor = SURFACE_BOUNDS.light[level] ?? SURFACE_BOUNDS.light.normal;
      return rgbToHex(withLuminance(rgb, Math.max(floor, Math.min(1, mirrored))), alpha);
    }
    // Dark and high contrast: push panels away from the text.
    return rgbToHex(withLuminance(rgb, Math.max(0, current * (SURFACE_BOUNDS.dark[level] ?? SURFACE_BOUNDS.dark.normal))), alpha);
  }

  // Foregrounds are placed by the ratio they have to clear, not by taste.
  const needed = theme === "light"
    ? luminanceForContrast(base, target.text, false)
    : luminanceForContrast(base, target.text, true);
  const wanted = theme === "light"
    ? Math.min(needed, 1 - current)
    : Math.max(needed, current);
  return rgbToHex(withLuminance(rgb, Math.max(0, Math.min(1, wanted))), alpha);
}

// Machado, Oliveira & Fernandes (2009), severity 1.0, applied in linear RGB.
const VISION_MATRICES = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};

/** Simulate how a colour is seen with a colour-vision deficiency. */
export function simulateVision(hex, mode) {
  const rgb = hexToRgb(hex);
  if (mode === "monochrome") {
    const grey = fromLinear(luminance(rgb));
    return rgbToHex([grey, grey, grey]);
  }
  const matrix = VISION_MATRICES[mode];
  if (!matrix) return rgbToHex(rgb);
  const linear = rgb.map(toLinear);
  return rgbToHex(matrix.map((row) => fromLinear(row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2])));
}

function toLab(rgb) {
  const [r, g, b] = rgb.map(toLinear);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (value) => (value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76 colour difference. Crude next to CIEDE2000, and sufficient for "are these two obviously different". */
export function colorDistance(first, second) {
  const [l1, a1, b1] = toLab(hexToRgb(first));
  const [l2, a2, b2] = toLab(hexToRgb(second));
  return Number(Math.hypot(l1 - l2, a1 - a2, b1 - b2).toFixed(2));
}

/**
 * Categories used by every graph, diagram, and status badge in the app.
 *
 * Each one carries a shape and a pattern as well as a colour. That redundancy
 * is the point: the palettes below are chosen to survive a simulated
 * deficiency, but "chosen to survive" is a claim about a measurement, and a
 * reader with a monochrome display, a projector, or a printout has no colour at
 * all. Shape and pattern still work there.
 */
export const GRAPH_CATEGORIES = [
  { id: "mastered", label: "Mastered", shape: "circle", pattern: "solid", glyph: "●" },
  { id: "recommended", label: "Recommended", shape: "diamond", pattern: "dashed", glyph: "◆" },
  { id: "available", label: "Available", shape: "square", pattern: "dotted", glyph: "■" },
  { id: "locked", label: "Locked", shape: "triangle", pattern: "none", glyph: "▲" },
  { id: "stale", label: "Needs review", shape: "cross", pattern: "cross-hatch", glyph: "✕" },
];

/**
 * Categorical palettes.
 *
 * `default` is the app's own hues. The other three were **searched for rather
 * than chosen**: a candidate grid over hue, saturation, and lightness, filtered
 * to colours legible on both the dark and the light surface, then optimised to
 * maximise the *smallest* pairwise distance after simulating that specific
 * deficiency — scored jointly against normal vision so a palette cannot buy
 * separation under one at the cost of the other. Reputable hand-picked sets did
 * markedly worse when measured: the widely recommended Okabe-Ito palette scores
 * a worst pair of **7.4** under simulated deuteranopia, where the searched set
 * scores **43.7**, because its yellow and orange collapse onto each other.
 *
 * Greyscale is deliberately not part of that objective. Five hues cannot also be
 * five distinct greys inside a usable contrast band, which is exactly why every
 * category carries a glyph and a border pattern — and why `monochrome` is a
 * separate palette that gives up on hue entirely and separates by lightness.
 */
export const GRAPH_PALETTES = {
  default: { mastered: "#9ee66f", recommended: "#79c8ff", available: "#a991ff", locked: "#8792a4", stale: "#e0bd7a" },
  deuteranopia: { mastered: "#b03b89", recommended: "#f96d10", available: "#104ef9", locked: "#376b24", stale: "#10abf9" },
  protanopia: { mastered: "#5aaf9e", recommended: "#2ab814", available: "#642efa", locked: "#c70505", stale: "#f910ab" },
  tritanopia: { mastered: "#c2298f", recommended: "#14b82a", available: "#642efa", locked: "#c39d83", stale: "#e50606" },
  monochrome: { mastered: "#f2f2f2", recommended: "#bdbdbd", available: "#8a8a8a", locked: "#5a5a5a", stale: "#2e2e2e" },
};

/**
 * The smallest distance between any two categories in a palette, after
 * simulating a given kind of colour vision.
 *
 * Reporting the *worst* pair rather than an average is deliberate: a palette is
 * only as readable as its closest two colours, and an average hides exactly the
 * pair that will be confused.
 */
export function paletteSeparation(palette, vision = "default") {
  const entries = Object.entries(palette);
  let worst = { distance: Number.POSITIVE_INFINITY, pair: null };
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const first = simulateVision(entries[i][1], vision);
      const second = simulateVision(entries[j][1], vision);
      const distance = colorDistance(first, second);
      if (distance < worst.distance) worst = { distance, pair: [entries[i][0], entries[j][0]] };
    }
  }
  return worst;
}

/**
 * Pick a palette for a reader's declared colour vision.
 *
 * `default` is only used when nobody has said otherwise; every other mode gets
 * a palette measured against that specific deficiency rather than a single
 * "accessible" palette that is a compromise for all of them.
 */
export function paletteFor(vision = "default") {
  return GRAPH_PALETTES[vision] ?? GRAPH_PALETTES.default;
}

/** The full display settings, normalized, with anything unrecognized falling back. */
export function normalizeDisplaySettings(settings = {}) {
  return {
    theme: THEMES.includes(settings.theme) ? settings.theme : "dark",
    contrast: CONTRAST_LEVELS.includes(settings.contrast) ? settings.contrast : "normal",
    motion: MOTION_LEVELS.includes(settings.motion) ? settings.motion : "full",
    vision: VISION_MODES.includes(settings.vision) ? settings.vision : "default",
  };
}
