import { consentState } from "./project-continuity.mjs";
import { validateRubricAgreement } from "./process-trace-assessment.mjs";
import { measureOverrideRate } from "./curriculum-review.mjs";
import { openPrivacyBudget, spendEpsilon } from "./private-cohort-analytics.mjs";
import { runAllAccessibilityPaths } from "./accessibility-learning-experiments.mjs";
import { evaluatePromotionGates, decideCurriculumPromotion } from "./curriculum-portfolio.mjs";
import { evaluateModelForQuarantine } from "./model-advisory.mjs";
import { canonicalJson, digestOfText } from "./offline-archive.mjs";
import { signPayload, verifyPayload, SIGNABLE_SUBJECTS } from "./signing.mjs";
import { appendEvent, readEvents } from "./activity-log.mjs";

/**
 * Publish longitudinal learning-governance records (item 50, this cycle,
 * the last of the ten).
 *
 * Every piece of evidence this item names already exists somewhere in this
 * app, already tested on its own, and the ten items this ten-day cycle just
 * finished (41-49) plus the governance machinery from earlier cycles each
 * produce one slice of it — but nothing ever assembled them into one
 * append-only, tamper-evident *record series* a human or an auditor could
 * read end to end. Confirmed by grep before writing a line here: zero prior
 * matches for `governanceRecord`/`governanceLedger`/`hashChain`/
 * `publishGovernanceRecord` as implementation identifiers anywhere in
 * `electron/*.mjs`.
 *
 * What this item names, and where each piece already lives, reused
 * unmodified:
 *
 *   - **Consent** — `project-continuity.mjs`'s own `consentState`.
 *   - **Curriculum/model versions** — `curriculum-update.mjs`'s own
 *     `CURRICULUM_UPDATE_VERSION`/release metadata and `model-advisory.mjs`'s
 *     own advisory records, read as plain fields on the caller-supplied
 *     snapshot rather than re-derived.
 *   - **Evaluator calibration** — `process-trace-assessment.mjs`'s own
 *     `validateRubricAgreement` (item 33).
 *   - **Interventions** — `cognitive-load-regulation.mjs`'s own
 *     `regulateCognitiveLoad` reports (item 44, this cycle); a caller passes
 *     the real report, this module never re-estimates load.
 *   - **Adjudications** — `curriculum-review.mjs`'s own `measureOverrideRate`
 *     (item 39).
 *   - **Privacy budgets** — `private-cohort-analytics.mjs`'s own
 *     `openPrivacyBudget`/`spendEpsilon` (item 28).
 *   - **Efficacy** — `curriculum-portfolio.mjs`'s own `evaluatePromotionGates`/
 *     `decideCurriculumPromotion` (item 40), which already folds retention/
 *     transfer/calibration into the `effectiveness`/`calibration` gates.
 *   - **Safety** — `model-advisory.mjs`'s own `evaluateModelForQuarantine`
 *     (item 37) and `curriculum-portfolio.mjs`'s own `answer-leakage` gate,
 *     both already part of the portfolio gate list reused above.
 *   - **Accessibility** — `accessibility-learning-experiments.mjs`'s own
 *     `runAllAccessibilityPaths` (item 36), and the portfolio's own
 *     `accessibility` gate.
 *   - **Deprecation decisions** — the one genuinely new concept: no prior
 *     module in this app ever decided to retire a curriculum or model
 *     version. [`decideDeprecation`] below is that decision, built the same
 *     way `decideCurriculumPromotion` already decides the opposite
 *     direction — refuse silently-losing evidence, name every reason.
 *
 * Design that follows from reusing rather than reinventing:
 *
 *   - [`buildGovernanceRecordContent`] assembles all ten named facets into
 *     one content object, each reported under its own named key — never
 *     blended into a single score, the same discipline every gate list in
 *     this app (`curriculum-portfolio.mjs`'s six gates, `tutor-safety-
 *     benchmark.mjs`'s four axes) already established. No wall-clock field
 *     lives inside the digested content, mirroring `buildProvenance`'s own
 *     already-established discipline, so identical inputs always produce
 *     an identical digest.
 *   - **Hash-chained, append-only series.** Every prior item in this app
 *     that persists evidence (`activity-log.mjs`, `telemetry.mjs`) appends
 *     to a *list*; none of them link one entry to the previous one by
 *     digest, so a deleted or reordered middle entry would be invisible to
 *     a reader who only sees the file as it stands now. [`appendGovernanceRecord`]
 *     is the one new mechanism: each record's content carries
 *     `previousDigest` — the digest of the immediately prior record in the
 *     same repository's series, or `null` for the first — so
 *     [`verifyGovernanceChain`] can walk the whole series and name the
 *     exact index where a link breaks, rather than report a single
 *     pass/fail for the series as a whole.
 *   - **Signed, like every other artifact this app seals.** A new signing
 *     subject, `"learning-governance-record"`, is added to `signing.mjs`'s
 *     `SIGNABLE_SUBJECTS` and documented in `docs/extending.md`'s
 *     signing-subjects contract, following the exact pattern
 *     `model-advisory.mjs` (item 37) and `curriculum-portfolio.mjs`
 *     (item 40) already established for adding a signing subject, so
 *     `scripts/docs-check.mjs` keeps the two from drifting apart.
 *   - **Deprecation is a decision with named reasons, not a flag.**
 *     [`decideDeprecation`] only recommends retiring a curriculum or model
 *     version when the portfolio's own `decideCurriculumPromotion` verdict
 *     is *not* `promote` for a version that has already shipped (an
 *     unpromoted version that never shipped is not "deprecated", it was
 *     simply never promoted — a different, already-existing concept this
 *     function does not relabel), or when `evaluateModelForQuarantine`
 *     reports `quarantined: true` for the model version in question.
 *     Exactly one of those two named reasons is always stated; a caller
 *     cannot get a bare `true` with no reason attached.
 *   - **Persistence reuses the existing append-only log.**
 *     [`persistGovernanceRecord`] writes through `activity-log.mjs`'s own
 *     `appendEvent` (unmodified) — the same main-process-owned, bounded,
 *     redacted log every other decision in this app already writes to —
 *     and [`loadGovernanceChain`] reads it back through that log's own
 *     `readEvents` (unmodified) to reconstruct the series for
 *     [`verifyGovernanceChain`].
 *
 * Node-free except [`persistGovernanceRecord`]/[`loadGovernanceChain`],
 * whose only I/O is the same `appendEvent`/`readEvents` every other
 * recorder in this app already calls.
 */

export const LEARNING_GOVERNANCE_RECORD_VERSION = 1;
export const LEARNING_GOVERNANCE_RECORD_SUBJECT = "learning-governance-record";
export const LEARNING_GOVERNANCE_RECORD_FORMAT = "trace-learning-governance-record-v1";

/** The ten facets this item names, in the item's own order. Every record
 * states all ten keys, even when a given facet has no evidence yet — a
 * facet that is absent is reported as such, never silently omitted. */
export const GOVERNANCE_RECORD_FACETS = [
  "consent",
  "curriculumVersion",
  "modelVersion",
  "evaluatorCalibration",
  "interventions",
  "adjudications",
  "privacyBudget",
  "efficacy",
  "safety",
  "accessibility",
];

/**
 * Evaluator calibration — `process-trace-assessment.mjs`'s own
 * `validateRubricAgreement` (unmodified), reported under this record's own
 * facet name.
 */
export function governanceEvaluatorCalibration(pairs) {
  return validateRubricAgreement(pairs);
}

/**
 * Adjudication override rate — `curriculum-review.mjs`'s own
 * `measureOverrideRate` (unmodified), reported under this record's own
 * facet name.
 */
export function governanceAdjudications(events, reviewKind = null) {
  return measureOverrideRate(events, reviewKind);
}

/**
 * Efficacy, safety, and accessibility — all three already live inside
 * `curriculum-portfolio.mjs`'s own six promotion gates (unmodified);
 * this function just reads the three this item names out of that gate
 * list by name rather than re-deriving any of them.
 */
export function governanceEfficacySafetyAccessibility(portfolioContent) {
  const gates = evaluatePromotionGates(portfolioContent);
  const byName = new Map(gates.map((gate) => [gate.gate, gate]));
  return {
    efficacy: { effectiveness: byName.get("effectiveness") ?? null, calibration: byName.get("calibration") ?? null },
    safety: { provenance: byName.get("provenance") ?? null, answerLeakage: byName.get("answer-leakage") ?? null },
    accessibility: byName.get("accessibility") ?? null,
    decision: decideCurriculumPromotion(gates),
  };
}

/**
 * The one genuinely new decision this item adds: whether a curriculum or
 * model version should be retired. Exactly one of two named reasons is
 * stated whenever `deprecate` is `true`; a caller can never see a bare
 * `true` with no evidence attached, the same discipline
 * `decideCurriculumPromotion` already enforces for the opposite decision.
 */
export function decideDeprecation({ curriculumDecision = null, modelQuarantine = null } = {}) {
  const reasons = [];
  if (curriculumDecision && curriculumDecision.promote === false) {
    reasons.push({ reason: "curriculum-not-promotable", detail: curriculumDecision.reason });
  }
  if (modelQuarantine && modelQuarantine.quarantined === true) {
    reasons.push({ reason: "model-quarantined", detail: (modelQuarantine.reasons ?? []).map((entry) => entry.detail).join(" ") });
  }
  return {
    deprecate: reasons.length > 0,
    reasons,
  };
}

/**
 * Assemble one record's content — everything that is digested, chained, and
 * signed. Deliberately has no wall-clock field inside it, mirroring
 * `buildProvenance`'s own `runDetails.metadata` discipline and
 * `curriculum-portfolio.mjs`'s own `buildPortfolioContent`, so identical
 * inputs always produce identical bytes. `previousDigest` is the digest of
 * the immediately prior record in the same repository's series, or `null`
 * for the first record — supplied by the caller, usually
 * `loadGovernanceChain`'s own last entry.
 */
export function buildGovernanceRecordContent(input = {}) {
  const consent = consentState(input.continuityRecord ?? null);
  const calibration = input.rubricPairs ? governanceEvaluatorCalibration(input.rubricPairs) : null;
  const adjudications = input.adjudicationEvents ? governanceAdjudications(input.adjudicationEvents, input.reviewKind ?? null) : null;
  const facets = input.portfolioContent ? governanceEfficacySafetyAccessibility(input.portfolioContent) : null;
  const modelQuarantine = input.modelAdvisory
    ? evaluateModelForQuarantine(input.modelAdvisory, input.currentArtifactBytes)
    : null;
  const deprecation = decideDeprecation({
    curriculumDecision: facets?.decision ?? null,
    modelQuarantine,
  });

  return {
    format: LEARNING_GOVERNANCE_RECORD_FORMAT,
    version: LEARNING_GOVERNANCE_RECORD_VERSION,
    repositoryId: input.repositoryId ?? null,
    previousDigest: input.previousDigest ?? null,
    consent,
    curriculumVersion: input.curriculumVersion ?? null,
    modelVersion: input.modelVersion ?? null,
    evaluatorCalibration: calibration,
    interventions: input.interventions ?? null,
    adjudications,
    privacyBudget: input.privacyBudget ?? null,
    efficacy: facets?.efficacy ?? null,
    safety: facets?.safety ? { ...facets.safety, modelQuarantine } : (modelQuarantine ? { provenance: null, answerLeakage: null, modelQuarantine } : null),
    accessibility: facets?.accessibility ?? null,
    deprecation,
  };
}

/** Digest a record's content — the same `canonicalJson`/`digestOfText`
 * pair every other signed artifact in this app already uses. */
export function governanceRecordDigest(content) {
  return digestOfText(canonicalJson(content));
}

/**
 * Build, chain, and sign a complete record. `generatedAt` is attached after
 * the digest target is fixed, exactly like `buildCurriculumPortfolio`'s own
 * `generatedAt` — it travels with the record for a human reader but is not
 * part of what is digested or signed.
 */
export function buildGovernanceRecord(input = {}) {
  const content = buildGovernanceRecordContent(input);
  const digest = governanceRecordDigest(content);
  const record = { ...content, digest, generatedAt: input.now ?? new Date().toISOString() };
  if (!input.keyPair) return { ...record, signature: null };
  return { ...record, signature: signPayload(LEARNING_GOVERNANCE_RECORD_SUBJECT, content, input.keyPair) };
}

/**
 * Verify one record: its digest is recomputed over its own content (every
 * field except `digest`/`generatedAt`/`signature`), and its signature, if
 * present, is checked the same way `verifyCurriculumPortfolio` already
 * checks a portfolio's.
 */
export function verifyGovernanceRecord(record, options = {}) {
  const { digest, generatedAt, signature, ...content } = record ?? {};
  void generatedAt;
  const recomputed = governanceRecordDigest(content);
  const digestOk = digest === recomputed;
  const seal = signature !== undefined && signature !== null
    ? verifyPayload(LEARNING_GOVERNANCE_RECORD_SUBJECT, content, signature, options)
    : { verified: false, reason: "not-signed", trust: "unsigned", keyId: null, subject: LEARNING_GOVERNANCE_RECORD_SUBJECT };
  return {
    reproducible: digestOk,
    digestOk,
    expectedDigest: recomputed,
    actualDigest: digest ?? null,
    seal,
    verdict: !digestOk ? "altered" : seal.verified && seal.trust === "trusted" ? "verified" : seal.verified ? "untrusted-signer" : "unsigned-or-unverifiable",
  };
}

/**
 * Walk an ordered series of records and name the exact index where the
 * hash chain breaks, rather than report one pass/fail for the whole series.
 * The first record's own `previousDigest` must be `null` (nothing came
 * before it); every later record's `previousDigest` must equal the
 * immediately prior record's own `digest`.
 */
export function verifyGovernanceChain(records) {
  const breaks = [];
  for (let index = 0; index < (records ?? []).length; index += 1) {
    const record = records[index];
    const expectedPrevious = index === 0 ? null : records[index - 1].digest;
    if ((record.previousDigest ?? null) !== (expectedPrevious ?? null)) {
      breaks.push({ index, expectedPrevious: expectedPrevious ?? null, actualPrevious: record.previousDigest ?? null });
    }
  }
  return { intact: breaks.length === 0, length: (records ?? []).length, breaks };
}

/**
 * Persist one record through `activity-log.mjs`'s own `appendEvent`
 * (unmodified) — the same append-only, main-process-owned log every other
 * decision in this app already writes to.
 */
export function persistGovernanceRecord(directory, repositoryId, record) {
  return appendEvent(directory, repositoryId, {
    kind: "learning-governance-record",
    digest: record.digest,
    previousDigest: record.previousDigest,
    deprecate: record.deprecation?.deprecate ?? false,
    record,
  });
}

/**
 * Read back the chain for one repository through `activity-log.mjs`'s own
 * `readEvents` (unmodified), filtered to this module's own event kind and
 * in the order they were appended — the order `appendEvent` already
 * guarantees via its own per-log write queue.
 */
export async function loadGovernanceChain(directory, repositoryId) {
  const events = await readEvents(directory, repositoryId);
  return events.filter((event) => event.kind === "learning-governance-record").map((event) => event.record);
}

/** Open a spendable privacy budget for this repository's governance series
 * — a thin, named pass-through to `private-cohort-analytics.mjs`'s own
 * `openPrivacyBudget` (unmodified), so a caller need not import that
 * module directly just to seed a record's `privacyBudget` facet. */
export function openGovernancePrivacyBudget(totalEpsilon, options = {}) {
  return openPrivacyBudget(totalEpsilon, options);
}

/** Spend epsilon against a governance privacy budget — a thin, named
 * pass-through to `private-cohort-analytics.mjs`'s own `spendEpsilon`
 * (unmodified). */
export function spendGovernancePrivacyBudget(budget, queryEpsilon, label) {
  return spendEpsilon(budget, queryEpsilon, label);
}

/** Whichever accessibility paths this record's safety/accessibility facets
 * should be built from — a thin, named pass-through to
 * `accessibility-learning-experiments.mjs`'s own `runAllAccessibilityPaths`
 * (unmodified), so a caller assembling `portfolioContent.accessibility`
 * for `buildGovernanceRecordContent` need not import that module
 * directly. */
export function governanceAccessibilityPaths(args) {
  return runAllAccessibilityPaths(args);
}

/** Confirms this module's own subject was actually registered, rather than
 * silently signing under a string `signing.mjs` would reject — read, never
 * mutated. */
export function governanceSubjectRegistered() {
  return SIGNABLE_SUBJECTS.includes(LEARNING_GOVERNANCE_RECORD_SUBJECT);
}

/** Human-readable rendering of one record, for a report panel or a CLI
 * printout. */
export function renderGovernanceRecord(record) {
  const lines = [`# Learning-governance record (v${record.version})`, ""];
  lines.push(`Repository: ${record.repositoryId ?? "(none)"}`);
  lines.push(`Previous digest: ${record.previousDigest ?? "(first record)"}`);
  lines.push(`Digest: ${record.digest}`);
  lines.push("");
  lines.push(`Consent: ${record.consent?.granted ? "granted" : "not granted"}${record.consent?.grantedAt ? ` (since ${record.consent.grantedAt})` : ""}.`);
  lines.push(`Curriculum version: ${record.curriculumVersion ?? "n/a"}.`);
  lines.push(`Model version: ${record.modelVersion ?? "n/a"}.`);
  lines.push(`Evaluator calibration: ${record.evaluatorCalibration ? record.evaluatorCalibration.verdict : "n/a"}.`);
  lines.push(`Adjudications: ${record.adjudications ? `${record.adjudications.overrides}/${record.adjudications.confirmations + record.adjudications.overrides} overridden` : "n/a"}.`);
  lines.push(`Efficacy: ${record.efficacy ? `effectiveness=${record.efficacy.effectiveness?.verdict ?? "n/a"}, calibration=${record.efficacy.calibration?.verdict ?? "n/a"}` : "n/a"}.`);
  lines.push(`Safety: ${record.safety ? `provenance=${record.safety.provenance?.verdict ?? "n/a"}, answer-leakage=${record.safety.answerLeakage?.verdict ?? "n/a"}, model-quarantined=${record.safety.modelQuarantine?.quarantined ?? "n/a"}` : "n/a"}.`);
  lines.push(`Accessibility: ${record.accessibility?.verdict ?? "n/a"}.`);
  lines.push(`Deprecation: ${record.deprecation?.deprecate ? `recommended (${record.deprecation.reasons.map((entry) => entry.reason).join(", ")})` : "not recommended"}.`);
  return lines.join("\n");
}
