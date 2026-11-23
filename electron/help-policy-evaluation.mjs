import { appendEvent } from "./activity-log.mjs";
import { MIN_SAMPLE, rate } from "./analytics.mjs";
import { classifyRequestObjective } from "./cognitive-offload-guard.mjs";
import { HIGH_LOAD_THRESHOLD, LOW_LOAD_THRESHOLD } from "./cognitive-load-regulation.mjs";

/**
 * Help-policy evaluation by help-seeking state.
 *
 * `cognitive-offload-guard.mjs` already decides, per request, whether a
 * finished solution should be gated. `cognitive-load-regulation.mjs`
 * already estimates extraneous load from real behavior. Neither one asks
 * the question this item names: *which response style actually works*,
 * and whether that answer is the same for every kind of request and every
 * load state, or whether a verification-first style that helps a calm
 * learner debugging a clear error is actively worse for a confused learner
 * asking a conceptual question. Collapsing all of that into one global
 * "this is our help style" setting is exactly the thing this item asks not
 * to do.
 *
 * Confirmed by grep before writing a line here: zero prior matches for
 * `RESPONSE_STYLES`/`helpPolicyCell`/`evaluateHelpPolicies` anywhere in
 * `electron/*.mjs`.
 *
 * Design, reusing rather than reinventing:
 *
 *   - **Request category** (`classifyRequestCategory`) reuses
 *     `cognitive-offload-guard.mjs`'s own `classifyRequestObjective`
 *     unmodified and only adds a mapping onto this item's own three named
 *     buckets: its `debugging` passes through unchanged; `architecture`
 *     and `performance` (both about how code is built or structured) map
 *     onto this item's `implementation`; `onboarding`, `security`, and
 *     `unclassified` (all about understanding something, not changing it)
 *     map onto this item's `conceptual`. No request text is matched
 *     against a second, parallel pattern set.
 *   - **Confusion/load state** (`classifyLoadState`) reuses
 *     `cognitive-load-regulation.mjs`'s own `HIGH_LOAD_THRESHOLD`/
 *     `LOW_LOAD_THRESHOLD` constants unmodified against a caller-supplied
 *     extraneous-load value (itself `cognitive-load-regulation.mjs`'s own
 *     `estimateExtraneousLoad`, computed elsewhere) — this module does not
 *     re-derive load from raw behavior, only buckets an already-estimated
 *     value. A value in the middle band is honestly reported as `null`
 *     (neither low nor high) rather than forced into one side.
 *   - **Scoring** (`scoreHelpPolicyCell`) reuses `analytics.mjs`'s own
 *     `rate()` unmodified, which already refuses to report below
 *     `MIN_SAMPLE` observations rather than guessing from too few.
 *
 * The one new thing this module adds is the cross-tab itself:
 * `evaluateHelpPolicies` scores every (response style × request category ×
 * load state) cell independently and returns them as a flat list. There is
 * deliberately no function anywhere in this module that averages across
 * cells into one ranking or one recommended style — the absence of that
 * function is the enforcement of "instead of selecting one global style."
 */

export const HELP_POLICY_EVALUATION_VERSION = 1;

/** The four response styles this item names, in the item's own stated order. */
export const RESPONSE_STYLES = Object.freeze(["verification", "stepwise", "socratic", "direct-answer"]);

/** The three request categories this item names, in the item's own stated order. */
export const REQUEST_CATEGORIES = Object.freeze(["conceptual", "debugging", "implementation"]);

/** The two load/confusion states this item names. */
export const LOAD_STATES = Object.freeze(["low", "high"]);

/** Which `classifyRequestObjective` buckets map onto which of this item's three categories. */
const CATEGORY_MAP = Object.freeze({
  debugging: "debugging",
  architecture: "implementation",
  performance: "implementation",
  onboarding: "conceptual",
  security: "conceptual",
  unclassified: "conceptual",
});

/**
 * One of this item's own three request categories, derived from
 * `cognitive-offload-guard.mjs`'s own `classifyRequestObjective` unmodified.
 */
export function classifyRequestCategory(text) {
  return CATEGORY_MAP[classifyRequestObjective(text)] ?? "conceptual";
}

/**
 * One of this item's own two load states, derived from a caller-supplied
 * extraneous-load value against `cognitive-load-regulation.mjs`'s own
 * thresholds, unmodified. A value in the middle band is honestly `null`.
 */
export function classifyLoadState(extraneous) {
  if (typeof extraneous !== "number" || !Number.isFinite(extraneous)) return null;
  if (extraneous >= HIGH_LOAD_THRESHOLD) return "high";
  if (extraneous <= LOW_LOAD_THRESHOLD) return "low";
  return null;
}

/** The allowlist for one raw help-policy outcome observation. Everything else is dropped. */
export const HELP_POLICY_OBSERVATION_FIELDS = ["responseStyle", "category", "loadState", "success", "at"];

/**
 * The privacy/validity allowlist for one observation. Rebuilt from scratch
 * rather than filtered, the same discipline
 * `counterbalanced-assistance-experiments.mjs`'s own
 * `sanitizeAssistanceObservation` already applies.
 */
export function sanitizeHelpPolicyObservation(candidate) {
  if (!RESPONSE_STYLES.includes(candidate?.responseStyle)) return { ok: false, reason: "unknown-response-style" };
  if (!REQUEST_CATEGORIES.includes(candidate?.category)) return { ok: false, reason: "unknown-category" };
  if (!LOAD_STATES.includes(candidate?.loadState)) return { ok: false, reason: "unknown-load-state" };
  if (typeof candidate?.success !== "boolean") return { ok: false, reason: "missing-success" };
  const at = typeof candidate?.at === "string" && Number.isFinite(Date.parse(candidate.at)) ? candidate.at : new Date().toISOString();
  return { ok: true, observation: { responseStyle: candidate.responseStyle, category: candidate.category, loadState: candidate.loadState, success: candidate.success, at } };
}

/** A stable key for one cell of the (style × category × load) cross-tab. */
export function helpPolicyCellKey(responseStyle, category, loadState) {
  return `${responseStyle}:${category}:${loadState}`;
}

/**
 * One cell's own success rate, reusing `analytics.mjs`'s own `rate()`
 * unmodified — it already refuses to report below `MIN_SAMPLE` observations.
 */
export function scoreHelpPolicyCell(responseStyle, category, loadState, observations, options = {}) {
  const relevant = (observations ?? []).filter(
    (item) => item.responseStyle === responseStyle && item.category === category && item.loadState === loadState,
  );
  const successes = relevant.filter((item) => item.success === true).length;
  return {
    version: HELP_POLICY_EVALUATION_VERSION,
    cell: helpPolicyCellKey(responseStyle, category, loadState),
    responseStyle,
    category,
    loadState,
    ...rate(successes, relevant.length, options.minimumSample ?? MIN_SAMPLE),
  };
}

/**
 * Every (response style × request category × load state) cell, scored
 * independently. Deliberately returned as a flat list with no averaging
 * step anywhere in this module — a caller that wants "the best style"
 * would have to invent that aggregation itself, which is the point: this
 * item asks for cells, not a global winner.
 */
export function evaluateHelpPolicies(observations, options = {}) {
  const cells = [];
  for (const responseStyle of RESPONSE_STYLES) {
    for (const category of REQUEST_CATEGORIES) {
      for (const loadState of LOAD_STATES) {
        cells.push(scoreHelpPolicyCell(responseStyle, category, loadState, observations, options));
      }
    }
  }
  return { version: HELP_POLICY_EVALUATION_VERSION, cells };
}

/**
 * Preserve one raw help-policy outcome observation as learning evidence,
 * through `activity-log.mjs`'s own `appendEvent` (unmodified) — the same
 * append-only, main-process-only log every other graded/measured activity
 * in this app already writes to.
 */
export function recordHelpPolicyOutcome(directory, repositoryId, observation) {
  return appendEvent(directory, repositoryId, { kind: "help-policy-outcome", ...observation });
}

/** Human-readable rendering, one line per cell, for review tooling. */
export function renderHelpPolicyReport(report) {
  if (!report?.cells?.length) return "No help-policy cells to report.";
  return report.cells
    .map((cell) => `${cell.cell}: ${cell.value === null ? `insufficient-evidence (${cell.samples}/${cell.required})` : `${Math.round(cell.value * 100)}% (n=${cell.samples})`}`)
    .join("\n");
}
