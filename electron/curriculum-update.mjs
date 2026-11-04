import { packageCourse } from "./course-package.mjs";
import { signPackage, verifyPackageSignature } from "./signing.mjs";
import { compareVersions } from "./updates.mjs";
import { applyMigration, revertMigration } from "./course-migration.mjs";
import { fingerprintModel, proveOfflineMode } from "./model-fingerprint.mjs";
import { indexSignature } from "./tree-sitter-index.mjs";
import { ALWAYS_FORBIDDEN, findForbiddenKeys } from "./answer-guard.mjs";

/**
 * Signed offline curriculum updates (item 30).
 *
 * `updates.mjs` (item 55) already refuses a signed binary release unless its
 * signature, version, and artifact digest all check out. A curriculum update
 * is a different kind of install — the thing shipped is a *course package*
 * (`course-package.mjs`, item 32), not an executable — but it is not a lower
 * risk: an installed course rewrites what a learner is shown as ground truth,
 * on disk, and `course-migration.mjs`'s own migration machinery (item 33)
 * will rewrite anchors the moment it is applied. So this module reuses
 * `updates.mjs`'s own refuse-unless-every-check-holds discipline, over a
 * payload built entirely from already-signed, already-tested primitives:
 *
 *   - **The artifact *is* a course package, signed under that subject.**
 *     Rather than inventing a new signing subject (which would mean editing
 *     `signing.mjs`'s own `SIGNABLE_SUBJECTS`, a reused module this item does
 *     not touch), [`buildCurriculumUpdate`] layers update-specific fields —
 *     `releaseVersion`, `minimumFrom`, `requiredModelFingerprint`,
 *     `requiredIndexSignature` — on top of `packageCourse`'s own payload
 *     (item 32, reused unmodified). `packagePayload`'s own `...rest` spread
 *     (in `signing.mjs`, also unmodified) signs *whatever* is on the object
 *     handed to it, so these extra fields are covered by the exact same
 *     `signPackage`/`verifyPackageSignature` call every other course package
 *     already goes through — confirmed by grep: zero prior matches for
 *     `curriculumUpdate`/`CurriculumUpdate` anywhere before this item.
 *   - **Compatibility is model and index identity, not just a version
 *     number.** `model-fingerprint.mjs`'s own `fingerprintModel` (item 14)
 *     and `tree-sitter-index.mjs`'s own `indexSignature` (item 9) are reused,
 *     unmodified, as the two fingerprints an installer's own environment
 *     must match before a migration plan computed against a *specific*
 *     indexer/model pairing is trusted to still mean what it meant when it
 *     was computed.
 *   - **Migration and rollback are `course-migration.mjs`'s own
 *     `planMigration`/`applyMigration`/`revertMigration` (item 33), reused
 *     unmodified.** This module adds exactly one new rule on top:
 *     [`assessMigrationReadiness`] refuses to auto-install a plan that still
 *     has operations needing review, unless the caller explicitly accepted
 *     them — an update that silently resolves an ambiguous rename is making
 *     a decision on the learner's behalf that the plan itself marked as not
 *     safe to make alone.
 *   - **Answer-leakage is `answer-guard.mjs`'s own `ALWAYS_FORBIDDEN`/
 *     `findForbiddenKeys` (item 6), reused unmodified, run against the
 *     artifact at rest rather than a response in flight.** That egress guard
 *     already proves a *live* IPC response never carries an answer key; this
 *     is the same check run one step earlier, over the course content a
 *     signed update would write to disk, so a compromised or malformed
 *     update cannot ship an answer key for the guard to catch only after it
 *     has already been installed.
 *   - **"Without network access" is `model-fingerprint.mjs`'s own
 *     `proveOfflineMode` (item 18), reused unmodified, run over this
 *     module's own installer code path** (its source plus its sibling-import
 *     closure, supplied by the caller the same way `local-model-evaluation.mjs`
 *     and `offline-privacy-verification.mjs` already do) — proving the
 *     *installer itself* has no network primitive to reach for, not merely
 *     that the already-downloaded update bytes look fine.
 *
 * [`evaluateCurriculumUpdate`] runs every one of these in order and stops at
 * the first failure, naming it, the same discipline `updates.mjs`'s own
 * `evaluateUpdate` already uses for a binary release. Only when every gate
 * passes does [`installCurriculumUpdate`] call `applyMigration` at all.
 */

export const CURRICULUM_UPDATE_FORMAT = "trace-curriculum-update-v1";
export const CURRICULUM_UPDATE_VERSION = 1;

function refuse(reason, detail, evidence = {}) {
  return { acceptable: false, reason, detail, ...evidence };
}

/**
 * Build the update artifact. `packageCourse` (reused unmodified) builds the
 * course-package payload; everything else here is the update-specific
 * metadata an installer needs to decide whether that payload is safe to
 * apply, layered on top of the same object so one signature covers all of it.
 */
export function buildCurriculumUpdate(repository, course, options = {}) {
  const base = packageCourse(repository, course, options);
  return {
    ...base,
    updateFormat: CURRICULUM_UPDATE_FORMAT,
    updateVersion: CURRICULUM_UPDATE_VERSION,
    releaseVersion: options.releaseVersion ?? "0.0.0",
    // The least version this update may be installed over — mirrors
    // `updates.mjs`'s own `minimumFrom`, same reasoning: a release that
    // changes what the migration plan assumes can refuse to be installed
    // over a course too old for that plan to make sense of.
    minimumFrom: options.minimumFrom ?? null,
    requiredModelFingerprint: fingerprintModel(options.modelConfig ?? {}),
    requiredIndexSignature: options.indexSignatureValue ?? indexSignature(),
    // Computed by the caller via `planMigration` against the specific
    // before/after symbol snapshots this update was built from; `null` for a
    // first install with no prior course to migrate from.
    migrationPlan: options.migrationPlan ?? null,
  };
}

/** Sign under the `course-package` subject — this update *is* a course package. */
export function signCurriculumUpdate(update, keyPair) {
  return signPackage(update, keyPair);
}

/** Verify the signature exactly the way any other course package is verified. */
export function verifyCurriculumUpdateSignature(update, options = {}) {
  return verifyPackageSignature(update, options);
}

/**
 * Model and index identity, plus the version step. Each gap is named: a
 * learner fixing one problem and immediately hitting the next, undisclosed,
 * is the failure mode `model-fingerprint.mjs`'s own `assessCompatibility`
 * already avoids by listing every reason rather than the first.
 */
export function assessCurriculumUpdateCompatibility(update, environment = {}) {
  const reasons = [];
  const step = compareVersions(update.releaseVersion, environment.installedVersion ?? "0.0.0");
  if (step === 0) reasons.push(`already-current: already on ${environment.installedVersion}.`);
  if (step < 0) reasons.push(`downgrade: ${update.releaseVersion} is older than the installed ${environment.installedVersion}.`);
  if (update.minimumFrom && compareVersions(environment.installedVersion ?? "0.0.0", update.minimumFrom) < 0) {
    reasons.push(`upgrade-path: ${update.releaseVersion} can only be installed over ${update.minimumFrom} or newer; this is ${environment.installedVersion}.`);
  }
  const environmentModelFingerprint = fingerprintModel(environment.modelConfig ?? {});
  if (environmentModelFingerprint !== update.requiredModelFingerprint) {
    reasons.push(`model-fingerprint-mismatch: this update was built for a different model/provider configuration than the one installed.`);
  }
  const environmentIndexSignature = environment.indexSignature ?? indexSignature();
  if (environmentIndexSignature !== update.requiredIndexSignature) {
    reasons.push(`index-signature-mismatch: this update's migration plan was computed against a different indexer than the one installed.`);
  }
  return { compatible: reasons.length === 0, reasons };
}

/**
 * Whether a migration plan may be auto-applied. An update that still has
 * operations the plan itself marked `requiresReview` is not auto-installable
 * unless the caller explicitly names which of them they accept — mirrors
 * `applyMigration`'s own `accept` contract (item 33, reused unmodified by
 * `installCurriculumUpdate` below), checked here *before* anything is written.
 */
export function assessMigrationReadiness(plan, options = {}) {
  if (!plan) return { ready: true, pendingReview: 0 };
  const accept = options.accept ?? "auto";
  const acceptedIds = new Set(accept === "all" ? plan.operations.map((operation) => operation.id) : Array.isArray(accept) ? accept : []);
  const pending = plan.operations.filter((operation) => operation.requiresReview && !acceptedIds.has(operation.id));
  return { ready: pending.length === 0, pendingReview: pending.length, pendingIds: pending.map((operation) => operation.id) };
}

/**
 * The same egress guard `answer-guard.mjs` already runs on a live IPC
 * response (item 6), run one step earlier over the course content an update
 * would write to disk. `ALWAYS_FORBIDDEN`/`findForbiddenKeys` are reused
 * unmodified; this function only decides what counts as "ok".
 */
export function scanCurriculumUpdateForAnswerLeakage(update) {
  const found = findForbiddenKeys(update?.content?.course ?? null, ALWAYS_FORBIDDEN);
  return { ok: found.length === 0, forbiddenFields: found };
}

/**
 * Prove the installer path itself has no network primitive to reach for —
 * `model-fingerprint.mjs`'s own `proveOfflineMode` (item 18), reused
 * unmodified, over the caller-supplied `{ name, source }` entries for this
 * module and whatever it imports (the same shape `local-model-evaluation.mjs`
 * and `offline-privacy-verification.mjs` already build their own offline
 * proofs from).
 */
export function proveCurriculumUpdateInstallerOffline(installerEntries, options = {}) {
  return proveOfflineMode(installerEntries ?? [], options);
}

/**
 * Run every gate, in order, and stop at the first failure — the same
 * discipline `updates.mjs`'s own `evaluateUpdate` already applies to a
 * binary release. Nothing here writes anything; `installCurriculumUpdate`
 * only proceeds to `applyMigration` once this returns `acceptable: true`.
 */
export function evaluateCurriculumUpdate(update, context = {}) {
  if (update?.updateFormat !== CURRICULUM_UPDATE_FORMAT) {
    return refuse("unreadable", `Not a Trace curriculum update (${update?.updateFormat ?? "no format"}).`);
  }
  if (Number(update.updateVersion) > CURRICULUM_UPDATE_VERSION) {
    return refuse("unreadable", `Update version ${update.updateVersion} is newer than this build understands.`);
  }

  const seal = verifyCurriculumUpdateSignature(update, { trustedKeyIds: context.trustedKeyIds ?? [] });
  if (!seal.verified) return { ...refuse("unsigned-or-tampered", `The update's signature did not verify (${seal.reason}).`), seal };
  if (seal.trust !== "trusted") {
    return { ...refuse("untrusted-key", `The update is signed by ${seal.keyId}, which this installation does not trust.`), seal };
  }

  const compatibility = assessCurriculumUpdateCompatibility(update, context.environment ?? {});
  if (!compatibility.compatible) {
    return { ...refuse(compatibility.reasons[0].split(":")[0], compatibility.reasons.join(" "), { compatibility }), seal };
  }

  const leakage = scanCurriculumUpdateForAnswerLeakage(update);
  if (!leakage.ok) {
    return { ...refuse("answer-leak", `This update's own content carries forbidden answer field(s): ${leakage.forbiddenFields.join(", ")}.`), seal, compatibility, leakage };
  }

  if (context.installerEntries) {
    const offline = proveCurriculumUpdateInstallerOffline(context.installerEntries, context.offlineOptions);
    if (!offline.offlineModeSafe) {
      return { ...refuse("network-capability-found", `The installer path itself has network capability: ${offline.findings.map((finding) => finding.primitive).join(", ")}.`), seal, compatibility, leakage, offline };
    }
  }

  const readiness = assessMigrationReadiness(update.migrationPlan, context.migrationOptions);
  if (!readiness.ready) {
    return { ...refuse("migration-requires-review", `${readiness.pendingReview} migration operation(s) still require review before this update can be installed.`), seal, compatibility, leakage, readiness };
  }

  return { acceptable: true, reason: null, detail: null, seal, compatibility, leakage, readiness };
}

/**
 * Install: evaluate every gate, and only on success call `applyMigration`
 * (item 33, reused unmodified). `rollbackMigrationId` is returned explicitly
 * so a caller can hand it straight to `rollbackCurriculumUpdate` without
 * having to dig it out of the installed course's own migration history.
 */
export function installCurriculumUpdate(update, course, context = {}) {
  const verification = evaluateCurriculumUpdate(update, context);
  if (!verification.acceptable) return { installed: false, verification, course, migration: null };

  // No prior course (a first install): the update's own content is the
  // installed course outright, with no anchors to carry over or migrate.
  if (!course) {
    return { installed: true, verification, course: update.content?.course ?? null, migration: null, rollbackMigrationId: null };
  }

  if (!update.migrationPlan) {
    return { installed: true, verification, course: update.content?.course ?? course, migration: null, rollbackMigrationId: null };
  }

  const applied = applyMigration(course, update.migrationPlan, context.migrationOptions);
  return {
    installed: true,
    verification,
    course: applied.course,
    migration: applied.migration,
    rollbackMigrationId: applied.migration?.id ?? null,
  };
}

/** Undo exactly `revertMigration` (item 33, reused unmodified) already does. */
export function rollbackCurriculumUpdate(course, migrationId = null) {
  return revertMigration(course, migrationId);
}

/** A sentence for a learner deciding whether to install. */
export function describeCurriculumUpdateDecision(result) {
  if (result.acceptable === false) return `No install: ${result.detail}`;
  if (result.installed === false) return `No install: ${result.verification.detail}`;
  return `Curriculum updated to ${result.verification?.compatibility ? "a compatible release" : "the new release"}${result.migration ? `, migrating ${result.migration.repointed} anchor(s)` : ""}.`;
}
