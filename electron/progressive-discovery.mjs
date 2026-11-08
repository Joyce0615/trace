import { neighborhood } from "./knowledge-graph.mjs";
import { isTestPath } from "./change-impact.mjs";
import { CONTEXT_PACK_BUDGETS, estimateTokens } from "./context-engine.mjs";
import { GRADED_KINDS, MIN_SAMPLE, normalizeEvents, rate } from "./analytics.mjs";

/**
 * Progressive repository discovery.
 *
 * Opening a repository's full symbol/file/graph/test/lesson surface at once
 * is the opposite of comprehension: there is no way to tell what a learner
 * actually attended to versus what simply existed on screen. This module
 * reveals that surface incrementally, one learner-requested expansion at a
 * time, under two independent budgets that are never merged into one:
 *
 *   - a **cognitive budget** — the maximum number of new items one expansion
 *     may reveal, regardless of how cheap they are to describe;
 *   - a **context budget** — the maximum estimated token cost of what is
 *     revealed, reusing `context-engine.mjs`'s own `CONTEXT_PACK_BUDGETS`
 *     and `estimateTokens` (unmodified), so "lean" here means the same
 *     thing it means when a tutor context pack is built.
 *
 * Whichever budget binds first stops the expansion, and the result says
 * which one it was (`boundBy`), rather than silently applying only one.
 *
 * Expansion is **learner-controlled**: `revealNext` only ever runs when a
 * caller invokes it, and it only ever adds to what was already revealed —
 * there is no background or automatic expansion anywhere in this module.
 *
 * Everything the frontier is computed from is real repository structure,
 * never invented:
 *
 *   - **symbols and files** come from `knowledge-graph.mjs`'s own
 *     `neighborhood` (unmodified) walked one hop at a time from the
 *     already-revealed set over `calls`/`defines` edges — the same graph
 *     every other graph-aware module in this app already reads;
 *   - **tests** are files `change-impact.mjs`'s own `isTestPath`
 *     (unmodified) recognizes as test files, flagged separately from
 *     ordinary files rather than mixed in as just more files;
 *   - **lessons** are skill-graph nodes whose anchors fall inside the
 *     newly revealed paths, unlocked exactly when their source becomes
 *     visible — a lesson about code the learner has not reached yet is
 *     never offered early;
 *   - **graph neighborhoods** are the edges that now connect two already
 *     revealed nodes, returned as `neighborhoodEdges`, so a caller can
 *     render the structural picture that progressively assembles itself as
 *     expansion proceeds, rather than only a flat list of revealed items.
 *
 * **Measurable comprehension impact** (`measureComprehensionImpact`) compares
 * accuracy on already-graded activities anchored inside the revealed scope
 * against accuracy on graded activities outside it, reusing `analytics.mjs`'s
 * own `rate` (unmodified) for the honest sample-floor discipline every other
 * rate in this app already respects. The two accuracies are reported side by
 * side, never averaged into a single "discovery score".
 */

export const PROGRESSIVE_DISCOVERY_VERSION = 1;

/** The most new items one learner-requested expansion may reveal. */
export const DEFAULT_COGNITIVE_BUDGET = 5;

function publicNode(node) {
  return { id: node.id, kind: node.kind, label: node.label, path: node.path ?? node.key };
}

/**
 * Start a discovery session at one entry node. If the entry is a symbol, the
 * file that defines it is revealed alongside it — a symbol is never shown
 * without the file a learner would actually open to read it.
 */
export function initializeDiscovery(graph, entryNodeId) {
  const revealedIds = [entryNodeId];
  const entry = (graph?.nodes ?? []).find((node) => node.id === entryNodeId);
  if (entry?.kind === "symbol" && entry.path) {
    const fileId = `file:${entry.path}`;
    if ((graph.nodes ?? []).some((node) => node.id === fileId) && !revealedIds.includes(fileId)) {
      revealedIds.push(fileId);
    }
  }
  return { version: PROGRESSIVE_DISCOVERY_VERSION, revealedIds, unlockedLessonIds: [] };
}

/**
 * Candidate nodes one hop away from the already-revealed set, over
 * `calls`/`defines` edges. A candidate symbol's own defining file is always
 * offered alongside it, even if that file is more than one hop away by
 * `calls` edges alone, for the same reason a symbol is never revealed alone
 * at session start.
 */
function frontierCandidates(graph, revealedIds) {
  const revealed = new Set(revealedIds);
  const byId = new Map((graph.nodes ?? []).map((node) => [node.id, node]));
  const candidates = new Map();
  for (const id of revealedIds) {
    const hop = neighborhood(graph, id, 1, ["calls", "defines"]);
    for (const node of hop.nodes) {
      if (revealed.has(node.id) || candidates.has(node.id)) continue;
      if (node.kind === "symbol" || node.kind === "file") candidates.set(node.id, node);
    }
  }
  for (const node of [...candidates.values()]) {
    if (node.kind !== "symbol" || !node.path) continue;
    const fileId = `file:${node.path}`;
    if (!revealed.has(fileId) && !candidates.has(fileId) && byId.has(fileId)) {
      candidates.set(fileId, byId.get(fileId));
    }
  }
  return [...candidates.values()].sort(
    (left, right) => (right.importance ?? 0) - (left.importance ?? 0) || left.id.localeCompare(right.id),
  );
}

/**
 * Reveal the next batch of symbols/files/tests, stopping at whichever of the
 * two independent budgets binds first, and unlock any lesson whose anchors
 * now fall inside the revealed scope.
 */
export function revealNext(graph, state, skillGraph, options = {}) {
  const cognitiveBudget = options.cognitiveBudget ?? DEFAULT_COGNITIVE_BUDGET;
  const contextTokenBudget = options.contextTokenBudget ?? CONTEXT_PACK_BUDGETS.lean;
  const revealedIds = [...(state?.revealedIds ?? [])];
  const candidates = frontierCandidates(graph, revealedIds);

  const accepted = [];
  let tokensUsed = 0;
  let boundBy = "frontier-exhausted";
  for (const candidate of candidates) {
    if (accepted.length >= cognitiveBudget) { boundBy = "cognitive-budget"; break; }
    const cost = estimateTokens(`${candidate.label} ${candidate.path ?? candidate.key ?? ""}`);
    if (tokensUsed + cost > contextTokenBudget) { boundBy = "context-budget"; break; }
    accepted.push(candidate);
    tokensUsed += cost;
  }

  const nextRevealedIds = [...revealedIds, ...accepted.map((node) => node.id)];
  const byId = new Map((graph.nodes ?? []).map((node) => [node.id, node]));
  const revealedPaths = new Set(
    nextRevealedIds.map((id) => byId.get(id)).filter(Boolean).map((node) => node.path ?? node.key),
  );

  const symbols = accepted.filter((node) => node.kind === "symbol");
  const files = accepted.filter((node) => node.kind === "file" && !isTestPath(node.key));
  const tests = accepted.filter((node) => node.kind === "file" && isTestPath(node.key));

  const alreadyUnlocked = new Set(state?.unlockedLessonIds ?? []);
  const newlyUnlockedLessons = (skillGraph?.nodes ?? []).filter(
    (lesson) => !alreadyUnlocked.has(lesson.id) && (lesson.anchors ?? []).some((anchor) => revealedPaths.has(anchor.path)),
  );

  const revealedIdSet = new Set(nextRevealedIds);
  const neighborhoodEdges = (graph.edges ?? [])
    .filter((edge) => revealedIdSet.has(edge.from) && revealedIdSet.has(edge.to))
    .map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind }));

  return {
    version: PROGRESSIVE_DISCOVERY_VERSION,
    boundBy,
    cognitiveBudget,
    contextTokenBudget,
    tokensUsed,
    revealedCount: accepted.length,
    symbols: symbols.map(publicNode),
    files: files.map(publicNode),
    tests: tests.map(publicNode),
    neighborhoodEdges,
    newlyUnlockedLessons: newlyUnlockedLessons.map((lesson) => ({ id: lesson.id, title: lesson.title, lessonId: lesson.lessonId ?? null })),
    state: {
      version: PROGRESSIVE_DISCOVERY_VERSION,
      revealedIds: nextRevealedIds,
      unlockedLessonIds: [...alreadyUnlocked, ...newlyUnlockedLessons.map((lesson) => lesson.id)],
    },
  };
}

/**
 * Compare accuracy on already-graded activities whose anchor path falls
 * inside the revealed scope against accuracy on graded activities outside
 * it. Both reuse `analytics.mjs`'s own `rate` (unmodified), so either side
 * honestly reports `insufficient-evidence` below the same sample floor every
 * other rate in this app already respects, and the two numbers are never
 * combined into one "discovery score".
 */
export function measureComprehensionImpact(events, revealedPaths, options = {}) {
  const minimum = options.minimum ?? MIN_SAMPLE;
  const revealed = new Set(revealedPaths ?? []);
  const graded = normalizeEvents(events).filter(
    (event) => GRADED_KINDS.has(event.kind) && typeof event.correct === "boolean" && typeof event.path === "string",
  );
  const within = graded.filter((event) => revealed.has(event.path));
  const beyond = graded.filter((event) => !revealed.has(event.path));
  const withinRevealedAccuracy = rate(within.filter((event) => event.correct).length, within.length, minimum);
  const beyondRevealedAccuracy = rate(beyond.filter((event) => event.correct).length, beyond.length, minimum);
  const bothReported = withinRevealedAccuracy.value !== null && beyondRevealedAccuracy.value !== null;
  return {
    version: PROGRESSIVE_DISCOVERY_VERSION,
    revealedAttempts: within.length,
    beyondAttempts: beyond.length,
    withinRevealedAccuracy,
    beyondRevealedAccuracy,
    gap: bothReported ? Number((withinRevealedAccuracy.value - beyondRevealedAccuracy.value).toFixed(4)) : null,
    verdict: !bothReported
      ? "insufficient-evidence"
      : withinRevealedAccuracy.value >= beyondRevealedAccuracy.value
        ? "discovery-keeps-pace"
        : "discovery-lags-exposure",
  };
}
