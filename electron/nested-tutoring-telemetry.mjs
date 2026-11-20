import { redactValue } from "./secret-scanner.mjs";
import { estimateCostUsd, DEFAULT_COST_CATALOG } from "./rag-eval.mjs";
import { ALWAYS_FORBIDDEN, findForbiddenKeys, findLeakedValues } from "./answer-guard.mjs";
import { appendEvent } from "./activity-log.mjs";

/**
 * Nested tutoring telemetry (item 46, this cycle).
 *
 * `telemetry.mjs`'s own opt-in local telemetry (item 60) already measures
 * the application's own behaviour as declared, bounded dimension/measure
 * pairs — but at one flat event per call, never as a *tree*: one tutoring
 * turn's `askAgent` call really runs a local-index lookup or a retrieval
 * step (`context-engine.mjs`'s `buildContextPack`), reads learner memory
 * (`learning-store.mjs`'s own state, or `project-continuity.mjs`'s thread),
 * assembles a plan (which sections to include at which budget), invokes a
 * tool (the agent CLI subprocess itself), may hand off to an evaluator
 * (`tutor-generation-verification.mjs`'s own evaluators, `curriculum-
 * review.mjs`'s own adjudication), and finally calls a model — and no
 * existing structure records *which* nested step of that chain actually
 * cost the time or the money, or attributes a failure to the right layer.
 * Grep confirmed before writing a line here: zero prior matches for
 * `nestedTutoring`/`operationSpan`/`costAttribution`/`latencyAttribution`
 * anywhere in `electron/*.mjs`.
 *
 * Design, reusing rather than reinventing:
 *
 *   - **A span tree, not a flat event.** [`startSpan`]/[`endSpan`] build an
 *     ordinary parent-pointer tree of named operations, each scoped to one
 *     of the six kinds this item names (`retrieval`, `memory`, `planning`,
 *     `tool`, `evaluator`, `model`) — [`OPERATION_KINDS`] is the exact,
 *     closed set, so a caller cannot invent a seventh kind that nothing
 *     downstream recognizes. [`attributeCostAndLatency`] rolls each span's
 *     own duration and cost up into every ancestor exactly once (a child's
 *     cost is never double-counted into a grandparent through two
 *     different paths), so "which layer is actually slow/expensive" has an
 *     exact answer instead of a guess from one flat total.
 *   - **Cost reuses `rag-eval.mjs`'s own pricing, unmodified, including its
 *     honest `null`.** [`attributeCostAndLatency`] calls `rag-eval.mjs`'s
 *     own `estimateCostUsd` for every `model`-kind span that names a
 *     token count and a family; an unpriced family still returns `null`
 *     (unknown, not a fabricated free), and a `null` child cost makes the
 *     parent's own rolled-up cost `null` too rather than silently treating
 *     the unknown child as zero — the same "not knowing is never reported
 *     as fine" rule `docs/threat-model.md` already states.
 *   - **Privacy-safe variables only.** [`privacySafeAttributes`] accepts an
 *     operation's own attribute bag and keeps only declared, enum-valued
 *     dimensions (reusing `telemetry.mjs`'s own closed-vocabulary
 *     discipline: an undeclared key is dropped, not folded to `other`,
 *     because a *key* nobody declared is a key nobody reviewed for privacy,
 *     distinct from an *unlisted value* of an already-reviewed key, which
 *     `telemetry.mjs` folds). Any free-text value — a question, a file
 *     path, a symbol name — is additionally run through
 *     `secret-scanner.mjs`'s own `redactValue` before being kept, never
 *     trusted on the strength of the allow-list alone.
 *   - **Answer leakage cannot reach a span through observability either.**
 *     [`auditSpanForLeakage`] runs the exact same two checks
 *     `answer-guard.mjs`'s own egress guard already runs on every live IPC
 *     response — `findForbiddenKeys` (structural, `ALWAYS_FORBIDDEN` keys
 *     at any depth) and `findLeakedValues` (registered answer strings) —
 *     over a span's own attributes, because a trace is a second, easily
 *     overlooked channel an answer could leak through even when the
 *     primary response channel is clean. A span that fails this audit is
 *     refused rather than recorded with the leak redacted-after-the-fact,
 *     matching `guardResponse`'s own "throw rather than log" discipline.
 *   - **Recorded like every other graded/decided event.**
 *     [`recordTutoringSpanTree`] preserves a completed, audited, cost-
 *     attributed span tree through `activity-log.mjs`'s own `appendEvent`
 *     (unmodified).
 *
 * Pure except [`recordTutoringSpanTree`], whose only I/O is the same
 * `appendEvent` every other recorder in this app already calls.
 */

export const NESTED_TUTORING_TELEMETRY_VERSION = 1;

/** The six nested operation kinds this item names, and no others. */
export const OPERATION_KINDS = ["retrieval", "memory", "planning", "tool", "evaluator", "model"];

/** Declared, enum-valued attributes a span may carry. Anything else is dropped, not folded. */
export const DECLARED_ATTRIBUTES = Object.freeze({
  strategy: ["lexical", "symbol", "graph", "embedding", "fused", "local-index"],
  memoryKind: ["learner-state", "project-continuity", "none"],
  planMode: ["lean", "balanced", "deep"],
  toolName: ["agent-cli", "repository-read", "search"],
  evaluatorName: ["claim", "policy", "leakage", "rubric", "adjudication"],
  modelFamily: Object.keys(DEFAULT_COST_CATALOG),
  outcome: ["ok", "refused", "error", "timeout"],
});

let sequence = 0;
function nextId() {
  sequence += 1;
  return `span-${Date.now()}-${sequence}`;
}

/**
 * Open one named operation of a declared kind, optionally nested under a
 * parent span. `at` is an injectable monotonic-style timestamp (ms) so a
 * span tree is fully deterministic and testable without a real clock.
 */
export function startSpan(kind, name, { parentId = null, at = Date.now() } = {}) {
  if (!OPERATION_KINDS.includes(kind)) throw new Error(`Unknown operation kind: ${kind}`);
  return { id: nextId(), kind, name, parentId, startedAt: at, endedAt: null, attributes: {}, children: [] };
}

/** Close a span, attaching its final (privacy-safe) attributes and duration. */
export function endSpan(span, attributes = {}, { at = Date.now() } = {}) {
  return {
    ...span,
    endedAt: at,
    durationMs: Math.max(0, at - span.startedAt),
    attributes: { ...span.attributes, ...privacySafeAttributes(attributes) },
  };
}

/**
 * Keep only declared, enum-valued dimensions (`DECLARED_ATTRIBUTES`); an
 * undeclared key is dropped entirely (not folded to `other` -- a key
 * nobody declared was never reviewed for privacy, so it cannot be kept
 * under any value). A declared key's free-text-shaped value is still run
 * through `secret-scanner.mjs`'s own `redactValue` before being kept, and
 * an unlisted value for a declared key is folded to `"other"`, mirroring
 * `telemetry.mjs`'s own value-folding rule.
 */
export function privacySafeAttributes(attributes = {}) {
  const kept = {};
  for (const [key, allowed] of Object.entries(DECLARED_ATTRIBUTES)) {
    const value = attributes?.[key];
    if (value === undefined || value === null) continue;
    const text = String(value);
    kept[key] = allowed.includes(text) ? text : "other";
  }
  // Numeric measures are not enum-bound; they are kept verbatim (a token
  // count or a duration is not personal data), then redacted defensively
  // through the same pipeline every other persisted payload goes through.
  for (const key of ["contextTokens", "completionTokens", "tokenCount"]) {
    if (typeof attributes?.[key] === "number") kept[key] = attributes[key];
  }
  return redactValue(kept);
}

/**
 * Attach a child span under its declared parent, by id. Returns a new tree
 * (never mutates), and reports `ok: false` if the named parent is not in
 * the tree -- a child cannot silently attach to the wrong place.
 */
export function attachChild(tree, parentId, child) {
  if (tree.id === parentId) return { ...tree, children: [...tree.children, child], ok: true };
  let attached = false;
  const children = tree.children.map((existing) => {
    if (attached) return existing;
    const result = attachChild(existing, parentId, child);
    if (result.ok) attached = true;
    return result.ok ? result : existing;
  });
  return { ...tree, children, ok: attached };
}

/**
 * Roll latency and cost up the tree exactly once per span. `totalMs` for a
 * parent is the parent's own measured duration (not a sum of children --
 * nested operations overlap in wall-clock terms with their parent, and
 * summing would double count); `rolledUpCostUsd` is the sum of a span's
 * own model cost (if any) plus every descendant's own model cost, each
 * counted exactly once at its own node, which is what makes "the model
 * calls under this retrieval step cost $0.004" an exact, not an estimated,
 * statement. Any unknown (`null`) descendant cost makes the whole subtree's
 * rolled-up cost `null` rather than silently treating it as zero.
 */
export function attributeCostAndLatency(span, catalog = DEFAULT_COST_CATALOG) {
  const children = span.children.map((child) => attributeCostAndLatency(child, catalog));
  let ownCostUsd = null;
  if (span.kind === "model" && typeof span.attributes.contextTokens === "number" && typeof span.attributes.completionTokens === "number" && span.attributes.modelFamily) {
    ownCostUsd = estimateCostUsd(span.attributes.modelFamily, span.attributes.contextTokens, span.attributes.completionTokens, catalog);
  }
  const childCosts = children.map((child) => child.rolledUpCostUsd);
  const anyUnknown = childCosts.some((cost) => cost === null) || (span.kind === "model" && span.attributes.modelFamily && ownCostUsd === null);
  const rolledUpCostUsd = anyUnknown
    ? null
    : Number(((ownCostUsd ?? 0) + childCosts.reduce((sum, cost) => sum + (cost ?? 0), 0)).toFixed(6));
  return { ...span, children, ownCostUsd, rolledUpCostUsd, totalMs: span.durationMs ?? 0 };
}

/**
 * Audit one span's own attributes for an answer leak, exactly the way
 * `answer-guard.mjs`'s own egress guard audits a live IPC response --
 * reused unmodified, so a trace cannot become a second channel an answer
 * leaks through just because the primary response channel is clean.
 */
export function auditSpanForLeakage(span, secrets = []) {
  const forbidden = findForbiddenKeys(span.attributes, ALWAYS_FORBIDDEN);
  const leaked = findLeakedValues(span.attributes, secrets);
  return { ok: forbidden.length === 0 && leaked.length === 0, forbiddenKeys: forbidden, leakedValues: leaked.map((value) => `${value.slice(0, 12)}…`) };
}

/**
 * Audit an entire span tree for leakage. Throws, rather than recording a
 * redacted-after-the-fact span, the same "throw rather than log"
 * discipline `answer-guard.mjs`'s own `guardResponse` already applies.
 */
export function auditSpanTreeForLeakage(tree, secrets = []) {
  const audit = auditSpanForLeakage(tree, secrets);
  if (!audit.ok) {
    throw new Error(`Span "${tree.name}" would have leaked an answer: ${[...audit.forbiddenKeys.map((pointer) => `field ${pointer}`), ...audit.leakedValues.map((value) => `value ${value}`)].join("; ")}`);
  }
  for (const child of tree.children) auditSpanTreeForLeakage(child, secrets);
  return true;
}

/** Flatten a tree into one list, parent before children, for easy iteration/reporting. */
export function flattenSpanTree(tree) {
  return [{ id: tree.id, kind: tree.kind, name: tree.name, parentId: tree.parentId, totalMs: tree.totalMs, rolledUpCostUsd: tree.rolledUpCostUsd, attributes: tree.attributes }, ...tree.children.flatMap((child) => flattenSpanTree(child))];
}

/**
 * Audit, cost/latency-attribute, and persist a completed span tree through
 * `activity-log.mjs`'s own `appendEvent`, unmodified -- the same
 * tamper-evident, append-only log every other decided/graded event in this
 * app already writes to.
 */
export async function recordTutoringSpanTree(directory, repositoryId, tree, { secrets = [], catalog = DEFAULT_COST_CATALOG } = {}) {
  auditSpanTreeForLeakage(tree, secrets);
  const attributed = attributeCostAndLatency(tree, catalog);
  return appendEvent(directory, repositoryId, {
    kind: "nested-tutoring-telemetry",
    version: NESTED_TUTORING_TELEMETRY_VERSION,
    spans: flattenSpanTree(attributed),
    totalMs: attributed.totalMs,
    rolledUpCostUsd: attributed.rolledUpCostUsd,
  });
}
