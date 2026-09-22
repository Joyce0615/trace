import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Signing for courses, source anchors, assessments, and cached agent output.
 *
 * Items 32, 34, and 44 all rest on the same unstated assumption: that the thing
 * being read is the thing that was produced. A course package is a file a
 * learner may receive from someone else; a cached agent answer is a file on
 * disk that any process on the machine can rewrite; a lesson's anchors decide
 * what a learner is shown as ground truth. None of those are self-protecting.
 *
 * Ed25519 signatures over a **canonical** serialisation make tampering
 * detectable. Three properties matter:
 *
 *   - *Canonicalisation.* Keys are sorted recursively before hashing, so a
 *     signature survives a JSON round trip, re-ordering by a structured clone,
 *     or a different key insertion order. Without it every signature would be
 *     valid exactly once.
 *   - *Subject binding.* The signed payload includes what kind of thing it is,
 *     so a signature over a cached answer cannot be lifted onto a course
 *     package.
 *   - *Trust is separate from validity.* An intact signature from an unknown
 *     key is `untrusted`, not `invalid`. Conflating them either teaches people
 *     to ignore warnings or refuses legitimate material from a new author.
 *
 * The key pair is generated locally and the private key never leaves the
 * machine; nothing here contacts a network or a certificate authority.
 */

export const SIGNING_VERSION = 1;
export const SIGNING_ALGORITHM = "ed25519";

/** The kinds of thing that can be signed. A signature is bound to exactly one. */
export const SIGNABLE_SUBJECTS = ["course-package", "source-anchors", "assessment", "agent-response", "offline-archive"];

/**
 * Deterministic serialisation: object keys sorted at every depth, arrays left
 * in order. Two structurally equal payloads always produce the same bytes.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

export function digestOf(subject, payload) {
  if (!SIGNABLE_SUBJECTS.includes(subject)) throw new Error(`Unknown signing subject: ${subject}`);
  // The subject is inside the hash, so a signature cannot be moved between kinds.
  return createHash("sha256").update(`${SIGNING_ALGORITHM}:${subject}:`).update(canonicalize(payload)).digest("hex");
}

export function keyIdFor(publicKeyPem) {
  return createHash("sha256").update(String(publicKeyPem).trim()).digest("hex").slice(0, 32);
}

/** Generate a local key pair. The private half is never returned to a renderer. */
export function createKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    version: SIGNING_VERSION,
    algorithm: SIGNING_ALGORITHM,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem,
    keyId: keyIdFor(publicKeyPem),
    createdAt: new Date().toISOString(),
  };
}

/** Sign one payload for one subject. */
export function signPayload(subject, payload, keyPair) {
  const digest = digestOf(subject, payload);
  const signature = cryptoSign(null, Buffer.from(digest, "hex"), createPrivateKey(keyPair.privateKeyPem));
  return {
    algorithm: SIGNING_ALGORITHM,
    subject,
    keyId: keyPair.keyId,
    publicKey: keyPair.publicKeyPem,
    digest,
    signature: signature.toString("base64"),
    signedAt: new Date().toISOString(),
  };
}

/**
 * Verify a signature against the payload as it stands now.
 *
 * `trust` is reported separately from `verified`: an intact signature from a
 * key the learner has not trusted is a decision for them to make, not a
 * failure.
 */
export function verifyPayload(subject, payload, signature, options = {}) {
  const trusted = new Set(options.trustedKeyIds ?? []);
  if (!signature) return { verified: false, reason: "not-signed", trust: "unsigned", keyId: null, subject };
  if (signature.algorithm !== SIGNING_ALGORITHM) return { verified: false, reason: `unsupported-algorithm:${signature.algorithm}`, trust: "invalid", keyId: signature.keyId ?? null, subject };
  if (signature.subject !== subject) return { verified: false, reason: `subject-mismatch:${signature.subject}`, trust: "invalid", keyId: signature.keyId ?? null, subject };

  let digest;
  try {
    digest = digestOf(subject, payload);
  } catch {
    return { verified: false, reason: "unknown-subject", trust: "invalid", keyId: signature.keyId ?? null, subject };
  }
  if (digest !== signature.digest) {
    return { verified: false, reason: "content-changed", trust: "invalid", keyId: signature.keyId ?? null, subject, expected: signature.digest, actual: digest };
  }
  // A key id that does not match its own public key means the key was swapped
  // for one whose signature would verify.
  if (signature.publicKey && keyIdFor(signature.publicKey) !== signature.keyId) {
    return { verified: false, reason: "key-id-mismatch", trust: "invalid", keyId: signature.keyId ?? null, subject };
  }

  const publicKeyPem = options.publicKeyPem ?? signature.publicKey;
  if (!publicKeyPem) return { verified: false, reason: "no-public-key", trust: "invalid", keyId: signature.keyId ?? null, subject };
  let ok = false;
  try {
    ok = cryptoVerify(null, Buffer.from(digest, "hex"), createPublicKey(publicKeyPem), Buffer.from(signature.signature, "base64"));
  } catch {
    ok = false;
  }
  if (!ok) return { verified: false, reason: "bad-signature", trust: "invalid", keyId: signature.keyId ?? null, subject };
  return {
    verified: true,
    reason: null,
    trust: trusted.has(signature.keyId) ? "trusted" : "untrusted",
    keyId: signature.keyId,
    subject,
    signedAt: signature.signedAt ?? null,
  };
}

/**
 * The payload a course package is signed over.
 *
 * The seal cannot cover itself, and it must not cover the *other* seals either:
 * the anchor signature is attached after the package is signed, so including it
 * would make every package fail its own verification. Everything else —
 * provenance, license policy, every anchor with its blob id, and the course
 * content — is covered, so changing any of it breaks the seal.
 */
export function packagePayload(packaged) {
  const { signature, anchorSignature, ...rest } = packaged ?? {};
  return rest;
}

/** Sign a course package in place, returning a new package. */
export function signPackage(packaged, keyPair) {
  return { ...packaged, signature: signPayload("course-package", packagePayload(packaged), keyPair) };
}

export function verifyPackageSignature(packaged, options = {}) {
  return verifyPayload("course-package", packagePayload(packaged), packaged?.signature, options);
}

/**
 * Anchors are signed as their own subject as well as inside the package, so a
 * lesson's ground truth can be checked without trusting the rest of the file.
 */
export function anchorPayload(anchors) {
  return (anchors ?? [])
    .map((anchor) => ({ lessonId: anchor.lessonId ?? null, path: anchor.path, line: anchor.line, symbol: anchor.symbol ?? null, blobId: anchor.blobId ?? null }))
    .sort((left, right) => `${left.lessonId}|${left.path}|${left.line}`.localeCompare(`${right.lessonId}|${right.path}|${right.line}`));
}

/** The parts of a graded assessment worth sealing: who scored what, on what. */
export function assessmentPayload(result) {
  return {
    kind: result?.kind ?? null,
    taskId: result?.taskId ?? result?.quizId ?? result?.predictionId ?? null,
    score: result?.score ?? null,
    passed: result?.passed ?? result?.correct ?? null,
    repositoryId: result?.repositoryId ?? null,
    sourceVersion: result?.sourceVersion ?? null,
    at: result?.at ?? null,
  };
}

/** The parts of a cached agent response worth sealing. */
export function responsePayload(response) {
  return {
    text: response?.text ?? null,
    answeredBy: response?.answeredBy ?? null,
    cacheKey: response?.cacheKey ?? null,
  };
}

// ---------------------------------------------------------------------------
// Local key storage
// ---------------------------------------------------------------------------

function keyPath(directory) {
  return path.join(directory, "signing-key.json");
}

function trustPath(directory) {
  return path.join(directory, "trusted-keys.json");
}

/**
 * Load the machine's signing key, creating one on first use.
 *
 * The file is written 0600 and never leaves this machine; `publicIdentity` is
 * the only part that may cross an IPC boundary.
 */
export async function loadOrCreateKeyPair(directory) {
  try {
    const parsed = JSON.parse(await readFile(keyPath(directory), "utf8"));
    if (parsed?.privateKeyPem && parsed?.publicKeyPem) {
      return { ...parsed, keyId: parsed.keyId ?? keyIdFor(parsed.publicKeyPem) };
    }
  } catch {
    // No key yet, or an unreadable one: make a fresh pair.
  }
  const created = createKeyPair();
  await mkdir(directory, { recursive: true });
  const destination = keyPath(directory);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(created, null, 2), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  return created;
}

/** What a renderer may see about the signing key. */
export function publicIdentity(keyPair) {
  return { algorithm: SIGNING_ALGORITHM, keyId: keyPair.keyId, publicKey: keyPair.publicKeyPem, createdAt: keyPair.createdAt ?? null };
}

export async function loadTrustedKeys(directory) {
  try {
    const parsed = JSON.parse(await readFile(trustPath(directory), "utf8"));
    return Array.isArray(parsed?.keyIds) ? parsed.keyIds : [];
  } catch {
    return [];
  }
}

/** Trust or untrust a key id. Trust is explicit and reversible. */
export async function setKeyTrust(directory, keyId, trusted) {
  const existing = new Set(await loadTrustedKeys(directory));
  if (trusted) existing.add(keyId);
  else existing.delete(keyId);
  await mkdir(directory, { recursive: true });
  const destination = trustPath(directory);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: SIGNING_VERSION, keyIds: [...existing] }, null, 2));
  await rename(temporary, destination);
  return [...existing];
}
