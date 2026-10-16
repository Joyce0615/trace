/**
 * Delayed transfer probes (item 11).
 *
 * `electron/analytics.mjs`'s existing `transferAnalytics` already splits
 * activity into near/far by whether the learner has opened the file — but it
 * has no time axis at all: a far-transfer attempt five minutes after reading
 * the lesson and one five weeks later are the same data point. And nothing in
 * the app ever *schedules* a transfer check against code the learner has
 * genuinely never opened; every transfer measurement today is incidental,
 * assembled after the fact from whatever exercises happened to touch
 * unfamiliar files. That conflates two different questions a learner-model
 * actually needs answered separately: "can you apply this right now" (what
 * every quiz/activity already measures) and "do you still have it, applied to
 * code you have never personally seen, after time has passed" (what this
 * module exists to make askable at all).
 *
 * This module answers the "what, and is it time yet" half of that question:
 *
 *   - `unseenRelatedFiles` walks the knowledge graph outward from a skill's own
 *     anchors (import/call edges, by default) and returns every file that is
 *     *related* to the skill but that the learner has never opened, nearest
 *     first by hop count. "Related" is deliberately graph-derived rather than
 *     guessed from naming or directory proximity, so it survives a rename.
 *   - `elapsedSinceStudy` reports how long it has been since the skill was
 *     last reviewed or given fresh evidence, so "delayed" has an actual number
 *     behind it instead of being whatever happens to occur.
 *   - `planDelayedTransferProbe` combines both: a probe is only "available"
 *     once a minimum delay has passed *and* there is still unseen related code
 *     to probe against. Every other outcome names exactly why not
 *     (`not-studied-yet` / `too-soon` / `no-unseen-related-code`), so a caller
 *     can tell "nothing to show yet" apart from "nothing left to probe".
 *
 * Grading a returned candidate and recording it (`kind: "delayed-transfer"`,
 * with `elapsedDays` and `path` on the activity event) is the caller's job —
 * exactly as every other activity kind in this app is recorded by the main
 * process, not by this module — so `electron/analytics.mjs`'s
 * `delayedTransferAnalytics` can bucket the resulting events by delay.
 *
 * The breadth-first walk below is its own small copy of
 * `knowledge-graph.mjs`'s `neighborhood`, not an import of it: this module is
 * loaded by `analytics.mjs`, which the browser demo imports directly, and
 * `knowledge-graph.mjs` pulls in `node:fs`/`node:crypto`/`node:child_process`
 * transitively through `repository.mjs`. Importing it here would make the
 * whole chain Node-only and break in the browser the first time a learner
 * opened the Analytics panel in the demo. The two walks are intentionally
 * identical in behaviour; `unseenRelatedFiles` growing `neighborhood` one hop
 * at a time below is additionally what gives each related file its *exact*
 * shortest hop count, which a single depth-N call does not expose.
 *
 * Pure: no fs/network, no Node builtins.
 */

export const TRANSFER_PROBE_VERSION = 1;

/** How many hops outward from a skill's anchors count as "related". */
export const DEFAULT_TRANSFER_PROBE_DEPTH = 3;

/** Which knowledge-graph edges count as a relatedness path. */
export const DEFAULT_TRANSFER_EDGE_KINDS = ["imports", "calls"];

/** How long since a skill was last studied before a delayed probe is offered. */
export const DEFAULT_MIN_TRANSFER_DELAY_DAYS = 1;

const DAY_MS = 86_400_000;

function round(value, places = 4) {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Number(Number(value).toFixed(places));
}

/**
 * Files related to `anchorPaths` by the knowledge graph, excluding anything
 * already an anchor or already studied, nearest first.
 *
 * A plain breadth-first search from every anchor at once, so a file reachable
 * from two different anchors (or by two different paths from the same one)
 * is reported at its true shortest distance rather than whichever path a
 * naive walk happened to take first.
 */
export function unseenRelatedFiles(knowledgeGraph, anchorPaths, studiedPaths, options = {}) {
  const depth = Math.max(1, Math.trunc(options.depth ?? DEFAULT_TRANSFER_PROBE_DEPTH));
  const edgeKinds = new Set(options.edgeKinds ?? DEFAULT_TRANSFER_EDGE_KINDS);
  const excluded = new Set([...(anchorPaths ?? []), ...(studiedPaths ?? [])]);

  const adjacency = new Map();
  for (const edge of knowledgeGraph?.edges ?? []) {
    if (!edgeKinds.has(edge.kind)) continue;
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.to).push(edge.from);
  }
  const byId = new Map((knowledgeGraph?.nodes ?? []).map((node) => [node.id, node]));

  const hopOf = new Map();
  const visited = new Set();
  let frontier = (anchorPaths ?? [])
    .map((anchorPath) => `file:${anchorPath}`)
    .filter((startId) => byId.has(startId));
  for (const startId of frontier) visited.add(startId);

  for (let hop = 1; hop <= depth && frontier.length; hop += 1) {
    const next = [];
    for (const id of frontier) {
      for (const neighbourId of adjacency.get(id) ?? []) {
        if (visited.has(neighbourId)) continue;
        visited.add(neighbourId);
        next.push(neighbourId);
        const node = byId.get(neighbourId);
        if (node?.kind === "file" && !excluded.has(node.key) && !hopOf.has(node.key)) hopOf.set(node.key, hop);
      }
    }
    frontier = next;
  }

  return [...hopOf.entries()]
    .map(([path, hops]) => ({ path, hops }))
    .sort((left, right) => left.hops - right.hops || left.path.localeCompare(right.path));
}

/**
 * Days since a skill was last reviewed or given fresh evidence, or `null` if
 * it has never been studied at all. The *most recent* of a spaced-repetition
 * review and a raw evidence entry wins, so a skill reviewed on the main-process
 * scheduler and one only ever touched through lessons/notes are both covered.
 */
export function elapsedSinceStudy(mastery, now) {
  const nowTime = typeof now === "number" ? now : Date.parse(now ?? new Date().toISOString());
  const reviewedTime = mastery?.review?.lastReviewedAt ? Date.parse(mastery.review.lastReviewedAt) : null;
  const evidenceTimes = (mastery?.evidence ?? [])
    .map((item) => Date.parse(item?.createdAt))
    .filter((value) => Number.isFinite(value));
  const candidates = [reviewedTime, ...evidenceTimes].filter((value) => Number.isFinite(value));
  if (!candidates.length) return null;
  return Math.max(0, (nowTime - Math.max(...candidates)) / DAY_MS);
}

/**
 * Decide whether a delayed transfer probe is available for one skill right
 * now, and which unseen related file it should target.
 *
 * Every unavailable outcome names its reason rather than returning a bare
 * `false`, because "the learner hasn't started this skill yet", "it is too
 * soon to tell anything about retention", and "there is nothing left nearby
 * to probe" call for three different responses from a caller (nudge toward
 * the skill, wait, or widen the search depth) and collapsing them loses that.
 */
export function planDelayedTransferProbe(skillNode, mastery, knowledgeGraph, studiedPaths, options = {}) {
  const minDelayDays = options.minDelayDays ?? DEFAULT_MIN_TRANSFER_DELAY_DAYS;
  const now = options.now ?? new Date().toISOString();
  const elapsedDays = elapsedSinceStudy(mastery, now);
  const anchorPaths = (skillNode?.anchors ?? []).map((anchor) => anchor.path);
  const base = {
    version: TRANSFER_PROBE_VERSION,
    skillId: skillNode?.id ?? null,
    minDelayDays,
    elapsedDays: round(elapsedDays, 2),
  };

  if (elapsedDays === null) {
    return { ...base, available: false, reason: "not-studied-yet", candidate: null, candidates: [] };
  }
  if (elapsedDays < minDelayDays) {
    return { ...base, available: false, reason: "too-soon", candidate: null, candidates: [] };
  }
  if (!knowledgeGraph) {
    return { ...base, available: false, reason: "no-knowledge-graph", candidate: null, candidates: [] };
  }

  const related = unseenRelatedFiles(knowledgeGraph, anchorPaths, studiedPaths, options);
  if (!related.length) {
    return { ...base, available: false, reason: "no-unseen-related-code", candidate: null, candidates: [] };
  }

  const candidates = related.slice(0, Math.max(1, Math.trunc(options.maxCandidates ?? 5)));
  return { ...base, available: true, reason: null, candidate: candidates[0], candidates };
}
