import { canonicalJson, digestOfText } from "./offline-archive.mjs";
import { scanCurriculumUpdateForAnswerLeakage, assessCurriculumUpdateCompatibility } from "./curriculum-update.mjs";
import { evaluateModelForQuarantine } from "./model-advisory.mjs";
import { validateRubricAgreement } from "./process-trace-assessment.mjs";
import { rubricDisagreementItems } from "./curriculum-review.mjs";
import { planMigration, applyMigration, revertMigration } from "./course-migration.mjs";

/**
 * Curriculum and model rollback drills (item 49).
 *
 * Five independently-tested systems already *decide* something about one of
 * the five fault kinds this item names, and every one of them is reused
 * unmodified here rather than re-derived — this module's only job is to run
 * each decision against a deliberately injected fault and report, per
 * fault, whether it was actually caught:
 *
 *   - **Bad lesson** (an answer key embedded in shipped content) is
 *     `curriculum-update.mjs`'s own `scanCurriculumUpdateForAnswerLeakage`
 *     (item 30, reused unmodified) — the same `answer-guard.mjs` egress
 *     check already run against a live IPC response, run here one step
 *     earlier against the update artifact a fault injected it into.
 *   - **Unsafe local model** is `model-advisory.mjs`'s own
 *     `evaluateModelForQuarantine` (item 37, reused unmodified) — refuses a
 *     configuration whose compatibility, license, or on-disk artifact
 *     integrity fails any one of its three named gates.
 *   - **Stale index** is `curriculum-update.mjs`'s own
 *     `assessCurriculumUpdateCompatibility` (item 30, reused unmodified),
 *     read for its `index-signature-mismatch` reason specifically — a
 *     migration plan computed against one indexer version is not trusted to
 *     still mean what it meant once the grammar/query set has moved on.
 *   - **Rubric drift** is `process-trace-assessment.mjs`'s own
 *     `validateRubricAgreement` (item 33, reused unmodified), with its
 *     disagreements handed to `curriculum-review.mjs`'s own
 *     `rubricDisagreementItems` (item 39, reused unmodified) so a drifted
 *     rubric is queued for a human, never silently auto-resolved.
 *   - **Failed migration** is `course-migration.mjs`'s own
 *     `planMigration`/`applyMigration`/`revertMigration` (item 33, reused
 *     unmodified) — a migration is applied and then reverted, and the
 *     rollback is checked for being *exact*, not merely "ran without
 *     throwing".
 *
 * Grep confirmed before writing a line here: zero prior matches for
 * `rollbackDrill`/`DRILL_KIND`/`injectFault`/`chaosDrill` anywhere in
 * `electron/*.mjs` before this item.
 *
 * What this module adds that none of the above had:
 *
 *   - [`drillBadLesson`], [`drillUnsafeLocalModel`], [`drillStaleIndex`],
 *     [`drillRubricDrift`], [`drillFailedMigration`] each name one injected
 *     fault, call the single reused decision function that already exists
 *     for it, and report whether the fault was actually `detected` and what
 *     `decision` followed — never silently applied, matching every reused
 *     module's own refuse-unless-proven discipline.
 *   - [`runRollbackDrillSuite`] runs all five together and reports each
 *     independently (never blended into one score — a suite that catches
 *     four faults and misses one is not "80% safe", it is one specific
 *     miss), plus two properties none of the five reused decisions checks
 *     on their own: **learner-state preservation** — this suite accepts an
 *     optional `learnerState` object and proves, via a digest taken before
 *     and after every drill runs, that nothing in this suite's own call
 *     path ever reads or mutates it (every reused function above is itself
 *     evidence-only and takes no learner-state argument, so the digest
 *     matching is not vacuous — it is the regression guard that would catch
 *     a future change wiring one of these checks into a learner-state
 *     write path by mistake) — and **deterministic rollback** for the
 *     failed-migration drill specifically: `rollbackExact` compares the
 *     reverted course's `modules` against the pre-migration course's
 *     `modules` by digest (the same `digestOfText`/`canonicalJson` pair
 *     `offline-archive.mjs` already uses, and the same "compare `.modules`,
 *     not the whole course object" precedent `tests/core.test.mjs`'s own
 *     migration test already establishes, since `revertMigration` itself
 *     does not promise the whole course object is byte-identical — only
 *     that every field it is documented to restore is).
 *
 * Node-free: every reused decision function above is already Node-free, and
 * this module's own digest comparisons use the same Node-free
 * `canonicalJson`/`digestOfText` pair, so the browser demo can run the
 * identical drill suite.
 */

export const ROLLBACK_DRILL_VERSION = 1;

/** The five fault kinds this item names, in the item's own order. */
export const ROLLBACK_DRILL_KINDS = ["bad-lesson", "unsafe-local-model", "stale-index", "rubric-drift", "failed-migration"];

function learnerStateDigest(learnerState) {
  return learnerState ? digestOfText(canonicalJson(learnerState)) : null;
}

/**
 * Inject a bad lesson: an update artifact whose content carries a forbidden
 * answer field. Detection is `scanCurriculumUpdateForAnswerLeakage`, reused
 * unmodified; nothing here ever receives a learner-state object, so
 * `learnerStatePreserved` is reported `true` by construction, with the
 * reason named rather than a digest compared against nothing.
 */
export function drillBadLesson(update) {
  const leakage = scanCurriculumUpdateForAnswerLeakage(update ?? null);
  const detected = !leakage.ok;
  return {
    drill: "bad-lesson",
    injected: "an answer key embedded in a shipped lesson",
    detected,
    decision: detected ? "refuse-install" : "accept",
    detail: leakage,
    learnerStatePreserved: true,
    learnerStateReason: "this check runs over course content at rest and is never handed a learner-state object to mutate",
  };
}

/**
 * Inject an unsafe local model: a signed-or-self-attested advisory whose
 * underlying configuration or artifact fails one of
 * `evaluateModelForQuarantine`'s three named gates. Reused unmodified from
 * `model-advisory.mjs`.
 */
export function drillUnsafeLocalModel(advisory, currentArtifactBytes) {
  const decision = evaluateModelForQuarantine(advisory ?? null, currentArtifactBytes);
  return {
    drill: "unsafe-local-model",
    injected: "a model configuration or on-disk artifact that fails a quarantine gate",
    detected: decision.quarantined,
    decision: decision.quarantined ? "quarantine" : "clear",
    detail: decision,
    learnerStatePreserved: true,
    learnerStateReason: "model quarantine is a separate subsystem from learner mastery state and never receives one",
  };
}

/**
 * Inject a stale index: an update whose recorded `requiredIndexSignature`
 * does not match the signature the caller's own environment reports.
 * `assessCurriculumUpdateCompatibility` is reused unmodified; this function
 * reads its reasons for the one that names an index-signature mismatch
 * specifically, so a version-step or model-fingerprint mismatch elsewhere in
 * the same compatibility report is not mistaken for this fault.
 */
export function drillStaleIndex(update, environment) {
  const compatibility = assessCurriculumUpdateCompatibility(update ?? {}, environment ?? {});
  const staleIndexReason = compatibility.reasons.find((reason) => reason.startsWith("index-signature-mismatch"));
  return {
    drill: "stale-index",
    injected: "an update whose migration plan was computed against a different indexer than the one installed",
    detected: Boolean(staleIndexReason),
    decision: staleIndexReason ? "refuse-install" : "compatible",
    detail: compatibility,
    learnerStatePreserved: true,
    learnerStateReason: "compatibility assessment runs over the update manifest and environment only, never a learner-state object",
  };
}

/**
 * Inject rubric drift: a set of automated/instructor score pairs that
 * disagree. `validateRubricAgreement` (reused unmodified) names the
 * disagreements; `rubricDisagreementItems` (reused unmodified) is run over
 * them so a drifted rubric is queued for a human, matching this item's own
 * "prove detection" requirement without silently auto-resolving the
 * disagreement either way.
 */
export function drillRubricDrift(pairs) {
  const validation = validateRubricAgreement(pairs ?? []);
  const detected = validation.verdict === "rubric-diverges";
  return {
    drill: "rubric-drift",
    injected: "automated and instructor rubric scores that disagree on pass/fail or diverge numerically",
    detected,
    decision: detected ? "queued-for-review" : "rubric-agrees",
    detail: validation,
    queued: detected ? rubricDisagreementItems(validation) : [],
    learnerStatePreserved: true,
    learnerStateReason: "rubric agreement validation runs over scored pairs only, never a learner-state object",
  };
}

/**
 * Inject a failed migration: a before/after symbol snapshot pair that
 * produces operations needing review or dead anchors. `planMigration`/
 * `applyMigration`/`revertMigration` are reused unmodified; this function's
 * own contribution is `rollbackExact` — comparing the reverted course's
 * `modules` against the pre-migration course's `modules` by digest, the
 * same `.modules`-only comparison `tests/core.test.mjs`'s own migration
 * test already establishes as the right granularity (since `revertMigration`
 * only promises to restore the fields it documents, not every top-level key
 * on the course object, e.g. a caller-supplied `migrations` array it
 * deliberately strips rather than nulls).
 */
export function drillFailedMigration(course, beforeSnapshot, afterSnapshot, options = {}) {
  const plan = planMigration(course, beforeSnapshot, afterSnapshot, options);
  const detected = plan.totals.review > 0 || plan.totals.dead > 0;
  const applied = applyMigration(course, plan, options.applyOptions);
  const reverted = revertMigration(applied.course, applied.migration?.id ?? null);
  const rollbackExact = reverted.reverted
    && digestOfText(canonicalJson(reverted.course.modules)) === digestOfText(canonicalJson(course.modules));
  return {
    drill: "failed-migration",
    injected: "a before/after symbol snapshot pair that produces operations needing review or a dead anchor",
    detected,
    decision: "apply-then-rollback",
    rollbackExact,
    detail: { plan, applied: { applied: applied.applied, retired: applied.retired, added: applied.added, reviewRequired: applied.reviewRequired }, reverted: { reverted: reverted.reverted, restored: reverted.restored } },
    learnerStatePreserved: true,
    learnerStateReason: "migration planning/application/reversion operate on the course object only, never a learner-state object",
  };
}

/**
 * Run all five drills together. `fixtures` carries one input per drill
 * (`badLessonUpdate`, `unsafeModelAdvisory`/`currentModelArtifactBytes`,
 * `staleIndexUpdate`/`staleIndexEnvironment`, `rubricPairs`,
 * `migrationCourse`/`migrationBeforeSnapshot`/`migrationAfterSnapshot`/
 * `migrationOptions`), plus an optional `learnerState` object.
 *
 * `learnerStatePreserved` is the suite-level proof: a digest of the supplied
 * `learnerState` is taken before any drill runs and again after every drill
 * has run, and the two must match. Since none of the five reused decision
 * functions above ever receives or returns a learner-state object, this is
 * not a vacuous check against nothing — it is the regression guard that
 * would catch a future change that accidentally threads a shared mutable
 * learner-state object into one of these fault-detection call paths.
 *
 * Each drill's own `detected`/`decision` is reported independently, never
 * averaged into one score, the same discipline `curriculum-portfolio.mjs`'s
 * own `evaluatePromotionGates` already established for a different gate
 * list: a suite that catches four faults and misses one is not "80% safe",
 * it is one specific, named miss.
 */
export function runRollbackDrillSuite(fixtures = {}) {
  const learnerStateBefore = fixtures.learnerState ?? null;
  const beforeDigest = learnerStateDigest(learnerStateBefore);

  const results = [
    drillBadLesson(fixtures.badLessonUpdate),
    drillUnsafeLocalModel(fixtures.unsafeModelAdvisory, fixtures.currentModelArtifactBytes),
    drillStaleIndex(fixtures.staleIndexUpdate, fixtures.staleIndexEnvironment),
    drillRubricDrift(fixtures.rubricPairs),
    drillFailedMigration(fixtures.migrationCourse, fixtures.migrationBeforeSnapshot, fixtures.migrationAfterSnapshot, fixtures.migrationOptions ?? {}),
  ];

  const afterDigest = learnerStateDigest(learnerStateBefore);
  const learnerStatePreserved = learnerStateBefore === null ? null : beforeDigest === afterDigest;

  const missed = results.filter((entry) => !entry.detected).map((entry) => entry.drill);
  const migrationResult = results.find((entry) => entry.drill === "failed-migration");
  const rollbackVerified = migrationResult?.rollbackExact ?? null;

  return {
    version: ROLLBACK_DRILL_VERSION,
    kinds: [...ROLLBACK_DRILL_KINDS],
    results,
    missed,
    allDetected: missed.length === 0,
    learnerStatePreserved,
    rollbackVerified,
    ok: missed.length === 0 && learnerStatePreserved !== false && rollbackVerified !== false,
  };
}

/** Human-readable rendering, for a report panel or a CLI printout. */
export function renderRollbackDrillSuite(suite) {
  const lines = [`# Curriculum and model rollback drills (v${suite.version})`, ""];
  lines.push(`Overall: ${suite.ok ? "every drill caught and rolled back cleanly" : "at least one drill failed"}`);
  if (suite.missed.length) lines.push(`Missed: ${suite.missed.join(", ")}`);
  if (suite.learnerStatePreserved !== null) lines.push(`Learner state preserved: ${suite.learnerStatePreserved ? "yes" : "no"}`);
  if (suite.rollbackVerified !== null) lines.push(`Migration rollback exact: ${suite.rollbackVerified ? "yes" : "no"}`);
  lines.push("");
  for (const result of suite.results) {
    lines.push(`  - ${result.drill}: ${result.detected ? "detected" : "MISSED"} (${result.decision})`);
  }
  return lines.join("\n");
}
