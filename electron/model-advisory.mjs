import { assessCompatibility, fingerprintModel } from "./model-fingerprint.mjs";
import { fingerprintRuntimeArtifact } from "./offline-privacy-verification.mjs";
import { DEFAULT_LICENSE_POLICY, FINDING_SEVERITIES } from "./supply-chain.mjs";
import { signPayload, verifyPayload } from "./signing.mjs";

/**
 * Local-model advisory and provenance gates.
 *
 * `model-fingerprint.mjs`'s own `fingerprintModel`/`assessCompatibility`
 * already identify a provider/model configuration and say whether it is
 * capable of running inside this application's trust boundary (item 14);
 * `offline-privacy-verification.mjs`'s own `fingerprintRuntimeArtifact`
 * already content-addresses the artifact bytes behind a configuration
 * (item 18); `supply-chain.mjs`'s own license-bucket policy
 * (`DEFAULT_LICENSE_POLICY`'s `allowed`/`review`/`denied`) already classifies
 * a dependency's declared license the same three ways a model's declared
 * license needs classifying (item 56); `signing.mjs`'s own `digestOf`/
 * `verifyPayload` already seal and check an untampered artifact under a
 * named subject (item 45). None of those four pieces had ever been combined
 * into one decision about a *local model's own binary/weights file*
 * specifically — confirmed by grep: zero prior matches for
 * `modelAdvisory`/`quarantine`/a model-targeted license classification
 * anywhere in `electron/*.mjs` before this item.
 *
 * This module is that combination, reusing every piece above unmodified:
 *
 *   - **Advisory mapping.** `buildModelAdvisory` takes one runtime artifact's
 *     bytes, a declared license identifier, and the provider/model
 *     configuration behind it, and produces one record: the real content
 *     fingerprint (`fingerprintRuntimeArtifact`, unmodified), the real
 *     configuration fingerprint (`fingerprintModel`, unmodified), the real
 *     capability compatibility verdict (`assessCompatibility`, unmodified),
 *     and the real license bucket this artifact's declared license falls
 *     into, read off the exact same `DEFAULT_LICENSE_POLICY` buckets
 *     `supply-chain.mjs` already defines for dependencies (not a second,
 *     model-specific policy — a license that is denied for a dependency is
 *     denied for a model binary for the identical reason).
 *   - **Signed advisories.** `signModelAdvisory`/`verifyModelAdvisory` seal
 *     an advisory record the same way `signing.mjs` already seals every
 *     other kind of artifact in this app — over a canonical digest
 *     (`digestOf`, unmodified) under a new signable subject,
 *     `"model-advisory"`, added to `SIGNABLE_SUBJECTS` in `signing.mjs` and
 *     documented in `docs/extending.md`'s signing-subjects contract so
 *     `scripts/docs-check.mjs` enforces that the list and the prose never
 *     drift apart — so a trusted maintainer's advisory about a specific
 *     model artifact can be distributed and checked the same way a course
 *     package or an update manifest already is.
 *   - **Quarantine.** `evaluateModelForQuarantine` is the one new decision
 *     this item actually asks for: given an advisory (signed and verified,
 *     or self-attested for a learner's own local check), it refuses to clear
 *     a configuration for use unless *every* one of three independently
 *     named gates holds — capability compatibility, a license bucket that is
 *     not `"denied"`, and the runtime artifact's content fingerprint still
 *     matching whatever fingerprint the advisory itself recorded (so a
 *     binary swapped in place after the advisory was produced is caught,
 *     not silently waved through). Exactly one gate failing is enough to
 *     quarantine; the result always names every gate that failed, not just
 *     the first, matching `assessCompatibility`'s own "report every gap"
 *     discipline rather than stopping at the first problem found.
 *
 * What this module deliberately does not do: it does not fetch a real CVE
 * feed for models (there is no equivalent of `npm audit` for local model
 * weights to reuse, the same gap `local-model-evaluation.mjs` already
 * documented for an energy meter), and it does not re-derive license-bucket
 * policy — a license denied for an npm dependency is denied for a model
 * artifact under the exact same policy object, not a parallel one that could
 * drift from it.
 */

export const MODEL_ADVISORY_VERSION = 1;
export const MODEL_ADVISORY_SUBJECT = "model-advisory";

/**
 * Classify one declared license identifier into the same three buckets
 * `supply-chain.mjs`'s own `scanDependencies` already reports for a
 * dependency, read off the identical policy object so a model artifact and
 * an npm package are never governed by two different lists that could say
 * different things about the same license string.
 */
export function classifyModelLicense(declared, policy = DEFAULT_LICENSE_POLICY) {
  if (!declared) return { bucket: "unknown", license: null };
  const license = String(declared).trim();
  if (policy.denied.includes(license)) return { bucket: "denied", license };
  if (policy.allowed.includes(license)) return { bucket: "allowed", license };
  if (policy.review.includes(license)) return { bucket: "review", license };
  return { bucket: "unrecognized", license };
}

/**
 * Build one advisory record for a local model artifact: its real content
 * fingerprint, its configuration fingerprint, its real capability
 * compatibility verdict, and its license bucket. Every field is produced by
 * an existing, unmodified function; this function only assembles them.
 */
export function buildModelAdvisory({ artifactBytes, declaredLicense, config, notes = null, licensePolicy = DEFAULT_LICENSE_POLICY } = {}) {
  const artifactFingerprint = fingerprintRuntimeArtifact(artifactBytes);
  const configFingerprint = fingerprintModel(config ?? {});
  const compatibility = assessCompatibility(config ?? {});
  const license = classifyModelLicense(declaredLicense, licensePolicy);
  return {
    version: MODEL_ADVISORY_VERSION,
    artifactFingerprint,
    configFingerprint,
    provider: config?.provider ?? null,
    model: config?.model ?? null,
    compatibility,
    license,
    notes,
    issuedAt: new Date().toISOString(),
  };
}

/**
 * Sign an advisory record the same way every other signable artifact in
 * this app is signed: delegating entirely to `signing.mjs`'s own
 * `signPayload` (unmodified) under this module's own subject, never a
 * subject another kind of artifact already owns.
 */
export function signModelAdvisory(advisory, keyPair) {
  return { ...advisory, signature: signPayload(MODEL_ADVISORY_SUBJECT, advisory, keyPair) };
}

/**
 * Verify an advisory's signature, delegating entirely to `signing.mjs`'s own
 * `verifyPayload` (unmodified) under this module's own subject. The
 * signature field itself is stripped from the payload before verifying,
 * matching `plugins.mjs`'s own `manifestPayload` precedent — a signature
 * cannot cover itself.
 */
export function verifyModelAdvisory(advisory, options = {}) {
  const { signature, ...payload } = advisory ?? {};
  return verifyPayload(MODEL_ADVISORY_SUBJECT, payload, signature ?? null, options);
}

/**
 * Decide whether a local model configuration may be used, given its signed
 * (or self-attested) advisory and the artifact currently on disk.
 *
 * Refuses unless every one of three independently named gates holds:
 *   1. **compatibility** — `assessCompatibility`'s own verdict, carried
 *      through from the advisory, must say `compatible: true`;
 *   2. **license** — the advisory's license bucket must not be `"denied"`;
 *   3. **artifact integrity** — the artifact's *current* content
 *      fingerprint must match the fingerprint the advisory itself recorded,
 *      so a binary swapped in place after the advisory was produced is
 *      caught rather than silently waved through.
 *
 * All three are checked and *every* failing gate is named in `reasons`, not
 * just the first — the same "report every gap" discipline
 * `assessCompatibility` itself already follows.
 */
export function evaluateModelForQuarantine(advisory, currentArtifactBytes) {
  const reasons = [];
  if (!advisory?.compatibility?.compatible) {
    reasons.push({ gate: "compatibility", detail: (advisory?.compatibility?.reasons ?? ["No compatibility verdict was recorded."]).join(" ") });
  }
  if (advisory?.license?.bucket === "denied") {
    reasons.push({ gate: "license", detail: `Licensed ${advisory.license.license}, which the policy denies.` });
  } else if (advisory?.license?.bucket === "unknown") {
    reasons.push({ gate: "license", detail: "No license identifier was recorded for this artifact." });
  }
  const currentFingerprint = fingerprintRuntimeArtifact(currentArtifactBytes);
  if (currentFingerprint !== advisory?.artifactFingerprint) {
    reasons.push({ gate: "artifact-integrity", detail: `The artifact on disk (${currentFingerprint}) does not match the fingerprint this advisory was issued for (${advisory?.artifactFingerprint ?? "(none)"}).` });
  }

  if (reasons.length) {
    return { cleared: false, quarantined: true, reasons, checkedAt: new Date().toISOString() };
  }
  return { cleared: true, quarantined: false, reasons: [], checkedAt: new Date().toISOString() };
}

/** The strict-sort order severities would use if this module ever needs to
 * rank a quarantine reason against supply-chain.mjs's own finding severities
 * — exposed so a caller can compose the two without this module inventing a
 * second severity scale. */
export function modelAdvisorySeverityOrder() {
  return [...FINDING_SEVERITIES];
}
