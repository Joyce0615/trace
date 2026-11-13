import { buildBundleContent } from "./learning-effectiveness-bundle.mjs";
import { runAllAccessibilityPaths } from "./accessibility-learning-experiments.mjs";
import { buildProvenance, verifyProvenance } from "./supply-chain.mjs";
import { ALWAYS_FORBIDDEN, findForbiddenKeys } from "./answer-guard.mjs";
import { canonicalJson, digestOfText } from "./offline-archive.mjs";
import { signPayload, verifyPayload } from "./signing.mjs";

/**
 * Publish learner-safety and efficacy portfolios (item 40).
 *
 * This item asks for exactly one new decision — "may this curriculum be
 * promoted?" — over evidence that already exists, each piece already tested
 * on its own, and none of them combined into a promotion gate before this:
 *
 *   - **Retention, transfer, calibration** are
 *     `learning-effectiveness-bundle.mjs`'s own `buildBundleContent` (item
 *     15), reused unmodified — this module does not re-measure any of it, it
 *     reads the same `effectiveness.retention`/`transfer`/`delayedTransfer`/
 *     `calibration` sections that bundle already assembles.
 *   - **Cognitive load and accessibility** are
 *     `accessibility-learning-experiments.mjs`'s own `runAllAccessibilityPaths`
 *     (item 36), reused unmodified — six paths including `cognitive-load`,
 *     each with its own structural-compliance and difficulty-equivalence
 *     verdict, never averaged into one app-wide accessibility score (that
 *     module's own stated rule, which this module does not violate by
 *     collapsing them here either).
 *   - **Privacy and provenance** are `offline-privacy-verification.mjs`'s own
 *     `verifyAdversarialOfflinePrivacy` (item 18, the sealed static+dynamic
 *     no-network verdict) and `supply-chain.mjs`'s own `buildProvenance`/
 *     `verifyProvenance` (item 56, the in-toto/SLSA attestation), both reused
 *     unmodified.
 *   - **Answer-leakage** is `answer-guard.mjs`'s own `ALWAYS_FORBIDDEN`/
 *     `findForbiddenKeys` (item 6), reused unmodified, run against the
 *     course content exactly the way `curriculum-update.mjs`'s own
 *     `scanCurriculumUpdateForAnswerLeakage` (item 30) already runs it
 *     against an update artifact at rest.
 *
 * Grep confirmed before writing a line here: zero prior matches for
 * `efficacyPortfolio`/`safetyPortfolio`/`promotionDecision`/
 * `curriculumPromotion`/`publishPortfolio` anywhere in `electron/*.mjs`
 * before this item.
 *
 * What this module adds that none of the above had:
 *
 *   - [`buildCurriculumPortfolio`] assembles all six kinds of evidence into
 *     one content object with a reproducibility digest (the same
 *     `canonicalJson`/`digestOfText` pair `offline-archive.mjs` and
 *     `learning-effectiveness-bundle.mjs` already use), with no wall-clock
 *     field inside the digested content, mirroring `buildProvenance`'s own
 *     already-established discipline.
 *   - [`evaluatePromotionGates`] is the one new decision: six independently
 *     named gates (`effectiveness`, `accessibility`, `privacy`, `provenance`,
 *     `answer-leakage`, `calibration`), each reporting pass/fail/
 *     insufficient-evidence on its own terms — never blended into one
 *     score, the same discipline `evaluateModelForQuarantine` (item 37)
 *     already established for a different kind of gate list.
 *   - [`decideCurriculumPromotion`] refuses promotion unless every gate that
 *     is not `insufficient-evidence` actually passed, and separately
 *     reports which gates could not be evaluated at all — a portfolio with
 *     three green gates and two gates with no data yet is not a 60% pass,
 *     it is "not enough evidence to decide" for those two, stated as such.
 *   - **Signing** reuses `signPayload`/`verifyPayload` under a new subject,
 *     `"curriculum-portfolio"`, added to `signing.mjs`'s `SIGNABLE_SUBJECTS`
 *     and documented in `docs/extending.md`'s signing-subjects contract so
 *     `scripts/docs-check.mjs` keeps the two from drifting apart, following
 *     the exact pattern `model-advisory.mjs` (item 37) already established
 *     for adding a signing subject.
 *
 * Node-free except where its own inputs already are not (`buildProvenance`
 * takes plain data; nothing here opens a file or a socket).
 */

export const CURRICULUM_PORTFOLIO_VERSION = 1;
export const CURRICULUM_PORTFOLIO_SUBJECT = "curriculum-portfolio";

/**
 * Answer-leakage, scanned against the course content at rest — the same
 * `ALWAYS_FORBIDDEN` keys `answer-guard.mjs` already forbids across every
 * live response channel, reused here over a static artifact instead of a
 * response in flight.
 */
export function scanPortfolioForAnswerLeakage(course) {
  const found = findForbiddenKeys(course ?? null, ALWAYS_FORBIDDEN);
  return { clean: found.length === 0, found };
}

/**
 * Assemble the portfolio's content — everything that is digested and
 * signed. Deliberately has no wall-clock field inside it, mirroring
 * `buildProvenance`'s own `runDetails.metadata` discipline, so identical
 * inputs always produce identical bytes.
 */
export function buildPortfolioContent(input = {}) {
  const effectivenessContent = buildBundleContent({
    events: input.events ?? [],
    learnerState: input.learnerState ?? null,
    skillGraph: input.skillGraph ?? null,
    studiedPaths: input.studiedPaths ?? [],
    now: input.now,
  });
  const accessibility = runAllAccessibilityPaths({
    baselineScores: input.accessibility?.baselineScores ?? [],
    perPathScores: input.accessibility?.perPathScores ?? {},
    snapshots: input.accessibility?.snapshots ?? {},
    contrastPairs: input.accessibility?.contrastPairs,
    options: input.accessibility?.options ?? {},
  });
  const leakage = scanPortfolioForAnswerLeakage(input.course);

  return {
    format: "trace-curriculum-portfolio-v1",
    version: CURRICULUM_PORTFOLIO_VERSION,
    repositoryId: input.repository?.id ?? input.learnerState?.repositoryId ?? null,
    sourceVersion: input.repository?.versionId ?? input.learnerState?.sourceVersion ?? null,
    tasks: effectivenessContent.tasks,
    effectiveness: effectivenessContent.effectiveness,
    calibration: effectivenessContent.calibration,
    sampleSizes: effectivenessContent.sampleSizes,
    accessibility: accessibility.map((report) => ({
      path: report.path,
      ok: report.ok,
      compliance: report.ok ? report.compliance : null,
      equivalence: report.ok ? report.equivalence : null,
    })),
    leakage,
    privacy: input.privacy ?? null,
    provenance: input.provenance ?? null,
  };
}

/** The portfolio's own reproducibility digest: identical inputs, identical bytes. */
export function portfolioDigest(content) {
  return digestOfText(canonicalJson(content));
}

/**
 * Six independently named promotion gates, each reporting its own verdict —
 * `pass`, `fail`, or `insufficient-evidence` — never blended into one score.
 */
export function evaluatePromotionGates(content) {
  const gates = [];

  // --- Effectiveness: retention and transfer, each reported, not blended --
  const retention = content.effectiveness?.retention;
  const transfer = content.effectiveness?.transfer;
  const effectivenessVerdict = !retention || retention.modelVerdict === "not-enough-reviews"
    ? "insufficient-evidence"
    : retention.modelVerdict === "learner-forgets-faster-than-model" || transfer?.verdict === "familiar-ground-only"
      ? "fail"
      : "pass";
  gates.push({ gate: "effectiveness", verdict: effectivenessVerdict, detail: { retentionVerdict: retention?.modelVerdict ?? null, transferVerdict: transfer?.verdict ?? null } });

  // --- Calibration: nobody assessed is insufficient evidence, not a pass --
  const calibration = content.calibration;
  const calibrationVerdict = !calibration || calibration.assessed === 0
    ? "insufficient-evidence"
    : calibration.meanBrier !== null && calibration.meanBrier > 0.3
      ? "fail"
      : "pass";
  gates.push({ gate: "calibration", verdict: calibrationVerdict, detail: { assessed: calibration?.assessed ?? 0, meanBrier: calibration?.meanBrier ?? null } });

  // --- Accessibility: every path must be equivalent or not-applicable -----
  const accessibilityReports = content.accessibility ?? [];
  const evaluated = accessibilityReports.filter((report) => report.ok && report.equivalence);
  const accessibilityVerdict = !evaluated.length
    ? "insufficient-evidence"
    : evaluated.some((report) => report.equivalence.verdict === "not-equivalent")
      ? "fail"
      : evaluated.some((report) => report.equivalence.verdict === "underpowered")
        ? "insufficient-evidence"
        : "pass";
  gates.push({ gate: "accessibility", verdict: accessibilityVerdict, detail: { evaluatedPaths: evaluated.length, totalPaths: accessibilityReports.length } });

  // --- Privacy: the sealed static+dynamic no-network verdict -------------
  const privacy = content.privacy;
  const privacyVerdict = !privacy
    ? "insufficient-evidence"
    : privacy.staticOfflineModeSafe && privacy.dynamicVerdict?.offlineAtRuntime && privacy.agree
      ? "pass"
      : "fail";
  gates.push({ gate: "privacy", verdict: privacyVerdict, detail: { staticOfflineModeSafe: privacy?.staticOfflineModeSafe ?? null, dynamicOfflineAtRuntime: privacy?.dynamicVerdict?.offlineAtRuntime ?? null, agree: privacy?.agree ?? null } });

  // --- Provenance: a verified in-toto/SLSA attestation --------------------
  const provenance = content.provenance;
  const provenanceVerdict = !provenance
    ? "insufficient-evidence"
    : provenance.accepted
      ? "pass"
      : "fail";
  gates.push({ gate: "provenance", verdict: provenanceVerdict, detail: { accepted: provenance?.accepted ?? null, reason: provenance?.reason ?? null } });

  // --- Answer-leakage: a static scan over the course content at rest -----
  const leakage = content.leakage;
  const leakageVerdict = !leakage ? "insufficient-evidence" : leakage.clean ? "pass" : "fail";
  gates.push({ gate: "answer-leakage", verdict: leakageVerdict, detail: { clean: leakage?.clean ?? null, found: leakage?.found?.length ?? 0 } });

  return gates;
}

/**
 * Refuse promotion unless every evaluated gate passed. A gate reporting
 * `insufficient-evidence` is named separately from a gate that actually
 * failed — "not enough evidence yet" is not the same claim as "this
 * curriculum is unsafe", and conflating them either blocks forever on
 * missing data or promotes on a false pass.
 */
export function decideCurriculumPromotion(gates) {
  const failed = gates.filter((entry) => entry.verdict === "fail");
  const unproven = gates.filter((entry) => entry.verdict === "insufficient-evidence");
  const promote = failed.length === 0 && unproven.length === 0;
  return {
    promote,
    gates,
    failedGates: failed.map((entry) => entry.gate),
    unprovenGates: unproven.map((entry) => entry.gate),
    reason: promote
      ? null
      : failed.length
        ? `${failed.length} gate(s) failed: ${failed.map((entry) => entry.gate).join(", ")}.`
        : `${unproven.length} gate(s) have insufficient evidence: ${unproven.map((entry) => entry.gate).join(", ")}.`,
  };
}

/**
 * Build, evaluate, and sign a complete portfolio. `generatedAt` is attached
 * after the digest target is fixed — it travels with the portfolio for a
 * human reader but is not part of what is signed or digested, exactly like
 * `buildProvenance`'s absent timestamps.
 */
export function buildCurriculumPortfolio(input = {}) {
  const content = buildPortfolioContent(input);
  const gates = evaluatePromotionGates(content);
  const decision = decideCurriculumPromotion(gates);
  const digest = portfolioDigest(content);
  const portfolio = { ...content, decision, digest, generatedAt: input.now ?? new Date().toISOString() };
  if (!input.keyPair) return { ...portfolio, signature: null };
  return { ...portfolio, signature: signPayload(CURRICULUM_PORTFOLIO_SUBJECT, content, input.keyPair) };
}

/**
 * Verify a portfolio two ways: the digest is recomputed over the content as
 * it stands (proving the content was not edited after `digest` was taken),
 * and the signature — if present — is checked the normal way. Reported
 * separately, matching `verifyLearningEffectivenessBundle`'s own discipline:
 * an unsigned portfolio with an intact digest is "unaltered but not
 * attested", not simply invalid.
 */
export function verifyCurriculumPortfolio(portfolio, options = {}) {
  const { digest, generatedAt, signature, decision, ...content } = portfolio ?? {};
  void generatedAt;
  void decision;
  const recomputed = portfolioDigest(content);
  const digestOk = digest === recomputed;
  const seal = signature !== undefined && signature !== null
    ? verifyPayload(CURRICULUM_PORTFOLIO_SUBJECT, content, signature, options)
    : { verified: false, reason: "not-signed", trust: "unsigned", keyId: null, subject: CURRICULUM_PORTFOLIO_SUBJECT };
  return {
    reproducible: digestOk,
    digestOk,
    expectedDigest: recomputed,
    actualDigest: digest ?? null,
    seal,
    verdict: !digestOk ? "altered" : seal.verified && seal.trust === "trusted" ? "verified" : seal.verified ? "untrusted-signer" : "unsigned-or-unverifiable",
  };
}

/** Re-exported so a caller building a portfolio's `provenance` field does not
 * need to import `supply-chain.mjs` directly just to check its own output. */
export { buildProvenance, verifyProvenance };

/** Human-readable rendering, for a report panel or a CLI printout. */
export function renderCurriculumPortfolio(portfolio) {
  const lines = [`# Curriculum portfolio (v${portfolio.version})`, ""];
  lines.push(`Promotion decision: ${portfolio.decision.promote ? "PROMOTE" : "DO NOT PROMOTE"}${portfolio.decision.reason ? ` — ${portfolio.decision.reason}` : ""}`);
  lines.push("");
  for (const gate of portfolio.decision.gates) {
    lines.push(`  - ${gate.gate}: ${gate.verdict}`);
  }
  lines.push("");
  lines.push(`Retention model verdict: ${portfolio.effectiveness.retention.modelVerdict}.`);
  lines.push(`Transfer verdict: ${portfolio.effectiveness.transfer.verdict}.`);
  lines.push(`Calibration: ${portfolio.calibration.assessed}/${portfolio.calibration.skills} skill(s) assessed, mean Brier ${portfolio.calibration.meanBrier ?? "n/a"}.`);
  lines.push(`Answer-leakage: ${portfolio.leakage.clean ? "clean" : `${portfolio.leakage.found.length} forbidden key(s) found`}.`);
  lines.push("");
  lines.push(`Reproducibility digest: ${portfolio.digest}`);
  return lines.join("\n");
}
