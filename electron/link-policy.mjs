/**
 * External link policy.
 *
 * The renderer can never open a URL directly. Every candidate is classified here:
 * non-http(s) schemes are blocked outright, a small allowlist of documentation and
 * source-hosting origins opens without friction, and everything else requires an
 * explicit confirmation that shows the learner the exact destination.
 */

export const LINK_POLICY_VERSION = 1;

// Origins a codebase learner routinely needs, and which cannot be used to
// exfiltrate repository content through a crafted path.
export const ALLOWED_ORIGINS = [
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "arxiv.org",
  "developer.mozilla.org",
  "docs.python.org",
  "doc.rust-lang.org",
  "pkg.go.dev",
  "www.typescriptlang.org",
  "docs.pytorch.org",
  "pytorch.org",
  "en.cppreference.com",
  "docs.nvidia.com",
];

const BLOCKED_SCHEMES = ["javascript:", "data:", "vbscript:", "file:", "blob:", "about:", "chrome:", "devtools:", "intent:", "ms-msdt:", "smb:"];
const MAX_LINK_LENGTH = 2_048;

function normalizeHost(host) {
  return String(host ?? "").toLowerCase().replace(/\.$/, "");
}

function isAllowedHost(host, extraOrigins) {
  const normalized = normalizeHost(host);
  return [...ALLOWED_ORIGINS, ...extraOrigins].some((origin) => {
    const allowed = normalizeHost(origin);
    return normalized === allowed || normalized.endsWith(`.${allowed}`);
  });
}

/**
 * Classify a link. Never throws: an unparsable or hostile URL is simply blocked.
 *
 * @returns {{ decision: "allow"|"confirm"|"block", reason: string, url: string|null, host: string|null }}
 */
export function classifyExternalLink(candidate, options = {}) {
  const raw = String(candidate ?? "").trim();
  const extraOrigins = (options.additionalOrigins ?? []).filter((origin) => typeof origin === "string" && origin.length < 256);

  if (!raw) return { decision: "block", reason: "empty-url", url: null, host: null };
  if (raw.length > MAX_LINK_LENGTH) return { decision: "block", reason: "url-too-long", url: null, host: null };
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { decision: "block", reason: "control-characters", url: null, host: null };

  const scheme = raw.slice(0, raw.indexOf(":") + 1).toLowerCase();
  if (BLOCKED_SCHEMES.includes(scheme)) return { decision: "block", reason: `blocked-scheme:${scheme.replace(":", "")}`, url: null, host: null };

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { decision: "block", reason: "unparsable", url: null, host: null };
  }

  if (url.protocol === "http:") {
    // Downgrade attacks and cleartext exfiltration are never worth a confirmation prompt.
    return { decision: "block", reason: "insecure-scheme", url: null, host: normalizeHost(url.hostname) };
  }
  if (url.protocol !== "https:") {
    return { decision: "block", reason: `blocked-scheme:${url.protocol.replace(":", "")}`, url: null, host: normalizeHost(url.hostname) };
  }
  if (url.username || url.password) {
    return { decision: "block", reason: "embedded-credentials", url: null, host: normalizeHost(url.hostname) };
  }
  if (!url.hostname) return { decision: "block", reason: "missing-host", url: null, host: null };

  const host = normalizeHost(url.hostname);
  const normalizedUrl = url.toString();
  if (isAllowedHost(host, extraOrigins)) {
    return { decision: "allow", reason: "allowlisted-origin", url: normalizedUrl, host };
  }
  return { decision: "confirm", reason: "unlisted-origin", url: normalizedUrl, host };
}

/** Origins derived from the open repository, so its own host needs no confirmation. */
export function repositoryOrigins(repository) {
  const remote = repository?.remoteUrl ?? repository?.remote?.normalized;
  if (!remote) return [];
  try {
    if (remote.startsWith("http")) return [normalizeHost(new URL(remote).hostname)];
    const scp = remote.match(/^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):/);
    return scp ? [normalizeHost(scp[1])] : [];
  } catch {
    return [];
  }
}

export function confirmationPrompt(classification) {
  return {
    title: "Open an external link?",
    message: `Trace is about to open ${classification.host} in your browser.`,
    detail: `${classification.url}\n\nThis origin is not on Trace's allowlist. Only continue if you recognise it.`,
    buttons: ["Cancel", "Open link"],
    cancelId: 0,
    defaultId: 0,
  };
}

/** In-app navigation is confined to the bundled renderer and the local dev server. */
export function isInternalNavigation(candidate, developmentUrl) {
  const raw = String(candidate ?? "");
  if (raw.startsWith("file://")) return true;
  if (!developmentUrl) return false;
  try {
    return new URL(raw).origin === new URL(developmentUrl).origin;
  } catch {
    return false;
  }
}
