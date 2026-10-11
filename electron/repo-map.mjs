import { estimateTokens } from "./context-engine.mjs";

/**
 * Graph-aware, token-budgeted repository maps (item 7).
 *
 * `search.mjs` ranks *symbols and lines* for a query. A repo map answers a
 * different question: "which whole *files* orient a reader (or an agent)
 * fastest, given this question, inside this many tokens" — Aider's
 * `repo-map` idea, generalized with three signals `search.mjs` does not
 * carry on its own:
 *
 *   - **structure** — PageRank over the knowledge graph's `imports`/`calls`
 *     edges, so a file many other files depend on outranks a leaf file that
 *     merely happens to match the query lexically;
 *   - **relevance** — the caller's own query-fused score per path (typically
 *     `search.mjs`'s fused RRF score), so the map is not just "the most
 *     central files" regardless of what was asked;
 *   - **confidence** — resolved edges are not all equally trustworthy.
 *     `repository.mjs`/`knowledge-graph.mjs` already label every resolved
 *     call edge `"exact"` (import-grounded) or `"heuristic"` (same-name
 *     guess), and leave the rest `"unresolved"`. A map built by treating
 *     every edge as equally real lets a same-name guess inflate a file's
 *     rank as confidently as a statically-grounded import; this module
 *     discounts PageRank's edge weight by that confidence instead.
 *
 * "Source/version" (the item's other named axis) is carried through as
 * `blobId`/`line of defines` provenance on every entry: each entry can be
 * traced to the exact graph node and partition it came from, and the whole
 * map is stamped with the knowledge graph's `version`, so a caller can tell
 * a map built from a stale graph apart from a fresh one without recomputing
 * anything.
 *
 * Pure: no fs/network — the caller supplies the already-built knowledge
 * graph and (optionally) a query-relevance lookup. No Node builtins (besides
 * the token estimator shared with context-engine.mjs, which has none
 * either), so this module stays importable from the browser demo like its
 * neighbours.
 */

export const REPO_MAP_VERSION = 1;

/** How much a resolution kind counts toward an edge's PageRank weight. */
export const CONFIDENCE_BY_RESOLUTION_KIND = {
  exact: 1,
  heuristic: 0.5,
  unresolved: 0,
};

function confidenceOf(edge) {
  if (!edge.resolved) return 0;
  return CONFIDENCE_BY_RESOLUTION_KIND[edge.resolutionKind] ?? 0.5;
}

/**
 * PageRank over file nodes, with edges weighted by resolution confidence.
 *
 * Standard damped power iteration. Dangling nodes (files with no outgoing
 * resolved edge — a leaf, or a file whose only edges are unresolved) must
 * redistribute their *entire* rank mass across every node each iteration;
 * dropping that mass is the classic bug that makes total rank drift below 1
 * and systematically under-ranks a repository with many leaf files relative
 * to one with few, which is exactly backwards (a leaf-heavy repo is not
 * "less connected" in aggregate, every file in it just has fewer out-edges).
 */
export function pageRank(fileIds, edgesByFile, options = {}) {
  const damping = options.damping ?? 0.85;
  const iterations = options.iterations ?? 40;
  const n = fileIds.length;
  if (n === 0) return new Map();

  const indexOf = new Map(fileIds.map((id, index) => [id, index]));
  // weightedOut[i] = [[j, weight], ...] for file i's outgoing edges to file j.
  const weightedOut = fileIds.map(() => []);
  const outWeightTotal = new Array(n).fill(0);
  for (const fileId of fileIds) {
    const i = indexOf.get(fileId);
    for (const edge of edgesByFile.get(fileId) ?? []) {
      const j = indexOf.get(edge.to);
      const weight = confidenceOf(edge);
      if (j === undefined || weight <= 0) continue;
      weightedOut[i].push([j, weight]);
      outWeightTotal[i] += weight;
    }
  }

  let rank = new Array(n).fill(1 / n);
  for (let iter = 0; iter < iterations; iter += 1) {
    // Dangling mass: every node whose confidence-weighted out-degree is
    // zero contributes its whole rank to be split evenly across all N
    // nodes this iteration, not discarded.
    let danglingMass = 0;
    for (let i = 0; i < n; i += 1) {
      if (outWeightTotal[i] <= 0) danglingMass += rank[i];
    }
    const base = (1 - damping) / n + (damping * danglingMass) / n;
    const next = new Array(n).fill(base);
    for (let i = 0; i < n; i += 1) {
      if (outWeightTotal[i] <= 0) continue;
      const share = (damping * rank[i]) / outWeightTotal[i];
      for (const [j, weight] of weightedOut[i]) {
        next[j] += share * weight;
      }
    }
    rank = next;
  }

  return new Map(fileIds.map((id, index) => [id, rank[index]]));
}

/** `file:<path>` nodes and `imports`/`calls` edges, grouped by source file path. */
function fileGraph(graph) {
  const fileIds = graph.nodes.filter((node) => node.kind === "file").map((node) => node.id);
  const edgesByFile = new Map();
  for (const edge of graph.edges) {
    if (edge.kind !== "imports" && edge.kind !== "calls") continue;
    // Edges may originate at a symbol node (calls) or a file node (imports);
    // a repo map ranks files, so every edge is attributed to its *file*.
    const fromFile = edge.from.startsWith("symbol:") ? `file:${edge.from.slice(7).split("#")[0]}` : edge.from;
    const toFile = edge.to.startsWith("symbol:")
      ? `file:${edge.to.slice(7).split("#")[0]}`
      : edge.to.startsWith("file:")
        ? edge.to
        : null; // external/unresolved target nodes carry no file to rank.
    if (!toFile || fromFile === toFile) continue;
    if (!edgesByFile.has(fromFile)) edgesByFile.set(fromFile, []);
    edgesByFile.get(fromFile).push({ to: toFile, resolved: edge.resolved, resolutionKind: edge.resolutionKind });
  }
  return { fileIds, edgesByFile };
}

/**
 * Build a token-budgeted repo map: rank every file by structure × relevance,
 * then greedily admit entries, highest combined score first, until the
 * budget is spent.
 *
 * `relevanceOf(path)` is supplied by the caller (typically a fused
 * `search.mjs` score per path, 0 when a path was not matched at all) so this
 * module stays retrieval-strategy-agnostic; a caller with no query simply
 * passes `() => 1` to get a pure-structure map.
 */
export function buildRepoMap(graph, options = {}) {
  const budget = options.budget ?? 2_000;
  const relevanceOf = options.relevanceOf ?? (() => 1);
  const limit = options.limit ?? 200;

  const { fileIds, edgesByFile } = fileGraph(graph);
  const rank = pageRank(fileIds, edgesByFile, options.pageRank);
  const totalRank = [...rank.values()].reduce((sum, value) => sum + value, 0) || 1;

  const fileNodesById = new Map(graph.nodes.filter((node) => node.kind === "file").map((node) => [node.id, node]));
  const blobIdByPath = new Map((graph.partitions ?? []).map((partition) => [partition.path, partition.blobId]));
  const symbolsByFile = new Map();
  for (const node of graph.nodes) {
    if (node.kind !== "symbol") continue;
    if (!symbolsByFile.has(node.path)) symbolsByFile.set(node.path, []);
    symbolsByFile.get(node.path).push(node);
  }

  const candidates = fileIds
    .map((fileId) => {
      const node = fileNodesById.get(fileId);
      const path = node.key;
      // Normalized so the two signals combine on comparable scales
      // regardless of repository size or query vocabulary breadth.
      const structure = rank.get(fileId) / totalRank;
      const relevance = Math.max(0, relevanceOf(path));
      const symbols = (symbolsByFile.get(path) ?? []).slice(0, options.maxSymbolsPerFile ?? 6);
      const summary = [path, ...symbols.map((symbol) => `${symbol.symbolKind ?? "symbol"} ${symbol.label}`)].join("\n");
      return {
        path,
        blobId: blobIdByPath.get(path) ?? null,
        score: structure * (1 + relevance),
        structure,
        relevance,
        symbols: symbols.map((symbol) => ({ name: symbol.label, kind: symbol.symbolKind ?? null, line: symbol.line ?? null })),
        summary,
        estimatedTokens: estimateTokens(summary),
      };
    })
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit);

  const entries = [];
  const omitted = [];
  let spent = 0;
  for (const candidate of candidates) {
    if (spent + candidate.estimatedTokens <= budget) {
      entries.push(candidate);
      spent += candidate.estimatedTokens;
    } else {
      omitted.push({ path: candidate.path, estimatedTokens: candidate.estimatedTokens, reason: `Excluded to stay within the ${budget}-token budget.` });
    }
  }

  return {
    version: REPO_MAP_VERSION,
    // Source/version provenance: which graph (and its own version/schema)
    // this map was derived from, so a caller can tell a map built from a
    // stale graph apart from a fresh one without recomputing anything.
    sourceGraphVersion: graph.version ?? null,
    sourceExtractionSchema: graph.extractionSchema ?? null,
    budget,
    estimatedTokens: spent,
    entries,
    omitted,
    consideredFiles: fileIds.length,
  };
}

/** A compact text block, ready to prepend to a prompt. */
export function renderRepoMap(map) {
  if (!map.entries.length) return "Repository map: (no files ranked within budget)";
  const lines = [`Repository map (${map.entries.length}/${map.consideredFiles} files, ~${map.estimatedTokens} tokens):`];
  for (const entry of map.entries) {
    lines.push(`- ${entry.path}`);
    for (const symbol of entry.symbols) lines.push(`    ${symbol.kind ?? "symbol"} ${symbol.name}${symbol.line ? ` (line ${symbol.line})` : ""}`);
  }
  if (map.omitted.length) lines.push(`...omitted ${map.omitted.length} lower-ranked file(s) to stay within budget.`);
  return lines.join("\n");
}
