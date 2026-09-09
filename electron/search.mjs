/**
 * Hybrid repository search.
 *
 * No single retrieval strategy answers every question a learner asks. "Where is
 * the retry timeout" is lexical, "Scheduler" is a symbol lookup, "what does this
 * file depend on" is a graph walk, and "code that batches requests" is fuzzy.
 * This module runs four independent retrievers and fuses their rankings:
 *
 *   - lexical:   BM25 over indexed file contents;
 *   - symbol:    exact, prefix, and subsequence matching over the symbol index;
 *   - graph:     import and call-edge expansion from the strongest seeds;
 *   - embedding: cosine similarity over local hashed character-trigram vectors.
 *
 * The embedding retriever is deliberately model-free: a hashed trigram vector
 * needs no download, no network, and no GPU, and it is deterministic, which
 * matters more here than absolute recall. Fusion is Reciprocal Rank Fusion, so
 * a result that several strategies agree on outranks one that only a single
 * strategy liked.
 *
 * This module has no Node dependencies on purpose: the desktop app and the
 * browser demo import the same retrieval code, so they cannot drift apart.
 */

export const SEARCH_VERSION = 1;
export const EMBEDDING_DIMENSIONS = 256;

export const DEFAULT_SEARCH_LIMITS = {
  maxIndexedFiles: 500,
  maxFileBytes: 120_000,
  maxTokensPerFile: 4_000,
  maxResults: 20,
};

const STOP_WORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "are", "was", "were", "have", "has", "not", "but", "you", "your", "its", "it's"]);

/** Split identifiers the way a reader does: snake_case, camelCase, and dots. */
export function tokenize(text) {
  const tokens = [];
  for (const raw of String(text ?? "").split(/[^A-Za-z0-9_$]+/)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (lower.length >= 2 && !STOP_WORDS.has(lower)) tokens.push(lower);
    for (const part of raw.split(/_+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      const piece = part.toLowerCase();
      if (piece.length >= 2 && piece !== lower && !STOP_WORDS.has(piece)) tokens.push(piece);
    }
  }
  return tokens;
}

function hashTrigram(trigram) {
  let hash = 2_166_136_261;
  for (let index = 0; index < trigram.length; index += 1) {
    hash ^= trigram.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return Math.abs(hash) % EMBEDDING_DIMENSIONS;
}

/** Deterministic local embedding: L2-normalized hashed character trigrams. */
export function embed(text) {
  const vector = new Float64Array(EMBEDDING_DIMENSIONS);
  const normalized = ` ${String(text ?? "").toLowerCase().replace(/[^a-z0-9_]+/g, " ").trim()} `;
  for (let index = 0; index + 3 <= normalized.length; index += 1) {
    vector[hashTrigram(normalized.slice(index, index + 3))] += 1;
  }
  let magnitude = 0;
  for (const value of vector) magnitude += value * value;
  magnitude = Math.sqrt(magnitude);
  if (magnitude > 0) for (let index = 0; index < vector.length; index += 1) vector[index] /= magnitude;
  return vector;
}

export function cosine(left, right) {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += left[index] * right[index];
  return total;
}

/**
 * Read and index the repository once per version. Indexing is bounded by file
 * count and file size so a large repository cannot stall the search box.
 *
 * `options.read` supplies file contents. It is required rather than defaulted so
 * this module stays free of Node built-ins and the browser demo can run exactly
 * the same retrieval code as the desktop app.
 */
export async function buildSearchIndex(repository, options = {}) {
  const limits = { ...DEFAULT_SEARCH_LIMITS, ...(options.limits ?? {}) };
  const read = options.read;
  if (typeof read !== "function") throw new Error("buildSearchIndex requires a read(filePath) function.");
  const candidates = [...(repository.files ?? [])]
    .filter((file) => (file.size ?? 0) <= limits.maxFileBytes && !/\.(png|jpg|jpeg|gif|pdf|zip|so|dylib|dll|bin|whl)$/i.test(file.path))
    .sort((left, right) => (right.importance ?? 0) - (left.importance ?? 0) || left.path.localeCompare(right.path))
    .slice(0, limits.maxIndexedFiles);

  const documents = [];
  const documentFrequency = new Map();
  for (const file of candidates) {
    let text = "";
    try {
      text = await read(file.path);
    } catch {
      continue;
    }
    const tokens = [...tokenize(`${file.path} ${text}`)].slice(0, limits.maxTokensPerFile);
    if (!tokens.length) continue;
    const frequencies = new Map();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    for (const token of frequencies.keys()) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    documents.push({
      path: file.path,
      language: file.language,
      importance: file.importance ?? 0,
      length: tokens.length,
      frequencies,
      lines: text.split(/\r?\n/),
      // Symbols in a file bias its embedding toward what the file is *about*.
      embedding: embed(`${file.path} ${(repository.symbols ?? []).filter((symbol) => symbol.path === file.path).map((symbol) => symbol.name).join(" ")} ${text.slice(0, 20_000)}`),
    });
  }

  return {
    version: SEARCH_VERSION,
    repositoryId: repository.id,
    sourceVersion: repository.versionId,
    documents,
    documentFrequency,
    averageLength: documents.reduce((sum, document) => sum + document.length, 0) / Math.max(1, documents.length),
    symbols: (repository.symbols ?? []).map((symbol) => ({ ...symbol, lower: symbol.name.toLowerCase(), embedding: null })),
    imports: repository.imports ?? [],
    callEdges: repository.callEdges ?? [],
    limits,
    stats: { indexedFiles: documents.length, candidateFiles: candidates.length, vocabulary: documentFrequency.size },
  };
}

function bm25(index, queryTokens, options = {}) {
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;
  const total = index.documents.length;
  const scored = [];
  for (const document of index.documents) {
    let score = 0;
    for (const token of queryTokens) {
      const frequency = document.frequencies.get(token);
      if (!frequency) continue;
      const documentFrequency = index.documentFrequency.get(token) ?? 0;
      const idf = Math.log(1 + (total - documentFrequency + 0.5) / (documentFrequency + 0.5));
      score += idf * ((frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * (document.length / (index.averageLength || 1)))));
    }
    if (score > 0) scored.push({ path: document.path, score, document });
  }
  return scored.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

/** Bounded Levenshtein distance; returns `limit + 1` once the bound is exceeded. */
export function editDistance(left, right, limit = 4) {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (unused, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let best = row;
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + cost);
      best = Math.min(best, current[column]);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length];
}

/** Normalized similarity for a misspelled identifier, in [0, 1]. */
export function similarityScore(query, candidate) {
  const longest = Math.max(query.length, candidate.length);
  if (!longest) return 0;
  const distance = editDistance(query, candidate);
  return distance > 4 ? 0 : 1 - distance / longest;
}

/** Subsequence match, the behaviour a fuzzy file/symbol picker is expected to have. */
export function subsequenceScore(query, candidate) {
  if (!query) return 0;
  let cursor = 0;
  let gaps = 0;
  for (const character of candidate) {
    if (character === query[cursor]) {
      cursor += 1;
      if (cursor === query.length) break;
    } else if (cursor > 0) {
      gaps += 1;
    }
  }
  if (cursor < query.length) return 0;
  return 1 / (1 + gaps / Math.max(1, candidate.length));
}

function symbolSearch(index, query) {
  const lower = query.toLowerCase();
  const tokens = tokenize(query);
  const scored = [];
  for (const symbol of index.symbols) {
    let score = 0;
    if (symbol.lower === lower) score = 4;
    else if (symbol.lower.startsWith(lower)) score = 3;
    else if (symbol.lower.includes(lower)) score = 2;
    else if (tokens.some((token) => symbol.lower.includes(token))) score = 1.2;
    else {
      // A misspelled identifier belongs to the symbol retriever, not to a fuzzy
      // embedding: edit similarity is what actually recognises `Schedular`.
      const compact = lower.replace(/[^a-z0-9_]/g, "");
      const similarity = similarityScore(compact, symbol.lower);
      const fuzzy = subsequenceScore(compact, symbol.lower);
      score = Math.max(similarity >= 0.7 ? similarity : 0, fuzzy);
    }
    if (score > 0) scored.push({ path: symbol.path, line: symbol.line, symbol: symbol.name, kind: symbol.kind, score });
  }
  return scored.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

function graphSearch(index, seeds, limit) {
  const scores = new Map();
  const seedPaths = new Set(seeds);
  for (const item of index.imports) {
    if (!item.targetPath) continue;
    if (seedPaths.has(item.targetPath)) scores.set(item.path, (scores.get(item.path) ?? 0) + 1);
    if (seedPaths.has(item.path)) scores.set(item.targetPath, (scores.get(item.targetPath) ?? 0) + 0.8);
  }
  for (const edge of index.callEdges) {
    if (!edge.resolved || !edge.targetPath) continue;
    if (seedPaths.has(edge.targetPath)) scores.set(edge.path, (scores.get(edge.path) ?? 0) + 0.9);
    if (seedPaths.has(edge.path)) scores.set(edge.targetPath, (scores.get(edge.targetPath) ?? 0) + 0.7);
  }
  for (const seed of seedPaths) scores.delete(seed);
  return [...scores.entries()]
    .map(([path, score]) => ({ path, score }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit);
}

// A trigram embedding always produces *some* similarity, and on a large corpus
// nonsense can out-score a real query (measured: 0.37 for gibberish against 0.43
// for a real phrase), so an absolute threshold cannot separate them. Embedding
// results are therefore kept only when something else anchors the query to this
// repository - a known token or a recognisable symbol - and must still clear a
// fraction of the best match for the query.
const EMBEDDING_FLOOR = 0.25;
const EMBEDDING_RELATIVE_FLOOR = 0.4;

function embeddingSearch(index, query, limit, options = {}) {
  const vector = embed(query);
  const scored = index.documents
    .map((document) => ({ path: document.path, score: cosine(vector, document.embedding) }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const best = scored[0]?.score ?? 0;
  const floor = Math.max(options.minSimilarity ?? EMBEDDING_FLOOR, best * (options.relativeFloor ?? EMBEDDING_RELATIVE_FLOOR));
  return scored.filter((entry) => entry.score >= floor).slice(0, limit);
}

function bestLine(document, queryTokens) {
  if (!document) return null;
  let best = null;
  document.lines.slice(0, 4_000).forEach((line, position) => {
    const lower = line.toLowerCase();
    const hits = queryTokens.filter((token) => lower.includes(token)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { line: position + 1, text: line.trim().slice(0, 200), hits };
  });
  return best;
}

/**
 * Run every retriever and fuse the rankings.
 * Reciprocal Rank Fusion is used because the four scores are not comparable:
 * BM25 is unbounded, cosine is in [0,1], and graph scores are edge counts.
 */
export function search(index, query, options = {}) {
  const limit = Math.min(options.limit ?? 10, index.limits.maxResults);
  const rrfK = options.rrfK ?? 60;
  const weights = { lexical: 1, symbol: 1.2, graph: 0.6, embedding: 0.8, ...(options.weights ?? {}) };
  const trimmed = String(query ?? "").trim();
  if (!trimmed) return { version: SEARCH_VERSION, query: "", results: [], strategies: {}, fused: 0 };

  const queryTokens = [...new Set(tokenize(trimmed))];
  const documentsByPath = new Map(index.documents.map((document) => [document.path, document]));
  const started = Date.now();

  const lexical = bm25(index, queryTokens).slice(0, limit * 3);
  const symbols = symbolSearch(index, trimmed).slice(0, limit * 3);
  const seeds = [...new Set([...lexical.slice(0, 5).map((entry) => entry.path), ...symbols.slice(0, 5).map((entry) => entry.path)])];
  const graph = graphSearch(index, seeds, limit * 2);
  const grounded = queryTokens.some((token) => index.documentFrequency.has(token))
    || symbols.some((entry) => entry.score >= 0.7);
  const embedding = grounded ? embeddingSearch(index, trimmed, limit * 3, options) : [];

  const fused = new Map();
  const contribute = (strategy, entries) => {
    entries.forEach((entry, position) => {
      const key = entry.symbol ? `${entry.path}#${entry.symbol}@${entry.line}` : entry.path;
      const record = fused.get(key) ?? {
        path: entry.path,
        line: entry.line ?? null,
        symbol: entry.symbol ?? null,
        kind: entry.kind ?? null,
        score: 0,
        strategies: {},
      };
      record.score += weights[strategy] / (rrfK + position + 1);
      record.strategies[strategy] = { rank: position + 1, score: Number(entry.score.toFixed(4)) };
      if (entry.symbol && !record.symbol) {
        record.symbol = entry.symbol;
        record.line = entry.line;
      }
      fused.set(key, record);
    });
  };
  contribute("lexical", lexical);
  contribute("symbol", symbols);
  contribute("graph", graph);
  contribute("embedding", embedding);

  const results = [...fused.values()]
    .map((record) => {
      const document = documentsByPath.get(record.path);
      const snippet = record.line && document
        ? { line: record.line, text: (document.lines[record.line - 1] ?? "").trim().slice(0, 200), hits: 1 }
        : bestLine(document, queryTokens);
      return {
        ...record,
        score: Number(record.score.toFixed(6)),
        strategyCount: Object.keys(record.strategies).length,
        language: document?.language ?? null,
        snippet,
      };
    })
    .sort((left, right) => right.score - left.score
      || right.strategyCount - left.strategyCount
      || left.path.localeCompare(right.path))
    .slice(0, limit);

  return {
    version: SEARCH_VERSION,
    query: trimmed,
    results,
    strategies: {
      lexical: lexical.length,
      symbol: symbols.length,
      graph: graph.length,
      embedding: embedding.length,
    },
    fused: fused.size,
    grounded,
    tookMs: Date.now() - started,
  };
}
