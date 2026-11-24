/**
 * Control benchmark contamination and memorization (item 60, the last of
 * this cycle).
 *
 * `transfer-curriculum.mjs` (item 26) already separates a memorized answer
 * from a transferred one for *one learner's own answer*, by checking
 * whether it leaked a symbol name the target repository could not have
 * supplied. That is a different question from this item's: whether the
 * *benchmark corpus itself* — the set of repositories and tasks a tutor is
 * evaluated against — is contaminated, so a reported "transfer" score is
 * actually inflated by having seen the test material, or a close paraphrase
 * of it, during whatever building or fine-tuning produced the tutor.
 * Confirmed by grep before writing a line here: zero prior matches for
 * `contamination`/`canary`/`nearDuplicate`/`exactDuplicate`/
 * `identifierRenamed`/`repositoryOverlap`/`normalizeIdentifiers` as
 * implementation identifiers anywhere in `electron/*.mjs`.
 *
 * Built entirely out of primitives this app already tested separately:
 *
 *   - **Exact duplicates** reuse `offline-archive.mjs`'s own `digestOfText`
 *     (unmodified) on each symbol body's raw text — a byte-identical body
 *     digests identically, full stop.
 *   - **Near duplicates** reuse `course-migration.mjs`'s own
 *     `bodyTokens`/`shingles`/`jaccard` pipeline (unmodified), the exact
 *     machinery `transfer-curriculum.mjs` (item 26, this cycle) already
 *     reuses for cross-repository structural similarity, applied here
 *     within one benchmark corpus to find bodies that are "the same
 *     thing, lightly edited" rather than byte-identical.
 *   - **Identifier-renamed clones** are the one genuinely new check:
 *     [`normalizeIdentifiers`] replaces every identifier token with a
 *     canonical placeholder in first-seen order (keeping every keyword,
 *     operator, and literal untouched), so `add(x, y) { return x + y }`
 *     and `sum(p, q) { return p + q }` normalize to the identical token
 *     sequence while a structurally different body with the same
 *     identifier names does not. Live-verified before writing the test:
 *     exactly that pair of fixtures normalizes identically while a third,
 *     structurally different fixture with the same two parameter names
 *     diverges.
 *   - **Canary symbols** are caller-declared marker names seeded into the
 *     corpus specifically to detect leakage; [`detectCanaryMentions`]
 *     reuses `explanation-grader.mjs`'s own `mentionedSymbols` (unmodified)
 *     to check whether an answer mentions one, which only a tutor that has
 *     actually seen the seeded corpus (not merely reasoned about the real
 *     repository) could produce.
 *   - **Repository overlap** reuses `course-migration.mjs`'s own
 *     `jaccard` (unmodified) over each repository's own symbol-name set,
 *     to find candidate benchmark repositories whose symbol vocabulary
 *     overlaps enough with a repository already used that evaluating on
 *     both would double-count, not meaningfully diversify, the corpus.
 *   - **Separating memorized performance from grounded transfer** combines
 *     all four signals per task: [`classifyTaskContamination`] names
 *     `"exact-duplicate"`/`"near-duplicate"`/`"identifier-renamed-clone"`/
 *     `"canary-leaked"`/`"clean"` for one task against one corpus, never
 *     silently folding a contaminated task's score into an aggregate
 *     transfer measurement. [`separateMemorizedFromTransferred`] partitions
 *     a scored task set by that classification so a benchmark's own
 *     reported transfer rate is computed only from `"clean"` tasks, with
 *     the contaminated share reported alongside, not hidden inside, the
 *     headline number — the same discipline `transfer-curriculum.mjs`'s
 *     own `evaluateTransferGain` already applies to one answer, lifted to
 *     a whole corpus.
 *
 * Pure: no fs/network, no Node builtins — every repository, symbol table,
 * and task is passed in as plain data.
 */

import { digestOfText } from "./offline-archive.mjs";
import { bodyTokens, jaccard, shingles } from "./course-migration.mjs";
import { mentionedSymbols } from "./explanation-grader.mjs";

export const BENCHMARK_CONTAMINATION_VERSION = 1;

/** A near-duplicate body match must clear this Jaccard similarity. */
export const DEFAULT_NEAR_DUPLICATE_THRESHOLD = 0.6;

/** Two repositories' symbol vocabularies count as overlapping at or above this Jaccard similarity. */
export const DEFAULT_REPOSITORY_OVERLAP_THRESHOLD = 0.5;

export const ContaminationKind = Object.freeze({
  EXACT_DUPLICATE: "exact-duplicate",
  NEAR_DUPLICATE: "near-duplicate",
  IDENTIFIER_RENAMED_CLONE: "identifier-renamed-clone",
  CANARY_LEAKED: "canary-leaked",
  CLEAN: "clean",
});

// Kept untouched by normalization, so two bodies with the same control
// flow and operators but renamed variables still line up token-for-token.
const KEYWORDS = new Set([
  "function", "return", "if", "else", "for", "while", "let", "const", "var",
  "def", "class", "import", "from", "as", "true", "false", "null", "none",
  "this", "self", "new", "typeof", "in", "of", "do", "switch", "case",
  "break", "continue", "try", "catch", "finally", "throw", "async", "await", "yield",
]);

/**
 * Replace every identifier token with a canonical `ID<n>` placeholder in
 * first-seen order, leaving every keyword, operator, punctuation, and
 * numeric literal untouched. Two bodies that differ only by consistent
 * variable/parameter renaming normalize to the identical sequence; a body
 * that reuses the same identifier names but has different structure does
 * not.
 */
export function normalizeIdentifiers(tokens) {
  const seen = new Map();
  return (tokens ?? []).map((token) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(token) || KEYWORDS.has(token)) return token;
    if (!seen.has(token)) seen.set(token, `ID${seen.size}`);
    return seen.get(token);
  });
}

/** `digestOfText` (unmodified) of the raw body text; exact byte-for-byte match. */
export function exactBodyDigest(bodyText) {
  return digestOfText(String(bodyText ?? ""));
}

/** `true` once the identifier-normalized token sequences are identical, even if the raw text differs by renaming alone. */
export function isIdentifierRenamedClone(bodyTextLeft, bodyTextRight) {
  const left = normalizeIdentifiers(bodyTokens(bodyTextLeft));
  const right = normalizeIdentifiers(bodyTokens(bodyTextRight));
  if (!left.length || !right.length) return false;
  return left.join("\u0000") === right.join("\u0000");
}

/** `course-migration.mjs`'s own shingles/jaccard pipeline, unmodified, over two raw bodies. */
export function nearDuplicateSimilarity(bodyTextLeft, bodyTextRight) {
  const leftShingles = shingles(bodyTokens(bodyTextLeft));
  const rightShingles = shingles(bodyTokens(bodyTextRight));
  if (!leftShingles.length || !rightShingles.length) return null;
  return jaccard(leftShingles, rightShingles);
}

/**
 * Compare one candidate task body against every body already in the
 * corpus, in a fixed check order (exact, then identifier-renamed, then
 * near-duplicate) — the first match found is reported, so an exact
 * duplicate is never also reported as merely "near".
 */
export function classifyBodyContamination(candidateBody, corpusBodies, options = {}) {
  const threshold = options.nearDuplicateThreshold ?? DEFAULT_NEAR_DUPLICATE_THRESHOLD;
  const candidateDigest = exactBodyDigest(candidateBody);
  for (const corpusBody of corpusBodies ?? []) {
    if (exactBodyDigest(corpusBody) === candidateDigest) {
      return { kind: ContaminationKind.EXACT_DUPLICATE, matchedBody: corpusBody, similarity: 1 };
    }
  }
  for (const corpusBody of corpusBodies ?? []) {
    if (isIdentifierRenamedClone(candidateBody, corpusBody)) {
      return { kind: ContaminationKind.IDENTIFIER_RENAMED_CLONE, matchedBody: corpusBody, similarity: 1 };
    }
  }
  let bestMatch = null;
  let bestSimilarity = -1;
  for (const corpusBody of corpusBodies ?? []) {
    const similarity = nearDuplicateSimilarity(candidateBody, corpusBody);
    if (similarity !== null && similarity > bestSimilarity) { bestSimilarity = similarity; bestMatch = corpusBody; }
  }
  if (bestMatch !== null && bestSimilarity >= threshold) {
    return { kind: ContaminationKind.NEAR_DUPLICATE, matchedBody: bestMatch, similarity: bestSimilarity };
  }
  return { kind: ContaminationKind.CLEAN, matchedBody: null, similarity: bestMatch === null ? null : bestSimilarity };
}

/**
 * Which caller-declared canary symbol names an answer actually mentions,
 * via `explanation-grader.mjs`'s own `mentionedSymbols` (unmodified). A
 * non-empty result is evidence the tutor has seen the seeded corpus
 * itself, not merely reasoned about the real repository.
 */
export function detectCanaryMentions(answerText, canarySymbolNames) {
  const known = new Set(canarySymbolNames ?? []);
  const mentioned = mentionedSymbols(answerText, known);
  return mentioned.filter((entry) => known.has(entry.name)).map((entry) => entry.name);
}

/**
 * `course-migration.mjs`'s own `jaccard` (unmodified) over two
 * repositories' own symbol-name sets, as plain string sets rather than
 * body shingles — vocabulary overlap, not body similarity.
 */
export function repositorySymbolOverlap(repositoryLeft, repositoryRight) {
  const leftNames = [...new Set((repositoryLeft?.symbols ?? []).map((symbol) => symbol.name))];
  const rightNames = [...new Set((repositoryRight?.symbols ?? []).map((symbol) => symbol.name))];
  return jaccard(leftNames, rightNames);
}

/**
 * Every candidate repository whose symbol vocabulary overlaps enough with
 * a repository already in the benchmark corpus to count as redundant
 * rather than diversifying, ranked by overlap (highest first).
 */
export function findOverlappingRepositories(candidateRepository, corpusRepositories, options = {}) {
  const threshold = options.threshold ?? DEFAULT_REPOSITORY_OVERLAP_THRESHOLD;
  const overlaps = (corpusRepositories ?? [])
    .map((corpusRepository) => ({ repositoryId: corpusRepository.id, overlap: repositorySymbolOverlap(candidateRepository, corpusRepository) }))
    .filter((entry) => entry.overlap >= threshold);
  return overlaps.sort((left, right) => right.overlap - left.overlap || left.repositoryId.localeCompare(right.repositoryId));
}

/**
 * One task's full classification: body contamination against the corpus,
 * plus a canary check on the task's own answer text, if both are
 * supplied. Canary leakage, if present, takes priority over a body-level
 * verdict — mentioning a seeded marker is direct evidence of exposure to
 * the benchmark corpus itself, a stronger signal than body similarity.
 */
export function classifyTaskContamination(task, corpusBodies, canarySymbolNames, options = {}) {
  const canaryLeaked = task.answerText ? detectCanaryMentions(task.answerText, canarySymbolNames) : [];
  if (canaryLeaked.length > 0) {
    return { kind: ContaminationKind.CANARY_LEAKED, matchedBody: null, similarity: null, canaryLeaked };
  }
  const bodyResult = classifyBodyContamination(task.body, corpusBodies, options);
  return { ...bodyResult, canaryLeaked: [] };
}

/**
 * Partition a scored task set by contamination classification, so a
 * benchmark's own reported transfer rate is computed only from
 * `"clean"` tasks. The contaminated share and its own classification
 * breakdown is reported alongside, never folded invisibly into the
 * headline number.
 */
export function separateMemorizedFromTransferred(scoredTasks, corpusBodies, canarySymbolNames, options = {}) {
  const classified = (scoredTasks ?? []).map((task) => ({ task, classification: classifyTaskContamination(task, corpusBodies, canarySymbolNames, options) }));
  const clean = classified.filter((entry) => entry.classification.kind === ContaminationKind.CLEAN);
  const contaminated = classified.filter((entry) => entry.classification.kind !== ContaminationKind.CLEAN);

  const cleanScores = clean.map((entry) => entry.task.score).filter((value) => typeof value === "number" && Number.isFinite(value));
  const groundedTransferRate = cleanScores.length ? Number((cleanScores.reduce((sum, value) => sum + value, 0) / cleanScores.length).toFixed(4)) : null;

  const breakdown = {};
  for (const kind of Object.values(ContaminationKind)) breakdown[kind] = classified.filter((entry) => entry.classification.kind === kind).length;

  return {
    version: BENCHMARK_CONTAMINATION_VERSION,
    totalTasks: classified.length,
    cleanTaskCount: clean.length,
    contaminatedTaskCount: contaminated.length,
    groundedTransferRate,
    groundedTransferRateComputedFrom: cleanScores.length,
    breakdown,
    classified,
  };
}

export function renderContaminationReport(report) {
  const lines = [
    `Benchmark contamination: ${report.contaminatedTaskCount}/${report.totalTasks} task(s) contaminated`,
    `Grounded transfer rate (clean tasks only, n=${report.groundedTransferRateComputedFrom}): ${report.groundedTransferRate === null ? "insufficient-evidence" : report.groundedTransferRate}`,
  ];
  for (const kind of Object.values(ContaminationKind)) {
    lines.push(`  ${kind}: ${report.breakdown[kind]}`);
  }
  return lines.join("\n");
}
