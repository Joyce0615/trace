import { buildMasteryEvidence } from "./counterexample-lab.mjs";
import { detectMisconceptions, misconceptionById } from "./misconception.mjs";

/**
 * The misconception repair gate.
 *
 * `misconception.mjs`'s own `detectMisconceptions` already names a wrong
 * mental model in a learner's own words, and `counterexample-lab.mjs`
 * already grounds a repair in a real, executed counterexample rather than a
 * simulated one. But nothing before this module ever stopped a diagnosed
 * claim from being persisted anyway: `project-continuity.mjs`'s
 * `recordHypothesis`/`recordEvidence`/`appendThreadTurn` and `learning.ts`'s
 * `addEvidence` all accept arbitrary learner text and write it into
 * long-term state unconditionally — a misconception named in a hypothesis,
 * a piece of evidence, a thread answer, or a side-chat memory note is
 * carried forward forever unless a caller happens to also run it through a
 * counterexample lab, and nothing enforces that it does.
 *
 * Grep confirmed before writing a line here: zero prior matches for
 * `gateClaimForPersistence`/`evaluateRepairCycle`/`requireRepairCycle`
 * anywhere in `electron/*.mjs`.
 *
 * This module adds exactly one enforcement path, reusing rather than
 * reinventing both halves of the work this app already built:
 *
 *   - **Diagnosis** (`diagnoseClaimBeforePersistence`) is
 *     `misconception.mjs`'s own `detectMisconceptions`, called on a claim
 *     *before* a caller would persist it — this module carries no detector
 *     pattern of its own.
 *   - **Repair** (`evaluateRepairCycle`) is three stages, all required: a
 *     prediction committed *before* the counterexample ran (the same
 *     before-you-look discipline `counterexample-lab.mjs`'s own
 *     `gradeCounterexamplePrediction` already scores — proven here by
 *     requiring the prediction's own `labId` to match the run's `labId`,
 *     the only way to tell a prediction that was genuinely committed
 *     against *this* lab from one spliced in from an unrelated attempt),
 *     a real observation
 *     (`counterexample-lab.mjs`'s own `runCounterexampleLab`'s `resolved`
 *     field, unmodified — never re-run or re-judged here), and a
 *     *reassessment*: the learner's own post-observation restatement, run
 *     back through `detectMisconceptions` one more time. A learner who
 *     watched the correct output print and then restates the exact wrong
 *     model anyway has not repaired anything, whatever the lab run says —
 *     this is the "prediction-observation-reassessment" cycle the item
 *     names, and the reassessment stage is the one none of this app's
 *     existing modules required.
 *   - **Enforcement** (`gateClaimForPersistence`,
 *     `buildGatedMasteryEvidence`) is the actual "keep unverified
 *     misconceptions out of long-term learner state" clause: a claim that
 *     names a misconception with no completed repair cycle on record is
 *     blocked, and `buildGatedMasteryEvidence` delegates to
 *     `counterexample-lab.mjs`'s own `buildMasteryEvidence` (unmodified)
 *     only once `evaluateRepairCycle` says the cycle actually completed.
 *
 * Everything here is deterministic and pure: no fs, no network, no Node
 * builtin — the Node-only half (actually running a counterexample) already
 * lives in `counterexample-lab.mjs`, and this module never duplicates it.
 */

export const MISCONCEPTION_REPAIR_GATE_VERSION = 1;

/**
 * Diagnose a learner's own claim text before it is ever persisted to
 * long-term learner state — a hypothesis, a piece of continuity evidence, a
 * thread answer, or a side-chat memory note. Reuses `misconception.mjs`'s
 * own `detectMisconceptions` unmodified.
 */
export function diagnoseClaimBeforePersistence(text, options = {}) {
  const findings = detectMisconceptions(text, options);
  return {
    version: MISCONCEPTION_REPAIR_GATE_VERSION,
    clean: findings.length === 0,
    findings,
  };
}

/**
 * Whether one named misconception's prediction-observation-reassessment
 * repair cycle actually completed, grounded in `counterexample-lab.mjs`'s
 * real execution (never simulated or re-judged here). All three stages
 * must hold; the first stage to fail is the one named in `reason`.
 */
export function evaluateRepairCycle(misconceptionId, { predictionGrade, run, reassessmentText } = {}) {
  const entry = misconceptionById(misconceptionId);
  if (!entry) {
    return { version: MISCONCEPTION_REPAIR_GATE_VERSION, misconceptionId, repaired: false, reason: "unknown-misconception", stages: null };
  }

  // `predictionGrade` only exists if `gradeCounterexamplePrediction` ran,
  // which only ever happens against a lab's own two options *before* that
  // lab's run is known to the caller; matching `labId` to the actual `run`
  // is what proves this prediction and this observation are the same
  // attempt, not two different attempts spliced together.
  const predicted = Boolean(predictionGrade?.labId) && predictionGrade.labId === run?.labId;
  const observed = Boolean(run?.resolved);
  const reassessmentFindings = typeof reassessmentText === "string" && reassessmentText.trim() ? detectMisconceptions(reassessmentText) : [];
  const stillHeld = reassessmentFindings.some((finding) => finding.id === misconceptionId);
  const reassessed = typeof reassessmentText === "string" && reassessmentText.trim().length > 0 && !stillHeld;

  const stages = { predicted, observed, reassessed };
  const repaired = predicted && observed && reassessed;
  const reason = repaired
    ? null
    : !predicted
      ? "No prediction was committed before the counterexample ran."
      : !observed
        ? "The counterexample run did not resolve the misconception."
        : "The reassessment still names the same misconception.";

  return { version: MISCONCEPTION_REPAIR_GATE_VERSION, misconceptionId, repaired, reason, stages };
}

/**
 * The actual enforcement: whether a learner claim may be persisted into
 * long-term learner state. `repairedCycles` is a record keyed by
 * misconceptionId -> the `evaluateRepairCycle` result already completed
 * elsewhere in this session; a claim naming a misconception with no entry
 * there, or an entry with `repaired: false`, is blocked. A clean claim (no
 * misconception detected) is never blocked by this gate.
 */
export function gateClaimForPersistence(text, repairedCycles = {}) {
  const diagnosis = diagnoseClaimBeforePersistence(text);
  if (diagnosis.clean) {
    return { version: MISCONCEPTION_REPAIR_GATE_VERSION, allowed: true, reason: null, blockedMisconceptions: [], diagnosis };
  }
  const blocked = diagnosis.findings.filter((finding) => !repairedCycles[finding.id]?.repaired);
  return {
    version: MISCONCEPTION_REPAIR_GATE_VERSION,
    allowed: blocked.length === 0,
    reason: blocked.length
      ? `This claim would persist an unverified misconception (${blocked.map((finding) => finding.id).join(", ")}) without a completed prediction-observation-reassessment repair.`
      : null,
    blockedMisconceptions: blocked.map((finding) => finding.id),
    diagnosis,
  };
}

/**
 * The mastery evidence item for a repaired misconception, or `null` with a
 * reason when the cycle has not completed — never persisted "on trust".
 * Delegates to `counterexample-lab.mjs`'s own `buildMasteryEvidence`
 * (unmodified) only once `evaluateRepairCycle` confirms the cycle completed.
 */
export function buildGatedMasteryEvidence(misconceptionId, { predictionGrade, run, reassessmentText } = {}) {
  const cycle = evaluateRepairCycle(misconceptionId, { predictionGrade, run, reassessmentText });
  if (!cycle.repaired) {
    return { version: MISCONCEPTION_REPAIR_GATE_VERSION, evidence: null, cycle };
  }
  return { version: MISCONCEPTION_REPAIR_GATE_VERSION, evidence: buildMasteryEvidence(run, predictionGrade), cycle };
}

/** Human-readable rendering for review tooling / the lesson canvas. */
export function renderRepairGateDecision(decision) {
  if (!decision) return "No repair-gate decision available.";
  if (decision.allowed) return "PERSISTENCE ALLOWED — no unverified misconception blocks this claim.";
  return `PERSISTENCE BLOCKED — ${decision.reason}`;
}
