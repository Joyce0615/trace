import { evaluateRetrieval } from "./evaluation.mjs";

/**
 * Retrieval counterfactual evaluation (item 9).
 *
 * `evaluation.mjs`'s `evaluateRetrieval` scores *one* configuration of
 * `search.mjs` — by default, the fully fused lexical+symbol+graph+embedding
 * ranking. It cannot, on its own, answer "how much is fusion actually
 * buying us over any single retriever" because comparing retrievers means
 * running the identical gold-symbol sample through each strategy in
 * isolation and lining the scorecards up side by side. This module is that
 * comparison: it runs `evaluateRetrieval` once per named strategy — the
 * four pure strategies the backlog item names (lexical/symbol/graph/
 * embedding) plus the fused baseline — over the *same* sampled queries, and
 * reports recall@1, recall@5, MRR, nDCG@5, median latency, and the
 * false-positive rate for each, plus one derived number: "grounding lift",
 * fusion's recall@5 margin over the best single strategy. A negative lift
 * would mean fusion is actively worse than just using its best input, which
 * is itself a signal worth surfacing rather than averaging away.
 *
 * Every strategy here is defined purely as a `search.mjs` weight vector
 * (`{ lexical, symbol, graph, embedding }`), zeroing out every retriever but
 * the one under test, so this module can never silently diverge from
 * `search.mjs`'s own fusion math the way a hand-rolled "run just the BM25
 * step" reimplementation could. Callers may add their own named weight
 * vectors via `options.strategies` (e.g. to score a config change before
 * shipping it), and a strategy that returns nothing at all is reported with
 * honest zero scores rather than silently dropped from the comparison.
 *
 * Pure: no fs/network, no Node builtins — same portability contract as
 * `search.mjs` and `evaluation.mjs`, so the browser demo can run the same
 * comparison the desktop app does.
 */

export const RETRIEVAL_COUNTERFACTUAL_VERSION = 1;

/** The four isolated retrievers the backlog item names, by weight vector. */
export const SINGLE_STRATEGY_WEIGHTS = {
  lexical: { lexical: 1, symbol: 0, graph: 0, embedding: 0 },
  symbol: { lexical: 0, symbol: 1, graph: 0, embedding: 0 },
  graph: { lexical: 0, symbol: 0, graph: 1, embedding: 0 },
  embedding: { lexical: 0, symbol: 0, graph: 0, embedding: 1 },
};

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
}

function metricsOf(scorecard) {
  return {
    cases: scorecard.cases,
    recallAt1: scorecard.recallAt1,
    recallAt5: scorecard.recallAt5,
    mrr: scorecard.mrr,
    ndcgAt5: scorecard.ndcgAt5,
    exactSymbolRate: scorecard.exactSymbolRate,
    medianLatencyMs: scorecard.medianLatencyMs,
    falsePositiveQueries: scorecard.falsePositiveQueries,
    falsePositiveRate: scorecard.falsePositiveRate,
  };
}

/**
 * Run every named strategy (the four single retrievers, "fused", plus any
 * caller-supplied extras) over one deterministic gold-symbol sample and
 * return a side-by-side scorecard for each, plus the grounding lift of
 * fusion over the best single strategy.
 *
 * `options.sampleSize`/`options.limit` are forwarded to every strategy's
 * `evaluateRetrieval` call unchanged, so every strategy is judged on
 * exactly the same queries at exactly the same cutoff — the only axis that
 * varies between runs is the weight vector itself.
 */
export function evaluateRetrievalCounterfactual(index, repository, options = {}) {
  const { strategies: extraStrategies, ...retrievalOptions } = options;
  const namedWeights = { ...SINGLE_STRATEGY_WEIGHTS, ...(extraStrategies ?? {}) };

  const strategies = [];
  for (const [name, weights] of Object.entries(namedWeights)) {
    const scorecard = evaluateRetrieval(index, repository, { ...retrievalOptions, weights });
    strategies.push({ name, weights, metrics: metricsOf(scorecard), missed: scorecard.missed });
  }
  // Fused is evaluated last and separately: it is the real, unweighted
  // search.mjs default rather than a weight vector this module invents, so
  // it must go through evaluateRetrieval with no `weights` override at all
  // (an explicit `{ lexical: 1, symbol: 1.2, graph: 0.6, embedding: 0.8 }`
  // vector would silently drift from search.mjs's own defaults the moment
  // either file changed its default weights independently).
  const fusedScorecard = evaluateRetrieval(index, repository, retrievalOptions);
  strategies.push({ name: "fused", weights: null, metrics: metricsOf(fusedScorecard), missed: fusedScorecard.missed });

  const singleStrategyRecallAt5 = strategies
    .filter((entry) => entry.name !== "fused" && Object.keys(namedWeights).includes(entry.name) && entry.name in SINGLE_STRATEGY_WEIGHTS)
    .map((entry) => entry.metrics.recallAt5);
  const bestSingle = singleStrategyRecallAt5.length ? Math.max(...singleStrategyRecallAt5) : 0;
  const fusedRecallAt5 = strategies.find((entry) => entry.name === "fused").metrics.recallAt5;
  const groundingLift = round(fusedRecallAt5 - bestSingle);

  return {
    version: RETRIEVAL_COUNTERFACTUAL_VERSION,
    kind: "retrieval-counterfactual",
    sampleSize: retrievalOptions.sampleSize ?? 20,
    strategies,
    bestSingleStrategyRecallAt5: round(bestSingle),
    fusedRecallAt5: round(fusedRecallAt5),
    groundingLift,
  };
}

/** Prompt/report-ready text rendering of a counterfactual comparison. */
export function renderRetrievalCounterfactual(report) {
  const lines = [`# Retrieval counterfactual (${report.sampleSize} sampled queries)`, ""];
  lines.push("| strategy | recall@1 | recall@5 | MRR | nDCG@5 | median ms | false positives |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const entry of report.strategies) {
    const m = entry.metrics;
    lines.push(`| ${entry.name} | ${m.recallAt1} | ${m.recallAt5} | ${m.mrr} | ${m.ndcgAt5} | ${m.medianLatencyMs} | ${m.falsePositiveQueries} |`);
  }
  lines.push("");
  lines.push(`Grounding lift (fused recall@5 − best single-strategy recall@5): ${report.groundingLift >= 0 ? "+" : ""}${report.groundingLift}`);
  if (report.groundingLift < 0) lines.push("Fusion is currently worse than its best single input — investigate before trusting fused results.");
  return lines.join("\n");
}
