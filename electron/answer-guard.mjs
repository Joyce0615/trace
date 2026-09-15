/**
 * Answer-leak prevention and shared progressive scaffolding.
 *
 * Eight items now ship graded exercises, and each of them keeps its answer key
 * in the main process *by convention*. Convention is not a guarantee: one
 * spread operator, one forgotten `undefined`, and a learner can read the answer
 * out of the DOM with no indication that anything went wrong. This module turns
 * that convention into an enforced property.
 *
 *   - **Egress guard.** Every IPC response is audited before it is returned.
 *     Structural leaks are caught by a per-channel forbidden-key list applied
 *     at any depth; value leaks are caught by comparing the serialized response
 *     against the answer strings the main process registered when it built the
 *     task. A leak throws rather than being logged, because a silently
 *     compromised exercise is worse than a broken one.
 *
 *   - **Scaffolding.** Withholding the answer only helps if a stuck learner has
 *     somewhere to go, so the same module owns the hint ladder. Rungs are
 *     derived from the real task, served strictly one at a time, priced, and —
 *     the invariant that makes them safe — a rung whose text would contain the
 *     answer is *dropped at construction time* rather than shown.
 *
 * Deliberate limitation, stated rather than hidden: value scanning only covers
 * registered strings of eight characters or more. A one-digit answer occurs in
 * every payload by chance, so scanning for it would produce noise instead of
 * safety; short answers are protected structurally, by their field names.
 */

export const ANSWER_GUARD_VERSION = 1;

/** The shortest registered answer worth scanning payloads for. */
export const MIN_SCANNED_SECRET = 8;

export class AnswerLeakError extends Error {
  constructor(channel, details) {
    super(`${channel} would have leaked an answer: ${details.join("; ")}`);
    this.name = "AnswerLeakError";
    this.channel = channel;
    this.details = details;
    this.leak = true;
  }
}

// Keys that must never appear in any response, at any depth. `answerId` is not
// here: revealing the correct option *after* the learner has answered is
// feedback, so it is forbidden per channel, on the channels that build tasks.
export const ALWAYS_FORBIDDEN = ["answerKey", "correctId", "solution", "goldAnswer", "predicates", "misconceptionByOption"];

/**
 * Per-channel additions. A key is only listed where it really is an answer:
 * `explanation` is a leak on a task and legitimate feedback on a grade, so the
 * rules are stated per channel rather than globally.
 */
export const RESPONSE_RULES = {
  "lessons:call-chains": ["answerId", "explanation", "answer"],
  // The public localization payload lists hint ids and prices but no text, and
  // has no other legitimate `text` field, so forbidding it catches the leak
  // that matters without banning the hint list itself.
  "exercise:localization": ["answerId", "goldFiles", "definition", "text"],
  "grade:race-task": ["answerId", "predicate", "answerFor"],
  "learning:diagnose": ["answerId", "probes", "patterns"],
  "quiz:build": ["answerId", "cases", "expected", "oracle", "reference"],
  "explain:task": ["answerId", "observed", "neighborhood", "reference"],
  "activity:build": ["answerId", "answer", "reveal", "tolerance", "reference", "differences"],
  "hint:next": ["answerId", "answer"],
};

/**
 * Where registered answer *values* are scanned for.
 *
 * Only channels that build or list an exercise are scanned. A function name or
 * a `path:line` is legitimate content on a data channel like `search:query` or
 * `repository:read-file`, so scanning those would turn ordinary repository
 * facts into false leak reports and break the app to protect nothing.
 */
export const SCANNED_CHANNELS = new Set([
  "lessons:call-chains",
  "exercise:localization",
  "grade:race-task",
  "learning:diagnose",
  "quiz:build",
  "explain:task",
  "activity:build",
  "hint:next",
]);

const registeredSecrets = new Set();
const MAX_REGISTERED = 2_000;

/**
 * Record the answer strings for a task that was just built, so the egress guard
 * can prove they never come back out.
 */
export function registerAnswerSecrets(values) {
  for (const value of values ?? []) {
    const text = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
    if (text.length < MIN_SCANNED_SECRET) continue;
    if (registeredSecrets.size >= MAX_REGISTERED) {
      // Bounded: the oldest registration is dropped rather than growing forever.
      registeredSecrets.delete(registeredSecrets.values().next().value);
    }
    registeredSecrets.add(text);
  }
  return registeredSecrets.size;
}

export function clearAnswerSecrets() {
  registeredSecrets.clear();
}

export function answerSecrets() {
  return [...registeredSecrets];
}

export function forbiddenKeysFor(channel) {
  return [...new Set([...ALWAYS_FORBIDDEN, ...(RESPONSE_RULES[channel] ?? [])])];
}

/** Every path at which a forbidden key appears, however deeply nested. */
export function findForbiddenKeys(value, keys, pointer = "", found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenKeys(item, keys, `${pointer}[${index}]`, found));
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      // A key explicitly set to `undefined` is how several graders strip an
      // answer; that is a removal, not a leak.
      if (keys.includes(key) && child !== undefined) found.push(`${pointer}.${key}`);
      findForbiddenKeys(child, keys, `${pointer}.${key}`, found);
    }
  }
  return found;
}

/** Registered answer strings that appear anywhere in the serialized response. */
export function findLeakedValues(payload, secrets = answerSecrets()) {
  let serialized;
  try {
    serialized = JSON.stringify(payload ?? null);
  } catch {
    return [];
  }
  if (!serialized) return [];
  return secrets.filter((secret) => secret.length >= MIN_SCANNED_SECRET && serialized.includes(JSON.stringify(secret).slice(1, -1)));
}

/** Audit one response without throwing, for tests and diagnostics. */
export function auditResponse(channel, response, secrets = answerSecrets()) {
  const keys = forbiddenKeysFor(channel);
  const forbidden = findForbiddenKeys(response, keys);
  const leaked = SCANNED_CHANNELS.has(channel) ? findLeakedValues(response, secrets) : [];
  return {
    version: ANSWER_GUARD_VERSION,
    channel,
    ok: forbidden.length === 0 && leaked.length === 0,
    forbiddenKeys: forbidden,
    leakedValues: leaked.map((value) => `${value.slice(0, 12)}…`),
    checkedKeys: keys,
  };
}

/** The enforced version: a leaking response never reaches the renderer. */
export function guardResponse(channel, response, secrets = answerSecrets()) {
  const audit = auditResponse(channel, response, secrets);
  if (audit.ok) return response;
  throw new AnswerLeakError(channel, [
    ...audit.forbiddenKeys.map((pointer) => `field ${pointer}`),
    ...audit.leakedValues.map((value) => `value ${value}`),
  ]);
}

// ---------------------------------------------------------------------------
// Progressive scaffolding
// ---------------------------------------------------------------------------

/** The most a full ladder may cost: hints reduce a score, they never erase it. */
export const MAX_HINT_PENALTY = 0.45;

function rung(id, level, price, text) {
  return { id, level, price, text };
}

/**
 * Build a hint ladder for one task.
 *
 * Rungs go from orientation to a strong nudge, and each is checked against the
 * answer before it is kept: a rung that would spell the answer out is dropped,
 * so a ladder can be short but can never be a giveaway.
 */
export function buildScaffold(kind, context = {}) {
  const answer = context.answer === undefined || context.answer === null ? null : String(context.answer);
  let rungs = [];

  if (kind === "executable-quiz") {
    rungs = [
      rung("quiz-shape", 1, 0.05, `The function takes ${context.parameters ?? "the listed"} parameter(s) and every hidden test calls it exactly the way the worked example does.`),
      rung("quiz-branch", 2, 0.1, `${context.hiddenCases ?? "Several"} hidden tests disagree with each other's results, so a single constant cannot satisfy them.`),
      rung("quiz-input", 3, 0.15, context.sampleInput ? `One hidden test calls it with ${context.sampleInput}.` : "One hidden test uses an empty or boundary input."),
    ];
  } else if (kind === "explanation") {
    rungs = [
      rung("explain-count", 1, 0.05, `${context.functionCount ?? "Several"} function(s) actually executed in this run.`),
      rung("explain-depth", 2, 0.1, `The call stack reached a depth of ${context.maxDepth ?? "more than one"}, so at least one call is nested inside another.`),
      rung("explain-entry", 3, 0.15, context.entryPath ? `The run starts in ${context.entryPath}; follow its calls from there.` : "Start from the function nothing else calls."),
    ];
  } else if (kind === "contrast") {
    rungs = [
      rung("contrast-difference", 1, 0.05, context.difference ?? "The two definitions are not interchangeable; compare their parameter lists first."),
      rung("contrast-arguments", 2, 0.1, context.argumentCount === undefined ? "Count the arguments at the call site." : `The call site passes ${context.argumentCount} argument(s).`),
      rung("contrast-import", 3, 0.15, context.importSpecifier ? `The calling file imports \`${context.importSpecifier}\`.` : "Read the calling file's imports."),
    ];
  } else if (kind === "prediction") {
    const value = Number(context.answer);
    const spread = Number.isFinite(value) ? Math.max(2, Math.ceil(Math.abs(value) / 2) + 1) : null;
    rungs = [
      rung("predict-bracket", 1, 0.05, spread === null ? "The answer is a path inside this repository." : `The answer is between ${Math.max(0, value - spread)} and ${value + spread}.`),
      rung("predict-scale", 2, 0.1, Number.isFinite(value) ? (value === 0 ? "The answer is zero or very close to it." : value <= 3 ? "The answer is a small single-digit number." : value <= 20 ? "The answer is in the low tens or below." : "The answer is larger than twenty.") : "The answer is a file the calling file imports."),
      rung("predict-where", 3, 0.15, context.anchorPath ? `Everything you need is reachable from ${context.anchorPath}.` : "Look at the resolved call edges for this symbol."),
    ];
  } else if (kind === "localization") {
    rungs = (context.hints ?? []).map((hint, index) => rung(hint.id ?? `locate-${index + 1}`, index + 1, hint.price ?? 0.05 * (index + 1), hint.text));
  } else {
    return { kind, available: false, reason: `No hint ladder is defined for ${kind}.`, rungs: [], dropped: [] };
  }

  // The invariant: no rung may contain the answer.
  const dropped = [];
  const safe = rungs.filter((item) => {
    if (!answer || answer.length < 2) return true;
    const spelled = new RegExp(`(?:^|[^A-Za-z0-9_])${answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^A-Za-z0-9_]|$)`);
    if (spelled.test(item.text)) { dropped.push(item.id); return false; }
    return true;
  });

  return {
    version: ANSWER_GUARD_VERSION,
    kind,
    available: safe.length > 0,
    rungs: safe.map((item, index) => ({ ...item, level: index + 1 })),
    dropped,
    maxPenalty: MAX_HINT_PENALTY,
  };
}

/**
 * The next rung, and only the next one. A learner cannot skip to the strongest
 * hint by asking for it directly.
 */
export function nextHintRung(scaffold, used = []) {
  const taken = new Set(used);
  const next = scaffold.rungs.find((item) => !taken.has(item.id));
  if (!next) return null;
  return { ...next, remaining: scaffold.rungs.length - taken.size - 1 };
}

/** What the revealed hints cost, capped so scaffolding never zeroes a score. */
export function scaffoldPenalty(scaffold, used = []) {
  const taken = new Set(used);
  // An unrecognised hint id is ignored rather than trusted: the renderer does
  // not get to decide what it was charged for.
  const charged = scaffold.rungs.filter((item) => taken.has(item.id));
  return {
    revealed: charged.map((item) => item.id),
    ignored: [...taken].filter((id) => !scaffold.rungs.some((item) => item.id === id)),
    penalty: Number(Math.min(MAX_HINT_PENALTY, charged.reduce((sum, item) => sum + item.price, 0)).toFixed(4)),
  };
}

export function applyScaffold(score, scaffold, used = []) {
  const { penalty, revealed, ignored } = scaffoldPenalty(scaffold, used);
  const raw = Math.max(0, Math.min(1, Number(score) || 0));
  return {
    raw: Number(raw.toFixed(4)),
    penalty,
    revealed,
    ignored,
    score: Number(Math.max(0, raw * (1 - penalty)).toFixed(4)),
  };
}

/** What a scaffold may look like from the renderer: rungs are fetched, not listed. */
export function publicScaffold(scaffold) {
  return {
    version: scaffold.version ?? ANSWER_GUARD_VERSION,
    kind: scaffold.kind,
    available: scaffold.available,
    reason: scaffold.reason,
    total: scaffold.rungs?.length ?? 0,
    prices: (scaffold.rungs ?? []).map((item) => item.price),
    maxPenalty: MAX_HINT_PENALTY,
  };
}
