import { search } from "./search.mjs";

/**
 * Quality evaluation, kept deliberately separate.
 *
 * Retrieval, tutor answers, and lessons fail for different reasons and are
 * fixed by different changes, so this module never blends them into a single
 * number. It produces three independent scorecards:
 *
 *   - retrieval: can search find the file that defines a known symbol?
 *     (recall@1, recall@5, MRR, nDCG@5, plus a false-positive guard)
 *   - tutor:     is the answer grounded in this repository?
 *     (citation validity, unknown-symbol rate, context faithfulness)
 *   - lessons:   is the course anchored, ordered, and answerable?
 *     (anchor validity, symbol precision, quiz coverage, difficulty order)
 *
 * Gold data is derived from the repository's own index rather than authored by
 * hand, so the evaluation runs on any repository the learner opens.
 */

export const EVALUATION_VERSION = 1;

const CITATION = /\b([\w./-]+\.[A-Za-z]{1,6}):(\d+)\b/g;
const MENTIONED_SYMBOL = /`([A-Za-z_]\w{2,})(?:\(\))?`/g;
const NONSENSE_QUERIES = ["zzzqqqxxwvv", "qqzzxxjjkkww", "vvzzqqxxppll"];

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
}

/** Deterministic sample: every run over the same index evaluates the same cases. */
function sampleSymbols(repository, size) {
  const candidates = (repository.symbols ?? [])
    .filter((symbol) => symbol.name.length >= 4 && /^[A-Za-z_]\w+$/.test(symbol.name))
    .filter((symbol, index, all) => all.findIndex((other) => other.name === symbol.name) === index);
  if (candidates.length <= size) return candidates;
  const step = Math.floor(candidates.length / size);
  return Array.from({ length: size }, (unused, index) => candidates[index * step]).filter(Boolean);
}

/**
 * Retrieval quality: for each sampled symbol, does search return the file that
 * defines it? Ranking metrics are computed over the fused result list.
 */
export function evaluateRetrieval(index, repository, options = {}) {
  const size = options.sampleSize ?? 20;
  const limit = options.limit ?? 5;
  const cases = sampleSymbols(repository, size);
  const results = [];
  for (const symbol of cases) {
    const started = Date.now();
    const response = search(index, symbol.name, { limit });
    const ranked = response.results.map((result) => result.path);
    const rank = ranked.findIndex((path) => path === symbol.path);
    results.push({
      query: symbol.name,
      goldPath: symbol.path,
      rank: rank >= 0 ? rank + 1 : null,
      returned: ranked.length,
      exactSymbol: response.results.some((result) => result.symbol === symbol.name && result.path === symbol.path),
      tookMs: Date.now() - started,
    });
  }

  const found = results.filter((result) => result.rank !== null);
  const recallAt1 = results.filter((result) => result.rank === 1).length / Math.max(1, results.length);
  const recallAt5 = found.filter((result) => result.rank <= 5).length / Math.max(1, results.length);
  const mrr = results.reduce((sum, result) => sum + (result.rank ? 1 / result.rank : 0), 0) / Math.max(1, results.length);
  // Single-relevant-document nDCG reduces to 1/log2(rank+1).
  const ndcg = results.reduce((sum, result) => sum + (result.rank ? 1 / Math.log2(result.rank + 1) : 0), 0) / Math.max(1, results.length);

  const falsePositives = NONSENSE_QUERIES.map((query) => ({ query, returned: search(index, query, { limit }).results.length }));
  return {
    kind: "retrieval",
    cases: results.length,
    recallAt1: round(recallAt1),
    recallAt5: round(recallAt5),
    mrr: round(mrr),
    ndcgAt5: round(ndcg),
    exactSymbolRate: round(results.filter((result) => result.exactSymbol).length / Math.max(1, results.length)),
    missed: results.filter((result) => result.rank === null).map((result) => ({ query: result.query, goldPath: result.goldPath })).slice(0, 10),
    medianLatencyMs: results.length ? results.map((result) => result.tookMs).sort((left, right) => left - right)[Math.floor(results.length / 2)] : 0,
    falsePositiveQueries: falsePositives.filter((entry) => entry.returned > 0).length,
    falsePositiveRate: round(falsePositives.filter((entry) => entry.returned > 0).length / NONSENSE_QUERIES.length),
    samples: results.slice(0, 10),
  };
}

/**
 * Tutor-answer quality: is the answer grounded in *this* repository?
 * Style is not scored; citations, invented symbols, and use of the supplied
 * context are, because those are what make an answer trustworthy.
 */
export function evaluateTutorAnswer(answer, repository, options = {}) {
  const text = String(answer?.text ?? answer ?? "");
  const files = new Map((repository.files ?? []).map((file) => [file.path, file]));
  const symbolNames = new Set((repository.symbols ?? []).map((symbol) => symbol.name));
  const lineCounts = options.lineCounts ?? {};

  const citations = [...text.matchAll(CITATION)].map((match) => ({ path: match[1], line: Number(match[2]) }));
  const checkedCitations = citations.map((citation) => {
    const known = files.has(citation.path);
    const lines = lineCounts[citation.path];
    const inRange = citation.line >= 1 && (lines === undefined || citation.line <= lines);
    return { ...citation, valid: known && inRange, reason: !known ? "unknown-file" : !inRange ? "line-out-of-range" : null };
  });
  const validCitations = checkedCitations.filter((citation) => citation.valid);

  const mentioned = [...new Set([...text.matchAll(MENTIONED_SYMBOL)].map((match) => match[1]))]
    .filter((name) => !files.has(name) && !/^(the|and|this|that|with|from|into|json|http)$/i.test(name));
  const unknown = mentioned.filter((name) => !symbolNames.has(name));

  const packSources = (answer?.pack?.sections ?? [])
    .map((section) => section.source?.split(":")[0])
    .filter(Boolean);
  const usedSources = [...new Set(packSources)].filter((source) => text.includes(source));

  const grounding = citations.length ? validCitations.length / citations.length : 0;
  const symbolPrecision = mentioned.length ? 1 - unknown.length / mentioned.length : 1;
  const faithfulness = packSources.length ? usedSources.length / new Set(packSources).size : 0;
  const score = 0.5 * grounding + 0.3 * symbolPrecision + 0.2 * faithfulness;

  return {
    kind: "tutor",
    citations: checkedCitations.length,
    validCitations: validCitations.length,
    invalidCitations: checkedCitations.filter((citation) => !citation.valid),
    grounding: round(grounding),
    mentionedSymbols: mentioned.length,
    unknownSymbols: unknown,
    symbolPrecision: round(symbolPrecision),
    contextSources: new Set(packSources).size,
    usedContextSources: usedSources.length,
    faithfulness: round(faithfulness),
    score: round(score),
    verdict: score >= 0.8 ? "grounded" : score >= 0.5 ? "partly-grounded" : "ungrounded",
    // An answer with no citation at all cannot be verified, however fluent it is.
    unverifiable: citations.length === 0,
  };
}

/** Course quality: anchors that exist, quizzes that exist, and sane ordering. */
export function evaluateLessons(course, repository, skillGraph = null) {
  const files = new Set((repository.files ?? []).map((file) => file.path));
  const symbolIndex = new Map();
  for (const symbol of repository.symbols ?? []) {
    if (!symbolIndex.has(symbol.path)) symbolIndex.set(symbol.path, new Set());
    symbolIndex.get(symbol.path).add(symbol.name);
  }
  const lessons = (course?.modules ?? []).flatMap((module) => module.lessons ?? []);
  const anchors = lessons.flatMap((lesson) => (lesson.anchors ?? []).map((anchor) => ({ ...anchor, lessonId: lesson.id })));
  const validAnchors = anchors.filter((anchor) => files.has(anchor.path));
  const symbolAnchors = anchors.filter((anchor) => anchor.symbol);
  const accurateSymbolAnchors = symbolAnchors.filter((anchor) => symbolIndex.get(anchor.path)?.has(anchor.symbol));

  const contentBlocks = lessons.flatMap((lesson) => lesson.content ?? []);
  const blockAnchors = contentBlocks.flatMap((block) => [
    ...(block.steps ?? []).map((step) => step.anchor).filter(Boolean),
    ...(block.nodes ?? []).map((node) => node.anchor).filter(Boolean),
  ]);
  const validBlockAnchors = blockAnchors.filter((anchor) => files.has(anchor.path));

  const difficultyRank = { foundation: 0, intermediate: 1, advanced: 2 };
  let inversions = 0;
  for (let index = 1; index < lessons.length; index += 1) {
    if ((difficultyRank[lessons[index].difficulty] ?? 0) < (difficultyRank[lessons[index - 1].difficulty] ?? 0)) inversions += 1;
  }

  const withQuiz = lessons.filter((lesson) => lesson.quiz?.question?.length > 10);
  const withoutAnchor = lessons.filter((lesson) => !(lesson.anchors ?? []).length).map((lesson) => lesson.id);
  const entryCoverage = (repository.entryFiles ?? []).filter((entry) => anchors.some((anchor) => anchor.path === entry)).length
    / Math.max(1, (repository.entryFiles ?? []).length);
  const skillCoverage = skillGraph
    ? skillGraph.nodes.filter((node) => lessons.some((lesson) => lesson.id === node.lessonId)).length / Math.max(1, skillGraph.nodes.length)
    : null;

  const anchorValidity = anchors.length ? validAnchors.length / anchors.length : 0;
  const symbolAccuracy = symbolAnchors.length ? accurateSymbolAnchors.length / symbolAnchors.length : 1;
  const quizCoverage = lessons.length ? withQuiz.length / lessons.length : 0;
  const score = 0.4 * anchorValidity + 0.2 * symbolAccuracy + 0.2 * quizCoverage + 0.2 * (inversions === 0 ? 1 : 0);

  return {
    kind: "lessons",
    lessons: lessons.length,
    anchors: anchors.length,
    anchorValidity: round(anchorValidity),
    danglingAnchors: anchors.filter((anchor) => !files.has(anchor.path)).map((anchor) => ({ lessonId: anchor.lessonId, path: anchor.path })).slice(0, 10),
    symbolAnchors: symbolAnchors.length,
    symbolAccuracy: round(symbolAccuracy),
    contentBlocks: contentBlocks.length,
    blockAnchorValidity: blockAnchors.length ? round(validBlockAnchors.length / blockAnchors.length) : 1,
    quizCoverage: round(quizCoverage),
    lessonsWithoutAnchor: withoutAnchor,
    difficultyInversions: inversions,
    entryPointCoverage: round(entryCoverage),
    skillCoverage: skillCoverage === null ? null : round(skillCoverage),
    score: round(score),
    verdict: score >= 0.8 ? "solid" : score >= 0.5 ? "usable" : "weak",
  };
}

/**
 * Run every scorecard. There is deliberately no combined score: a course with
 * perfect anchors and a broken retriever is not "70% good", it is two different
 * problems, and averaging them would hide both.
 */
export function runEvaluation({ index, repository, course, skillGraph, answers = [], options = {} }) {
  return {
    version: EVALUATION_VERSION,
    separate: true,
    retrieval: index ? evaluateRetrieval(index, repository, options.retrieval ?? {}) : null,
    tutor: answers.length
      ? (() => {
          const scored = answers.map((answer) => evaluateTutorAnswer(answer, repository, options.tutor ?? {}));
          return {
            kind: "tutor",
            answers: scored.length,
            grounding: round(scored.reduce((sum, item) => sum + item.grounding, 0) / scored.length),
            symbolPrecision: round(scored.reduce((sum, item) => sum + item.symbolPrecision, 0) / scored.length),
            faithfulness: round(scored.reduce((sum, item) => sum + item.faithfulness, 0) / scored.length),
            score: round(scored.reduce((sum, item) => sum + item.score, 0) / scored.length),
            unverifiable: scored.filter((item) => item.unverifiable).length,
            verdicts: scored.map((item) => item.verdict),
            details: scored,
          };
        })()
      : null,
    lessons: course ? evaluateLessons(course, repository, skillGraph) : null,
    generatedAt: new Date().toISOString(),
  };
}
