import { scoreDebuggingStep } from "./process-trace-assessment.mjs";

/**
 * Scaffold-fading probes.
 *
 * A learner who succeeds with hints, a retrieval answer, and an executed
 * tool run available has not yet shown they can do the task alone. This
 * module probes exactly that: after a scaffolded attempt succeeds, it
 * verifies the three named supports (hints, retrieval, tool execution) were
 * actually withdrawn — checked against real usage counts, never a
 * caller-trusted "I withdrew it" flag — and then compares three named
 * independent-performance dimensions (planning, debugging, explanation)
 * between the scaffolded attempt and the unassisted probe. None of the
 * three is ever averaged into the others, for the same reason
 * `process-trace-assessment.mjs`'s five dimensions are never averaged: a
 * learner who can plan unaided but cannot debug unaided has a different
 * problem than one who can explain unaided but cannot plan unaided, and a
 * single "independence score" would hide both. Mastery is withheld — not
 * silently passed — whenever assistance was not really withdrawn, whenever
 * a dimension's evidence is missing, or whenever any dimension collapsed.
 *
 * What is reused here, unmodified:
 *
 *   - **debugging** is scored by importing `process-trace-assessment.mjs`'s
 *     own `scoreDebuggingStep`, the exact function that already turns a raw
 *     `misconception.mjs` `gradeProbe` result into a 0/1 score for this
 *     dimension; this module calls it once for the assisted probe grade and
 *     once for the unassisted one;
 *   - **planning** and **explanation** scores are expected already-graded
 *     from this app's own existing full graders
 *     (`race-grader.mjs`'s own `gradeRaceSubmission(...).stages.plan.score`
 *     for planning, `explanation-grader.mjs`'s own
 *     `gradeExplanation(...).score` for explanation) — this module accepts
 *     those numbers as inputs rather than re-deriving them, the same
 *     contract `process-trace-assessment.mjs` already uses for its own
 *     navigation/evidenceSelection/tracing steps;
 *   - **the 0.4 absolute collapse floor** reuses the exact cutoff
 *     `race-grader.mjs`'s own `band()` and `explanation-grader.mjs`'s own
 *     `BANDS` already use for their lowest-but-one tier, so "barely
 *     functional" means the same score here that it already means
 *     everywhere else in this app;
 *   - **the 0.2 collapse-drop threshold** reuses the exact magnitude
 *     `analytics.mjs`'s own `hintAnalytics` trend detector already uses to
 *     decide a rate shift is a real trend and not noise.
 *
 * Genuinely new here: verifying withdrawal against real counts
 * (`verifyAssistanceWithdrawn`), the per-dimension collapse comparator
 * (`scoreIndependentDimension`), the combined probe
 * (`evaluateScaffoldFadingProbe`), and the mastery-withholding decision
 * (`decideMasteryWithholding`).
 */

export const SCAFFOLD_FADING_PROBE_VERSION = 1;

/** The three supports this item names, withdrawn after success, in the item's own order. */
export const ASSISTANCE_CHANNELS = ["hints", "retrieval", "toolExecution"];

/** The three independent-performance dimensions this item names, in the item's own order. */
export const INDEPENDENT_DIMENSIONS = ["planning", "debugging", "explanation"];

/** Reuses race-grader.mjs's own band()/explanation-grader.mjs's own BANDS cutoff. */
export const ABSOLUTE_COLLAPSE_FLOOR = 0.4;

/** Reuses analytics.mjs's own hintAnalytics trend-shift threshold. */
export const RELATIVE_COLLAPSE_DROP = 0.2;

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

/**
 * Was assistance actually withdrawn on the probe attempt? Checked against
 * real usage counts (how many hints were revealed, how many retrieval
 * calls were made, how many tool executions ran), not a caller-trusted
 * boolean: a probe that still shows any of the three channels used above
 * zero is not an unassisted attempt, no matter what it is labelled.
 */
export function verifyAssistanceWithdrawn(assistanceUsed = {}) {
  const stillPresent = ASSISTANCE_CHANNELS.filter((channel) => Number(assistanceUsed?.[channel] ?? 0) > 0);
  return {
    version: SCAFFOLD_FADING_PROBE_VERSION,
    withdrawn: stillPresent.length === 0,
    stillPresent,
  };
}

/**
 * Compare one named dimension's unassisted probe score against its
 * scaffolded-attempt score (when available). Collapse is reported for
 * either reason independently: the unassisted score itself fell below the
 * absolute floor, or it dropped by more than the trend-shift threshold from
 * the assisted score, even if it did not cross the absolute floor.
 */
export function scoreIndependentDimension(dimension, probeScore, assistedScore = null) {
  if (typeof probeScore !== "number" || !Number.isFinite(probeScore)) {
    return { version: SCAFFOLD_FADING_PROBE_VERSION, dimension, available: false, reason: `No independent ${dimension} attempt was submitted for this probe.` };
  }
  const belowFloor = probeScore < ABSOLUTE_COLLAPSE_FLOOR;
  const droppedFromAssisted = typeof assistedScore === "number" && Number.isFinite(assistedScore) && (assistedScore - probeScore) > RELATIVE_COLLAPSE_DROP;
  return {
    version: SCAFFOLD_FADING_PROBE_VERSION,
    dimension,
    available: true,
    assistedScore: typeof assistedScore === "number" && Number.isFinite(assistedScore) ? round(assistedScore) : null,
    probeScore: round(probeScore),
    collapsed: belowFloor || droppedFromAssisted,
    collapseReason: belowFloor ? "below-floor" : droppedFromAssisted ? "large-drop-from-assisted" : null,
  };
}

/**
 * Debugging specifically: reuses `process-trace-assessment.mjs`'s own
 * `scoreDebuggingStep` (unmodified) to turn a raw `misconception.mjs`
 * `gradeProbe` result into the 0/1 debugging score for both the probe
 * attempt and, when supplied, the scaffolded attempt, then hands both
 * through the same comparator every other dimension uses.
 */
export function scoreDebuggingDimension(probeGrade, assistedProbeGrade = null) {
  const probe = scoreDebuggingStep(probeGrade);
  const assisted = assistedProbeGrade ? scoreDebuggingStep(assistedProbeGrade) : null;
  return scoreIndependentDimension(
    "debugging",
    probe.available ? probe.score : null,
    assisted?.available ? assisted.score : null,
  );
}

/**
 * The full probe. Only runs at all once the scaffolded attempt actually
 * succeeded ("withdraw ... after success", exactly this item's own
 * wording) — probing an attempt that never succeeded would not be fading a
 * scaffold, it would just be a second attempt at the same unsolved task.
 * `planningScore`/`assistedPlanningScore` and
 * `explanationScore`/`assistedExplanationScore` are expected already-graded
 * numbers from this app's own `race-grader.mjs`/`explanation-grader.mjs`;
 * `debuggingProbeGrade`/`assistedDebuggingProbeGrade` are raw
 * `misconception.mjs` `gradeProbe` results, graded here via
 * `scoreDebuggingDimension`.
 */
export function evaluateScaffoldFadingProbe({
  assistedSucceeded,
  assistanceUsed,
  planningScore,
  assistedPlanningScore,
  debuggingProbeGrade,
  assistedDebuggingProbeGrade,
  explanationScore,
  assistedExplanationScore,
} = {}) {
  if (!assistedSucceeded) {
    return { version: SCAFFOLD_FADING_PROBE_VERSION, available: false, reason: "The scaffolded attempt did not succeed yet; fading is only probed after success." };
  }

  const withdrawal = verifyAssistanceWithdrawn(assistanceUsed);
  const planning = scoreIndependentDimension("planning", planningScore, assistedPlanningScore);
  const debugging = scoreDebuggingDimension(debuggingProbeGrade, assistedDebuggingProbeGrade);
  const explanation = scoreIndependentDimension("explanation", explanationScore, assistedExplanationScore);
  const dimensions = [planning, debugging, explanation];

  return {
    version: SCAFFOLD_FADING_PROBE_VERSION,
    available: true,
    withdrawal,
    dimensions,
    collapsedDimensions: dimensions.filter((entry) => entry.available && entry.collapsed).map((entry) => entry.dimension),
    unprovenDimensions: dimensions.filter((entry) => !entry.available).map((entry) => entry.dimension),
    collapsed: dimensions.some((entry) => entry.available && entry.collapsed),
  };
}

/**
 * Should this probe's success be allowed to count as mastery evidence?
 * Checked in order, each a distinct, named reason rather than one blended
 * verdict:
 *
 *   1. no probe ran, or the scaffolded attempt never succeeded — withheld,
 *      because nothing was proven either way;
 *   2. assistance was not actually withdrawn — withheld, because the probe
 *      proves nothing about independence regardless of its scores;
 *   3. any dimension's evidence is missing — withheld as insufficient
 *      evidence, the same "unproven is not a pass" discipline
 *      `curriculum-portfolio.mjs`'s own `decideCurriculumPromotion` already
 *      applies to its own gates;
 *   4. any dimension collapsed — withheld, naming which dimension(s).
 *
 * Only when none of the above holds is mastery allowed through.
 */
export function decideMasteryWithholding(probeResult) {
  if (!probeResult?.available) {
    return { version: SCAFFOLD_FADING_PROBE_VERSION, withhold: true, reason: probeResult?.reason ?? "No scaffold-fading probe was run." };
  }
  if (!probeResult.withdrawal.withdrawn) {
    return { version: SCAFFOLD_FADING_PROBE_VERSION, withhold: true, reason: `Assistance was not actually withdrawn: ${probeResult.withdrawal.stillPresent.join(", ")} still present.` };
  }
  if (probeResult.unprovenDimensions.length) {
    return { version: SCAFFOLD_FADING_PROBE_VERSION, withhold: true, reason: `Insufficient evidence for: ${probeResult.unprovenDimensions.join(", ")}.` };
  }
  if (probeResult.collapsed) {
    return { version: SCAFFOLD_FADING_PROBE_VERSION, withhold: true, reason: `Performance collapsed without assistance in: ${probeResult.collapsedDimensions.join(", ")}.` };
  }
  return { version: SCAFFOLD_FADING_PROBE_VERSION, withhold: false, reason: null };
}

/** Human-readable rendering for review tooling. */
export function renderScaffoldFadingReport(probeResult, withholdDecision) {
  if (!probeResult?.available) {
    return `Scaffold-fading probe: not available (${probeResult?.reason ?? "unknown"}).`;
  }
  const lines = [`Scaffold-fading probe v${probeResult.version}`];
  lines.push(probeResult.withdrawal.withdrawn ? "Assistance withdrawn: yes" : `Assistance withdrawn: no (${probeResult.withdrawal.stillPresent.join(", ")} still present)`);
  for (const entry of probeResult.dimensions) {
    if (!entry.available) {
      lines.push(`  ${entry.dimension}: insufficient evidence`);
      continue;
    }
    lines.push(`  ${entry.dimension}: probe=${entry.probeScore} assisted=${entry.assistedScore ?? "n/a"} ${entry.collapsed ? `COLLAPSED (${entry.collapseReason})` : "ok"}`);
  }
  lines.push(withholdDecision.withhold ? `Mastery withheld: ${withholdDecision.reason}` : "Mastery withheld: no");
  return lines.join("\n");
}
