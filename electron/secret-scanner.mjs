
/**
 * Secret and personal-data scanning.
 *
 * Anything that leaves the learner's machine (agent prompts), or is written to
 * disk for reuse (response caches, learner state, exports), is scanned first.
 * Findings never carry the raw match: only a type, a location, and a masked
 * preview. `redact` is applied before the value is transmitted or persisted.
 */

export const SECRET_SCANNER_VERSION = 1;

const DETECTORS = [
  { id: "private-key", severity: "critical", expression: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,64}/g },
  { id: "aws-access-key", severity: "critical", expression: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { id: "aws-secret-key", severity: "critical", expression: /\baws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}["']?/gi },
  { id: "github-token", severity: "critical", expression: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { id: "slack-token", severity: "critical", expression: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: "google-api-key", severity: "critical", expression: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "stripe-key", severity: "critical", expression: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { id: "anthropic-key", severity: "critical", expression: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: "openai-key", severity: "critical", expression: /\bsk-(?!ant-)[A-Za-z0-9]{32,}\b/g },
  { id: "jwt", severity: "high", expression: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: "credential-uri", severity: "critical", expression: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@[^\s/]+/gi },
  { id: "assigned-secret", severity: "high", hasCapture: true, expression: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[=:]\s*["']?([^\s"',;]{8,})["']?/gi },
  { id: "email-address", severity: "medium", expression: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { id: "home-directory", severity: "low", expression: /\/(?:Users|home)\/[A-Za-z0-9._-]+/g },
];

// Values that look like secrets but are unambiguously placeholders or examples.
const ALLOWED_VALUES = [
  /^(?:x{3,}|\*{3,}|\.{3,})$/i,
  /^(?:your|my|the)[-_]?(?:api[-_]?key|token|secret|password)$/i,
  /^(?:changeme|placeholder|example|redacted|dummy|test|none|null|undefined|todo|fixme)$/i,
  /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/,
  /^<[^>]+>$/,
];

const ALLOWED_EMAIL_DOMAINS = ["example.com", "example.org", "example.net", "localhost", "test.com", "noreply.github.com"];

function isAllowedValue(value) {
  const trimmed = String(value ?? "").trim().replace(/^["']|["']$/g, "");
  return ALLOWED_VALUES.some((pattern) => pattern.test(trimmed));
}

/** Shannon entropy in bits per character; real keys sit well above placeholders. */
export function shannonEntropy(value) {
  const text = String(value ?? "");
  if (!text.length) return 0;
  const counts = new Map();
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function mask(value) {
  const text = String(value ?? "");
  if (text.length <= 8) return "*".repeat(text.length);
  return `${text.slice(0, 3)}${"*".repeat(Math.min(12, text.length - 6))}${text.slice(-3)}`;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/**
 * Scan text for secrets and personal data.
 * Findings carry a masked preview only; the raw match is never returned.
 */
export function scanText(text, options = {}) {
  const value = String(text ?? "");
  const findings = [];
  const minimumEntropy = options.minimumEntropy ?? 3.0;
  for (const detector of DETECTORS) {
    detector.expression.lastIndex = 0;
    let match;
    while ((match = detector.expression.exec(value)) !== null) {
      const raw = match[0];
      const captured = match[1] ?? raw;
      if (isAllowedValue(captured)) continue;
      if (detector.id === "email-address" && ALLOWED_EMAIL_DOMAINS.some((domain) => raw.toLowerCase().endsWith(`@${domain}`))) continue;
      // Generic assignments need entropy support, or every `password = "hunter2"`
      // style example in documentation would be reported.
      if (detector.id === "assigned-secret" && shannonEntropy(captured) < minimumEntropy) continue;
      // The learner's own account name is personal data even at low entropy.
      if (detector.id === "home-directory" && raw === `/Users/${currentUserName()}` && options.includeOwnHome === false) continue;
      findings.push({
        id: detector.id,
        severity: detector.severity,
        line: lineOf(value, match.index),
        preview: mask(captured),
        length: raw.length,
      });
      if (findings.length >= (options.maxFindings ?? 200)) return findings;
      if (!detector.expression.global) break;
    }
  }
  return findings;
}

/** Replace every detected secret with a typed marker. Idempotent. */
export function redact(text) {
  let value = String(text ?? "");
  for (const detector of DETECTORS) {
    detector.expression.lastIndex = 0;
    value = value.replace(detector.expression, (...args) => {
      const match = args[0];
      // Only one detector has a capture group; without this check the replace
      // callback's `offset` argument would be mistaken for a captured value.
      const captured = detector.hasCapture ? args[1] : null;
      const target = captured ?? match;
      if (isAllowedValue(target)) return match;
      if (detector.id === "email-address" && ALLOWED_EMAIL_DOMAINS.some((domain) => match.toLowerCase().endsWith(`@${domain}`))) return match;
      if (detector.id === "assigned-secret" && shannonEntropy(target) < 3.0) return match;
      if (detector.id === "home-directory") return "~";
      if (captured) return match.replace(captured, `[REDACTED:${detector.id}]`);
      return `[REDACTED:${detector.id}]`;
    });
  }
  return value;
}

/**
 * The home directory, when there is a process to ask.
 *
 * This module is shared with the browser demo, so it must not import
 * `node:os`: Vite externalizes it and the *first call* throws, which is a
 * failure that only appears in the one target nobody runs under a debugger.
 * Where there is no process, the `home-directory` detector below still redacts
 * `/Users/name` and `/home/name` by shape.
 */
function homeDirectory() {
  const environment = typeof process === "undefined" ? null : process.env;
  return environment?.HOME || environment?.USERPROFILE || null;
}

function currentUserName() {
  const home = homeDirectory();
  return home ? home.split(/[/\\]/).filter(Boolean).at(-1) ?? "" : "";
}

/** Redact absolute paths that expose the user's account name. */
export function anonymizePath(filePath) {
  const home = homeDirectory();
  const value = String(filePath ?? "");
  if (!home || !value.startsWith(home)) return redact(value);
  const relative = value.slice(home.length).replace(/^[/\\]+/, "");
  return relative ? `~/${relative}` : "~";
}

/**
 * Scan and redact a whole context pack before it is sent to an agent.
 * Returns a new pack; the original is never mutated.
 */
export function scanContextPack(pack) {
  const findings = [];
  const sections = (pack.sections ?? []).map((section) => {
    const sectionFindings = scanText(section.content);
    if (!sectionFindings.length) return section;
    findings.push(...sectionFindings.map((finding) => ({ ...finding, section: section.title, source: section.source ?? null })));
    return { ...section, content: redact(section.content), redacted: true, secretFindings: sectionFindings };
  });
  return { ...pack, sections, secretFindings: findings, redactedSections: sections.filter((section) => section.redacted).length };
}

/** Recursively redact a value before it is written to a cache, log, or export. */
export function redactValue(value, depth = 0) {
  if (depth > 12) return value;
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, depth + 1)]));
  }
  return value;
}

export function summarizeFindings(findings) {
  const counts = {};
  for (const finding of findings) counts[finding.id] = (counts[finding.id] ?? 0) + 1;
  return {
    total: findings.length,
    critical: findings.filter((finding) => finding.severity === "critical").length,
    high: findings.filter((finding) => finding.severity === "high").length,
    byType: counts,
  };
}
