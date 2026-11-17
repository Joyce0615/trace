import { Verdict, extractCallClaims, verifyAnswerFaithfulness, verifyCourseFaithfulness } from "./faithfulness-guard.mjs";
import { detectInjection } from "./prompt-isolation.mjs";
import { ALWAYS_FORBIDDEN, findForbiddenKeys, findLeakedValues, MIN_SCANNED_SECRET } from "./answer-guard.mjs";
import { validateRubricAgreement } from "./process-trace-assessment.mjs";
import { measureOverrideRate } from "./curriculum-review.mjs";

/**
 * Separate tutor generation from pedagogical verification (item 43).
 *
 * `agents.mjs`'s own `generateCourseWithAgent`/`askAgent` spawn an external
 * model and the result is normalized and stored (`course.mjs`'s
 * `normalizeAgentCourse`, called from `main.mjs`'s `"course:enhance"`
 * handler) with **no independent check of what the model produced** —
 * confirmed by grep before writing a line here: zero prior matches for
 * `generatorVersion`/`verifierVersion`/`CLAIM_EVALUATOR_VERSION`/
 * `POLICY_EVALUATOR_VERSION`/`LEAKAGE_EVALUATOR_VERSION`/
 * `RUBRIC_EVALUATOR_VERSION`/`hiddenSolution`/`blindGenerationRequest`
 * anywhere in `electron/*.mjs` before this item.
 *
 * This module adds the missing verification layer, built entirely out of
 * four systems this app already has, each kept **independently versioned**
 * (a later change to one evaluator's logic bumps only its own constant, not
 * the other three, and not this module's own `TUTOR_GENERATION_VERIFICATION_VERSION`):
 *
 *   - **Claim evaluator** (`CLAIM_EVALUATOR_VERSION`) — is a factual or
 *     relational claim in the generated content true against this
 *     repository's own structural evidence? Reuses `faithfulness-guard.mjs`'s
 *     own `verifyCourseFaithfulness`/`verifyAnswerFaithfulness`/
 *     `extractCallClaims` unmodified, for a generated course draft or a
 *     generated tutor-answer text respectively.
 *   - **Policy evaluator** (`POLICY_EVALUATOR_VERSION`) — does the generated
 *     content itself carry a high-severity prompt-injection pattern, the
 *     sharpest evidence the generator was compromised by untrusted
 *     repository content it read? Reuses `prompt-isolation.mjs`'s own
 *     `detectInjection` unmodified. When the caller supplies the injection
 *     findings already detected in the untrusted source material the
 *     generator read (`context.sourceFindings`), a matching finding in the
 *     output is additionally reported as `echoed` — confirmed, not merely
 *     suspected, to have come from that source.
 *   - **Leakage evaluator** (`LEAKAGE_EVALUATOR_VERSION`) — does the
 *     generated content reproduce a forbidden answer-key field or a
 *     blinded hidden-solution value, despite the generator never having
 *     been handed it directly? Reuses `answer-guard.mjs`'s own
 *     `findForbiddenKeys`/`findLeakedValues` unmodified.
 *   - **Rubric evaluator** (`RUBRIC_EVALUATOR_VERSION`) — does this app's
 *     own automated pass/score for the generated content agree with
 *     instructor-reviewed scores for the same cases? Reuses
 *     `process-trace-assessment.mjs`'s own `validateRubricAgreement`
 *     unmodified, including its honest `insufficient-evidence` floor.
 *
 * **Blinding hidden solutions.** [`blindGenerationRequest`] strips every
 * field a generation request carries that would hand the generator its own
 * gold answer ahead of time — the same key list `answer-guard.mjs`'s own
 * `ALWAYS_FORBIDDEN` already forbids on every live response, reused here on
 * the *request* side instead of the response side, at any depth, plus any
 * extra keys a caller names for a task-specific hidden-solution field. This
 * is a removal, not merely a value scan: the key is gone from the object the
 * generator receives, not set to `undefined`. The leakage evaluator then
 * checks the *output* independently against the real hidden-solution values
 * — the same redundant-defense posture `answer-guard.mjs`'s own egress guard
 * already applies (removing a field from the request is not trusted as proof
 * nothing leaked; the response is scanned regardless).
 *
 * **Disagreement against instructor adjudication.** This module does not
 * reinvent a review queue or an override-tracking mechanism:
 * [`generationVerificationReviewItems`] turns each non-faithful/abstained
 * evaluator verdict into exactly the item shape `curriculum-review.mjs`'s
 * own `recordAdjudication` and `blindReviewItem` already understand (reused
 * unmodified, by the caller, not re-exported here to avoid a duplicate
 * import surface), tagged with a `generation-verification-<evaluator>`
 * review kind. [`measureEvaluatorDisagreement`] is a thin, evaluator-scoped
 * wrapper over `curriculum-review.mjs`'s own `measureOverrideRate`
 * (unmodified) — that function already takes an arbitrary `reviewKind`, so
 * no new rate-computation logic is needed, only the naming convention that
 * lets one override-rate function serve both curriculum-review's four kinds
 * and this module's four evaluators without drifting into two
 * implementations of the same honest sample-floor discipline.
 *
 * Every report keeps the four evaluators separate — never blended into one
 * score, the same discipline `verifyCourseFaithfulness`'s own `separate: true`
 * flag already states for its four claim families, applied here across four
 * *evaluators* instead: a report with a faithful claim evaluator and a
 * diverging rubric evaluator is not "50% verified", it is two different
 * findings a single number would hide.
 *
 * Pure and Node-free: no filesystem, network, or model calls. `generated` is
 * always caller-supplied content (a real agent response, or a deterministic
 * fixture in a test) — this module never spawns a model itself, the same
 * boundary `tutor-safety-benchmark.mjs`/`rag-eval.mjs` already state for
 * their own caller-supplied content.
 */

export const CLAIM_EVALUATOR_VERSION = 1;
export const POLICY_EVALUATOR_VERSION = 1;
export const LEAKAGE_EVALUATOR_VERSION = 1;
export const RUBRIC_EVALUATOR_VERSION = 1;
export const TUTOR_GENERATION_VERIFICATION_VERSION = 1;

const EVALUATOR_VERSIONS = Object.freeze({
  claim: CLAIM_EVALUATOR_VERSION,
  policy: POLICY_EVALUATOR_VERSION,
  leakage: LEAKAGE_EVALUATOR_VERSION,
  rubric: RUBRIC_EVALUATOR_VERSION,
});

function generatedText(generated) {
  if (typeof generated === "string") return generated;
  if (typeof generated?.text === "string") return generated.text;
  return "";
}

/**
 * Remove every forbidden/hidden-solution key from a generation request, at
 * any depth, before it is handed to a generator. A removal, not a value
 * scan: the key is gone, never set to `undefined` (which `findForbiddenKeys`
 * elsewhere in this app treats as an intentional, already-handled removal).
 */
function stripKeysDeep(value, keys, seen = new Set()) {
  if (Array.isArray(value)) return value.map((item) => stripKeysDeep(item, keys, seen));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    if (seen.has(value)) return null;
    seen.add(value);
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (keys.includes(key)) continue;
      out[key] = stripKeysDeep(child, keys, seen);
    }
    return out;
  }
  return value;
}

/**
 * Blind a generation request: strip `answer-guard.mjs`'s own
 * `ALWAYS_FORBIDDEN` keys (plus any caller-named extra hidden-solution
 * fields) from the request before a generator ever sees it, and report
 * exactly which pointers were removed (the same pointer shape
 * `findForbiddenKeys` already reports, reused unmodified to detect what to
 * strip).
 */
export function blindGenerationRequest(request, extraForbiddenKeys = []) {
  const keys = [...new Set([...ALWAYS_FORBIDDEN, ...extraForbiddenKeys])];
  const stripped = findForbiddenKeys(request ?? null, keys);
  const blinded = stripKeysDeep(request ?? null, keys);
  return { version: TUTOR_GENERATION_VERIFICATION_VERSION, blinded, stripped };
}

function overallCourseStatus(result) {
  const families = [result.lessons, result.quizzes, result.hints, result.answers].filter(Boolean);
  if (!families.length) return Verdict.ABSTAIN;
  if (families.some((family) => family.status === Verdict.UNFAITHFUL)) return Verdict.UNFAITHFUL;
  if (families.some((family) => family.status === Verdict.ABSTAIN)) return Verdict.ABSTAIN;
  return Verdict.FAITHFUL;
}

/**
 * Claim evaluator: is a factual/relational claim in the generated content
 * true against this repository's own structural evidence? For a generated
 * course draft (`generated.course`), every claim family
 * `verifyCourseFaithfulness` already checks is preserved in full in
 * `detail`; `status` is a single top-level convenience verdict for queueing
 * purposes only, never the only thing reported.
 */
export function evaluateClaimFidelity(generated, repository) {
  if (generated?.course) {
    const detail = verifyCourseFaithfulness({
      course: generated.course,
      repository,
      quizzes: generated.quizzes ?? [],
      hints: generated.hints ?? [],
      answers: generated.answers ?? [],
      lineCounts: generated.lineCounts ?? {},
    });
    return { version: CLAIM_EVALUATOR_VERSION, evaluator: "claim", status: overallCourseStatus(detail), detail };
  }
  const detail = verifyAnswerFaithfulness(extractCallClaims(generatedText(generated)), repository);
  return { version: CLAIM_EVALUATOR_VERSION, evaluator: "claim", status: detail.status, detail };
}

/**
 * Policy evaluator: does the generated content itself carry a
 * prompt-injection pattern? Any high-severity finding fails the evaluator
 * outright (the generator produced hostile-looking output, regardless of
 * whether it can be proven to have come from an untrusted source); a
 * medium/low finding alone abstains rather than failing, since those
 * patterns (a code fence, a credential-sounding phrase) are common in
 * ordinary technical writing. When `context.sourceFindings` names the
 * injection findings already detected in the untrusted repository content
 * the generator read, a matching high-severity finding in the output is
 * additionally reported as `echoed` — confirmed, not merely found.
 */
export function evaluatePolicyCompliance(generated, context = {}) {
  const findings = detectInjection(generatedText(generated));
  const highSeverity = findings.filter((finding) => finding.severity === "high");
  const sourceFindings = context.sourceFindings ?? [];
  const echoed = highSeverity.filter((finding) => sourceFindings.some((source) => source.id === finding.id));
  return {
    version: POLICY_EVALUATOR_VERSION,
    evaluator: "policy",
    status: highSeverity.length ? Verdict.UNFAITHFUL : findings.length ? Verdict.ABSTAIN : Verdict.FAITHFUL,
    findings: findings.map((finding) => finding.id),
    echoed: echoed.map((finding) => finding.id),
  };
}

/**
 * Leakage evaluator: does the generated content reproduce a forbidden
 * answer-key field, or a real blinded hidden-solution value, despite the
 * generator never having been handed it directly (`blindGenerationRequest`,
 * above)? Reuses `answer-guard.mjs`'s own `findForbiddenKeys`/
 * `findLeakedValues` unmodified.
 */
export function evaluateLeakageResistance(generated, hiddenSolutionValues = []) {
  const forbiddenKeys = findForbiddenKeys(generated ?? null, ALWAYS_FORBIDDEN);
  const leaked = findLeakedValues(
    { text: generatedText(generated), raw: generated ?? null },
    hiddenSolutionValues.filter((value) => String(value).length >= MIN_SCANNED_SECRET),
  );
  return {
    version: LEAKAGE_EVALUATOR_VERSION,
    evaluator: "leakage",
    status: forbiddenKeys.length === 0 && leaked.length === 0 ? Verdict.FAITHFUL : Verdict.UNFAITHFUL,
    forbiddenKeys,
    leaked: leaked.map((value) => `${value.slice(0, 12)}\u2026`),
  };
}

/**
 * Rubric evaluator: does this app's own automated score for the generated
 * content agree with instructor-reviewed scores for the same cases? Reuses
 * `process-trace-assessment.mjs`'s own `validateRubricAgreement` unmodified,
 * including its honest `insufficient-evidence` floor.
 */
export function evaluateRubricAlignment(pairs) {
  const validation = validateRubricAgreement(pairs);
  return {
    version: RUBRIC_EVALUATOR_VERSION,
    evaluator: "rubric",
    status: validation.verdict === "insufficient-evidence"
      ? Verdict.ABSTAIN
      : validation.verdict === "rubric-agrees"
        ? Verdict.FAITHFUL
        : Verdict.UNFAITHFUL,
    validation,
  };
}

/**
 * Run all four evaluators over one piece of generated tutor content.
 * `rubric` is honestly `null`, not a manufactured pass, when the caller
 * supplies no instructor-reviewed pairs to check against — there is nothing
 * to evaluate the rubric evaluator against yet, which is different from the
 * rubric evaluator having run and abstained.
 */
export function runGenerationVerification({ generated, repository, hiddenSolutionValues = [], sourceFindings = [], rubricPairs = [] } = {}) {
  return {
    version: TUTOR_GENERATION_VERIFICATION_VERSION,
    evaluatorVersions: EVALUATOR_VERSIONS,
    separate: true,
    claim: evaluateClaimFidelity(generated, repository),
    policy: evaluatePolicyCompliance(generated, { sourceFindings }),
    leakage: evaluateLeakageResistance(generated, hiddenSolutionValues),
    rubric: rubricPairs.length ? evaluateRubricAlignment(rubricPairs) : null,
  };
}

function describeEvaluatorConcern(evaluatorResult) {
  if (evaluatorResult.evaluator === "claim") {
    return evaluatorResult.status === Verdict.UNFAITHFUL
      ? "The claim evaluator found a fabricated or stale claim in the generated content."
      : "The claim evaluator could not check at least one claim in the generated content.";
  }
  if (evaluatorResult.evaluator === "policy") {
    return evaluatorResult.echoed.length
      ? `The generated content echoes a high-severity injection pattern (${evaluatorResult.echoed.join(", ")}) found in untrusted source material.`
      : `The generated content trips an injection pattern (${evaluatorResult.findings.join(", ")}).`;
  }
  if (evaluatorResult.evaluator === "leakage") {
    return "The generated content leaked a forbidden key or a blinded hidden-solution value.";
  }
  return evaluatorResult.validation.verdict === "insufficient-evidence"
    ? "Not enough instructor-reviewed cases yet to validate the rubric evaluator."
    : "The rubric evaluator disagrees with instructor-reviewed scores.";
}

/**
 * Turn every non-faithful evaluator verdict in a report into a review item
 * in exactly the shape `curriculum-review.mjs`'s own `blindReviewItem`/
 * `recordAdjudication` already understand — this module does not reinvent
 * the adjudication queue, it feeds one, tagged with a
 * `generation-verification-<evaluator>` kind so
 * `measureEvaluatorDisagreement` (below) can scope an override rate to one
 * evaluator family at a time. A faithful verdict never becomes a review
 * item — there is no concern to adjudicate.
 */
export function generationVerificationReviewItems(report, label) {
  const items = [];
  for (const evaluatorResult of [report.claim, report.policy, report.leakage, report.rubric]) {
    if (!evaluatorResult || evaluatorResult.status === Verdict.FAITHFUL) continue;
    items.push({
      kind: `generation-verification-${evaluatorResult.evaluator}`,
      id: `generation-verification:${evaluatorResult.evaluator}:${label}`,
      label,
      reason: describeEvaluatorConcern(evaluatorResult),
      evidence: evaluatorResult,
      automatedVerdict: evaluatorResult.status,
    });
  }
  return items;
}

/**
 * How often an instructor overrode one evaluator family's flag, scoped to
 * that evaluator alone — a thin, evaluator-named wrapper over
 * `curriculum-review.mjs`'s own `measureOverrideRate` (unmodified), which
 * already honestly reports `insufficient-evidence` below the same
 * minimum-sample floor every other rate in this app respects.
 */
export function measureEvaluatorDisagreement(events, evaluatorName) {
  return measureOverrideRate(events, `generation-verification-${evaluatorName}`);
}
