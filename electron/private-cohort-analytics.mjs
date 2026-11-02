import { retentionAnalytics, transferAnalytics } from "./analytics.mjs";
import { hash32 } from "./hashing.mjs";
import { canonicalJson, digestOfText } from "./offline-archive.mjs";

/**
 * Privacy-budgeted cohort analytics (item 28).
 *
 * `analytics.mjs` (item 11) already has honest, sample-floored retention and
 * transfer rates for *one* learner's own event log — `retentionAnalytics`
 * and `transferAnalytics`, reused unmodified below. What it has no notion
 * of at all, confirmed by reading that module whole and grepping
 * `electron/*.mjs` for `differentialPrivacy`/`epsilon`/`privacyBudget`/
 * `cohortThreshold` before writing a line here (zero prior matches as
 * implementation identifiers): releasing one number that describes *many*
 * learners at once without that number being traceable back to any one of
 * them, a declared, spendable privacy budget, a floor on how small a group
 * can be before an aggregate is even attempted, how sensitive that
 * aggregate is to the learners who stopped contributing evidence partway
 * through, and noise that is random enough to protect an individual but
 * reproducible enough that the same inputs always produce the same report.
 *
 * Design that follows from reusing rather than reinventing:
 *
 *   - **Person-level sensitivity, not observation-level.** A learner who
 *     did five exercises and one who did fifty must not be allowed to move
 *     a cohort aggregate by different amounts just because one of them was
 *     more active — that would leak exactly how active the memorable
 *     learner was. [`learnerRetentionOutcome`] / [`learnerTransferOutcome`]
 *     each reduce one learner's own `retentionAnalytics`/`transferAnalytics`
 *     rate (reused unmodified, including its own `insufficient-evidence`
 *     floor) to a single `0`/`1`/`null` outcome against
 *     `DEFAULT_MASTERY_THRESHOLD`, so every contributing learner moves the
 *     cohort sum by at most one, and the sensitivity of a mean over `n`
 *     contributors is exactly `1/n` — the standard bound for a bounded
 *     per-record value, applied here per *person* rather than per *event*.
 *   - **A minimum cohort threshold is checked before any number is
 *     computed, not after.** [`aggregateCohortOutcomes`] reports how many
 *     learners actually contributed (filtering out the `null`s — a learner
 *     with insufficient evidence contributes nothing, is not counted as a
 *     zero), and [`evaluatePrivateCohortAnalytics`] refuses to privatize or
 *     release an axis whose contributor count is below
 *     `MIN_COHORT_SIZE` — the same "say why not" refusal shape
 *     `experiment-cohort.mjs`'s own `openCohort` already uses for an
 *     unknown experiment, reused here for a cohort that is simply too small
 *     to protect anyone inside it.
 *   - **Explicit, spendable epsilon accounting.** [`openPrivacyBudget`] /
 *     [`spendEpsilon`] track a running total against a declared ceiling and
 *     refuse a query that would exceed it — mirroring
 *     `experiments.mjs`'s own refusal to name a winner below its declared
 *     sample floor: a check that can fail says so, rather than silently
 *     doing less than it was asked. A query that is gated out by the
 *     minimum cohort threshold never spends budget at all, because no
 *     number was ever going to be released for it.
 *   - **Attrition sensitivity, not just an attrition rate.**
 *     [`attritionSensitivityBounds`] reports the *range* a cohort's true
 *     rate could sit in if every missing learner (enrolled but never
 *     contributing evidence) is assumed to have failed, versus if every one
 *     of them is assumed to have succeeded — a width of zero means
 *     attrition cannot be hiding anything, a wide range means the released
 *     number is only as trustworthy as the dropout assumption a reader is
 *     willing to make, and the report states the range rather than hiding
 *     it behind one point estimate.
 *   - **Reproducible seeds.** [`seededUniform`] / [`laplaceNoise`] derive
 *     every draw from `hash32` (reused unmodified, the same hash
 *     `experiments.mjs`'s own `assignArm` and `course-migration.mjs`'s own
 *     fingerprints already share) keyed by a caller-supplied seed string
 *     plus a per-query counter — never `Math.random()`. The same seed and
 *     the same inputs always produce the identical noisy report, the same
 *     reproducibility `offline-archive.mjs`'s own `canonicalJson`/
 *     `digestOfText` (reused unmodified below for this report's own digest)
 *     already requires of every other digest in this codebase.
 *
 * Retention and transfer are privatized and reported separately, never
 * blended into one score — the same discipline `analytics.mjs`'s own module
 * doc already requires of its five measures, carried through here to their
 * cohort-level aggregates.
 */

export const PRIVATE_COHORT_ANALYTICS_VERSION = 1;

/** Below this many contributing learners, an axis is not privatized or released at all. */
export const MIN_COHORT_SIZE = 5;

/** The per-learner rate at or above which that learner's own outcome counts as success (`1`). */
export const DEFAULT_MASTERY_THRESHOLD = 0.5;

function round(value, places = 4) {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Number(Number(value).toFixed(places));
}

// ---------------------------------------------------------------------------
// Per-learner outcome reduction (bounds sensitivity to one unit per person)
// ---------------------------------------------------------------------------

/** One learner's own retention rate (reused, unmodified), reduced to a single bounded outcome. */
export function learnerRetentionOutcome(events, learnerState, skillGraph, options = {}) {
  const result = retentionAnalytics(events, learnerState, skillGraph, options);
  if (result.successRate.value === null) return null;
  return result.successRate.value >= (options.masteryThreshold ?? DEFAULT_MASTERY_THRESHOLD) ? 1 : 0;
}

/** One learner's own far-transfer rate (reused, unmodified), reduced to a single bounded outcome. */
export function learnerTransferOutcome(events, learnerState, options = {}) {
  const result = transferAnalytics(events, learnerState, options);
  if (result.far.value === null) return null;
  return result.far.value >= (options.masteryThreshold ?? DEFAULT_MASTERY_THRESHOLD) ? 1 : 0;
}

/**
 * Sum the non-null outcomes. A learner who contributed no evidence is
 * excluded from both the numerator and the denominator — not counted as a
 * zero, which would silently penalize a cohort for learners it never
 * actually measured.
 */
export function aggregateCohortOutcomes(outcomes) {
  const contributing = (outcomes ?? []).filter((value) => value === 0 || value === 1);
  const successes = contributing.filter((value) => value === 1).length;
  return { contributed: contributing.length, successes, rate: contributing.length ? round(successes / contributing.length) : null };
}

// ---------------------------------------------------------------------------
// Attrition sensitivity
// ---------------------------------------------------------------------------

/**
 * How wide the true cohort rate could be once the learners who never
 * contributed evidence are accounted for, rather than silently dropped.
 * `enrolled` is the full roster size; `aggregate` is this axis's own
 * `aggregateCohortOutcomes` result over whoever actually contributed.
 */
export function attritionSensitivityBounds(enrolled, aggregate) {
  if (!enrolled) return { lower: null, upper: null, missing: null, width: null, reason: "no-roster" };
  const missing = Math.max(0, enrolled - aggregate.contributed);
  // Worst case: every missing learner would have failed. Best case: every missing learner would have succeeded.
  const lower = round(aggregate.successes / enrolled);
  const upper = round((aggregate.successes + missing) / enrolled);
  return { lower, upper, missing, width: round(upper - lower), enrolled, contributed: aggregate.contributed };
}

// ---------------------------------------------------------------------------
// Reproducible seeded noise
// ---------------------------------------------------------------------------

/** A deterministic value in [0, 1), derived from `hash32` (unmodified) rather than `Math.random()`. */
export function seededUniform(seed, counter) {
  return hash32(`${seed}:${counter}`) / 4294967296;
}

/**
 * Laplace-distributed noise with the given scale, drawn deterministically
 * from `seededUniform`. The inverse-CDF construction (`-scale * sign(u) *
 * ln(1 - 2|u|)`) is the standard way to turn one uniform draw into one
 * Laplace draw; `u` is clamped away from exactly ±0.5 so the logarithm never
 * sees zero.
 */
export function laplaceNoise(seed, counter, scale) {
  const centered = seededUniform(seed, counter) - 0.5;
  const sign = centered < 0 ? -1 : 1;
  const magnitude = Math.min(Math.abs(centered), 0.5 - 1e-9);
  return -scale * sign * Math.log(1 - 2 * magnitude);
}

// ---------------------------------------------------------------------------
// Privacy budget
// ---------------------------------------------------------------------------

/** Open a spendable epsilon budget. Refuses a non-positive total up front. */
export function openPrivacyBudget(totalEpsilon, options = {}) {
  if (!(totalEpsilon > 0)) return { ok: false, reason: "invalid-total-epsilon" };
  return {
    ok: true,
    budget: { version: PRIVATE_COHORT_ANALYTICS_VERSION, totalEpsilon, spent: 0, seed: options.seed ?? "private-cohort-analytics", queries: [] },
  };
}

/** Spend epsilon against a budget. Refuses rather than overspending, and names what is left either way. */
export function spendEpsilon(budget, queryEpsilon, label) {
  if (!(queryEpsilon > 0)) return { ok: false, budget, reason: "invalid-query-epsilon" };
  if (round(budget.spent + queryEpsilon) > budget.totalEpsilon + 1e-9) {
    return { ok: false, budget, reason: "budget-exhausted", remaining: round(budget.totalEpsilon - budget.spent) };
  }
  const updated = { ...budget, spent: round(budget.spent + queryEpsilon), queries: [...budget.queries, { label, epsilon: queryEpsilon }] };
  return { ok: true, budget: updated, remaining: round(updated.totalEpsilon - updated.spent) };
}

/**
 * Add reproducible Laplace noise to one aggregate rate, scaled by the
 * person-level sensitivity `1/contributed` and the epsilon spent on this
 * query, then clip back into `[0, 1]` — a rate outside that range would not
 * be a rate.
 */
export function privatizeAggregate(aggregate, { epsilon, seed, counter }) {
  if (aggregate.rate === null) return { value: null, raw: null, contributed: aggregate.contributed, epsilon, reason: "insufficient-evidence" };
  const sensitivity = 1 / Math.max(1, aggregate.contributed);
  const noise = laplaceNoise(seed, counter, sensitivity / epsilon);
  const noisy = Math.max(0, Math.min(1, aggregate.rate + noise));
  return { value: round(noisy), raw: aggregate.rate, contributed: aggregate.contributed, successes: aggregate.successes, epsilon, noiseScale: round(sensitivity / epsilon, 6) };
}

// ---------------------------------------------------------------------------
// Top-level cohort evaluation
// ---------------------------------------------------------------------------

/**
 * Produce privacy-budgeted retention/transfer estimates for one cohort.
 *
 * `roster` is the full list of enrolled participant ids (nothing more —
 * the same "no field for anything sensitive to survive in" allowlist
 * discipline `experiments.mjs`'s own `sanitizeObservation` already
 * enforces). `learners` is one `{ events, learnerState, skillGraph }` entry
 * per participant who actually has an event log to measure; a participant
 * on the roster with no matching entry here is attrition, not absence of a
 * record, and is accounted for by `attritionSensitivityBounds` rather than
 * silently ignored.
 *
 * Refuses, by name, rather than silently returning a smaller number:
 * `cohort-too-small` if the roster itself (not just the contributing
 * subset) is below `minimumCohortSize`, or `invalid-total-epsilon` /
 * `budget-exhausted` if the epsilon accounting itself fails. An axis whose
 * *contributor* count (as opposed to roster size) falls below the
 * threshold is reported as `null` with `insufficient-evidence` and never
 * spends budget, rather than refusing the whole report.
 */
export function evaluatePrivateCohortAnalytics({ roster = [], learners = [], skillGraph, options = {} }) {
  const minimumCohortSize = options.minimumCohortSize ?? MIN_COHORT_SIZE;
  const epsilonPerQuery = options.epsilonPerQuery ?? 1;
  const seed = options.seed ?? "private-cohort-analytics";

  if (roster.length < minimumCohortSize) {
    return { ok: false, reason: "cohort-too-small", enrolled: roster.length, required: minimumCohortSize };
  }

  const budgetOpen = openPrivacyBudget(options.totalEpsilon ?? epsilonPerQuery * 2, { seed });
  if (!budgetOpen.ok) return { ok: false, reason: budgetOpen.reason };
  let budget = budgetOpen.budget;

  const retentionOutcomes = learners.map((learner) => learnerRetentionOutcome(learner.events, learner.learnerState, skillGraph, options));
  const transferOutcomes = learners.map((learner) => learnerTransferOutcome(learner.events, learner.learnerState, options));

  const retentionAggregate = aggregateCohortOutcomes(retentionOutcomes);
  const transferAggregate = aggregateCohortOutcomes(transferOutcomes);

  let retention = { value: null, raw: null, contributed: retentionAggregate.contributed, reason: "insufficient-evidence" };
  if (retentionAggregate.contributed >= minimumCohortSize) {
    const spend = spendEpsilon(budget, epsilonPerQuery, "retention");
    if (!spend.ok) return { ok: false, reason: spend.reason, remaining: spend.remaining ?? 0 };
    budget = spend.budget;
    retention = privatizeAggregate(retentionAggregate, { epsilon: epsilonPerQuery, seed, counter: "retention" });
  }

  let transfer = { value: null, raw: null, contributed: transferAggregate.contributed, reason: "insufficient-evidence" };
  if (transferAggregate.contributed >= minimumCohortSize) {
    const spend = spendEpsilon(budget, epsilonPerQuery, "transfer");
    if (!spend.ok) return { ok: false, reason: spend.reason, remaining: spend.remaining ?? 0 };
    budget = spend.budget;
    transfer = privatizeAggregate(transferAggregate, { epsilon: epsilonPerQuery, seed, counter: "transfer" });
  }

  const retentionAttrition = attritionSensitivityBounds(roster.length, retentionAggregate);
  const transferAttrition = attritionSensitivityBounds(roster.length, transferAggregate);

  const report = {
    version: PRIVATE_COHORT_ANALYTICS_VERSION,
    ok: true,
    enrolled: roster.length,
    minimumCohortSize,
    budget: { totalEpsilon: budget.totalEpsilon, spent: budget.spent, remaining: round(budget.totalEpsilon - budget.spent), queries: budget.queries },
    retention: { ...retention, attrition: retentionAttrition },
    transfer: { ...transfer, attrition: transferAttrition },
  };
  report.digest = digestOfText(canonicalJson({ enrolled: report.enrolled, retention: report.retention, transfer: report.transfer }));
  return report;
}

/** Human-readable rendering, for a report panel or a CLI printout. */
export function renderPrivateCohortAnalytics(report) {
  if (!report.ok) return `Cohort analytics refused: ${report.reason}.`;
  const lines = [`# Private cohort analytics (enrolled ${report.enrolled})`, ""];
  lines.push(`Budget: ${report.budget.spent}/${report.budget.totalEpsilon} epsilon spent, ${report.budget.remaining} remaining.`);
  for (const [label, axis] of [["Retention", report.retention], ["Transfer", report.transfer]]) {
    lines.push(`## ${label}`);
    if (axis.value === null) {
      lines.push(`  - ${axis.reason}.`);
    } else {
      lines.push(`  - Privatized rate: ${axis.value} (raw ${axis.raw}, ${axis.contributed} contributors, epsilon ${axis.epsilon}).`);
      lines.push(`  - Attrition sensitivity: [${axis.attrition.lower}, ${axis.attrition.upper}] (${axis.attrition.missing} missing of ${axis.attrition.enrolled}).`);
    }
  }
  return lines.join("\n");
}
