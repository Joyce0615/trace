import { rate, MIN_SAMPLE } from "./analytics.mjs";

/**
 * Process-trace learning assessment.
 *
 * A final answer says whether a task was solved, not how the learner got
 * there. This module scores the *process* a learner went through — how they
 * navigated the repository, which evidence they selected, whether they
 * traced execution correctly, whether they diagnosed the right bug, and
 * whether a revision after feedback was a real, targeted fix — as four
 * separate reports, plus the final answer kept structurally apart from all
 * four. None of the five is ever averaged into the others, for the same
 * reason `analytics.mjs`'s five measures are never averaged: a learner who
 * traces well but cannot debug, and one who debugs well but never revises,
 * have different problems, and a single "process score" would hide both.
 *
 * Every grading judgment this module reports is read from a real grader this
 * app already has, never re-derived:
 *
 *   - **navigation** and **evidence selection** both come from
 *     `localization.mjs`'s own `scoreLocalization` output — the former from
 *     its efficiency fields (how much of what was *read* was relevant), the
 *     latter from its coverage/precision/f1 fields (how much of what was
 *     *selected* was relevant). They are two different questions about the
 *     same submission and are reported as two different steps here.
 *   - **tracing** comes from `program-state-tracing.mjs`'s own
 *     `gradeStateTrace` output (correct/omitted/swapped/wrong), unmodified.
 *   - **debugging** comes from `misconception.mjs`'s own `gradeProbe` output
 *     (did the learner avoid acting on a specific wrong mental model),
 *     unmodified.
 *
 * Genuinely new here: **revision** scoring (`scoreRevisionStep`), which
 * compares two of this app's own graded attempts at the *same* task and
 * reports not just "did the score go up" but whether the specific thing that
 * was wrong before is now fixed — and **rubric validation**
 * (`validateRubricAgreement`), which checks this module's own automated
 * scores against instructor-reviewed scores for the same traces, reusing
 * `analytics.mjs`'s own `rate` (unmodified) for the honest sample-floor
 * discipline on the agreement rate, and reporting mean absolute error and
 * every concrete disagreement rather than a single blended "validity" score.
 */

export const PROCESS_TRACE_ASSESSMENT_VERSION = 1;

/** Disagreements below this score gap are not worth listing individually. */
export const DISAGREEMENT_THRESHOLD = 0.2;

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

/** Navigation: how much of what the learner read was actually relevant. */
export function scoreNavigationStep(localizationScore) {
  if (!localizationScore) return { available: false, reason: "No localization attempt was submitted for this task." };
  return {
    available: true,
    fileEfficiency: localizationScore.fileEfficiency,
    byteEfficiency: localizationScore.byteEfficiency,
    wastedInspections: localizationScore.wastedInspections,
    firstHitRank: localizationScore.firstHitRank,
    score: round((localizationScore.fileEfficiency + localizationScore.byteEfficiency) / 2),
  };
}

/** Evidence selection: how much of the final selection was actually relevant, and how much relevant evidence it covers. */
export function scoreEvidenceSelectionStep(localizationScore) {
  if (!localizationScore) return { available: false, reason: "No localization attempt was submitted for this task." };
  return {
    available: true,
    coverage: localizationScore.coverage,
    precision: localizationScore.precision,
    f1: localizationScore.f1,
    missed: localizationScore.missed,
    falsePositives: localizationScore.falsePositives,
    score: localizationScore.f1,
  };
}

/** Tracing: whether the learner's checkpoint-by-checkpoint account of execution matches the real recorded run. */
export function scoreTracingStep(stateTraceGrade) {
  if (!stateTraceGrade) return { available: false, reason: "No program-state trace attempt was submitted for this task." };
  return {
    available: true,
    correct: stateTraceGrade.correct,
    checkpointCount: stateTraceGrade.checkpointCount,
    omitted: stateTraceGrade.omitted,
    swapped: stateTraceGrade.swapped,
    wrong: stateTraceGrade.wrong,
    score: stateTraceGrade.score,
  };
}

/** Debugging: whether the learner's diagnostic approach avoided a specific, named wrong mental model. */
export function scoreDebuggingStep(probeGrade) {
  if (!probeGrade) return { available: false, reason: "No misconception probe attempt was submitted for this task." };
  return {
    available: true,
    correct: probeGrade.correct,
    misconceptionId: probeGrade.misconception?.id ?? null,
    misconceptionTitle: probeGrade.misconception?.title ?? null,
    remediation: probeGrade.misconception?.remediation ?? null,
    score: probeGrade.correct ? 1 : 0,
  };
}

/**
 * Revision: compares two of this app's own graded attempts at the *same*
 * task. "Improved" is a higher score; "targeted" is specifically whether the
 * concrete things that were wrong the first time (an omitted/swapped/wrong
 * checkpoint, or a missed/false-positive file) are the things that are now
 * fixed, as opposed to an unrelated change that happened to raise the score.
 * Recognizes both `gradeStateTrace`-shaped attempts (`results` with
 * `checkpointId`/`correct`) and `scoreLocalization`-shaped attempts (`missed`
 * / `falsePositives` path lists); an attempt pair in neither shape still
 * reports `improved`/`delta` honestly, just with `targetedFix: null`.
 */
export function scoreRevisionStep(before, after) {
  if (!before || !after) return { available: false, reason: "A revision step needs both a prior and a revised attempt for the same task." };
  const beforeScore = Number(before.score ?? 0);
  const afterScore = Number(after.score ?? 0);
  let targetedFix = null;
  if (Array.isArray(before.results) && Array.isArray(after.results)) {
    const brokenBefore = before.results.filter((result) => !result.correct).map((result) => result.checkpointId);
    const afterById = new Map(after.results.map((result) => [result.checkpointId, result]));
    const fixed = brokenBefore.filter((id) => afterById.get(id)?.correct);
    targetedFix = { attempted: brokenBefore.length, fixed: fixed.length };
  } else if (Array.isArray(before.missed) || Array.isArray(before.falsePositives)) {
    const missedFixed = (before.missed ?? []).filter((filePath) => !(after.missed ?? []).includes(filePath));
    const falsePositivesFixed = (before.falsePositives ?? []).filter((filePath) => !(after.falsePositives ?? []).includes(filePath));
    const attempted = (before.missed ?? []).length + (before.falsePositives ?? []).length;
    targetedFix = { attempted, fixed: missedFixed.length + falsePositivesFixed.length };
  }
  return {
    available: true,
    beforeScore: round(beforeScore),
    afterScore: round(afterScore),
    improved: afterScore > beforeScore,
    delta: round(afterScore - beforeScore),
    targetedFix,
  };
}

/**
 * The combined process-trace report. `finalAnswer` (whatever the task's own
 * grader already decided about pass/fail) is kept structurally separate from
 * the four process dimensions below it, exactly as this item's text asks:
 * none of navigation/evidenceSelection/tracing/debugging/revision/finalAnswer
 * is folded into any other.
 */
export function assessProcessTrace({ localization = null, tracing = null, debugging = null, revisionBefore = null, revisionAfter = null, finalAnswer = null } = {}) {
  return {
    version: PROCESS_TRACE_ASSESSMENT_VERSION,
    navigation: scoreNavigationStep(localization),
    evidenceSelection: scoreEvidenceSelectionStep(localization),
    tracing: scoreTracingStep(tracing),
    debugging: scoreDebuggingStep(debugging),
    revision: scoreRevisionStep(revisionBefore, revisionAfter),
    finalAnswer: finalAnswer ? { correct: Boolean(finalAnswer.correct), score: Number(finalAnswer.score ?? (finalAnswer.correct ? 1 : 0)) } : { available: false, reason: "No final-answer outcome was supplied." },
  };
}

/**
 * Validate this module's automated rubric scores against instructor-reviewed
 * scores for the same traces. `pairs` is `[{ id, automatedScore,
 * automatedPassed, instructorScore, instructorPassed }]`. The agreement rate
 * reuses `analytics.mjs`'s own `rate` (unmodified), so it refuses to report a
 * confident-looking percentage below the same minimum-sample floor every
 * other rate in this app already respects. Mean absolute error and the list
 * of concrete disagreements are reported alongside it rather than folded
 * into one "validity" number, because a rubric that agrees on pass/fail but
 * is numerically far off, and one that is numerically close but flips
 * pass/fail, are different failures a single number would hide.
 */
export function validateRubricAgreement(pairs) {
  const usable = (pairs ?? []).filter((pair) => pair
    && Number.isFinite(Number(pair.automatedScore))
    && Number.isFinite(Number(pair.instructorScore)));
  const agreementRate = rate(
    usable.filter((pair) => Boolean(pair.automatedPassed) === Boolean(pair.instructorPassed)).length,
    usable.length,
  );
  const meanAbsoluteError = usable.length
    ? round(usable.reduce((sum, pair) => sum + Math.abs(Number(pair.automatedScore) - Number(pair.instructorScore)), 0) / usable.length)
    : null;
  const disagreements = usable
    .filter((pair) => Boolean(pair.automatedPassed) !== Boolean(pair.instructorPassed)
      || Math.abs(Number(pair.automatedScore) - Number(pair.instructorScore)) > DISAGREEMENT_THRESHOLD)
    .map((pair) => ({
      id: pair.id ?? null,
      automatedScore: round(Number(pair.automatedScore)),
      instructorScore: round(Number(pair.instructorScore)),
      gap: round(Number(pair.automatedScore) - Number(pair.instructorScore)),
      passedMismatch: Boolean(pair.automatedPassed) !== Boolean(pair.instructorPassed),
    }));
  return {
    version: PROCESS_TRACE_ASSESSMENT_VERSION,
    samples: usable.length,
    requiredSamples: MIN_SAMPLE,
    agreementRate,
    meanAbsoluteError,
    disagreements,
    verdict: agreementRate.value === null
      ? "insufficient-evidence"
      : disagreements.length === 0
        ? "rubric-agrees"
        : "rubric-diverges",
  };
}
