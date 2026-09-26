/**
 * Deep links, treated as what they are: untrusted input handed to the app by
 * the operating system.
 *
 * A `trace://` URL can arrive from a browser, a chat message, a calendar
 * invitation, or a malicious page that guessed the scheme. It is not typed by
 * the person sitting at the machine and it must not be able to do anything they
 * did not ask for. So this module parses rather than dispatches, and returns an
 * *intent* the caller may then apply — never a side effect.
 *
 * Three rules do the work:
 *
 *   - **A link may only ask for things already open.** It names a repository by
 *     path, and the caller matches that against the repositories the learner
 *     opened. A link cannot cause a clone, cannot cause an index of an
 *     arbitrary directory, and cannot reach a path outside the repository it
 *     names — the same containment `repository:read-file` enforces, applied one
 *     layer earlier so a bad link is rejected before anything touches disk.
 *   - **Unknown parameters are refused, not ignored.** A link with a parameter
 *     this build does not understand is a link written for a different build,
 *     and guessing at it is how a "harmless" extra field becomes an injection.
 *   - **Every rejection says why.** A deep link that silently does nothing is
 *     indistinguishable from a broken app.
 *
 * Node-free so the tests, the main process, and the demo share one parser.
 */

export const DEEP_LINK_VERSION = 1;
export const DEEP_LINK_SCHEME = "trace";

/** Everything a link may ask for. Anything else is refused. */
export const DEEP_LINK_ACTIONS = {
  open: { required: ["repo"], optional: ["file", "line", "lesson", "view"] },
  lesson: { required: ["repo", "lesson"], optional: ["view"] },
  file: { required: ["repo", "file"], optional: ["line"] },
};

export const DEEP_LINK_VIEWS = ["lesson", "diagram", "code", "chains", "locate", "review", "notes"];

const MAX_LINK_LENGTH = 2_048;
const MAX_PARAMETER_LENGTH = 1_024;

function refuse(reason, detail) {
  return { valid: false, reason, detail, intent: null };
}

/**
 * Is a repository-relative path safe to act on?
 *
 * Absolute paths, parent traversal, and Windows drive letters are all refused
 * outright rather than normalized, because normalizing an attack into something
 * that looks fine is how traversal bugs survive review.
 */
export function isSafeRelativePath(value) {
  if (typeof value !== "string" || !value || value.length > MAX_PARAMETER_LENGTH) return false;
  if (value.startsWith("/") || value.startsWith("\\") || /^[a-zA-Z]:/.test(value)) return false;
  if (value.includes("\0")) return false;
  return !value.split(/[/\\]/).some((segment) => segment === ".." || segment === "");
}

/**
 * Parse a `trace://` URL into an intent.
 *
 * `openRepositories` is the list the learner actually has open; a link naming
 * anything else is refused. Passing an empty list is meaningful — it means
 * nothing is open, and every link should be refused rather than queued.
 */
export function parseDeepLink(url, options = {}) {
  const raw = String(url ?? "");
  if (!raw) return refuse("empty", "No link was provided.");
  if (raw.length > MAX_LINK_LENGTH) return refuse("too-long", `A deep link may not exceed ${MAX_LINK_LENGTH} characters.`);

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return refuse("unparsable", "That is not a URL.");
  }
  if (parsed.protocol !== `${DEEP_LINK_SCHEME}:`) {
    return refuse("wrong-scheme", `Only ${DEEP_LINK_SCHEME}: links are handled; this was ${parsed.protocol.replace(":", "")}:.`);
  }
  // `trace://open?…` puts the action in the host; `trace:/open?…` puts it in the
  // path. Both are accepted because both are produced in the wild, and neither
  // is allowed to be empty.
  const action = (parsed.hostname || parsed.pathname.replace(/^\/+/, "").split("/")[0] || "").toLowerCase();
  const declared = DEEP_LINK_ACTIONS[action];
  if (!declared) return refuse("unknown-action", `“${action || "(none)"}” is not something a link can ask for.`);

  const parameters = {};
  for (const [key, value] of parsed.searchParams) {
    if (!declared.required.includes(key) && !declared.optional.includes(key)) {
      // Refused rather than dropped: an unrecognised parameter means the link
      // was written for a different build, and acting on the rest of it is a
      // guess about what its author meant.
      return refuse("unknown-parameter", `“${key}” is not a parameter of ${action}.`);
    }
    if (value.length > MAX_PARAMETER_LENGTH) return refuse("parameter-too-long", `“${key}” is too long.`);
    if (parameters[key] !== undefined) return refuse("duplicate-parameter", `“${key}” was given twice.`);
    parameters[key] = value;
  }
  for (const key of declared.required) {
    if (!parameters[key]) return refuse("missing-parameter", `${action} needs a “${key}”.`);
  }

  const open = options.openRepositories ?? [];
  const repository = open.find((candidate) => candidate.rootPath === parameters.repo || candidate.id === parameters.repo);
  if (!repository) {
    return refuse("unknown-repository", "That repository is not open. Open it first; a link cannot open one for you.");
  }

  if (parameters.file !== undefined && !isSafeRelativePath(parameters.file)) {
    return refuse("unsafe-path", "A link may only point at a path inside the repository.");
  }
  let line = null;
  if (parameters.line !== undefined) {
    if (!/^\d{1,7}$/.test(parameters.line)) return refuse("bad-line", "A line number must be a positive integer.");
    line = Math.max(1, Number(parameters.line));
  }
  if (parameters.view !== undefined && !DEEP_LINK_VIEWS.includes(parameters.view)) {
    return refuse("unknown-view", `“${parameters.view}” is not a view.`);
  }
  if (parameters.lesson !== undefined && !/^[\w.:-]{1,120}$/.test(parameters.lesson)) {
    return refuse("bad-lesson", "A lesson id may only contain letters, digits, and -._:");
  }

  return {
    valid: true,
    reason: null,
    detail: null,
    intent: {
      action,
      repository: { id: repository.id, rootPath: repository.rootPath },
      file: parameters.file ?? null,
      line,
      lesson: parameters.lesson ?? null,
      view: parameters.view ?? (parameters.file ? "code" : null),
    },
  };
}

/** Build a link for an intent, so the app can offer "copy link to this lesson". */
export function formatDeepLink(intent) {
  const parameters = new URLSearchParams();
  parameters.set("repo", intent.repository?.rootPath ?? intent.repo ?? "");
  if (intent.file) parameters.set("file", intent.file);
  if (intent.line) parameters.set("line", String(intent.line));
  if (intent.lesson) parameters.set("lesson", intent.lesson);
  if (intent.view) parameters.set("view", intent.view);
  return `${DEEP_LINK_SCHEME}://${intent.action ?? "open"}?${parameters.toString()}`;
}

/**
 * The first `trace://` argument in a process argv.
 *
 * On Windows and Linux a second launch delivers the link as a command-line
 * argument rather than an event, so the argv has to be searched — and only for
 * the scheme, because the rest of argv is the app's own switches.
 */
export function deepLinkFromArgv(argv = []) {
  return argv.find((argument) => typeof argument === "string" && argument.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`)) ?? null;
}
