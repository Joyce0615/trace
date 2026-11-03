import { analyzeExperiment } from "./experiments.mjs";
import { auditSnapshot } from "./accessibility.mjs";
import { CONTRAST_TARGETS, contrast as contrastRatioOf, normalizeDisplaySettings } from "./theme.mjs";

/**
 * Accessibility-aware learning experiments (item 29).
 *
 * `experiments.mjs` (item 42) already has an honest two-arm comparison —
 * `analyzeExperiment`, reused unmodified below — that refuses to name a
 * winner when the interval crosses zero or the arms are underpowered.
 * `accessibility.mjs` (item 49) already has a static-snapshot audit —
 * `auditSnapshot`, also reused unmodified — that finds exactly the keyboard,
 * screen-reader, and contrast defects a learner using those paths would
 * actually hit. `theme.mjs`'s own `normalizeDisplaySettings`/
 * `CONTRAST_TARGETS`/`contrast` (item 49) already derive and measure the
 * contrast and motion settings a path needs. Confirmed by grep: zero prior
 * matches for `keyboardOnly`/`screenReader`/`reducedMotion`/`cognitiveLoad`
 * as implementation identifiers anywhere in `electron/*.mjs` before this
 * item, and nothing before this item asked *the same fixed task* to be
 * delivered down six different accessibility paths and then checked
 * whether the one number that actually matters to a learner — how hard the
 * task was — moved when the path changed.
 *
 * The one genuinely new piece this item needs, confirmed absent everywhere
 * else in this codebase: **equivalence testing**, not difference testing.
 * `analyzeExperiment`'s own `"no-difference"` verdict means "we failed to
 * find evidence of a difference", which an underpowered comparison can
 * produce by accident — it is not the same claim as "we have positive
 * evidence the two are the same within a stated margin". A learner who
 * uses the keyboard-only path deserves the second claim, not the first.
 * [`evaluateDifficultyEquivalence`] is the standard two-one-sided-tests
 * (TOST) construction, applied to `analyzeExperiment`'s own already-computed
 * `interval` (never re-derived): equivalence holds only when the comparison
 * is `powered` *and* the whole 95% interval sits inside
 * `[-equivalenceMargin, +equivalenceMargin]` — a stricter, different claim
 * from the interval merely crossing zero.
 *
 * Design that follows from reusing rather than reinventing:
 *
 *   - **An accommodation changes presentation, input modality, or time —
 *     never the correctness bar.** [`pathAccommodation`] returns exactly a
 *     `displaySettings` object (passed straight through `theme.mjs`'s own
 *     `normalizeDisplaySettings`, unmodified), an `interactionMode`, a
 *     `extraTimeMultiplier`, and a `presentationMode`. There is no scoring
 *     field here at all, which is *why* difficulty equivalence is even a
 *     testable question: nothing in this module is allowed to make a task
 *     easier by grading it more leniently.
 *   - **Compliance is checked per path, and a path with no static rule says
 *     so rather than fabricating a pass.** [`auditPathCompliance`] reuses
 *     `auditSnapshot` unmodified for the three paths it actually has rules
 *     for (`keyboard-only`, `screen-reader`, `contrast`) and reports
 *     `applicable: false` with a named reason for the three it does not
 *     (`reduced-motion`, `cognitive-load`, `alternative-format`) — the same
 *     "say what a check can and cannot see" discipline
 *     `model-fingerprint.mjs`'s own `proveOfflineMode` already applies to
 *     its own static-analysis limit.
 *   - **Difficulty equivalence is a statistical claim about *scores*, kept
 *     separate from compliance, which is a structural claim about the
 *     DOM.** [`runAccessibilityLearningExperiment`] reports both, never
 *     blended: a path can be fully compliant and still turn out harder (a
 *     genuine regression to fix), or fail compliance on an unrelated rule
 *     while the scores are still equivalent (a real but separate problem).
 */

export const ACCESSIBILITY_LEARNING_EXPERIMENTS_VERSION = 1;

/** The six paths the item text names, in that order. */
export const ACCESSIBILITY_PATHS = ["keyboard-only", "screen-reader", "reduced-motion", "contrast", "cognitive-load", "alternative-format"];

/** How far apart two mean scores (0..1) may sit and still be called equivalent. */
export const DEFAULT_EQUIVALENCE_MARGIN = 0.1;

/** The accessibility-audit rule ids each snapshot-checkable path actually governs, so a path's own compliance check never silently expands to rules it has no claim over. */
export const PATH_AUDIT_RULES = Object.freeze({
  "keyboard-only": ["no-positive-tabindex", "focusable-aria-hidden", "tab-parent", "tab-selected", "tablist-empty", "tablist-roving"],
  "screen-reader": ["html-lang", "document-title", "interactive-name", "control-label", "landmark-main", "landmark-unique", "dialog-name", "dialog-modal", "aria-reference", "image-alt", "decorative-svg"],
  contrast: ["contrast"],
});

function round(value, places = 4) {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Number(Number(value).toFixed(places));
}

// ---------------------------------------------------------------------------
// Accommodation
// ---------------------------------------------------------------------------

/**
 * Exactly what changes for one path: presentation, input modality, and
 * time. Never a scoring field — the correctness bar for every path is
 * identical, which is what makes "equivalent difficulty" a real question
 * rather than a tautology.
 */
export function pathAccommodation(path) {
  if (!ACCESSIBILITY_PATHS.includes(path)) return { ok: false, reason: "unknown-path" };
  return {
    ok: true,
    path,
    displaySettings: normalizeDisplaySettings({
      contrast: path === "contrast" ? "high" : "normal",
      motion: path === "reduced-motion" ? "reduced" : "full",
    }),
    interactionMode: path === "keyboard-only" ? "keyboard-only" : path === "screen-reader" ? "assistive-technology" : "pointer-or-keyboard",
    extraTimeMultiplier: path === "cognitive-load" ? 2 : 1,
    presentationMode: path === "alternative-format" ? "text-equivalent" : "default",
  };
}

// ---------------------------------------------------------------------------
// Compliance (structural, DOM-level)
// ---------------------------------------------------------------------------

/**
 * Whether a path's own rules are clean in a given rendered snapshot.
 * `auditSnapshot` is reused unmodified and run exactly once; this function
 * only narrows its violations down to the subset that path actually owns.
 */
export function auditPathCompliance(path, snapshot, options = {}) {
  const rules = PATH_AUDIT_RULES[path];
  if (!rules) {
    return { path, applicable: false, reason: `accessibility.mjs has no static rule for the "${path}" path; compliance here cannot be machine-checked.` };
  }
  const audit = auditSnapshot(snapshot, options);
  const relevant = audit.violations.filter((violation) => rules.includes(violation.rule));
  return { path, applicable: true, compliant: relevant.length === 0, violations: relevant, rulesChecked: rules };
}

/**
 * The `contrast` path's own measured check, independent of the DOM audit:
 * every foreground/background pair a caller supplies must clear the ratio
 * `theme.mjs`'s own `CONTRAST_TARGETS` declares for the requested level.
 */
export function measureContrastCompliance(pairs, level = "high") {
  const target = CONTRAST_TARGETS[level] ?? CONTRAST_TARGETS.normal;
  const measured = (pairs ?? []).map((pair) => ({ ...pair, ratio: contrastRatioOf(pair.foreground, pair.background), required: target.text }));
  const failing = measured.filter((entry) => entry.ratio < entry.required);
  return { level, required: target.text, measured, compliant: failing.length === 0, failing };
}

// ---------------------------------------------------------------------------
// Difficulty equivalence (statistical, score-level)
// ---------------------------------------------------------------------------

/**
 * Build the ad hoc two-arm "experiment" `analyzeExperiment` (reused
 * unmodified) expects, with the baseline path as the control arm and the
 * accessibility path as the variant — never registered in
 * `experiments.mjs`'s own `EXPERIMENTS` list, because this comparison is
 * scoped to one evaluation run, not a persisted, consented experiment a
 * learner opts into.
 */
export function buildPathComparison(path, baselineScores, pathScores, options = {}) {
  const experiment = {
    id: `accessibility-path:${path}`,
    arms: [{ id: "baseline", control: true }, { id: path, control: false }],
    metric: "task-score",
    minimumSample: options.minimumSample ?? 3,
    higherIsBetter: true,
  };
  const observations = [
    ...(baselineScores ?? []).map((value) => ({ experimentId: experiment.id, arm: "baseline", metric: "task-score", value })),
    ...(pathScores ?? []).map((value) => ({ experimentId: experiment.id, arm: path, metric: "task-score", value })),
  ];
  return analyzeExperiment(experiment, observations);
}

/**
 * Two-one-sided-tests equivalence over `analyzeExperiment`'s own already
 * computed interval. Equivalence is a *stronger*, different claim than
 * `analysis.verdict === "no-difference"`: the whole interval must sit
 * inside `[-margin, +margin]`, and the comparison must be `powered` — an
 * underpowered comparison is `"underpowered"`, never silently promoted to
 * `"equivalent"` just because its wide interval happens to contain zero.
 */
export function evaluateDifficultyEquivalence(analysis, margin = DEFAULT_EQUIVALENCE_MARGIN) {
  if (!analysis.powered) return { verdict: "underpowered", margin, interval: analysis.interval, needed: analysis.needed };
  const [lower, upper] = analysis.interval;
  const equivalent = lower >= -margin && upper <= margin;
  return {
    verdict: equivalent ? "equivalent" : "not-equivalent",
    margin,
    interval: analysis.interval,
    difference: analysis.difference,
  };
}

// ---------------------------------------------------------------------------
// Top-level, per-path report
// ---------------------------------------------------------------------------

/**
 * One path's full report: the accommodation that was actually applied, its
 * structural compliance (or an honest "not applicable"), and whether the
 * task it produced is statistically equivalent in difficulty to the
 * baseline — three separate claims, never blended into one score.
 */
export function runAccessibilityLearningExperiment({ path, baselineScores, pathScores, snapshot, contrastPairs, options = {} }) {
  const accommodation = pathAccommodation(path);
  if (!accommodation.ok) return { ok: false, reason: accommodation.reason };

  const compliance = snapshot ? auditPathCompliance(path, snapshot, options.auditOptions) : { path, applicable: false, reason: "no-snapshot-supplied" };
  const contrastCheck = path === "contrast" && contrastPairs ? measureContrastCompliance(contrastPairs, accommodation.displaySettings.contrast) : null;

  const comparison = buildPathComparison(path, baselineScores, pathScores, options);
  const equivalence = evaluateDifficultyEquivalence(comparison, options.equivalenceMargin ?? DEFAULT_EQUIVALENCE_MARGIN);

  return {
    version: ACCESSIBILITY_LEARNING_EXPERIMENTS_VERSION,
    ok: true,
    path,
    accommodation,
    compliance,
    contrastCheck,
    comparison,
    equivalence,
  };
}

/** Every path, side by side, never averaged into one app-wide accessibility score. */
export function runAllAccessibilityPaths({ baselineScores, perPathScores = {}, snapshots = {}, contrastPairs, options = {} }) {
  return ACCESSIBILITY_PATHS.map((path) => runAccessibilityLearningExperiment({
    path,
    baselineScores,
    pathScores: perPathScores[path] ?? [],
    snapshot: snapshots[path],
    contrastPairs: path === "contrast" ? contrastPairs : undefined,
    options,
  }));
}

/** Human-readable rendering, for a report panel or a CLI printout. */
export function renderAccessibilityLearningExperiments(reports) {
  const lines = ["# Accessibility-aware learning experiments", ""];
  for (const report of reports) {
    if (!report.ok) { lines.push(`## ${report.reason}`); continue; }
    lines.push(`## ${report.path}`);
    lines.push(`  - Compliance: ${report.compliance.applicable === false ? `n/a (${report.compliance.reason})` : report.compliance.compliant ? "clean" : `${report.compliance.violations.length} violation(s)`}.`);
    lines.push(`  - Difficulty: ${report.equivalence.verdict}${report.equivalence.difference === null ? "" : ` (difference ${round(report.equivalence.difference)}, margin ±${report.equivalence.margin})`}.`);
  }
  return lines.join("\n");
}
