import { CONTEXT_PACK_BUDGETS, buildContextPack, estimateTokens } from "./context-engine.mjs";
import { evaluateRetrievalCounterfactual } from "./retrieval-counterfactual.mjs";
import { evaluateTutorAnswer } from "./evaluation.mjs";
import { summarize } from "./performance.mjs";

/**
 * A local code-RAG evaluation suite (item 17).
 *
 * Every piece this item asks for already exists as a separately tested
 * system — `retrieval-counterfactual.mjs` already compares
 * lexical/symbol/graph/embedding/fused retrieval on one sampled gold set;
 * `context-engine.mjs`'s `buildContextPack` already enforces the three
 * context budgets (`lean`/`balanced`/`deep`); `evaluation.mjs`'s
 * `evaluateTutorAnswer` already scores grounding; `performance.mjs`'s
 * `summarize` already turns a list of durations into reliable
 * percentiles. Nothing here re-measures or re-derives any of those four —
 * confirmed by grep: zero prior matches for `rag-eval`/`modelFamilies`/
 * `costPerToken` as implementation identifiers anywhere in `electron/*.mjs`
 * before this item. What was missing is the thing that ties them together:
 * running the *same* fixed set of questions through every named model
 * family at every context budget, over one pinned ingestion snapshot, so
 * "which combination is actually worth its latency and cost" has an answer
 * instead of four separate, incomparable scorecards.
 *
 *   - **Model families, not live agents.** This module never spawns
 *     `codex`/`claude` itself (that is `agents.mjs`'s job, and it would make
 *     the suite non-deterministic, networked, and slow). A "provider" here
 *     is `{ id, family, answer }`, where `answer` is a caller-supplied
 *     function — in production, a thin wrapper around `agents.mjs`'s
 *     `askAgent`; in a test or an offline benchmark run, a deterministic
 *     fixture. The suite measures whatever `answer` returns; it never
 *     claims to have measured a live model it did not call.
 *   - **A fixed offline ingestion snapshot.** Comparing model families or
 *     context budgets is only meaningful if every comparison ran against
 *     the identical indexed repository — a benchmark that silently
 *     re-indexed between questions would be comparing different ground
 *     truth, not different configurations. `verifyFixedIngestionSnapshot`
 *     checks the one structural fact that makes that true: the search
 *     index's own `sourceVersion` must equal the repository's
 *     `versionId`, mirroring the same versionId-keying discipline
 *     `search.mjs`'s own `buildSearchIndex` already uses to bind an index
 *     to the repository state it was built from. `runRagEvaluationSuite`
 *     refuses to run rather than silently benchmark a mismatched pairing.
 *   - **Context budgets reused, not re-declared.** `modes` defaults to
 *     `Object.keys(CONTEXT_PACK_BUDGETS)` — the exact three budgets
 *     `buildContextPack` enforces, newly exported from `context-engine.mjs`
 *     for this purpose — so this suite can never silently drift from the
 *     budgets the application actually ships, the same drift risk already
 *     named for `model-fingerprint.mjs`'s `REQUIRED_CAPABILITIES` and
 *     `scale-tiers.mjs`'s `TIER_BUDGETS` in earlier items.
 *   - **Cost is estimated, never fabricated.** There is no real per-token
 *     billing data anywhere in this codebase (`codex`/`claude` are
 *     locally-installed CLIs with flat-rate access, not metered APIs this
 *     application calls), so inventing commercial pricing numbers would be
 *     exactly the kind of fabricated data this project's own discipline
 *     elsewhere refuses to produce. `DEFAULT_COST_CATALOG` therefore ships
 *     with exactly one entry — `local-index`, priced at a true, structural
 *     zero because `answerFromLocalIndex`'s free lookup path calls no model
 *     at all — and `estimateCostUsd` returns `null` (unknown, not a
 *     fabricated zero) for any family absent from the catalog. A caller who
 *     has real pricing for a family passes it via
 *     `options.costCatalog`, the same "caller may add their own named
 *     entries" extensibility `retrieval-counterfactual.mjs`'s
 *     `options.strategies` already offers.
 *
 * Pure except for the one `await answer(...)` call per case, which is
 * caller-supplied and may itself be async (a real agent invocation) or
 * synchronous (a deterministic fixture); this module does no file I/O, no
 * network, and no process spawning of its own.
 */

export const RAG_EVAL_VERSION = 1;

/**
 * The only built-in cost entry: the local-index path is free because it
 * calls no model at all. Every other family's cost is `null` (unknown)
 * unless the caller supplies real pricing via `options.costCatalog`.
 */
export const DEFAULT_COST_CATALOG = Object.freeze({
  "local-index": Object.freeze({ context: 0, completion: 0 }),
});

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

/**
 * Estimate the dollar cost of one question for a named model family, given
 * the context tokens spent and the completion tokens produced. Returns
 * `null` — not a fabricated `0` — when the family has no known per-token
 * pricing, because "free" and "unpriced" are different claims and
 * collapsing them would misreport a cost comparison as cheaper than it is.
 */
export function estimateCostUsd(family, contextTokens, completionTokens, catalog = DEFAULT_COST_CATALOG) {
  const pricing = catalog?.[family];
  if (!pricing) return null;
  const cost = (contextTokens / 1000) * pricing.context + (completionTokens / 1000) * pricing.completion;
  return round(cost);
}

/**
 * The one structural fact that makes a cross-configuration comparison
 * valid: the index was built from the exact repository state being
 * benchmarked, not some other snapshot. Mirrors `search.mjs`'s own
 * `sourceVersion`/`versionId` binding.
 */
export function verifyFixedIngestionSnapshot(index, repository) {
  const indexVersion = index?.sourceVersion;
  const repositoryVersion = repository?.versionId;
  if (!indexVersion || !repositoryVersion) {
    return { valid: false, reason: "index or repository is missing a versionId to pin the snapshot to." };
  }
  if (indexVersion !== repositoryVersion) {
    return { valid: false, reason: `index was built from ${indexVersion}, but the repository being benchmarked is ${repositoryVersion}.` };
  }
  return { valid: true, reason: null };
}

/**
 * Run one question through one provider at one context budget, and report
 * grounding, latency, and estimated cost for that single case.
 *
 * `questionCase` is passed through to `buildContextPack` almost unchanged
 * (merged with `{ mode }`) — it carries `question`/`scope`/`lesson`/
 * `openFile`/`memory` exactly as `buildContextPack`'s own contract already
 * requires, so this module invents no second context-request shape.
 */
export async function evaluateRagQuestion({ repository, provider, mode, questionCase, now = Date.now, costCatalog = DEFAULT_COST_CATALOG, lineCounts }) {
  const pack = await buildContextPack(repository, { ...questionCase, mode });
  const started = now();
  const response = await provider.answer({ question: questionCase.question, contextPack: pack, provider });
  const finished = now();
  const tookMs = Number.isFinite(response?.tookMs) ? response.tookMs : Math.max(0, finished - started);

  const grounding = evaluateTutorAnswer(response, repository, { lineCounts });
  const completionTokens = estimateTokens(response?.text ?? response ?? "");
  const costUsd = estimateCostUsd(provider.family, pack.estimatedTokens, completionTokens, costCatalog);

  return {
    questionId: questionCase.id,
    providerId: provider.id,
    family: provider.family,
    mode,
    contextTokens: pack.estimatedTokens,
    contextBudget: pack.budget,
    completionTokens,
    grounding,
    tookMs,
    costUsd,
  };
}

function summaryKey(family, mode) {
  return `${family}::${mode}`;
}

/**
 * Run the fixed question set through every provider at every requested
 * context budget, plus a retrieval-strategy comparison over the same
 * pinned ingestion snapshot, and report a grouped summary by
 * family/budget.
 *
 * Refuses to run (throws) when the snapshot is not fixed — see
 * `verifyFixedIngestionSnapshot` — rather than silently benchmarking a
 * mismatched index/repository pairing.
 */
export async function runRagEvaluationSuite({ index, repository, questions, providers, modes, retrieval = {}, costCatalog = DEFAULT_COST_CATALOG, now = Date.now, lineCounts }) {
  const snapshot = verifyFixedIngestionSnapshot(index, repository);
  if (!snapshot.valid) {
    throw new Error(`Fixed ingestion snapshot required for a RAG evaluation suite: ${snapshot.reason}`);
  }
  const modesToRun = modes?.length ? modes : Object.keys(CONTEXT_PACK_BUDGETS);

  const retrievalReport = evaluateRetrievalCounterfactual(index, repository, retrieval);

  const cases = [];
  for (const provider of providers ?? []) {
    for (const mode of modesToRun) {
      for (const questionCase of questions ?? []) {
        cases.push(await evaluateRagQuestion({ repository, provider, mode, questionCase, now, costCatalog, lineCounts }));
      }
    }
  }

  const groups = new Map();
  for (const entry of cases) {
    const key = summaryKey(entry.family, entry.mode);
    if (!groups.has(key)) groups.set(key, { family: entry.family, mode: entry.mode, entries: [] });
    groups.get(key).entries.push(entry);
  }

  const summaryList = [...groups.values()].map((group) => {
    const groundingScores = group.entries.map((entry) => entry.grounding.score);
    const costs = group.entries.map((entry) => entry.costUsd).filter((value) => value !== null);
    return {
      family: group.family,
      mode: group.mode,
      questions: group.entries.length,
      averageGrounding: round(groundingScores.reduce((sum, value) => sum + value, 0) / Math.max(1, groundingScores.length), 4),
      latency: summarize(group.entries.map((entry) => entry.tookMs)),
      totalCostUsd: costs.length ? round(costs.reduce((sum, value) => sum + value, 0)) : null,
      costUnknownCount: group.entries.length - costs.length,
    };
  });
  summaryList.sort((left, right) => left.family.localeCompare(right.family) || left.mode.localeCompare(right.mode));

  return {
    version: RAG_EVAL_VERSION,
    kind: "rag-eval",
    ingestionSnapshot: { repositoryId: repository.id, versionId: repository.versionId, valid: true },
    modes: modesToRun,
    retrieval: retrievalReport,
    cases,
    summary: summaryList,
    generatedAt: new Date().toISOString(),
  };
}

/** Prompt/report-ready text rendering of a full RAG evaluation suite run. */
export function renderRagEvaluationSuite(report) {
  const lines = [
    `# Code-RAG evaluation suite`,
    "",
    `Ingestion snapshot: repository \`${report.ingestionSnapshot.repositoryId}\` at \`${report.ingestionSnapshot.versionId}\`.`,
    "",
    "## Model family x context budget",
    "",
    "| family | mode | questions | avg grounding | p50 ms | p95 ms | total cost |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of report.summary) {
    const cost = row.totalCostUsd === null ? "unknown" : `$${row.totalCostUsd}`;
    lines.push(`| ${row.family} | ${row.mode} | ${row.questions} | ${row.averageGrounding} | ${row.latency.p50 ?? "n/a"} | ${row.latency.p95 ?? "n/a"} | ${cost} |`);
  }
  lines.push("");
  lines.push(`## Retrieval strategies (grounding lift: ${report.retrieval.groundingLift >= 0 ? "+" : ""}${report.retrieval.groundingLift})`);
  lines.push("");
  for (const entry of report.retrieval.strategies) {
    lines.push(`- ${entry.name}: recall@5 ${entry.metrics.recallAt5}, MRR ${entry.metrics.mrr}`);
  }
  return lines.join("\n");
}
