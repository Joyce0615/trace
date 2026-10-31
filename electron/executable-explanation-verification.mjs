import { Verdict, extractCallClaims } from "./faithfulness-guard.mjs";
import { probeArguments, runInSandbox, selfContainedFunctions } from "./executable-quiz.mjs";

/**
 * Executable explanation verification (item 25).
 *
 * `faithfulness-guard.mjs` (item 19) checks a claim against the *static*
 * index: does this symbol exist, does this resolved call edge exist. That is
 * one of the four things this item asks for ("symbol queries"); the other
 * three — running a real test against a claimed behavior, checking a claim
 * against a real dynamic trace, and searching for a counterexample to a
 * universal claim — are not static lookups, and nothing in the codebase did
 * them before this module (confirmed by grep: zero prior matches for
 * `counterexample` as an implementation identifier anywhere in `electron/`).
 *
 * Every claim is turned into exactly one of:
 *
 *   - **symbol query** — a bare `` `name` `` mention, checked the same way
 *     `faithfulness-guard.mjs` already checks a symbol's existence;
 *   - **test** — `` `fn(args)` returns `value` ``, executed for real inside
 *     `executable-quiz.mjs`'s own sandbox (reused unmodified) and compared
 *     against what actually came back;
 *   - **trace** — `` `a` calls `b` `` (the same shape `extractCallClaims`
 *     already parses), checked against an already-recorded dynamic trace
 *     summary rather than the static call graph, so a claim can be confirmed
 *     by what the code *did*, not only by what it could do;
 *   - **counterexample** — `` `fn` always returns `value` `` / `` `fn` never
 *     raises ``, checked by probing the real function with many generated
 *     inputs (`executable-quiz.mjs`'s own `probeArguments`) and searching for
 *     one that breaks the claim.
 *
 * Every verdict is one of `faithfulness-guard.mjs`'s own three states
 * (faithful/unfaithful/abstain), so "unverifiable" is never folded into a
 * false pass: a claim whose function cannot be isolated into the sandbox, or
 * whose trace never recorded the caller, abstains honestly instead of being
 * scored faithful by default. A universal claim's "faithful" verdict is
 * additionally gated by a minimum probe count, because a finite search that
 * found no counterexample is real but bounded evidence, not proof.
 *
 * `gateHighConfidenceTeaching` is the second half of this item: a lesson
 * presented at `"ready"` (this app's existing high-confidence status, set by
 * `course.mjs`) must not keep teaching from evidence `change-impact.mjs`
 * (item 8) already knows is stale. The caller supplies the set of lesson ids
 * `tracedLessons` flagged as anchoring changed code (reused unmodified, not
 * re-derived), and a `"ready"` lesson in that set is blocked until its claims
 * are re-verified.
 */

export const EXECUTABLE_EXPLANATION_VERIFICATION_VERSION = 1;

/** A universal claim's "no counterexample found" cannot be called faithful below this many completed probes. */
export const MIN_COUNTEREXAMPLE_PROBES = 8;

function verdictResult(status, method, detail, evidence) {
  return { status, method, detail, evidence: evidence ?? null };
}

function combineVerdicts(statuses) {
  if (!statuses.length) return Verdict.ABSTAIN;
  if (statuses.some((status) => status === Verdict.UNFAITHFUL)) return Verdict.UNFAITHFUL;
  if (statuses.some((status) => status === Verdict.ABSTAIN)) return Verdict.ABSTAIN;
  return Verdict.FAITHFUL;
}

const RETURN_VALUE_CLAIM = /`([A-Za-z_]\w*)\(([^`()]*)\)`\s+returns\s+`([^`]+)`/gi;
const UNIVERSAL_RETURN_CLAIM = /`([A-Za-z_]\w*)`\s+always\s+returns\s+`([^`]+)`/gi;
const UNIVERSAL_NO_RAISE_CLAIM = /`([A-Za-z_]\w*)`\s+never\s+raises\b/gi;
const BARE_SYMBOL = /`([A-Za-z_]\w*)`/g;

/**
 * Parse free text into executable claims. Order matters: the more specific
 * shapes (return-value, universal, relational) are extracted first and their
 * names are removed from consideration so a function already claimed to
 * "always return X" is not *also* reported as a bare, unchecked symbol
 * mention of the same name.
 */
export function extractExecutableClaims(text) {
  const value = String(text ?? "");
  const claims = [];
  const consumed = new Set();
  for (const match of value.matchAll(RETURN_VALUE_CLAIM)) {
    claims.push({ kind: "return-value", fn: match[1], argsText: match[2], expectedText: match[3] });
    consumed.add(match[1]);
  }
  for (const match of value.matchAll(UNIVERSAL_RETURN_CLAIM)) {
    claims.push({ kind: "universal", fn: match[1], verb: "returns", expectedText: match[2] });
    consumed.add(match[1]);
  }
  for (const match of value.matchAll(UNIVERSAL_NO_RAISE_CLAIM)) {
    claims.push({ kind: "universal", fn: match[1], verb: "raises", expectedText: null });
    consumed.add(match[1]);
  }
  for (const claim of extractCallClaims(value)) {
    claims.push({ kind: "relational", caller: claim.caller, callee: claim.callee });
    consumed.add(claim.caller);
    consumed.add(claim.callee);
  }
  for (const match of value.matchAll(BARE_SYMBOL)) {
    if (consumed.has(match[1])) continue;
    claims.push({ kind: "symbol", name: match[1] });
    consumed.add(match[1]);
  }
  return claims;
}

/** A Python literal (string/int/float/bool/None) as the JS value the sandbox's JSON-decoded `calls` array needs. */
export function parsePythonLiteral(text) {
  const trimmed = String(text ?? "").trim();
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === "True") return true;
  if (trimmed === "False") return false;
  if (trimmed === "None") return null;
  const singleQuoted = /^'((?:[^'\\]|\\.)*)'$/.exec(trimmed);
  if (singleQuoted) return singleQuoted[1].replace(/\\'/g, "'");
  const doubleQuoted = /^"((?:[^"\\]|\\.)*)"$/.exec(trimmed);
  if (doubleQuoted) return doubleQuoted[1].replace(/\\"/g, '"');
  return trimmed;
}

/** Top-level comma split (no nested parens/brackets support — see module docstring's residual scope). */
function parseArgsList(argsText) {
  const trimmed = String(argsText ?? "").trim();
  if (!trimmed) return [];
  return trimmed.split(",").map((piece) => parsePythonLiteral(piece));
}

/** Symbol queries: does this repository's own index know this name at all. */
function verifyBySymbolQuery(claim, repository) {
  const known = (repository?.symbols ?? []).some((symbol) => symbol.name === claim.name);
  return known
    ? verdictResult(Verdict.FAITHFUL, "symbol-query", `\`${claim.name}\` is a real symbol in this repository's index.`, { name: claim.name })
    : verdictResult(Verdict.UNFAITHFUL, "symbol-query", `\`${claim.name}\` is not a symbol this repository's index knows about.`, { name: claim.name });
}

/**
 * Trace: check a relational claim against an already-recorded dynamic run
 * (`execution-trace.mjs`'s `summarizeTrace` output), not the static graph —
 * this is the one check in this module that can confirm a dynamic-only edge
 * the static index never resolved, or catch a claim about code that ran but
 * took a different path than claimed.
 */
function verifyByTrace(claim, context) {
  const summary = context?.traceSummary;
  if (!summary) return verdictResult(Verdict.ABSTAIN, "trace", "No execution trace was supplied, so this relational claim cannot be checked dynamically.", { caller: claim.caller, callee: claim.callee });
  const matching = (summary.transitions ?? []).filter((transition) => transition.from.name === claim.caller);
  if (matching.some((transition) => transition.to.name === claim.callee)) {
    return verdictResult(Verdict.FAITHFUL, "trace", `The recorded run shows \`${claim.caller}\` really calling \`${claim.callee}\`.`, { transitions: matching });
  }
  const callerRan = (summary.functions ?? []).some((item) => item.name === claim.caller);
  if (!callerRan) {
    return verdictResult(Verdict.ABSTAIN, "trace", `\`${claim.caller}\` never ran in the recorded trace, so this claim cannot be checked dynamically.`, { caller: claim.caller });
  }
  return verdictResult(
    Verdict.UNFAITHFUL,
    "trace",
    `\`${claim.caller}\` ran in the recorded trace, but never called \`${claim.callee}\` — it called ${matching.map((t) => `\`${t.to.name}\``).join(", ") || "nothing"}.`,
    { caller: claim.caller, observedCallees: matching.map((transition) => transition.to.name) },
  );
}

/**
 * Test: execute `fn(args)` for real inside the executable-quiz sandbox and
 * compare the result against the claimed return value.
 */
async function verifyByTest(claim, context) {
  const candidates = selfContainedFunctions(context?.repository ?? {}, context?.sources ?? {});
  const candidate = candidates.find((item) => item.name === claim.fn);
  if (!candidate) {
    return verdictResult(Verdict.ABSTAIN, "test", `\`${claim.fn}\` could not be isolated into a runnable sandbox function, so this claim cannot be executed.`, { fn: claim.fn });
  }
  const args = parseArgsList(claim.argsText);
  const oracle = await runInSandbox({ moduleSource: candidate.source, entry: claim.fn, calls: [args] });
  if (oracle.status !== "ok") {
    return verdictResult(Verdict.ABSTAIN, "test", `Running \`${claim.fn}\` in the sandbox did not complete (${oracle.status}), so this claim cannot be executed.`, { status: oracle.status });
  }
  const result = oracle.results?.[0];
  if (!result) return verdictResult(Verdict.ABSTAIN, "test", "The sandbox produced no result for this call.", null);
  if (!result.ok) {
    return verdictResult(Verdict.UNFAITHFUL, "test", `\`${claim.fn}(${claim.argsText})\` raised ${result.error}, not the claimed return value.`, { error: result.error });
  }
  const matches = result.value.trim() === String(claim.expectedText).trim();
  return matches
    ? verdictResult(Verdict.FAITHFUL, "test", `\`${claim.fn}(${claim.argsText})\` really returns \`${result.value}\`, exactly as claimed.`, { actual: result.value })
    : verdictResult(Verdict.UNFAITHFUL, "test", `\`${claim.fn}(${claim.argsText})\` really returns \`${result.value}\`, not \`${claim.expectedText}\` as claimed.`, { actual: result.value, claimed: claim.expectedText });
}

/**
 * Counterexample: probe `fn` with many generated inputs
 * (`executable-quiz.mjs`'s own `probeArguments`) and search for one that
 * breaks a universal claim. "No counterexample found" is only reported
 * faithful once at least `MIN_COUNTEREXAMPLE_PROBES` calls actually
 * completed — a finite search is bounded evidence, not proof, and fewer
 * probes than the floor abstains rather than overclaiming.
 */
async function verifyByCounterexample(claim, context) {
  const candidates = selfContainedFunctions(context?.repository ?? {}, context?.sources ?? {});
  const candidate = candidates.find((item) => item.name === claim.fn);
  if (!candidate) {
    return verdictResult(Verdict.ABSTAIN, "counterexample", `\`${claim.fn}\` could not be isolated into a runnable sandbox function, so no counterexample search could run.`, { fn: claim.fn });
  }
  const maxProbes = context?.maxProbes ?? Math.max(MIN_COUNTEREXAMPLE_PROBES, 16);
  const calls = probeArguments(candidate.signature.parameters, maxProbes);
  const oracle = await runInSandbox({ moduleSource: candidate.source, entry: claim.fn, calls });
  if (oracle.status !== "ok") {
    return verdictResult(Verdict.ABSTAIN, "counterexample", `The sandbox did not complete (${oracle.status}), so no counterexample search could run.`, { status: oracle.status });
  }
  const results = oracle.results ?? [];

  if (claim.verb === "raises") {
    const failing = results.find((item) => !item.ok);
    if (failing) {
      return verdictResult(
        Verdict.UNFAITHFUL,
        "counterexample",
        `\`${claim.fn}\` raised ${failing.error} for one probed input, contradicting the claim that it never raises.`,
        { counterexample: calls[failing.index], error: failing.error },
      );
    }
    if (results.length < MIN_COUNTEREXAMPLE_PROBES) {
      return verdictResult(Verdict.ABSTAIN, "counterexample", `Only ${results.length} probe(s) completed, below the ${MIN_COUNTEREXAMPLE_PROBES}-probe floor for endorsing a universal claim.`, { probesChecked: results.length });
    }
    return verdictResult(Verdict.FAITHFUL, "counterexample", `No counterexample was found in ${results.length} probes.`, { probesChecked: results.length });
  }

  const differing = results.find((item) => item.ok && item.value.trim() !== String(claim.expectedText).trim());
  if (differing) {
    return verdictResult(
      Verdict.UNFAITHFUL,
      "counterexample",
      `\`${claim.fn}\` returned \`${differing.value}\` for one probed input, contradicting the claim that it always returns \`${claim.expectedText}\`.`,
      { counterexample: calls[differing.index], actual: differing.value },
    );
  }
  const checked = results.filter((item) => item.ok).length;
  if (checked < MIN_COUNTEREXAMPLE_PROBES) {
    return verdictResult(Verdict.ABSTAIN, "counterexample", `Only ${checked} successful probe(s), below the ${MIN_COUNTEREXAMPLE_PROBES}-probe floor for endorsing a universal claim.`, { probesChecked: checked });
  }
  return verdictResult(Verdict.FAITHFUL, "counterexample", `No counterexample was found in ${checked} probes.`, { probesChecked: checked });
}

/**
 * Verify every executable claim in free text, dispatching each one to
 * whichever of the four methods its shape names.
 */
export async function verifyExplanationClaimsExecutably(text, context = {}) {
  const claims = extractExecutableClaims(text);
  const results = [];
  for (const claim of claims) {
    if (claim.kind === "symbol") results.push({ claim, ...verifyBySymbolQuery(claim, context.repository) });
    else if (claim.kind === "relational") results.push({ claim, ...verifyByTrace(claim, context) });
    else if (claim.kind === "return-value") results.push({ claim, ...await verifyByTest(claim, context) });
    else if (claim.kind === "universal") results.push({ claim, ...await verifyByCounterexample(claim, context) });
  }
  return {
    version: EXECUTABLE_EXPLANATION_VERIFICATION_VERSION,
    checked: results.length,
    status: combineVerdicts(results.map((entry) => entry.status)),
    unfaithful: results.filter((entry) => entry.status === Verdict.UNFAITHFUL).length,
    abstained: results.filter((entry) => entry.status === Verdict.ABSTAIN).length,
    claims: results,
  };
}

/** Claim text drawn from a lesson's objective, summary, and content blocks. */
function lessonClaimText(lesson) {
  const parts = [lesson?.objective, lesson?.summary];
  for (const block of lesson?.content ?? []) {
    if (block.body) parts.push(block.body);
    for (const step of block.steps ?? []) if (step.detail) parts.push(step.detail);
  }
  return parts.filter(Boolean).join("\n");
}

/** Verify every executable claim in one lesson's own text (item 25's "lesson claims"). */
export async function verifyLessonExecutably(lesson, context = {}) {
  const verification = await verifyExplanationClaimsExecutably(lessonClaimText(lesson), context);
  return { lessonId: lesson?.id ?? null, ...verification };
}

/** Verify every executable claim in one hint's own text (item 25's "hint claims"). */
export async function verifyHintExecutably(hint, context = {}) {
  const verification = await verifyExplanationClaimsExecutably(typeof hint?.text === "string" ? hint.text : "", context);
  return { hintId: hint?.id ?? null, ...verification };
}

export const TEACHING_GATE_STATUSES = Object.freeze({
  READY: "ready",
  NEEDS_REVIEW: "needs-review",
  BLOCKED_CONTRADICTED: "blocked-contradicted",
  BLOCKED_STALE_EVIDENCE: "blocked-stale-evidence",
});

/**
 * Block high-confidence teaching from stale evidence.
 *
 * `lesson.status === "ready"` is this app's own existing signal that a
 * lesson is presented at high confidence (`course.mjs` sets it). `staleLessonIds`
 * is the set of lesson ids `change-impact.mjs`'s own `tracedLessons` (item 8,
 * reused unmodified) already flagged as anchoring code that changed since the
 * course was built — this function does not re-derive staleness, it gates on
 * it. A ready lesson whose anchors are stale is blocked regardless of what its
 * own claims verified to in the past, because that verification was run
 * against evidence that is no longer current.
 */
export function gateHighConfidenceTeaching(lesson, verification, { staleLessonIds = new Set() } = {}) {
  const isHighConfidence = lesson?.status === "ready";
  const isStale = staleLessonIds.has(lesson?.id);
  if (isHighConfidence && isStale) {
    return {
      status: TEACHING_GATE_STATUSES.BLOCKED_STALE_EVIDENCE,
      lessonId: lesson?.id ?? null,
      reason: `"${lesson?.title ?? lesson?.id}" is presented as ready-to-teach, but the code it anchors into has changed since its claims were verified; teaching is blocked until the claims are re-verified against the current repository.`,
    };
  }
  if (verification?.status === Verdict.UNFAITHFUL) {
    return { status: TEACHING_GATE_STATUSES.BLOCKED_CONTRADICTED, lessonId: lesson?.id ?? null, reason: "An executable check contradicted at least one claim in this lesson." };
  }
  if (verification?.status === Verdict.ABSTAIN) {
    return { status: TEACHING_GATE_STATUSES.NEEDS_REVIEW, lessonId: lesson?.id ?? null, reason: "At least one claim in this lesson could not be executed and verified." };
  }
  return { status: TEACHING_GATE_STATUSES.READY, lessonId: lesson?.id ?? null, reason: "Every executable claim in this lesson was verified against the current repository." };
}
