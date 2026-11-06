import { detectInjection } from "./prompt-isolation.mjs";
import { GOAL_LESSON_KEYWORDS } from "./goal-keywords.mjs";
import { calibrateSkill } from "./misconception.mjs";
import { retentionAnalytics, delayedTransferAnalytics } from "./analytics.mjs";
import { appendEvent } from "./activity-log.mjs";

/**
 * Cognitive-offloading safeguards.
 *
 * A tutor that hands over a finished answer the moment it is asked for one
 * optimizes the wrong thing: the learner's immediate task gets done, and
 * nothing is learned. This module classifies an incoming request by its
 * learning objective and the learner's calibrated mastery of the skill it
 * touches, decides whether the request is actually asking to be handed a
 * finished solution, and — only for a learner who has not yet built the
 * skill — gates high-assistance output behind a real prediction or
 * explanation. It then measures the outcome on delayed retention, never on
 * whether the immediate request was completed.
 *
 * Every building block this module needs already exists elsewhere and is
 * reused unmodified, never re-derived:
 *
 *   - **Objective classification** reuses `goal-keywords.mjs`'s own
 *     `GOAL_LESSON_KEYWORDS` — the same five keyword sets `goals.mjs` and
 *     the skill graph already use to decide what a *lesson* is about —
 *     applied here to what a *request* is about, so a request and the
 *     lessons it could draw from are classified by one taxonomy, not two.
 *   - **Adversarial answer-seeking** reuses `prompt-isolation.mjs`'s own
 *     `detectInjection`, the same detector `tutor-safety-benchmark.mjs`'s
 *     `adversarial-answer-seeking` category already relies on.
 *   - **Calibrated mastery** reuses `misconception.mjs`'s own
 *     `calibrateSkill` (a Beta-Bernoulli posterior, not a raw percentage),
 *     so "has this learner actually built the skill" is answered with the
 *     same honest, sample-size-aware estimate the mastery view already
 *     shows them.
 *   - **Delayed retention**, the outcome measure this item names instead of
 *     immediate completion, reuses `analytics.mjs`'s own `retentionAnalytics`
 *     and `delayedTransferAnalytics` unmodified.
 *   - **Evidence that a prediction/explanation happened** is read from
 *     already-graded results produced by `activities.mjs`'s `gradePrediction`
 *     or `explanation-grader.mjs`'s `gradeExplanation` — this module does not
 *     grade anything itself, it only decides whether the grade that already
 *     exists is good enough to unlock high-assistance output.
 *
 * Genuinely new here: the plain, non-adversarial "write it for me" / "just
 * give me the answer" patterns (`HIGH_ASSISTANCE_PATTERNS`) that
 * `detectInjection` does not cover (it looks for attempts to *override* the
 * tutor, not an ordinary request for a finished solution), the decision rule
 * combining objective + assistance-seeking + mastery into a gate, and the
 * "measure retention, not completion" framing of the outcome.
 */

export const COGNITIVE_OFFLOAD_GUARD_VERSION = 1;

/** Below this calibrated mastery, a high-assistance request is gated. */
export const DEFAULT_MASTERY_FLOOR = 0.6;

/** Below this explanation score, a submitted explanation does not satisfy the gate. */
export const EXPLANATION_GATE_THRESHOLD = 0.6;

const HIGH_ASSISTANCE_PATTERNS = [
  { id: "write-it-for-me", expression: /\b(?:write|code|implement|build)\s+(?:it|this|that|the\s+\w+)(?:\s+\w+){0,3}\s+for\s+me\b/i },
  { id: "just-give-answer", expression: /\bjust\s+(?:give|tell|show)\s+me\s+the\s+(?:answer|solution|code|fix)\b/i },
  { id: "do-my-work", expression: /\bdo\s+(?:my|this)\s+(?:homework|assignment|exercise)\s+for\s+me\b/i },
  { id: "full-solution-request", expression: /\b(?:full|complete|entire|whole)\s+solution\b/i },
  { id: "fix-it-for-me", expression: /\bfix\s+(?:it|this|that)\s+for\s+me\b/i },
];

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

/**
 * Which of the five learning-goal keyword sets this request's own wording
 * matches, reusing exactly the taxonomy lessons are already classified
 * under. A request that matches none of them is honestly `unclassified`
 * rather than forced into a bucket it does not fit.
 */
export function classifyRequestObjective(text) {
  const value = String(text ?? "");
  for (const [goal, pattern] of Object.entries(GOAL_LESSON_KEYWORDS)) {
    if (pattern.test(value)) return goal;
  }
  return "unclassified";
}

/**
 * Is this request asking to be handed a finished solution? Two independent
 * signals, both named: a plain (non-adversarial) "do it for me" phrasing,
 * and `prompt-isolation.mjs`'s own high-severity injection findings (an
 * adversarial attempt to override the tutor is, a fortiori, also asking for
 * unrestricted assistance).
 */
export function classifyAssistanceSeeking(text) {
  const value = String(text ?? "");
  const matchedPatterns = HIGH_ASSISTANCE_PATTERNS.filter((pattern) => pattern.expression.test(value)).map((pattern) => pattern.id);
  const injectionFindings = detectInjection(value).filter((finding) => finding.severity === "high").map((finding) => finding.id);
  const reasons = [...matchedPatterns, ...injectionFindings];
  return { level: reasons.length ? "high" : "standard", reasons, adversarial: injectionFindings.length > 0 };
}

/**
 * Classify one request: what it is about, whether it is seeking a finished
 * solution, and — combining that with the learner's calibrated mastery of
 * the skill — what level of assistance is actually appropriate.
 *
 * A high-assistance request from a learner who has already demonstrated
 * mastery is not gated: the safeguard exists for the learner who has not yet
 * built the skill, not as a blanket refusal to ever help.
 */
export function classifyRequest(text, mastery, options = {}) {
  const masteryFloor = options.masteryFloor ?? DEFAULT_MASTERY_FLOOR;
  const objective = classifyRequestObjective(text);
  const seeking = classifyAssistanceSeeking(text);
  const calibrated = calibrateSkill(mastery);
  const belowFloor = calibrated.mastery < masteryFloor;
  const recommendedLevel = seeking.level !== "high"
    ? "standard"
    : belowFloor
      ? "high-assistance-gated"
      : "high-assistance";
  return {
    version: COGNITIVE_OFFLOAD_GUARD_VERSION,
    objective,
    seeking,
    masteryFloor,
    mastery: calibrated.mastery,
    masteryConfidence: calibrated.confidence,
    belowFloor,
    recommendedLevel,
  };
}

/**
 * Require a real prediction or explanation before releasing high-assistance
 * output. Evidence is not graded here — it is read from a grade this app
 * already produced (`activities.mjs`'s `gradePrediction`, or
 * `explanation-grader.mjs`'s `gradeExplanation`) — so this function cannot be
 * satisfied by a claim, only by a real graded attempt.
 */
export function gateHighAssistanceOutput(classification, evidence = {}) {
  if (classification.recommendedLevel !== "high-assistance-gated") {
    return { version: COGNITIVE_OFFLOAD_GUARD_VERSION, gated: false, allowed: true, reason: null, satisfiedBy: null };
  }
  const predictionOk = Boolean(evidence.prediction?.correct);
  const explanationOk = Number.isFinite(evidence.explanation?.score) && evidence.explanation.score >= EXPLANATION_GATE_THRESHOLD;
  const allowed = predictionOk || explanationOk;
  return {
    version: COGNITIVE_OFFLOAD_GUARD_VERSION,
    gated: true,
    allowed,
    satisfiedBy: predictionOk ? "prediction" : explanationOk ? "explanation" : null,
    reason: allowed
      ? null
      : "This would hand over a finished solution before you have made a correct prediction or a passing explanation about this code.",
  };
}

/**
 * Preserve one gate decision as learning evidence, through the same
 * append-only, main-process-owned activity log every other graded activity
 * writes to (`activity-log.mjs`'s `appendEvent`, reused unmodified).
 */
export function recordOffloadDecision(directory, repository, classification, gate) {
  return appendEvent(directory, repository.id, {
    kind: "cognitive-offload-decision",
    objective: classification.objective,
    assistanceSeeking: classification.seeking.level,
    recommendedLevel: classification.recommendedLevel,
    mastery: classification.mastery,
    gated: gate.gated,
    allowed: gate.allowed,
    satisfiedBy: gate.satisfiedBy,
  });
}

/**
 * The outcome measure this item names instead of immediate task completion:
 * delayed retention and delayed transfer, reusing `analytics.mjs`'s own
 * `retentionAnalytics`/`delayedTransferAnalytics` (unmodified) over the same
 * event log the gate decisions above were appended to. This function never
 * computes an "immediate completion rate" for granted-vs-withheld requests —
 * that is precisely the metric this item asks not to optimize for — so no
 * such field exists on the result.
 */
export function measureOffloadingOutcome(events, learnerState, skillGraph, options = {}) {
  const decisions = (events ?? []).filter((event) => event.kind === "cognitive-offload-decision");
  const granted = decisions.filter((event) => event.gated && event.allowed);
  const withheld = decisions.filter((event) => event.gated && !event.allowed);
  const ungated = decisions.filter((event) => !event.gated);
  return {
    version: COGNITIVE_OFFLOAD_GUARD_VERSION,
    decisions: decisions.length,
    granted: granted.length,
    withheld: withheld.length,
    ungated: ungated.length,
    retention: retentionAnalytics(events, learnerState, skillGraph, options),
    delayedTransfer: delayedTransferAnalytics(events, options),
  };
}

/** A gate decision rendered as human-readable text for the lesson canvas. */
export function describeOffloadDecision(classification, gate) {
  if (!gate.gated) {
    return classification.recommendedLevel === "high-assistance"
      ? "This request asks for a finished solution, but your calibrated mastery already clears the bar, so it is not gated."
      : "This request is not asking for a finished solution; no gate applies.";
  }
  if (gate.allowed) {
    return `High-assistance output unlocked by a passing ${gate.satisfiedBy}.`;
  }
  return round(classification.mastery) < classification.masteryFloor
    ? `Held back: your calibrated mastery (${round(classification.mastery * 100)}%) is below the floor, and no passing prediction or explanation has been submitted yet.`
    : gate.reason;
}
