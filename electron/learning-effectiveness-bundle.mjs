import { analyticsReport } from "./analytics.mjs";
import { canonicalJson, digestOfText } from "./offline-archive.mjs";
import { diagnoseLearner } from "./misconception.mjs";
import { signPayload, verifyPayload } from "./signing.mjs";
import { exportTelemetry } from "./telemetry.mjs";

/**
 * Publish a learning-effectiveness bundle (item 15).
 *
 * Every piece this item asks for already exists and is already tested
 * separately — `analyticsReport` (item 34) measures retention, transfer,
 * delayed transfer, time-on-task, and hint dependence, each refusing to exist
 * below its sample floor; `diagnoseLearner`/`calibrateSkill` (item 12) turn
 * raw evidence into a calibrated mastery estimate with a stated confidence
 * interval and a Brier score; `exportTelemetry` (item 60) is already the
 * learner's exact private-telemetry export, with no endpoint and nothing but
 * declared labels; and `signPayload`/`verifyPayload` (item 45) already seal a
 * payload with Ed25519 under a named subject. This module does not re-measure
 * or re-derive any of that — it is a *bundle*, meaning it packages the outputs
 * of those four systems side by side with the two things none of them state on
 * their own: which tasks the numbers came from, and a byte-identical
 * reproducibility proof that re-running the exact same assembly over the exact
 * same inputs produces the exact same digest.
 *
 * Design choices that follow from reusing rather than reinventing:
 *
 *   - **Tasks** are the raw activity log, grouped by `kind`, because that is
 *     the one piece `analyticsReport` consumes but never echoes back; a bundle
 *     that reports "73% near-transfer accuracy" with no record of which task
 *     kinds, how many, over what span produced that number is not
 *     reproducible even if the number itself is honest.
 *   - **Pre/post/delayed/transfer** results are `analyticsReport`'s own
 *     `retention` (pre/post via the item-36 model vs. observed recall),
 *     `transfer` (near/far by file familiarity), and `delayedTransfer` (item
 *     11's own delay-gated probes) sections, named explicitly in the bundle so
 *     a reader does not have to already know analytics.mjs's internal names to
 *     find them.
 *   - **Calibration** is `diagnoseLearner`'s per-skill `calibrateSkill` output
 *     — mastery, 95% interval, Brier score, overconfident/underconfident
 *     verdict — summarized the same way `diagnoseLearner` already summarizes
 *     it (mean confidence, mean Brier, counts), not recomputed.
 *   - **Sample sizes** travel with every rate already (`rate()`'s `samples`
 *     field, `diagnoseLearner`'s `evidenceCount`): this module does not add a
 *     second counting mechanism, it is explicit that `sampleSizes` below is a
 *     *read* of fields the inputs already carry.
 *   - **Private telemetry** is `exportTelemetry`'s own output, included
 *     unmodified. If telemetry is off (no consent), the bundle says so and
 *     includes nothing — the same opt-in rule the telemetry module enforces at
 *     its own boundary is not re-decided here.
 *   - **Reproducible analysis** means the bundle's own content (everything
 *     except its signature) is deterministic for the same inputs: no
 *     wall-clock field is read inside the analysis payload (`generatedAt` sits
 *     outside the digested content, exactly where `buildProvenance` already
 *     keeps its own wall-clock-free discipline, deliberately, for the same
 *     reason). `bundleDigest` is `digestOfText(canonicalJson(content))`, the
 *     same canonicalization `offline-archive.mjs` already uses for its own
 *     checksum, so two bundles built from identical inputs produce an
 *     identical digest and two bundles built from inputs that differ in any
 *     way the content captures do not.
 *   - **Signing** reuses `signPayload`/`verifyPayload` under a new subject,
 *     `"learning-effectiveness-bundle"`, following the exact pattern
 *     `offline-archive.mjs`'s own export handler already follows: sign the
 *     content, attach the signature after, verify by recomputing the digest
 *     over the content with the signature stripped first (so the signature
 *     can never cover itself).
 *
 * Node-free: takes its event log, learner state, skill graph, and telemetry
 * state as parameters, exactly like `analytics.mjs` and `misconception.mjs`
 * already do, so the browser demo can build the same bundle.
 */

export const LEARNING_EFFECTIVENESS_BUNDLE_VERSION = 1;
export const LEARNING_EFFECTIVENESS_BUNDLE_SUBJECT = "learning-effectiveness-bundle";

function round(value, places = 4) {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Number(Number(value).toFixed(places));
}

/**
 * The raw activity log, grouped by task kind, with each kind's own sample
 * size — the piece `analyticsReport` consumes but does not itself restate.
 */
export function summarizeTasks(events) {
  const list = (events ?? []).filter((event) => event && typeof event.kind === "string");
  const byKind = new Map();
  for (const event of list) {
    if (!byKind.has(event.kind)) byKind.set(event.kind, { kind: event.kind, total: 0, graded: 0, correct: 0 });
    const bucket = byKind.get(event.kind);
    bucket.total += 1;
    if (typeof event.correct === "boolean") {
      bucket.graded += 1;
      if (event.correct) bucket.correct += 1;
    }
  }
  const kinds = [...byKind.values()]
    .map((bucket) => ({
      kind: bucket.kind,
      total: bucket.total,
      graded: bucket.graded,
      // A per-kind rate here is purely descriptive bookkeeping of this task
      // list; the sample-floor-gated verdicts a reader should trust live in
      // `effectiveness.retention`/`transfer`/`delayedTransfer` below, not here.
      accuracy: bucket.graded ? round(bucket.correct / bucket.graded) : null,
    }))
    .sort((left, right) => left.kind.localeCompare(right.kind));
  return { totalTasks: list.length, kinds };
}

/**
 * Calibration, summarized exactly the way `diagnoseLearner` already
 * summarizes its own per-skill `calibrateSkill` output — not recomputed here.
 */
export function summarizeCalibration(diagnosis) {
  if (!diagnosis) return { skills: 0, assessed: 0, meanConfidence: 0, meanBrier: null, overconfidentSkills: 0, underconfidentSkills: 0 };
  return {
    skills: diagnosis.summary.skills,
    assessed: diagnosis.summary.assessed,
    meanConfidence: diagnosis.summary.meanConfidence,
    meanBrier: diagnosis.summary.meanBrier,
    overconfidentSkills: diagnosis.summary.overconfidentSkills,
    underconfidentSkills: diagnosis.summary.underconfidentSkills,
    // Per-skill detail, with the probe's own answer key already stripped by
    // `diagnoseLearner` — this bundle never sees it to begin with.
    perSkill: diagnosis.skills.map((skill) => ({
      skillId: skill.skillId,
      mastery: skill.mastery,
      confidence: skill.confidence,
      interval: skill.interval,
      intervalWidth: skill.intervalWidth,
      evidenceCount: skill.evidenceCount,
      brier: skill.brier,
      calibration: skill.calibration,
    })),
  };
}

/**
 * Every sample size a reader would need to judge whether a number in this
 * bundle is trustworthy, read from the fields the inputs already carry.
 */
export function collectSampleSizes(effectiveness, calibration) {
  return {
    retentionRecalls: effectiveness.retention.recalls,
    transferActivities: effectiveness.transfer.activities,
    delayedTransferProbes: effectiveness.delayedTransfer.probes,
    hintAttempts: effectiveness.hints.attempts,
    misconceptionHintTargeted: effectiveness.misconceptionHints.targeted.samples,
    misconceptionHintGeneric: effectiveness.misconceptionHints.generic.samples,
    calibratedSkills: calibration.assessed,
    totalTasks: effectiveness.events,
  };
}

/**
 * Assemble the bundle's content — everything that is digested and signed.
 * Deliberately has no wall-clock field inside it (mirrors
 * `buildProvenance`'s own `runDetails.metadata` discipline), so the same
 * inputs always produce the same bytes.
 */
export function buildBundleContent(input = {}) {
  const effectiveness = analyticsReport({
    events: input.events ?? [],
    learnerState: input.learnerState ?? null,
    skillGraph: input.skillGraph ?? null,
    studiedPaths: input.studiedPaths ?? [],
    now: input.now,
  });
  const diagnosis = input.skillGraph
    ? diagnoseLearner(input.learnerState ?? {}, input.skillGraph, input.repository ?? { symbols: [], callEdges: [] }, { findings: input.findings ?? {} })
    : null;
  const calibration = summarizeCalibration(diagnosis);
  const tasks = summarizeTasks(input.events);

  // Telemetry is included only with consent; `exportTelemetry` already
  // enforces nothing-leaves-this-machine, this module just carries its output
  // through unmodified. Without a telemetry state at all, or without consent,
  // the bundle says so rather than silently omitting the field.
  const telemetry = input.telemetryState
    ? { included: Boolean(input.telemetryState.consent?.granted), export: input.telemetryState.consent?.granted ? exportTelemetry(input.telemetryState, input.now) : null }
    : { included: false, export: null };

  return {
    format: "trace-learning-effectiveness-bundle-v1",
    version: LEARNING_EFFECTIVENESS_BUNDLE_VERSION,
    repositoryId: input.repository?.id ?? input.learnerState?.repositoryId ?? null,
    sourceVersion: input.repository?.versionId ?? input.learnerState?.sourceVersion ?? null,
    tasks,
    effectiveness: {
      retention: effectiveness.retention,
      transfer: effectiveness.transfer,
      delayedTransfer: effectiveness.delayedTransfer,
      timeOnTask: effectiveness.timeOnTask,
      hints: effectiveness.hints,
      misconceptionHints: effectiveness.misconceptionHints,
      warnings: effectiveness.warnings,
    },
    calibration,
    sampleSizes: collectSampleSizes(effectiveness, calibration),
    privateTelemetry: telemetry,
  };
}

/** The bundle's own reproducibility digest: identical inputs, identical bytes. */
export function bundleDigest(content) {
  return digestOfText(canonicalJson(content));
}

/**
 * Build and sign a complete bundle. `generatedAt` is attached after signing's
 * digest target is fixed — it travels with the bundle for a human reader, but
 * is not part of what is signed or digested, exactly like
 * `buildProvenance`'s absent timestamps.
 */
export function buildLearningEffectivenessBundle(input = {}) {
  const content = buildBundleContent(input);
  const digest = bundleDigest(content);
  const bundle = { ...content, digest, generatedAt: input.now ?? new Date().toISOString() };
  if (!input.keyPair) return { ...bundle, signature: null };
  return { ...bundle, signature: signPayload(LEARNING_EFFECTIVENESS_BUNDLE_SUBJECT, content, input.keyPair) };
}

/**
 * Verify a bundle two ways: the digest is recomputed over the content as it
 * stands (proving the content was not edited after `digest` was taken), and
 * the signature — if present — is checked the normal way. The two checks are
 * reported separately because an unsigned bundle with an intact digest is
 * "unaltered but not attested", not simply invalid.
 */
export function verifyLearningEffectivenessBundle(bundle, options = {}) {
  const { digest, generatedAt, signature, ...content } = bundle ?? {};
  void generatedAt;
  const recomputed = bundleDigest(content);
  const digestOk = digest === recomputed;
  const seal = signature !== undefined && signature !== null
    ? verifyPayload(LEARNING_EFFECTIVENESS_BUNDLE_SUBJECT, content, signature, options)
    : { verified: false, reason: "not-signed", trust: "unsigned", keyId: null, subject: LEARNING_EFFECTIVENESS_BUNDLE_SUBJECT };
  return {
    reproducible: digestOk,
    digestOk,
    expectedDigest: recomputed,
    actualDigest: digest ?? null,
    seal,
    verdict: !digestOk ? "altered" : seal.verified && seal.trust === "trusted" ? "verified" : seal.verified ? "untrusted-signer" : "unsigned-or-unverifiable",
  };
}

/** Human-readable rendering, for a report panel or a CLI printout. */
export function renderLearningEffectivenessBundle(bundle) {
  const lines = [`# Learning-effectiveness bundle (v${bundle.version})`, ""];
  lines.push(`Tasks: ${bundle.tasks.totalTasks} across ${bundle.tasks.kinds.length} kind(s).`);
  for (const kind of bundle.tasks.kinds) {
    lines.push(`  - ${kind.kind}: ${kind.total} task(s), accuracy ${kind.accuracy === null ? "n/a" : kind.accuracy}`);
  }
  lines.push("");
  lines.push(`Retention: ${bundle.effectiveness.retention.recalls} recall(s), model verdict "${bundle.effectiveness.retention.modelVerdict}".`);
  lines.push(`Transfer: ${bundle.effectiveness.transfer.activities} activity(ies), verdict "${bundle.effectiveness.transfer.verdict}".`);
  lines.push(`Delayed transfer: ${bundle.effectiveness.delayedTransfer.probes} probe(s), verdict "${bundle.effectiveness.delayedTransfer.verdict}".`);
  lines.push("");
  lines.push(`Calibration: ${bundle.calibration.assessed}/${bundle.calibration.skills} skill(s) assessed, mean confidence ${bundle.calibration.meanConfidence}, mean Brier ${bundle.calibration.meanBrier ?? "n/a"}.`);
  lines.push("");
  lines.push(`Private telemetry: ${bundle.privateTelemetry.included ? "included (consented)" : "not included (no consent, or no telemetry recorded)"}.`);
  lines.push("");
  lines.push(`Reproducibility digest: ${bundle.digest}`);
  if (bundle.effectiveness.warnings.length) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of bundle.effectiveness.warnings) lines.push(`  - ${warning.measure}: ${warning.reason} (have ${warning.have}, need ${warning.need})`);
  }
  return lines.join("\n");
}
