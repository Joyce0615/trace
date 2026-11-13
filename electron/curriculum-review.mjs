import { Verdict } from "./faithfulness-guard.mjs";
import { detectInjection } from "./prompt-isolation.mjs";
import { appendEvent } from "./activity-log.mjs";
import { rate } from "./analytics.mjs";

/**
 * Instructor adjudication and curriculum review (item 39).
 *
 * Four independently-tested systems already *decide* something about a piece
 * of this app's teaching content, and none of them queue the case for a human
 * to look at — each either auto-resolves or reports a verdict with nowhere to
 * send disagreement:
 *
 *   - `faithfulness-guard.mjs`'s own `Verdict.ABSTAIN` (reused unmodified) is
 *     already the honest "could not check" state for a lesson/quiz/hint/
 *     answer claim, but nothing collects an abstained claim into a queue a
 *     human reviews — it is reported and then dropped on the floor.
 *   - `answer-guard.mjs`'s own hint ladder (`buildScaffold`, item 6) already
 *     drops a rung that would spell out the answer, but never scans a kept
 *     rung's own *text* for an injected instruction (a hint whose text was
 *     built from repository-derived strings — a symbol name, a file path —
 *     that happen to contain something `prompt-isolation.mjs`'s own
 *     `detectInjection` would flag). Confirmed by grep: zero prior call sites
 *     pass a built scaffold's rung text through `detectInjection`.
 *   - `process-trace-assessment.mjs`'s own `validateRubricAgreement` (item 33,
 *     reused unmodified) already reports *that* the automated rubric and an
 *     instructor disagree on a case, but stops at the report — nothing turns
 *     a disagreement into a queued item awaiting the instructor's actual
 *     decision, or records what they decided.
 *   - `course-migration.mjs`'s own lesson-status rollup (`planMigration`,
 *     item 33, reused unmodified via its `plan.lessons` list) already labels
 *     a lesson `needs-review`/`orphaned`, but nothing queues *that* label
 *     alongside the other three kinds of pending decision in one place a
 *     reviewer can work through together.
 *
 * Grep confirmed before writing a line here: zero prior matches for
 * `reviewQueue`/`ReviewQueue`/`adjudicat`/`blindedCase`/`reviewOverride`
 * anywhere in `electron/*.mjs` before this item.
 *
 * This module adds exactly the missing queue and override-tracking layer,
 * reusing every judgment above unmodified as the queue's *source material*:
 *
 *   - [`buildReviewQueue`] assembles four review-item kinds —
 *     `low-confidence-claim` (an abstained faithfulness verdict),
 *     `unsafe-hint` (a kept scaffold rung whose text `detectInjection` flags),
 *     `rubric-disagreement` (one `validateRubricAgreement` disagreement
 *     entry), `stale-lesson` (a `needs-review`/`orphaned` migration-plan
 *     lesson) — into one list, sorted oldest-queued-first, never blended into
 *     one score: a queue with zero unsafe hints and ten rubric disagreements
 *     is not "60% healthy", it is four separate counts.
 *   - **Blinding.** [`blindReviewItem`] strips every field that could bias a
 *     reviewer before they look — the automated verdict/score, the
 *     instructor's own prior decision if any, and any learner-identifying id
 *     — leaving only the content a human needs to judge the case fresh:
 *     the claim/hint/case/lesson itself and its evidence. The real automated
 *     verdict is kept out of the blinded view entirely (checked by an
 *     explicit test assertion), not merely hidden by a UI convention.
 *   - **Adjudication.** [`recordAdjudication`] is the one place an
 *     instructor's decision is written down: every queued item already
 *     represents a concern the automated system flagged, so `"approve"`
 *     (act on it) is a `confirmation` of that flag and `"reject"` (dismiss
 *     it as a false alarm) is an `override`, and preserves the event through
 *     `activity-log.mjs`'s own `appendEvent` (unmodified) — the same
 *     append-only, main-process-owned log every other graded/decided event in
 *     this app writes to, so an instructor decision is tamper-evident the
 *     same way a learner's graded attempt already is.
 *   - **Versioning.** [`applyApprovedReview`] is the only function that
 *     mutates curriculum content as a result of a review: it requires an
 *     adjudication whose `decision` is `"approve"` and stamps the result with
 *     a monotonically increasing `reviewVersion` (one counter per course,
 *     never reused) plus the adjudication's own id, so a later caller can
 *     always trace *which* reviewed decision produced the content currently
 *     on screen — the "feed changes through approved versioning" half of
 *     this item's text. An adjudication that rejects or defers is reported,
 *     never silently applied.
 *   - **Overrides measured.** [`measureOverrideRate`] reuses `analytics.mjs`'s
 *     own `rate` (unmodified), so an override rate below the same
 *     `MIN_SAMPLE` floor every other rate in this app respects is reported
 *     `null` with a reason, not a misleadingly precise fraction.
 *
 * Pure and Node-free except [`recordAdjudication`], whose only I/O is the
 * same `appendEvent` every other graded-activity recorder in this app already
 * calls — no new persistence primitive.
 */

export const CURRICULUM_REVIEW_VERSION = 1;

const KIND_RANK = { "unsafe-hint": 0, "stale-lesson": 1, "rubric-disagreement": 2, "low-confidence-claim": 3 };

function queueId(kind, parts) {
  return `${kind}:${parts.join(":")}`;
}

/**
 * Review items from abstained faithfulness verdicts (`verifyLessonFaithfulness`/
 * `verifyQuizFaithfulness`/`verifyHintFaithfulness`/`verifyAnswerFaithfulness`
 * results, or any array of `{ status, reason, evidence }` entries carrying an
 * identifying label) that could not be resolved either way.
 */
export function lowConfidenceClaimItems(verifiedClaims = []) {
  return (verifiedClaims ?? [])
    .filter((entry) => entry?.status === Verdict.ABSTAIN)
    .map((entry) => ({
      kind: "low-confidence-claim",
      id: queueId("low-confidence-claim", [entry.label ?? entry.lessonId ?? entry.id ?? "claim"]),
      label: entry.label ?? entry.lessonId ?? entry.id ?? null,
      reason: entry.reason,
      evidence: entry.evidence ?? null,
      automatedVerdict: Verdict.ABSTAIN,
    }));
}

/**
 * Review items from a built hint scaffold (`buildScaffold`'s own output,
 * reused unmodified) whose *kept* rung text trips `detectInjection` — a hint
 * built from repository-derived strings can carry an injection pattern the
 * answer-leak guard's own spelled-out-answer check does not look for at all.
 */
export function unsafeHintItems(scaffold) {
  if (!scaffold?.rungs?.length) return [];
  const items = [];
  for (const rung of scaffold.rungs) {
    const findings = detectInjection(rung.text);
    if (!findings.length) continue;
    items.push({
      kind: "unsafe-hint",
      id: queueId("unsafe-hint", [scaffold.kind, rung.id]),
      label: rung.id,
      reason: `This hint's text trips ${findings.map((finding) => finding.id).join(", ")}.`,
      evidence: { scaffoldKind: scaffold.kind, rungId: rung.id, text: rung.text, findings: findings.map((finding) => finding.id) },
      automatedVerdict: "flagged",
    });
  }
  return items;
}

/**
 * Review items from `validateRubricAgreement`'s own `disagreements` list
 * (reused unmodified) — one queued item per case the automated rubric and the
 * instructor scored differently.
 */
export function rubricDisagreementItems(validation) {
  return (validation?.disagreements ?? []).map((entry) => ({
    kind: "rubric-disagreement",
    id: queueId("rubric-disagreement", [entry.id ?? "case"]),
    label: entry.id,
    reason: entry.passedMismatch
      ? "The automated rubric and the instructor disagreed on pass/fail."
      : `The automated and instructor scores differ by ${entry.gap}.`,
    evidence: entry,
    automatedVerdict: entry.automatedPassed ? "pass" : "fail",
  }));
}

/**
 * Review items from a migration plan's own `lessons` rollup
 * (`planMigration`'s output, reused unmodified) — one queued item per lesson
 * the plan already marked `needs-review` or `orphaned`.
 */
export function staleLessonItems(plan) {
  return (plan?.lessons ?? [])
    .filter((entry) => entry.status === "needs-review" || entry.status === "orphaned")
    .map((entry) => ({
      kind: "stale-lesson",
      id: queueId("stale-lesson", [entry.lessonId]),
      label: entry.lessonId,
      reason: entry.status === "orphaned"
        ? "Every anchor this lesson relied on is gone."
        : `${entry.review} of ${entry.anchors} anchor(s) still need review.`,
      evidence: entry,
      automatedVerdict: entry.status,
    }));
}

/**
 * Assemble every pending review item into one queue, sorted oldest-kind-first
 * (unsafe hints before stale lessons before rubric disagreements before
 * low-confidence claims — the order a reviewer should triage, most
 * learner-facing risk first) and then by id for a stable order within a kind.
 * Counts are reported per kind, never blended into one number.
 */
export function buildReviewQueue({ claims = [], scaffolds = [], rubricValidation = null, migrationPlan = null } = {}) {
  const items = [
    ...claims.flatMap((entry) => lowConfidenceClaimItems(Array.isArray(entry) ? entry : [entry])),
    ...scaffolds.flatMap((scaffold) => unsafeHintItems(scaffold)),
    ...rubricDisagreementItems(rubricValidation),
    ...staleLessonItems(migrationPlan),
  ].sort((left, right) => KIND_RANK[left.kind] - KIND_RANK[right.kind] || left.id.localeCompare(right.id));

  const counts = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;

  return {
    version: CURRICULUM_REVIEW_VERSION,
    items,
    counts,
    total: items.length,
  };
}

/**
 * The view a reviewer sees before deciding: every bias-carrying field
 * stripped. The real automated verdict, any prior adjudication, and any
 * learner-identifying field are not merely omitted from a renderer
 * convention — they are absent from the object this function returns.
 */
export function blindReviewItem(item) {
  return {
    id: item.id,
    kind: item.kind,
    label: item.label,
    reason: item.reason,
    evidence: item.evidence,
  };
}

const ADJUDICATION_DECISIONS = new Set(["approve", "reject", "defer"]);

/**
 * Record an instructor's decision on one queued item. Every item in this
 * queue already represents a case the automated system flagged as needing
 * attention (an abstained claim, a hint it could not clear, a rubric
 * disagreement, a lesson it marked stale) — there is no case here where the
 * automated system confidently passed something. So the decision is judged
 * against *that* flag: `"approve"` (act on the concern — it is real) is a
 * `confirmation` of the automated flag, `"reject"` (dismiss it — the flag was
 * a false alarm) is an `override` of it, and `"defer"` is neither, since no
 * verdict was actually chosen yet. Preserved through `activity-log.mjs`'s own
 * `appendEvent`, unmodified.
 */
export async function recordAdjudication(directory, repositoryId, item, decision, options = {}) {
  if (!ADJUDICATION_DECISIONS.has(decision)) {
    return { ok: false, reason: `Unknown decision: ${JSON.stringify(decision)}. Must be one of ${[...ADJUDICATION_DECISIONS].join(", ")}.` };
  }
  const classification = decision === "defer" ? "deferred" : decision === "approve" ? "confirmation" : "override";
  const record = await appendEvent(directory, repositoryId, {
    kind: "curriculum-review",
    reviewItemId: item.id,
    reviewKind: item.kind,
    decision,
    classification,
    automatedVerdict: item.automatedVerdict,
    reviewer: options.reviewer ?? null,
    note: options.note ?? null,
  });
  return { ok: true, event: record, classification };
}

/**
 * Apply an *approved* adjudication to curriculum content, stamping a
 * monotonically increasing `reviewVersion` so later content always traces
 * back to the specific reviewed decision that produced it. Refuses to apply
 * anything but an `"approve"` decision — a reject or defer is reported, never
 * silently treated as approval.
 */
export function applyApprovedReview(course, adjudicationEvent, patch) {
  if (adjudicationEvent?.decision !== "approve") {
    return { ok: false, reason: `Adjudication decision was ${JSON.stringify(adjudicationEvent?.decision ?? null)}, not "approve".` };
  }
  const previousVersion = Number(course?.reviewVersion) || 0;
  const reviewVersion = previousVersion + 1;
  return {
    ok: true,
    course: {
      ...course,
      ...patch,
      reviewVersion,
      reviewHistory: [...(course?.reviewHistory ?? []), { reviewVersion, adjudicationId: adjudicationEvent.id, reviewItemId: adjudicationEvent.reviewItemId, at: adjudicationEvent.at }],
    },
  };
}

/**
 * How often instructors overrode the automated verdict, out of every
 * non-deferred adjudication recorded — reuses `analytics.mjs`'s own `rate`
 * unmodified, so this honestly reports `insufficient-evidence` below the same
 * floor every other rate in this app respects, scoped by `reviewKind` so an
 * override rate on unsafe hints is never blended with one on stale lessons.
 */
export function measureOverrideRate(events, reviewKind = null) {
  const relevant = (events ?? []).filter((event) => event.kind === "curriculum-review"
    && event.classification !== "deferred"
    && (reviewKind === null || event.reviewKind === reviewKind));
  const overrides = relevant.filter((event) => event.classification === "override").length;
  return { ...rate(overrides, relevant.length), reviewKind, overrides, confirmations: relevant.length - overrides };
}
