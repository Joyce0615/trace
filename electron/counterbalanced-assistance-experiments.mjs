/**
 * Counterbalanced assistance experiments (item 48, this cycle).
 *
 * `experiments.mjs` (item 42) already has everything a *two-arm* comparison
 * needs: consent as the gate, a deterministic `assignArm`, and
 * `analyzeExperiment`'s own Welch-interval verdict that refuses to name a
 * winner below its declared sample floor or when the interval crosses
 * zero. `accessibility-learning-experiments.mjs` (item 29) already shows
 * the right way to *reuse* that two-arm machinery for a domain
 * `experiments.mjs` itself never heard of: `buildPathComparison` builds an
 * ad hoc `{id, arms, metric, minimumSample, higherIsBetter}` object by
 * hand and hands it straight to `analyzeExperiment`, never re-deriving the
 * Welch arithmetic. This item needs the identical trick applied to six
 * arms instead of two, plus one genuinely new piece neither module has:
 * confirmed by grep, zero prior matches anywhere in `electron/*.mjs` for
 * `latin`/`counterbalanc`/`ASSISTANCE_TYPES`/`matchedTask` as
 * implementation identifiers.
 *
 * The missing piece is **counterbalancing itself** — controlling for
 * *order*, not just condition. `experiment-cohort.mjs`'s own docstring
 * already names the general risk (pooling across an uncontrolled
 * dimension "answers a different, wrong question"); the dimension that
 * module controls for is *phase* (pre/post/delayed/transfer), never
 * *task order within a session*. A learner who sees direct answers first
 * and tool-building sixth is not comparable to one who sees them in the
 * reverse order — practice and fatigue both grow with position, and
 * neither `experiments.mjs`'s single random arm draw nor
 * `experiment-cohort.mjs`'s phase schedule says anything about which
 * *position* in a task sequence an arm landed in. [`buildCounterbalancedSchedule`]
 * fixes exactly that with a cyclic Latin square: each participant's own
 * deterministic rotation (`hashing.mjs`'s own `hash32`, reused unmodified,
 * mixed with the participant id the same way `assignArm` already mixes it
 * with an experiment id) assigns the six named assistance types to six
 * matched tasks in a different order per participant, so across a cohort
 * every assistance type appears in every ordinal position roughly
 * equally often — the standard fix for the problem `experiments.mjs` and
 * `experiment-cohort.mjs` both leave untouched.
 *
 * The other piece this item names — four outcomes, "delayed retention,
 * transfer, cognitive load, and overreliance" — is kept exactly as
 * separate as this project's own established discipline demands
 * (`analytics.mjs`'s own docstring: "reported separately and never
 * averaged"; `runAccessibilityLearningExperiment`'s own "three separate
 * claims, never blended into one score"). Rather than forcing all four
 * into one comparison, [`compareAssistanceTypes`] runs
 * `buildPathComparison`'s own trick once *per outcome metric*,
 * independently: a raw per-attempt value tagged with which of the four
 * named outcomes it measures and which assistance type produced it,
 * compared pairwise against the `"direct-answer"` control arm via
 * `analyzeExperiment`, unmodified, four separate times — never pooled
 * across outcomes, and never pooled across assistance types into a single
 * "which assistance type wins" ranking that would hide which specific
 * outcome a given assistance type actually helps or hurts.
 *
 * Node-free: no fs/network, so the browser demo runs the identical
 * schedule and comparison logic `experiments.mjs` and
 * `accessibility-learning-experiments.mjs` already keep Node-free for the
 * same reason.
 */

import { hash32 } from "./hashing.mjs";
import { MIN_SAMPLE } from "./analytics.mjs";
import { analyzeExperiment, consentState } from "./experiments.mjs";
import { appendEvent } from "./activity-log.mjs";

export const COUNTERBALANCED_ASSISTANCE_VERSION = 1;

/** The six assistance types this item names, in the item's own stated order. */
export const ASSISTANCE_TYPES = ["direct-answer", "socratic-prompt", "prediction-first", "tracing", "worked-example", "tool-building"];

/** The baseline arm every pairwise comparison is run against, and what an unconsented schedule gives every task. */
export const CONTROL_ASSISTANCE_TYPE = "direct-answer";

/** The four outcome axes this item names, reported separately and never blended into one score. */
export const OUTCOME_METRICS = ["delayed-retention", "transfer", "cognitive-load", "overreliance"];

/** Which direction is "better" for each outcome. Lower cognitive load and lower overreliance are the wins; higher retention and higher transfer are. */
export const METRIC_HIGHER_IS_BETTER = Object.freeze({
  "delayed-retention": true,
  transfer: true,
  "cognitive-load": false,
  overreliance: false,
});

/** Fields an assistance observation may contain. Everything else is dropped. */
export const ASSISTANCE_OBSERVATION_FIELDS = ["assistanceType", "taskId", "metric", "value", "at"];

function round(value, places = 4) {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Number(Number(value).toFixed(places));
}

/**
 * A cyclic Latin square: six matched tasks, six assistance types, one row
 * per participant. `matchedTaskIds` must declare exactly one task per
 * assistance type (the caller's own job, same as elsewhere in this app, is
 * to have made those tasks actually equivalent in difficulty); a count
 * that does not match `ASSISTANCE_TYPES.length` is refused outright rather
 * than silently truncated or padded.
 *
 * Without consent (`experiments.mjs`'s own `consentState`, reused
 * unmodified), every task in the schedule gets `CONTROL_ASSISTANCE_TYPE` —
 * the same "no consent, no experiment, the app behaves as it always
 * would" rule `experiments.mjs`'s own `activeAssignments` already
 * enforces for a single two-arm experiment, applied here to a whole
 * six-arm schedule.
 */
export function buildCounterbalancedSchedule(matchedTaskIds, state = {}) {
  if (!Array.isArray(matchedTaskIds) || matchedTaskIds.length !== ASSISTANCE_TYPES.length) {
    return {
      available: false,
      reason: `Exactly ${ASSISTANCE_TYPES.length} matched tasks are required, one per assistance type; received ${Array.isArray(matchedTaskIds) ? matchedTaskIds.length : 0}.`,
    };
  }

  const consent = consentState(state);
  if (!consent.granted || !consent.participantId) {
    return {
      available: true,
      version: COUNTERBALANCED_ASSISTANCE_VERSION,
      enrolled: false,
      rotation: 0,
      positions: matchedTaskIds.map((taskId, position) => ({ position, taskId, assistanceType: CONTROL_ASSISTANCE_TYPE })),
    };
  }

  // Mixing the participant id with this module's own fixed label (not the
  // experiment id, since there is no per-experiment registry entry here)
  // keeps this rotation independent of whatever arm `experiments.mjs`'s
  // own `assignArm` happened to draw for the same participant elsewhere.
  const rotation = hash32(`counterbalanced-assistance:${consent.participantId}`) % ASSISTANCE_TYPES.length;
  return {
    available: true,
    version: COUNTERBALANCED_ASSISTANCE_VERSION,
    enrolled: true,
    rotation,
    positions: matchedTaskIds.map((taskId, position) => ({
      position,
      taskId,
      assistanceType: ASSISTANCE_TYPES[(position + rotation) % ASSISTANCE_TYPES.length],
    })),
  };
}

/**
 * The privacy/validity allowlist for one raw outcome observation. Rebuilt
 * from scratch rather than filtered, the same discipline `experiments.mjs`'s
 * own `sanitizeObservation` already applies to its own five fields, applied
 * here to this module's own five (an assistance type and a task id in place
 * of an experiment id and an arm).
 */
export function sanitizeAssistanceObservation(candidate) {
  if (!ASSISTANCE_TYPES.includes(candidate?.assistanceType)) return { ok: false, reason: "unknown-assistance-type" };
  if (typeof candidate?.taskId !== "string" || !candidate.taskId) return { ok: false, reason: "missing-task-id" };
  if (!OUTCOME_METRICS.includes(candidate?.metric)) return { ok: false, reason: "unknown-metric" };
  const value = Number(candidate?.value);
  if (!Number.isFinite(value)) return { ok: false, reason: "non-numeric-value" };
  const at = typeof candidate?.at === "string" && Number.isFinite(Date.parse(candidate.at)) ? candidate.at : new Date().toISOString();
  return { ok: true, observation: { assistanceType: candidate.assistanceType, taskId: candidate.taskId, metric: candidate.metric, value: round(value), at } };
}

/**
 * One pairwise comparison for one outcome metric: `CONTROL_ASSISTANCE_TYPE`
 * versus one other assistance type, built as an ad hoc two-arm experiment
 * object and handed to `experiments.mjs`'s own `analyzeExperiment`
 * unmodified — exactly `accessibility-learning-experiments.mjs`'s own
 * `buildPathComparison` trick, applied to a different domain's raw
 * observations instead of re-deriving the Welch-interval arithmetic.
 */
export function buildAssistanceComparison(metric, variantAssistanceType, observations, options = {}) {
  const relevant = (observations ?? []).filter((item) => item.metric === metric);
  const experiment = {
    id: `counterbalanced-assistance:${metric}:${variantAssistanceType}`,
    arms: [{ id: CONTROL_ASSISTANCE_TYPE, control: true }, { id: variantAssistanceType, control: false }],
    metric,
    minimumSample: options.minimumSample ?? MIN_SAMPLE,
    higherIsBetter: METRIC_HIGHER_IS_BETTER[metric],
  };
  const armObservations = [
    ...relevant.filter((item) => item.assistanceType === CONTROL_ASSISTANCE_TYPE).map((item) => ({ experimentId: experiment.id, arm: CONTROL_ASSISTANCE_TYPE, metric, value: item.value })),
    ...relevant.filter((item) => item.assistanceType === variantAssistanceType).map((item) => ({ experimentId: experiment.id, arm: variantAssistanceType, metric, value: item.value })),
  ];
  return analyzeExperiment(experiment, armObservations);
}

/**
 * Every non-control assistance type actually present in the observations,
 * compared against the control for one outcome metric — never pooled into
 * a single ranking across assistance types, and never pooled with any
 * other outcome metric's own comparisons.
 */
export function compareAssistanceTypes(metric, observations, options = {}) {
  const present = new Set((observations ?? []).filter((item) => item.metric === metric).map((item) => item.assistanceType));
  return ASSISTANCE_TYPES
    .filter((type) => type !== CONTROL_ASSISTANCE_TYPE && present.has(type))
    .map((type) => buildAssistanceComparison(metric, type, observations, options));
}

/**
 * All four outcome metrics' own comparisons, side by side — the top-level
 * report this item names. Each entry is independent; a caller must not
 * average `comparisons` across metrics into one "best assistance type"
 * verdict, which is exactly the blending `analytics.mjs`'s own docstring
 * warns would hide which specific outcome a given assistance type helps
 * or hurts.
 */
export function compareAllOutcomes(observations, options = {}) {
  return OUTCOME_METRICS.map((metric) => ({ metric, higherIsBetter: METRIC_HIGHER_IS_BETTER[metric], comparisons: compareAssistanceTypes(metric, observations, options) }));
}

/**
 * Preserve one raw outcome observation as learning evidence, through
 * `activity-log.mjs`'s own `appendEvent` (unmodified) — the same
 * append-only, main-process-only log every other graded/measured activity
 * in this app already writes to.
 */
export function recordAssistanceOutcome(directory, repositoryId, observation) {
  return appendEvent(directory, repositoryId, { kind: "counterbalanced-assistance-outcome", ...observation });
}
