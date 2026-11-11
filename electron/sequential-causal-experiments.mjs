import { digestOfText, canonicalJson } from "./offline-archive.mjs";
import { experimentById } from "./experiments.mjs";
import { COHORT_PHASES, assignCohortArm, openCohort, sanitizeCohortObservation } from "./experiment-cohort.mjs";
import { aggregateCohortOutcomes, attritionSensitivityBounds, openPrivacyBudget, spendEpsilon } from "./private-cohort-analytics.mjs";

/**
 * Sequential causal learning experiments.
 *
 * `experiments.mjs` (item 42) already refuses to name a winner below a
 * declared minimum sample or when a Welch interval crosses zero, but it
 * only ever looks *once*: nothing stops a caller from calling
 * `analyzeExperiment` after every single new observation and stopping the
 * moment the interval happens to clear zero, which inflates the real false
 * positive rate far above the nominal 5% the interval's own 1.96 constant
 * assumes — the textbook "peeking" problem. `experiment-cohort.mjs` (item
 * 63) already schedules pre/post/delayed/transfer phases and reports
 * attrition per phase, but analyzes each phase's pooled observations with
 * the exact same single-look interval, with the same vulnerability if a
 * caller checks it early and often. `private-cohort-analytics.mjs` (item 28)
 * already has a spendable epsilon budget and a `cohort-too-small` floor,
 * reused unmodified below for a sequential experiment's *own* reporting,
 * not re-derived. Confirmed by grep: zero prior matches for
 * `preregist`/`stoppingRule`/`heterogeneousEffect`/`alphaSpend` anywhere in
 * `electron/*.mjs` before this item.
 *
 * This module adds exactly the pieces those three do not have, reusing
 * everything above unmodified:
 *
 *   - **Preregistration.** `preregisterSequentialExperiment` freezes, before
 *     any observation exists, the experiment id, the planned number of
 *     interim looks, the total two-sided alpha to spend across all of them,
 *     the subgroup dimension (if any) for heterogeneous-effect analysis,
 *     and a `preregistrationDigest` (`offline-archive.mjs`'s own
 *     `canonicalJson`/`digestOfText`, unmodified) over exactly those fields.
 *     `verifyAgainstPreregistration` later checks a sequential analysis run
 *     against that digest, so a caller cannot quietly change the look count
 *     or the subgroup dimension after seeing early data and claim the
 *     original plan still applies.
 *   - **A real stopping rule, not an unprotected repeated test.** Peeking at
 *     an unmodified 95% interval `k` times inflates the true false-positive
 *     rate; the standard fix (O'Brien-Fleming/Pocock-family group-sequential
 *     testing) spends a *fraction* of the total alpha at each planned look
 *     so the cumulative false-positive rate across all looks stays at the
 *     declared total. `sequentialCriticalValue` implements the simplest
 *     member of that family — equal (Pocock-style) alpha spending per look,
 *     computed from `plannedLooks` via `erf`'s own inverse — so a wider
 *     interval is required at every look than `experiments.mjs`'s
 *     unconditional 1.96, and the width grows with the number of planned
 *     looks rather than staying fixed regardless of how often a caller
 *     checks.
 *   - **Heterogeneous treatment effects, estimated and reported
 *     separately per subgroup, never blended into the overall estimate** —
 *     the same "separate, never combined" discipline this project's
 *     multi-measure reports already keep (`analyzeCohort`'s per-phase
 *     results, `tutor-safety-benchmark.mjs`'s per-axis scores).
 *     `analyzeSubgroups` reuses this module's own `sequentialLookResult`
 *     once per subgroup value rather than deriving a second comparison
 *     arithmetic, and a subgroup below the minimum sample is reported
 *     `underpowered`, not silently dropped from the table.
 *   - **Attrition sensitivity** reuses `private-cohort-analytics.mjs`'s own
 *     `attritionSensitivityBounds` unmodified, scoped to a sequential
 *     experiment's own roster (via `experiment-cohort.mjs`'s own
 *     `attritionReport`, unmodified) at whichever phase a caller is
 *     currently looking at.
 *   - **Privacy budgets** reuse `private-cohort-analytics.mjs`'s own
 *     `openPrivacyBudget`/`spendEpsilon` unmodified: each interim look
 *     spends a declared epsilon from the same kind of budget object that
 *     module already produces, so a sequential experiment's own interim
 *     checks are charged against the identical accounting a cohort report
 *     already uses, not a second untracked one.
 */

export const SEQUENTIAL_CAUSAL_EXPERIMENT_VERSION = 1;

function round(value, places = 4) {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Number(Number(value).toFixed(places));
}

// ---------------------------------------------------------------------------
// Peter Acklam's rational approximation to the inverse standard-normal CDF.
// Reused rather than re-derived elsewhere: this is the one place in this
// codebase that needs a *non-fixed* z critical value (every other module
// hard-codes 1.96 for a single, unconditional 95% look).
// ---------------------------------------------------------------------------
const RATIONAL_A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const RATIONAL_B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const RATIONAL_C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const RATIONAL_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const RATIONAL_LOW_TAIL = 0.02425;

export function invNormalCdf(p) {
  if (!(p > 0) || !(p < 1)) return null;
  if (p < RATIONAL_LOW_TAIL) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((RATIONAL_C[0] * q + RATIONAL_C[1]) * q + RATIONAL_C[2]) * q + RATIONAL_C[3]) * q + RATIONAL_C[4]) * q + RATIONAL_C[5]) / ((((RATIONAL_D[0] * q + RATIONAL_D[1]) * q + RATIONAL_D[2]) * q + RATIONAL_D[3]) * q + 1);
  }
  if (p <= 1 - RATIONAL_LOW_TAIL) {
    const q = p - 0.5;
    const r = q * q;
    return (((((RATIONAL_A[0] * r + RATIONAL_A[1]) * r + RATIONAL_A[2]) * r + RATIONAL_A[3]) * r + RATIONAL_A[4]) * r + RATIONAL_A[5]) * q / (((((RATIONAL_B[0] * r + RATIONAL_B[1]) * r + RATIONAL_B[2]) * r + RATIONAL_B[3]) * r + RATIONAL_B[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((RATIONAL_C[0] * q + RATIONAL_C[1]) * q + RATIONAL_C[2]) * q + RATIONAL_C[3]) * q + RATIONAL_C[4]) * q + RATIONAL_C[5]) / ((((RATIONAL_D[0] * q + RATIONAL_D[1]) * q + RATIONAL_D[2]) * q + RATIONAL_D[3]) * q + 1);
}

/**
 * Pocock-style (equal alpha spending per look) two-sided critical z-value
 * for `plannedLooks` interim analyses spending `totalAlpha` total. With one
 * planned look this collapses to exactly `experiments.mjs`'s own 1.96 — the
 * sequential rule is a strict generalization of the single-look rule, not a
 * separate one.
 */
export function sequentialCriticalValue(plannedLooks, totalAlpha = 0.05) {
  const looks = Math.max(1, Math.round(plannedLooks));
  const perLookAlpha = totalAlpha / looks;
  return invNormalCdf(1 - perLookAlpha / 2);
}

// ---------------------------------------------------------------------------
// Preregistration
// ---------------------------------------------------------------------------

/**
 * Freeze a sequential experiment's design before any observation exists.
 * Refuses an unknown experiment id (the same `experiments.mjs` registry
 * every other experiment module already reads from) or a non-positive
 * `plannedLooks`/`totalAlpha` up front, rather than producing a plan that
 * can never be analyzed.
 */
export function preregisterSequentialExperiment(experimentId, options = {}) {
  const experiment = experimentById(experimentId);
  if (!experiment) return { ok: false, reason: "unknown-experiment" };
  const plannedLooks = Math.max(1, Math.round(options.plannedLooks ?? 1));
  const totalAlpha = options.totalAlpha ?? 0.05;
  if (!(totalAlpha > 0 && totalAlpha < 1)) return { ok: false, reason: "invalid-total-alpha" };
  const subgroupDimension = options.subgroupDimension ?? null;
  const preregistration = {
    version: SEQUENTIAL_CAUSAL_EXPERIMENT_VERSION,
    experimentId,
    plannedLooks,
    totalAlpha,
    subgroupDimension,
    preregisteredAt: options.now ?? new Date().toISOString(),
  };
  const preregistrationDigest = digestOfText(canonicalJson({ experimentId, plannedLooks, totalAlpha, subgroupDimension }));
  return { ok: true, preregistration: { ...preregistration, preregistrationDigest } };
}

/**
 * Whether a sequential analysis run still matches its own preregistration:
 * the same digest check `offline-archive.mjs`'s own archive verification
 * already uses for tamper detection, applied here to a design decision
 * instead of an exported file.
 */
export function verifyAgainstPreregistration(preregistration, { experimentId, plannedLooks, totalAlpha, subgroupDimension }) {
  const expected = digestOfText(canonicalJson({ experimentId, plannedLooks, totalAlpha, subgroupDimension: subgroupDimension ?? null }));
  return expected === preregistration.preregistrationDigest;
}

// ---------------------------------------------------------------------------
// Sequential looks
// ---------------------------------------------------------------------------

function summarizeValues(values) {
  const n = values.length;
  if (!n) return { n: 0, mean: null, variance: null, standardError: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance = n > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, variance, standardError: n > 1 ? Math.sqrt(variance / n) : 0 };
}

/**
 * One interim or final look at a sequential experiment's pooled
 * observations, using `sequentialCriticalValue` (not a fixed 1.96) for the
 * interval width, so the declared total false-positive rate holds across
 * every planned look rather than just the first one.
 */
export function sequentialLookResult(preregistration, observations, { minimumSample } = {}) {
  const experiment = experimentById(preregistration.experimentId);
  const relevant = (observations ?? []).filter((item) => item.experimentId === experiment.id && item.metric === experiment.metric);
  const control = experiment.arms.find((arm) => arm.control) ?? experiment.arms[0];
  const variant = experiment.arms.find((arm) => arm.id !== control.id) ?? control;
  const controlStats = summarizeValues(relevant.filter((item) => item.arm === control.id).map((item) => item.value));
  const variantStats = summarizeValues(relevant.filter((item) => item.arm === variant.id).map((item) => item.value));
  const floor = minimumSample ?? experiment.minimumSample;
  const powered = controlStats.n >= floor && variantStats.n >= floor;

  const criticalValue = sequentialCriticalValue(preregistration.plannedLooks, preregistration.totalAlpha);
  let difference = null;
  let interval = null;
  if (controlStats.mean !== null && variantStats.mean !== null) {
    difference = variantStats.mean - controlStats.mean;
    const standardError = Math.sqrt((controlStats.standardError ?? 0) ** 2 + (variantStats.standardError ?? 0) ** 2);
    interval = [difference - criticalValue * standardError, difference + criticalValue * standardError];
  }
  const crossesZero = interval === null || (interval[0] <= 0 && interval[1] >= 0);

  return {
    version: SEQUENTIAL_CAUSAL_EXPERIMENT_VERSION,
    experimentId: experiment.id,
    control: control.id,
    variant: variant.id,
    samples: { control: controlStats.n, variant: variantStats.n },
    criticalValue: round(criticalValue, 6),
    difference: round(difference),
    interval: interval ? interval.map((value) => round(value)) : null,
    powered,
    verdict: !powered
      ? "underpowered"
      : crossesZero
        ? "no-difference"
        : (difference > 0) === Boolean(experiment.higherIsBetter)
          ? "variant-better"
          : "control-better",
  };
}

/**
 * Run every planned look in sequence against a growing list of
 * observation snapshots (one array per look, each a superset of the
 * previous one — the caller's own accumulating data), spending one
 * declared epsilon per look from a shared privacy budget
 * (`private-cohort-analytics.mjs`'s own `openPrivacyBudget`/`spendEpsilon`,
 * unmodified), and stopping the moment any look's verdict is not
 * `"no-difference"`/`"underpowered"` — the stopping rule this item asks
 * for. Refuses to run more looks than were preregistered, and refuses a
 * look whose epsilon spend would exhaust the budget rather than silently
 * running it unaccounted.
 */
export function runSequentialLooks(preregistration, observationSnapshots, { totalEpsilon, epsilonPerLook = 0.2, minimumSample, now } = {}) {
  if ((observationSnapshots ?? []).length > preregistration.plannedLooks) {
    return { ok: false, reason: "more-looks-than-preregistered", planned: preregistration.plannedLooks, attempted: observationSnapshots.length };
  }
  const budgetOpen = openPrivacyBudget(totalEpsilon ?? epsilonPerLook * preregistration.plannedLooks, { seed: preregistration.preregistrationDigest });
  if (!budgetOpen.ok) return { ok: false, reason: budgetOpen.reason };
  let budget = budgetOpen.budget;

  const looks = [];
  let stoppedAt = null;
  for (let index = 0; index < observationSnapshots.length; index += 1) {
    const spend = spendEpsilon(budget, epsilonPerLook, `look-${index + 1}`);
    if (!spend.ok) return { ok: false, reason: spend.reason, looks };
    budget = spend.budget;
    const result = sequentialLookResult(preregistration, observationSnapshots[index], { minimumSample });
    looks.push({ look: index + 1, ...result, epsilonSpent: epsilonPerLook, remainingEpsilon: spend.remaining });
    if (result.verdict !== "no-difference" && result.verdict !== "underpowered") {
      // A concluding verdict only counts as stopping *early* when it happens
      // before the last planned look — reaching a conclusion exactly on the
      // final planned look is the plan running to completion, not an early
      // stop, even though no further look remains either way.
      if (index + 1 < preregistration.plannedLooks) stoppedAt = index + 1;
      break;
    }
  }
  return { ok: true, looks, stoppedEarly: stoppedAt !== null, stoppedAt, finalBudget: budget, finishedAt: now ?? new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Heterogeneous treatment effects
// ---------------------------------------------------------------------------

/**
 * Estimate the treatment effect separately per subgroup value, never
 * blending subgroups into the overall estimate. Each subgroup's own result
 * comes from this module's own `sequentialLookResult`, scoped to just that
 * subgroup's observations — no second comparison arithmetic. A subgroup
 * below the minimum sample reports `underpowered` rather than being
 * silently omitted from the table, so a caller cannot mistake "no row" for
 * "no effect".
 */
export function analyzeSubgroups(preregistration, observations, subgroupOf, { minimumSample } = {}) {
  const bySubgroup = new Map();
  for (const observation of observations ?? []) {
    const key = subgroupOf(observation);
    if (key === null || key === undefined) continue;
    if (!bySubgroup.has(key)) bySubgroup.set(key, []);
    bySubgroup.get(key).push(observation);
  }
  const subgroups = [...bySubgroup.keys()].sort().map((key) => ({
    subgroup: key,
    ...sequentialLookResult(preregistration, bySubgroup.get(key), { minimumSample }),
  }));
  return { version: SEQUENTIAL_CAUSAL_EXPERIMENT_VERSION, dimension: preregistration.subgroupDimension, subgroups };
}

// ---------------------------------------------------------------------------
// Attrition sensitivity, reused from private-cohort-analytics.mjs/experiment-cohort.mjs
// ---------------------------------------------------------------------------

/**
 * Attrition sensitivity for a sequential experiment's cohort at a given
 * phase, built entirely out of `private-cohort-analytics.mjs`'s own
 * `aggregateCohortOutcomes`/`attritionSensitivityBounds` (both unmodified).
 * `outcomes` is the caller's own list of per-participant binary outcomes
 * (`0`/`1`/`null` for "no evidence yet") for this phase — the same shape
 * `private-cohort-analytics.mjs`'s own `learnerRetentionOutcome`/
 * `learnerTransferOutcome` already produce per learner — scoped against the
 * cohort's full roster size, so a participant who never contributed an
 * outcome for this phase is counted as attrition, not silently excluded.
 */
export function sequentialAttritionSensitivity(cohort, outcomes) {
  const aggregate = aggregateCohortOutcomes(outcomes);
  return { ...attritionSensitivityBounds(cohort.roster.length, aggregate), contributed: aggregate.contributed };
}

export { assignCohortArm, openCohort, sanitizeCohortObservation, COHORT_PHASES };
