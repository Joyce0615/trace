import { createHash } from "node:crypto";
import { SIGNABLE_SUBJECTS, signPayload, verifyPayload } from "./signing.mjs";

/**
 * Update manifests, and the rules for accepting one.
 *
 * An auto-updater is the single most dangerous feature a desktop application
 * has: it downloads code from the network and runs it with the learner's
 * privileges, on a schedule, without being asked. Everything else in this
 * project is careful about reading a repository; none of that matters if the
 * updater can be talked into installing anything.
 *
 * So the interesting part is not fetching — it is *refusing*. A candidate is
 * accepted only when every one of these holds, and each rejection names which
 * one failed:
 *
 *   - **The manifest is signed by a key this installation trusts.** Item 45's
 *     Ed25519 signing, with `update-manifest` as its own subject so a signature
 *     over a course package can never be lifted onto an update.
 *   - **The version is strictly newer.** A downgrade is how a signed *old*
 *     release with a known vulnerability gets re-installed, so the rule is not
 *     "different version" but "greater version", compared numerically rather
 *     than as strings — `0.10.0` is newer than `0.9.0`, and a string comparison
 *     says the opposite.
 *   - **The artifact is the one the manifest describes.** The digest is checked
 *     against the bytes actually downloaded, not against a length or a name.
 *   - **The platform, architecture, and channel match.** An arm64 build handed
 *     to an x64 machine is not an update, it is a broken installation; a beta
 *     handed to somebody on stable is a decision they did not make.
 *
 * Node is used only for the digest; everything else is pure so the rules can be
 * tested without a network, a server, or a release.
 */

export const UPDATE_MANIFEST_FORMAT = "trace-update-v1";
export const UPDATE_MANIFEST_VERSION = 1;
export const UPDATE_CHANNELS = ["stable", "beta"];
export const UPDATE_PLATFORMS = ["darwin", "win32", "linux"];

/** Digest of the bytes that will actually be executed. */
export function artifactDigest(bytes) {
  return `sha512:${createHash("sha512").update(bytes).digest("base64")}`;
}

/**
 * Compare two semantic versions numerically.
 *
 * Returns a negative number when `left` is older. Pre-release identifiers sort
 * *before* the release they lead to, which is what makes `1.0.0-beta.1` an
 * upgrade path to `1.0.0` rather than a downgrade from it.
 */
export function compareVersions(left, right) {
  const parse = (value) => {
    const [core, pre = ""] = String(value ?? "").split("-", 2);
    return { numbers: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const first = parse(left);
  const second = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (first.numbers[index] ?? 0) - (second.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (first.pre === second.pre) return 0;
  // A release beats its own pre-releases; between two pre-releases, compare.
  if (!first.pre) return 1;
  if (!second.pre) return -1;
  return first.pre < second.pre ? -1 : 1;
}

/** Build the manifest for one release. Signed separately, never in place. */
export function buildUpdateManifest(release) {
  return {
    format: UPDATE_MANIFEST_FORMAT,
    version: UPDATE_MANIFEST_VERSION,
    product: release.product ?? "trace",
    releaseVersion: release.releaseVersion,
    channel: UPDATE_CHANNELS.includes(release.channel) ? release.channel : "stable",
    releasedAt: release.releasedAt ?? new Date().toISOString(),
    notes: String(release.notes ?? "").slice(0, 4_000),
    // The minimum version that may update *to* this one, so a release that
    // changes the on-disk format can refuse to be installed over one that
    // cannot read what it writes.
    minimumFrom: release.minimumFrom ?? null,
    artifacts: (release.artifacts ?? []).map((artifact) => ({
      platform: artifact.platform,
      arch: artifact.arch,
      target: artifact.target,
      name: artifact.name,
      size: artifact.size,
      digest: artifact.digest,
      url: artifact.url ?? null,
    })),
  };
}

/** Sign a manifest under its own subject. */
export function signUpdateManifest(manifest, keyPair) {
  if (!SIGNABLE_SUBJECTS.includes("update-manifest")) throw new Error("update-manifest is not a signable subject.");
  return { ...manifest, signature: signPayload("update-manifest", manifest, keyPair) };
}

function refuse(reason, detail) {
  return { acceptable: false, reason, detail, artifact: null };
}

/**
 * Decide whether an update may be installed.
 *
 * `current` describes this installation; `manifest` is what a server offered;
 * `downloadedBytes` is optional and, when present, is what turns "the manifest
 * says so" into "the bytes on disk are those bytes".
 */
export function evaluateUpdate(manifest, current, options = {}) {
  const { signature, ...payload } = manifest ?? {};
  if (payload?.format !== UPDATE_MANIFEST_FORMAT) {
    return refuse("unreadable", `Not a Trace update manifest (${payload?.format ?? "no format"}).`);
  }
  if (Number(payload.version) > UPDATE_MANIFEST_VERSION) {
    return refuse("unreadable", `Manifest version ${payload.version} is newer than this build understands.`);
  }
  if (payload.product !== (current.product ?? "trace")) {
    return refuse("wrong-product", `This manifest is for “${payload.product}”, not “${current.product ?? "trace"}”.`);
  }

  // The signature is checked before anything in the manifest is believed.
  const seal = verifyPayload("update-manifest", payload, signature ?? null, { trustedKeyIds: options.trustedKeyIds ?? [] });
  if (!seal.verified) return { ...refuse("unsigned-or-tampered", `The manifest's signature did not verify (${seal.reason}).`), seal };
  if (seal.trust !== "trusted") {
    // An intact signature from an unknown key is not an update. For a course
    // package that distinction earns a warning; for code that will execute, it
    // is a refusal.
    return { ...refuse("untrusted-key", `The manifest is signed by ${seal.keyId}, which this installation does not trust.`), seal };
  }

  if (payload.channel !== (current.channel ?? "stable")) {
    return { ...refuse("wrong-channel", `This is a ${payload.channel} release and this installation follows ${current.channel ?? "stable"}.`), seal };
  }
  const step = compareVersions(payload.releaseVersion, current.version);
  if (step === 0) return { ...refuse("already-current", `Already on ${current.version}.`), seal };
  if (step < 0) {
    return { ...refuse("downgrade", `${payload.releaseVersion} is older than the installed ${current.version}; a signed old release is still an old release.`), seal };
  }
  if (payload.minimumFrom && compareVersions(current.version, payload.minimumFrom) < 0) {
    return { ...refuse("upgrade-path", `${payload.releaseVersion} can only be installed over ${payload.minimumFrom} or newer; this is ${current.version}.`), seal };
  }

  const artifact = (payload.artifacts ?? []).find((candidate) => candidate.platform === current.platform && candidate.arch === current.arch);
  if (!artifact) {
    return { ...refuse("no-artifact", `${payload.releaseVersion} has no build for ${current.platform}/${current.arch}.`), seal };
  }
  if (!/^sha512:[A-Za-z0-9+/=]{64,}$/.test(artifact.digest ?? "")) {
    return { ...refuse("bad-digest", "The artifact's digest is missing or malformed."), seal };
  }

  if (options.downloadedBytes !== undefined && options.downloadedBytes !== null) {
    const actual = artifactDigest(options.downloadedBytes);
    if (actual !== artifact.digest) {
      return { ...refuse("digest-mismatch", "The downloaded file is not the one the manifest describes."), seal };
    }
    if (typeof artifact.size === "number" && options.downloadedBytes.length !== artifact.size) {
      return { ...refuse("size-mismatch", `The download is ${options.downloadedBytes.length} bytes; the manifest says ${artifact.size}.`), seal };
    }
  }

  return {
    acceptable: true,
    reason: null,
    detail: null,
    seal,
    artifact,
    from: current.version,
    to: payload.releaseVersion,
    verifiedBytes: options.downloadedBytes !== undefined && options.downloadedBytes !== null,
  };
}

/**
 * A sentence for the learner.
 *
 * An updater that says "update failed" teaches people to click through it; one
 * that says which check failed is one somebody can act on — or report.
 */
export function describeUpdate(result) {
  if (result.acceptable) {
    return `Update ${result.from} → ${result.to} for ${result.artifact.platform}/${result.artifact.arch}${result.verifiedBytes ? ", verified against the downloaded file" : ", not yet downloaded"}.`;
  }
  return `No update: ${result.detail}`;
}
