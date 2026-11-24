import { checkCitations } from "./explanation-grader.mjs";
import { runInSandbox } from "./executable-quiz.mjs";

/**
 * Epistemic vigilance for generated code (tutor patches).
 *
 * `tutor-generation-verification.mjs` (item 43) checks whether *the tutor's
 * own output* is faithful, policy-compliant, leakage-free, and
 * rubric-aligned. Nothing in this app checked whether *the learner*
 * actually verified a tutor-proposed patch before adopting it, as opposed
 * to simply agreeing with it. Confirmed by grep before writing a line here:
 * zero prior matches for `VERIFICATION_STAGES`/`epistemicVigilance`/
 * `gatePatchAdoption`/`scoreFalsifyingTestStage` as implementation
 * identifiers anywhere in `electron/*.mjs`.
 *
 * This module scores three stages this item names, in the item's own
 * order, and keeps every one of them structurally separate from whether
 * the learner's final decision matches the tutor's:
 *
 *   1. **evidence location** — did the learner cite real `path:line`
 *      evidence from the repository? Reuses `explanation-grader.mjs`'s own
 *      `checkCitations` unmodified, the exact function this app already
 *      uses to validate a citation against the real file index.
 *   2. **failure-mode prediction** — before the falsifying test actually
 *      runs, which of this module's three named outcome categories
 *      (`raises`/`diverges`/`matches`) does the learner predict, and with
 *      what stated confidence? Scored with the same confidence-weighted
 *      Brier calculation `program-state-tracing.mjs`'s own `gradeHypothesis`
 *      already uses — narrowly reimplemented here for the same reason that
 *      module's own docstring gives for reimplementing it there: the
 *      answer shape (one of three named categories, not a number or a
 *      path) does not fit `activities.mjs`'s `gradePrediction` cases either.
 *   3. **falsifying-test design** — does the learner's own test, run for
 *      real inside `executable-quiz.mjs`'s own sandbox (`runInSandbox`,
 *      unmodified, the exact layered sandbox every other executable
 *      attempt in this app already uses) against the tutor's proposed
 *      patch, actually discriminate a correct patch from an incorrect one?
 *      A test is only scored once it actually ran; a claimed test that
 *      never executed abstains rather than being trusted.
 *
 * **The core invariant this item names** ("scoring the verification
 * process rather than agreement with the tutor") is enforced structurally,
 * not by a comment: [`gatePatchAdoptionOnVerification`] accepts a caller's
 * `tutorPatchDecision.adopted` boolean and explicitly, visibly ignores it —
 * the same accept-and-ignore discipline `knowledge-components.mjs`'s own
 * `rebuildComponentMastery` already uses for an untrusted `learnerState`
 * input it must not let influence its own computation. Whether the
 * learner's final adoption decision happens to agree with the tutor is
 * never read by this module at all; only whether the three stages above
 * were actually, verifiably completed decides the gate.
 */

export const EPISTEMIC_VIGILANCE_GATE_VERSION = 1;

/** The three stages this item names, in the item's own order. */
export const VERIFICATION_STAGES = ["evidence-location", "failure-mode-prediction", "falsifying-test"];

/** This module's own three named outcome categories for a falsifying test, in a fixed order. */
export const FAILURE_MODE_CATEGORIES = ["raises", "diverges", "matches"];

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

/**
 * Stage 1: evidence location. Reuses `explanation-grader.mjs`'s own
 * `checkCitations` unmodified. Available only once at least one citation
 * was given at all — zero citations is not "no evidence needed", it is
 * unproven.
 */
export function scoreEvidenceLocationStage(text, repository) {
  const citations = checkCitations(text, repository);
  if (!citations.length) {
    return { version: EPISTEMIC_VIGILANCE_GATE_VERSION, stage: "evidence-location", available: false, reason: "No repository citation (path:line) was given to support this claim.", citations: [] };
  }
  const valid = citations.filter((citation) => citation.valid);
  return {
    version: EPISTEMIC_VIGILANCE_GATE_VERSION,
    stage: "evidence-location",
    available: true,
    citations,
    validCount: valid.length,
    totalCount: citations.length,
    score: round(valid.length / citations.length),
  };
}

/**
 * Stage 3: falsifying-test design, executed for real. `patch` is
 * `{ moduleSource, entry, args, expectedIfCorrect }` — the tutor's
 * proposed patch module, the learner-designed call, and the output the
 * patch *should* produce if it is actually correct. The test is run once,
 * for real, inside `executable-quiz.mjs`'s own unmodified sandbox; nothing
 * about the outcome is predicted or assumed ahead of execution.
 *
 *   - sandbox did not complete -> abstain (`available: false`), the same
 *     honest non-answer `executable-explanation-verification.mjs`'s own
 *     `verifyByTest` already gives for an incomplete run;
 *   - the call raised           -> `"raises"`, and the test falsified the patch;
 *   - the call returned something other than `expectedIfCorrect` -> `"diverges"`,
 *     and the test falsified the patch;
 *   - the call matched `expectedIfCorrect` exactly -> `"matches"`, and this
 *     particular test did not find a problem (which is not the same claim
 *     as "the patch has no problem" — only that this test did not find one).
 */
export async function runFalsifyingTestStage(patch) {
  const oracle = await runInSandbox({ moduleSource: patch.moduleSource, entry: patch.entry, calls: [patch.args ?? []] });
  if (oracle.status !== "ok") {
    return { version: EPISTEMIC_VIGILANCE_GATE_VERSION, stage: "falsifying-test", available: false, reason: `The sandbox did not complete (${oracle.status}), so this falsifying test could not actually run.` };
  }
  const result = oracle.results?.[0];
  if (!result) {
    return { version: EPISTEMIC_VIGILANCE_GATE_VERSION, stage: "falsifying-test", available: false, reason: "The sandbox produced no result for this call." };
  }
  const actualCategory = !result.ok ? "raises" : result.value.trim() !== String(patch.expectedIfCorrect).trim() ? "diverges" : "matches";
  return {
    version: EPISTEMIC_VIGILANCE_GATE_VERSION,
    stage: "falsifying-test",
    available: true,
    actualCategory,
    falsified: actualCategory !== "matches",
    raw: result,
  };
}

/**
 * Stage 2: failure-mode prediction, scored only once the real execution in
 * stage 3 is known. A before-you-look discipline: the caller must supply
 * `predictedCategory`/`statedConfidence` from *before* `runFalsifyingTestStage`
 * ran, the same ordering `counterexample-lab.mjs`'s own
 * `gradeCounterexamplePrediction` already enforces for its own
 * before-you-run predictions.
 */
export function scoreFailureModePredictionStage(predictedCategory, statedConfidence, actualCategory) {
  if (!FAILURE_MODE_CATEGORIES.includes(predictedCategory)) {
    return { version: EPISTEMIC_VIGILANCE_GATE_VERSION, stage: "failure-mode-prediction", available: false, reason: `"${predictedCategory}" is not one of this module's named failure-mode categories.` };
  }
  const stated = Math.max(0, Math.min(1, Number(statedConfidence ?? 0.5)));
  const correct = predictedCategory === actualCategory;
  const brier = round((stated - (correct ? 1 : 0)) ** 2);
  return {
    version: EPISTEMIC_VIGILANCE_GATE_VERSION,
    stage: "failure-mode-prediction",
    available: true,
    predictedCategory,
    actualCategory,
    correct,
    confidence: round(stated),
    brier,
    calibration: correct
      ? (stated >= 0.7 ? "confident-and-right" : "underconfident")
      : (stated >= 0.7 ? "overconfident" : "appropriately-unsure"),
  };
}

/**
 * The full three-stage verification process for one proposed tutor patch.
 * Each stage is reported on its own; there is deliberately no averaging
 * function anywhere in this module, and no field anywhere named `score`
 * at this level — only `stages.evidenceLocation.score` /
 * `stages.failureModePrediction.brier`, each scoped to its own stage.
 */
export async function evaluateVerificationProcess({ evidenceText, repository, predictedCategory, statedConfidence, patch } = {}) {
  const evidenceLocation = scoreEvidenceLocationStage(evidenceText, repository);
  const falsifyingTest = await runFalsifyingTestStage(patch ?? {});
  const failureModePrediction = falsifyingTest.available
    ? scoreFailureModePredictionStage(predictedCategory, statedConfidence, falsifyingTest.actualCategory)
    : { version: EPISTEMIC_VIGILANCE_GATE_VERSION, stage: "failure-mode-prediction", available: false, reason: "The falsifying test did not run, so the prediction against it cannot be scored." };

  const stages = { evidenceLocation, failureModePrediction, falsifyingTest };
  const unprovenStages = Object.values(stages).filter((entry) => !entry.available).map((entry) => entry.stage);

  return {
    version: EPISTEMIC_VIGILANCE_GATE_VERSION,
    stages,
    unprovenStages,
    falsified: falsifyingTest.available ? falsifyingTest.falsified : null,
  };
}

/**
 * Was this verification process actually complete? `tutorPatchDecision` is
 * accepted so a caller already holding one (including its own `adopted`
 * field, naming whether the learner ultimately agreed with the tutor's
 * patch) does not have to strip it first — but `adopted` is never read:
 * agreement with the tutor is explicitly not part of this gate, which is
 * the whole point of this item.
 */
export function gatePatchAdoptionOnVerification(processResult, tutorPatchDecision = {}) {
  void tutorPatchDecision.adopted; // Explicitly accepted and explicitly ignored; see module doc. Agreement with the tutor is never scored here.
  if (processResult.unprovenStages.length) {
    return { version: EPISTEMIC_VIGILANCE_GATE_VERSION, verified: false, reason: `Insufficient evidence for: ${processResult.unprovenStages.join(", ")}.` };
  }
  return { version: EPISTEMIC_VIGILANCE_GATE_VERSION, verified: true, reason: null, falsified: processResult.falsified };
}

/** Human-readable rendering for review tooling. */
export function renderVerificationProcessReport(processResult, gateDecision) {
  const lines = [`Epistemic vigilance process v${processResult.version}`];
  const { evidenceLocation, failureModePrediction, falsifyingTest } = processResult.stages;
  lines.push(evidenceLocation.available
    ? `evidence-location: ${evidenceLocation.validCount}/${evidenceLocation.totalCount} citation(s) valid`
    : `evidence-location: insufficient evidence (${evidenceLocation.reason})`);
  lines.push(failureModePrediction.available
    ? `failure-mode-prediction: predicted=${failureModePrediction.predictedCategory} actual=${failureModePrediction.actualCategory} ${failureModePrediction.correct ? "correct" : "incorrect"} (brier=${failureModePrediction.brier})`
    : `failure-mode-prediction: insufficient evidence (${failureModePrediction.reason})`);
  lines.push(falsifyingTest.available
    ? `falsifying-test: actual=${falsifyingTest.actualCategory} ${falsifyingTest.falsified ? "falsified the patch" : "did not falsify the patch"}`
    : `falsifying-test: insufficient evidence (${falsifyingTest.reason})`);
  lines.push(gateDecision.verified ? "Verification process: complete" : `Verification process: incomplete (${gateDecision.reason})`);
  return lines.join("\n");
}
