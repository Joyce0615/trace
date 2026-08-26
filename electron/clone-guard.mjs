import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Remote repository intake hardening.
 *
 * Every remote source is parsed and validated before it reaches `git`. The rules
 * are deliberately strict: only https and ssh transports, never embedded
 * credentials, never option-injection, never submodule checkout, and never an
 * archive that would have to be unpacked.
 */

export const ALLOWED_PROTOCOLS = ["https:", "ssh:"];
const MAX_URL_LENGTH = 512;
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const SCP_PATTERN = /^([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+):(?!\/)(.+)$/;
const ARCHIVE_EXTENSIONS = [".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".7z", ".rar", ".bundle"];

export class RemoteSourceError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "RemoteSourceError";
    this.reason = reason;
  }
}

export function looksRemote(value) {
  const trimmed = String(value ?? "").trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || SCP_PATTERN.test(trimmed) || /^[a-z][a-z0-9+.-]*::/i.test(trimmed);
}

function rejectShellHazards(value) {
  if (value.length > MAX_URL_LENGTH) throw new RemoteSourceError(`Repository URLs are limited to ${MAX_URL_LENGTH} characters.`, "too-long");
  // Control characters and newlines can smuggle extra arguments into helpers.
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new RemoteSourceError("Repository URLs cannot contain control characters.", "control-characters");
  // A leading dash would be parsed by git as an option rather than a URL.
  if (value.startsWith("-")) throw new RemoteSourceError("Repository URLs cannot start with a dash.", "option-injection");
}

function rejectArchive(pathname) {
  const lowered = pathname.toLowerCase().replace(/\.git$/, "");
  if (ARCHIVE_EXTENSIONS.some((extension) => lowered.endsWith(extension))) {
    throw new RemoteSourceError("Trace clones Git repositories and never unpacks downloaded archives.", "archive");
  }
}

/**
 * Validate and normalize a remote repository URL.
 * Throws `RemoteSourceError` with a machine-readable `reason` on rejection.
 */
export function parseRemoteSource(input) {
  const value = String(input ?? "").trim();
  if (!value) throw new RemoteSourceError("Choose a repository first.", "empty");
  rejectShellHazards(value);

  // Checked on the raw input: `new URL` silently collapses `..` segments.
  if (/(^|[/:])\.\.([/]|$)/.test(value)) {
    throw new RemoteSourceError("Repository URLs cannot contain path traversal segments.", "traversal");
  }

  // `ext::`, `git::`, and other transport-helper forms execute arbitrary commands.
  if (/^[a-z][a-z0-9+.-]*::/i.test(value)) {
    throw new RemoteSourceError("Git transport helpers such as `ext::` are not allowed.", "transport-helper");
  }

  const scp = value.match(SCP_PATTERN);
  if (scp) {
    const [, user, host, remotePath] = scp;
    if (!HOST_PATTERN.test(host)) throw new RemoteSourceError(`"${host}" is not a valid host name.`, "host");
    rejectArchive(remotePath);
    return {
      normalized: `${user}@${host}:${remotePath}`,
      protocol: "ssh:",
      host: host.toLowerCase(),
      pathname: remotePath,
      username: user,
      form: "scp",
    };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteSourceError("That does not look like a repository path or Git URL.", "unparsable");
  }

  if (url.protocol === "http:") {
    throw new RemoteSourceError("Plain http is not allowed; use https so the clone is authenticated and encrypted.", "insecure-protocol");
  }
  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    const supported = ALLOWED_PROTOCOLS.map((protocol) => protocol.replace(":", "")).join(" and ");
    throw new RemoteSourceError(`Only ${supported} remotes are supported, not ${url.protocol.replace(":", "")}.`, "protocol");
  }
  // A password is always a smuggled secret. A username is only legitimate for ssh,
  // where `ssh://git@host/...` is the canonical form; over https it is a token.
  if (url.password || (url.username && url.protocol !== "ssh:")) {
    throw new RemoteSourceError("Remove the credentials from the URL. Trace never accepts inline usernames or tokens.", "embedded-credentials");
  }
  if (!url.hostname || !HOST_PATTERN.test(url.hostname)) {
    throw new RemoteSourceError(`"${url.hostname}" is not a valid host name.`, "host");
  }
  if (url.hash || url.search) {
    throw new RemoteSourceError("Repository URLs cannot include a query string or fragment.", "url-extras");
  }
  rejectArchive(url.pathname);

  return {
    normalized: `${url.protocol}//${url.username ? `${url.username}@` : ""}${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`,
    protocol: url.protocol,
    host: url.hostname.toLowerCase(),
    port: url.port || null,
    pathname: url.pathname,
    username: url.username || null,
    form: "url",
  };
}

/** Directory name for a validated remote, always inside the managed clone root. */
export function cloneDestination(repositoriesDirectory, remote) {
  const base = path.basename(remote.pathname.replace(/\/+$/, "")).replace(/\.git$/i, "") || "repository";
  const safeBase = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 48) || "repository";
  const fingerprint = createHash("sha256").update(remote.normalized).digest("hex").slice(0, 9);
  const destination = path.join(repositoriesDirectory, `${safeBase}-${fingerprint}`);
  const relative = path.relative(repositoriesDirectory, destination);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new RemoteSourceError("Refusing to clone outside the managed repository directory.", "destination-escape");
  }
  return destination;
}

/**
 * Arguments for a hardened clone: shallow, single branch, no tags, no submodules,
 * no credential helpers, no transport helpers, and no symlink checkout.
 */
export function cloneArguments(remote, destination) {
  return [
    "-c", "credential.helper=",
    "-c", "protocol.ext.allow=never",
    "-c", "protocol.file.allow=never",
    "-c", "core.symlinks=false",
    "-c", "core.fsmonitor=false",
    "-c", "submodule.recurse=false",
    "-c", "http.followRedirects=false",
    "clone",
    "--depth=1",
    "--single-branch",
    "--no-tags",
    "--no-recurse-submodules",
    "--config", "submodule.recurse=false",
    "--",
    remote.normalized,
    destination,
  ];
}

/** Environment that disables every interactive and out-of-band credential path. */
export function cloneEnvironment(baseEnvironment = process.env) {
  const environment = { ...baseEnvironment };
  delete environment.GIT_ASKPASS;
  delete environment.SSH_ASKPASS;
  delete environment.GIT_PROXY_COMMAND;
  delete environment.GIT_SSH_COMMAND;
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "https:ssh",
    GCM_INTERACTIVE: "never",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
}

/**
 * Verify an existing clone directory before it is reused, so a cached folder can
 * never be silently repointed at a different remote.
 */
export function verifyExistingClone(remote, originUrl) {
  const actual = String(originUrl ?? "").trim();
  if (!actual) return { reusable: false, reason: "missing-origin" };
  let parsed;
  try {
    parsed = parseRemoteSource(actual);
  } catch {
    return { reusable: false, reason: "unverifiable-origin" };
  }
  if (parsed.normalized !== remote.normalized) return { reusable: false, reason: "origin-mismatch" };
  return { reusable: true, reason: null };
}

/** Submodule declarations are recorded for the learner but never checked out. */
export function summarizeSubmodules(gitmodulesText) {
  const declared = [...String(gitmodulesText ?? "").matchAll(/^\s*url\s*=\s*(.+)$/gm)].map((match) => match[1].trim());
  return {
    declared: declared.length,
    urls: declared.slice(0, 20),
    checkedOut: false,
    note: declared.length
      ? "Submodules are declared but intentionally not checked out. Lessons stay inside the parent repository."
      : "This repository declares no submodules.",
  };
}
