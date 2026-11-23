import { hintAnalytics } from "./analytics.mjs";
import { calibrateSkill } from "./misconception.mjs";
import { MIN_COHORT_SIZE, aggregateCohortOutcomes, learnerRetentionOutcome, learnerTransferOutcome } from "./private-cohort-analytics.mjs";

/**
 * Gate subgroup calibration and equal learning opportunity (item 57, this
 * cycle).
 *
 * `private-cohort-analytics.mjs` (item 28) already reduces one learner's
 * own retention/transfer rate to a single bounded `0`/`1`/`null` outcome
 * (`learnerRetentionOutcome`/`learnerTransferOutcome`, both reused
 * unmodified below) and already refuses to release any aggregate built
 * from fewer than `MIN_COHORT_SIZE` contributors (also reused unmodified).
 * `misconception.mjs`'s own `calibrateSkill` already computes a fresh
 * Beta-Bernoulli posterior over a skill's evidence and names it
 * `"overconfident"` when the learner's own self-reports predicted success
 * the posterior and later graded evidence did not support.
 * `analytics.mjs`'s own `hintAnalytics` already reports `hintedShare` as a
 * sample-floored `rate()`.
 *
 * What none of that does — confirmed by grep before writing a line here,
 * zero prior matches for `subgroupCalibration`/`equalLearningOpportunity`/
 * `falseMastery`/`hintBurdenOutcome` anywhere in `electron/*.mjs` — is
 * compare any of those outcomes *across* a caller-declared learner
 * attribute (prior experience, language, accessibility mode, assistance
 * history) to ask whether one subgroup is quietly worse served than
 * another. This module adds exactly that comparison, reusing every
 * existing reduction unmodified:
 *
 *   - **False mastery** is the one outcome this app had no existing
 *     reduction for, because it is a genuine latent inconsistency between
 *     two already-separate subsystems: `src/learning.ts`'s own `status`
 *     field ratchets to `"mastered"` the first time its own running-product
 *     `mastery` number crosses 0.75 and never revisits that label from new
 *     evidence (by that module's own documented design — status ownership
 *     passes to the spaced-repetition reviewer, or stays put), while
 *     `misconception.mjs`'s own `calibrateSkill` recomputes a *fresh*
 *     Beta-Bernoulli posterior over the identical evidence list on every
 *     call and can honestly call it `"overconfident"`. [`learnerFalseMasteryOutcome`]
 *     reads both, unmodified, and asks the one question neither one asks on
 *     its own: of the skills this learner's own state already calls
 *     `"mastered"`, does the fresh posterior actually agree?
 *   - **Hint burden** is [`learnerHintBurdenOutcome`], a single bounded
 *     outcome built from `hintAnalytics`'s own `hintedShare` (a `rate()`
 *     result, reused unmodified, including its own sample floor) —
 *     `null` when `hintedShare` itself abstains, `1` at or above 0.5,
 *     `0` below.
 *   - **Retention and transfer** are `learnerRetentionOutcome`/
 *     `learnerTransferOutcome`, reused unmodified — this module does not
 *     re-derive either reduction.
 *   - **Subgroup membership is never inferred or guessed.** [`groupBySubgroupValue`]
 *     reads a caller-declared `learner.subgroups[dimension]` string;
 *     a learner who never declared a value for a dimension is excluded
 *     from that dimension's comparison and counted as `unlabeled`, never
 *     silently folded into some default group.
 *   - **The item's own instruction — "abstaining rather than overstating
 *     small-sample fairness" — is enforced structurally, not by
 *     convention.** [`evaluateSubgroupCell`] reuses
 *     `aggregateCohortOutcomes` (unmodified) per subgroup value, and a
 *     fairness verdict is only ever `"gap-detected"`/`"no-gap-detected"`
 *     once *at least two* subgroup values each clear `MIN_COHORT_SIZE`
 *     contributing learners; with fewer than two qualifying groups the
 *     verdict is honestly `"insufficient-evidence"`, the same three-state
 *     shape `accessibility-learning-experiments.mjs`'s own
 *     `evaluateDifficultyEquivalence` already uses for the identical
 *     reason (an underpowered comparison must never be promoted to a
 *     claim just because it happens to look clean).
 *   - **Every (dimension × outcome axis) cell is scored and reported
 *     independently and never blended into one fairness score** — the
 *     same "separate, never combined" discipline this project's other
 *     multi-axis reports already keep (`analytics.mjs`'s five measures,
 *     `curriculum-portfolio.mjs`'s six gates, `sequential-causal-experiments.mjs`'s
 *     own `analyzeSubgroups`).
 *
 * Node-free: every input here is a plain learner-state/event-log object
 * the browser demo already has access to, exactly like `analytics.mjs`
 * and `private-cohort-analytics.mjs`.
 */

export const SUBGROUP_CALIBRATION_GATE_VERSION = 1;

/** The four outcome axes this item names, in the item's own order. */
export const OUTCOME_AXES = ["false-mastery", "hint-burden", "retention", "transfer"];

/** The four subgroup dimensions this item names, in the item's own order. */
export const SUBGROUP_DIMENSIONS = ["prior-experience", "language", "accessibility-mode", "assistance-history"];

/** A gap between qualifying subgroups wider than this (as an absolute rate
 * difference) is reported as detected — the same magnitude this project's
 * own `analytics.mjs` `hintAnalytics` trend check and
 * `reward-hacking-guard.mjs`'s `PROXY_RISE_THRESHOLD` already use to call a
 * difference real rather than noise. */
export const EQUITY_GAP_THRESHOLD = 0.2;

/** A learner's own `hintedShare` at or above this share counts as a "high
 * hint burden" outcome. */
export const HINT_BURDEN_THRESHOLD = 0.5;

function round(value, places = 4) {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Number(Number(value).toFixed(places));
}

/**
 * Of the skills this learner's own state already calls `"mastered"`, does
 * `misconception.mjs`'s own fresh posterior (`calibrateSkill`, unmodified)
 * agree? `1` means at least one mastered skill is overconfident by that
 * posterior — a false-mastery instance; `0` means every mastered skill
 * the posterior could assess is not overconfident; `null` (insufficient
 * evidence) means this learner has no skill marked `"mastered"` at all,
 * never guessed as a clean `0`.
 */
export function learnerFalseMasteryOutcome(learnerState) {
  const masteredSkills = Object.values(learnerState?.mastery ?? {}).filter((mastery) => mastery?.status === "mastered");
  if (!masteredSkills.length) return null;
  const overconfident = masteredSkills.some((mastery) => calibrateSkill(mastery).calibration === "overconfident");
  return overconfident ? 1 : 0;
}

/**
 * A single bounded hint-burden outcome, built from `hintAnalytics`'s own
 * `hintedShare` (unmodified, including its own sample floor). `null`
 * whenever `hintedShare` itself abstains with `insufficient-evidence`.
 */
export function learnerHintBurdenOutcome(events) {
  const { hintedShare } = hintAnalytics(events);
  if (hintedShare.value === null) return null;
  return hintedShare.value >= HINT_BURDEN_THRESHOLD ? 1 : 0;
}

/**
 * One learner's own outcome on every axis, each reduced to a bounded
 * `0`/`1`/`null` by the function named above it — never blended into one
 * number.
 */
export function computeLearnerOutcomes(learner) {
  return {
    "false-mastery": learnerFalseMasteryOutcome(learner.learnerState),
    "hint-burden": learnerHintBurdenOutcome(learner.events),
    retention: learnerRetentionOutcome(learner.events, learner.learnerState, learner.skillGraph ?? null, learner.options ?? {}),
    transfer: learnerTransferOutcome(learner.events, learner.learnerState, { studiedPaths: learner.studiedPaths ?? [], ...(learner.options ?? {}) }),
  };
}

/**
 * Group learners by a caller-declared subgroup value for one dimension.
 * A learner with no declared value for this dimension is excluded from
 * every group and counted once in `unlabeled` — never guessed, never
 * folded into a default bucket.
 */
export function groupBySubgroupValue(learners, dimension) {
  const groups = new Map();
  let unlabeled = 0;
  for (const learner of learners ?? []) {
    const value = learner?.subgroups?.[dimension];
    if (typeof value !== "string" || !value) {
      unlabeled += 1;
      continue;
    }
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(learner);
  }
  return { groups, unlabeled };
}

/**
 * One (dimension × outcome axis) cell: every declared subgroup value's own
 * `aggregateCohortOutcomes` result (unmodified), and a fairness verdict
 * that only ever fires once at least two subgroup values each clear
 * `MIN_COHORT_SIZE` contributing learners for this specific axis.
 */
export function evaluateSubgroupCell(learners, dimension, axis) {
  const { groups, unlabeled } = groupBySubgroupValue(learners, dimension);
  const subgroups = [...groups.keys()].sort().map((value) => {
    const members = groups.get(value);
    const outcomes = members.map((learner) => computeLearnerOutcomes(learner)[axis]);
    const aggregate = aggregateCohortOutcomes(outcomes);
    return { value, learners: members.length, ...aggregate, qualifies: aggregate.contributed >= MIN_COHORT_SIZE && aggregate.rate !== null };
  });

  const qualifying = subgroups.filter((entry) => entry.qualifies);
  if (qualifying.length < 2) {
    return {
      version: SUBGROUP_CALIBRATION_GATE_VERSION,
      dimension,
      axis,
      subgroups,
      unlabeled,
      verdict: "insufficient-evidence",
      reason: `Fewer than two "${dimension}" groups cleared the ${MIN_COHORT_SIZE}-contributor floor for the "${axis}" axis.`,
      gap: null,
    };
  }
  const rates = qualifying.map((entry) => entry.rate);
  const gap = round(Math.max(...rates) - Math.min(...rates));
  return {
    version: SUBGROUP_CALIBRATION_GATE_VERSION,
    dimension,
    axis,
    subgroups,
    unlabeled,
    verdict: gap > EQUITY_GAP_THRESHOLD ? "gap-detected" : "no-gap-detected",
    reason: null,
    gap,
  };
}

/**
 * Every (dimension × outcome axis) cell, sixteen in this item's own fixed
 * order, each scored independently and never blended into one fairness
 * score.
 */
export function evaluateSubgroupCalibration(learners) {
  const cells = [];
  for (const dimension of SUBGROUP_DIMENSIONS) {
    for (const axis of OUTCOME_AXES) {
      cells.push(evaluateSubgroupCell(learners, dimension, axis));
    }
  }
  return {
    version: SUBGROUP_CALIBRATION_GATE_VERSION,
    cells,
    gapsDetected: cells.filter((cell) => cell.verdict === "gap-detected").map((cell) => ({ dimension: cell.dimension, axis: cell.axis, gap: cell.gap })),
  };
}

/** Human-readable rendering, for an instructor-facing equity review panel. */
export function renderSubgroupCalibrationReport(report) {
  const lines = [`Subgroup calibration v${report.version}`];
  for (const cell of report.cells) {
    if (cell.verdict === "insufficient-evidence") {
      lines.push(`${cell.dimension} / ${cell.axis}: insufficient-evidence (${cell.reason})`);
      continue;
    }
    const groupText = cell.subgroups.filter((entry) => entry.qualifies).map((entry) => `${entry.value}=${entry.rate}`).join(", ");
    lines.push(`${cell.dimension} / ${cell.axis}: ${cell.verdict} (gap=${cell.gap}; ${groupText})`);
  }
  if (report.gapsDetected.length) {
    lines.push(`GAPS DETECTED: ${report.gapsDetected.map((entry) => `${entry.dimension}/${entry.axis}`).join(", ")}`);
  }
  return lines.join("\n");
}
