import { bodyTokens, jaccard, shingles } from "./course-migration.mjs";
import { mentionedSymbols } from "./explanation-grader.mjs";
import { evaluateTutorAnswer } from "./evaluation.mjs";

/**
 * Cross-repository transfer curricula (item 26).
 *
 * `transfer-probe.mjs` (item 11) already measures transfer *within* one
 * repository: it walks the knowledge graph outward from a skill's own
 * anchors and finds files the learner has never opened, but still inside
 * the one repository the lesson was built from. `curriculum-distance.mjs`
 * (item 24) already runs a *fixed question set* against other repositories
 * at increasing language-family distance, but it is a benchmark harness fed
 * by a caller-supplied provider and question list, not a curriculum a
 * learner is actually walked through, and it never checks what an answer's
 * own correctness is actually evidence *of* — a model that answers the
 * target's question by repeating a symbol name it only knows from the home
 * repository has not transferred anything, and nothing before this item
 * checked for that (confirmed by grep: zero prior matches for
 * `memorized`/`preTestIsolation`/`crossRepository` as implementation
 * identifiers anywhere in `electron/*.mjs`).
 *
 * This module is the one piece neither covers: a *curriculum* — pick other
 * repositories, enforce an order, and tell a real transfer answer apart from
 * a memorized one — built entirely out of primitives this app already
 * tested separately rather than re-deriving any of them:
 *
 *   - **Structurally related** reuses `course-migration.mjs`'s own
 *     `bodyTokens`/`shingles`/`jaccard` pipeline (item 44/45, unmodified) —
 *     the exact machinery that already decides whether two function bodies
 *     are "the same thing, moved" during a migration is equally the right
 *     answer to "is this other repository's function structurally similar
 *     to the one this skill is about", just compared across two different
 *     repositories' symbol tables instead of two versions of one.
 *     [`bestStructuralMatch`] finds the best-matching symbol in a candidate
 *     repository for one of the skill's own anchor symbols; a candidate
 *     only counts as [`classifyStructuralRelation`]'s `"structurally-related"`
 *     once a match clears a minimum similarity, never on name alone — a
 *     function with the same name and an unrelated body is not what this
 *     item means by "related".
 *   - **Unseen** is a caller-supplied `seenRepositoryIds` set, filtered out
 *     by [`selectTransferCandidates`] before structural similarity is even
 *     computed — the same "excluded before being considered" shape
 *     `transfer-probe.mjs`'s own `unseenRelatedFiles` already uses for
 *     files, lifted one level up to whole repositories.
 *   - **Pre-test isolation is enforced by a state machine, not a
 *     convention.** [`administerPreTest`] only succeeds from the curriculum's
 *     initial `"pending"` state; [`recordLessonDelivered`] only succeeds once
 *     a pre-test is already recorded for that repository
 *     (`"pre-test-required-first"` otherwise); [`administerPostTest`] only
 *     succeeds once the lesson has actually been delivered. A caller cannot
 *     accidentally expose the target repository's own lesson before
 *     recording what the learner already knew without it — the one order a
 *     transfer measurement depends on — because the ledger refuses the
 *     out-of-order call outright rather than silently accepting it.
 *   - **Beyond memorized symbols** is the one genuinely new check:
 *     [`detectMemorizedSymbolLeak`] reuses `explanation-grader.mjs`'s own
 *     `mentionedSymbols` (unmodified) to find which symbol names an answer
 *     actually used, then asks whether any of them is a name the *home*
 *     repository's index knows but the *target* repository's index does
 *     not. An answer that only ever worked by producing the home
 *     repository's own symbol name — one the target repository could not
 *     possibly have supplied — demonstrated memorization, not transfer,
 *     however fluent it reads. [`evaluateTransferGain`] combines this with
 *     `evaluation.mjs`'s own `evaluateTutorAnswer` grounding score
 *     (unmodified) on both tests, so a pre→post improvement is reported
 *     alongside, not instead of, whether that improvement was tainted by a
 *     leaked symbol.
 *
 * Pure: no fs/network, no Node builtins — every repository, symbol table,
 * and answer is passed in as plain data.
 */

export const TRANSFER_CURRICULUM_VERSION = 1;

/** A candidate's best symbol match must clear this Jaccard similarity to count as "structurally related". */
export const DEFAULT_STRUCTURAL_SIMILARITY_THRESHOLD = 0.3;

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function fingerprint(symbol, sources) {
  const lines = typeof sources?.[symbol.path] === "string" ? sources[symbol.path].split("\n") : null;
  const start = Math.max(1, Number(symbol.line) || 1);
  const end = Math.max(start, Number(symbol.endLine) || start);
  const body = lines ? lines.slice(start - 1, end).join("\n") : "";
  return shingles(bodyTokens(body));
}

/**
 * The best-matching symbol in `candidateSymbols` for one of the skill's own
 * anchor symbols, by body-shingle Jaccard similarity. `null` similarity (not
 * `0`) when neither side has a usable body to compare, so "nothing to
 * compare" stays distinguishable from "compared and found unrelated".
 */
export function bestStructuralMatch(anchorSymbol, homeSources, candidateSymbols, candidateSources) {
  const anchorShingles = fingerprint(anchorSymbol, homeSources);
  if (!anchorShingles.length) return { symbol: null, similarity: null };
  let best = null;
  let bestSimilarity = -1;
  for (const candidate of candidateSymbols ?? []) {
    const candidateShingles = fingerprint(candidate, candidateSources);
    if (!candidateShingles.length) continue;
    const similarity = jaccard(anchorShingles, candidateShingles);
    if (similarity > bestSimilarity) { bestSimilarity = similarity; best = candidate; }
  }
  return best ? { symbol: best, similarity: round(bestSimilarity) } : { symbol: null, similarity: null };
}

/** `"structurally-related"` once a match clears the threshold, `"unrelated"` otherwise (including no usable match at all). */
export function classifyStructuralRelation(similarity, threshold = DEFAULT_STRUCTURAL_SIMILARITY_THRESHOLD) {
  return typeof similarity === "number" && similarity >= threshold ? "structurally-related" : "unrelated";
}

/**
 * Every candidate repository the learner has never opened, with its best
 * structural match to the skill's own anchor symbols, ranked by similarity
 * (highest first). A repository already in `seenRepositoryIds` is excluded
 * before any similarity is computed at all, never merely ranked last.
 */
export function selectTransferCandidates(skillNode, homeRepository, homeSources, candidates, seenRepositoryIds, options = {}) {
  const threshold = options.threshold ?? DEFAULT_STRUCTURAL_SIMILARITY_THRESHOLD;
  const seen = new Set(seenRepositoryIds ?? []);
  const anchorNames = new Set((skillNode?.anchors ?? []).map((anchor) => anchor.symbol).filter(Boolean));
  const anchorSymbols = (homeRepository?.symbols ?? []).filter((symbol) => anchorNames.has(symbol.name));

  const results = [];
  for (const candidate of candidates ?? []) {
    const repository = candidate.repository ?? candidate;
    if (seen.has(repository.id)) continue;
    let best = { symbol: null, similarity: null };
    for (const anchorSymbol of anchorSymbols) {
      const match = bestStructuralMatch(anchorSymbol, homeSources, repository.symbols ?? [], candidate.sources ?? {});
      if ((match.similarity ?? -1) > (best.similarity ?? -1)) best = match;
    }
    results.push({
      repositoryId: repository.id,
      relation: classifyStructuralRelation(best.similarity, threshold),
      similarity: best.similarity,
      matchedSymbol: best.symbol?.name ?? null,
    });
  }
  return results
    .filter((entry) => entry.relation === "structurally-related")
    .sort((left, right) => right.similarity - left.similarity || left.repositoryId.localeCompare(right.repositoryId));
}

export const CurriculumPhase = Object.freeze({
  PENDING: "pending",
  PRE_TESTED: "pre-tested",
  LESSONED: "lessoned",
  POST_TESTED: "post-tested",
});

/** A fresh curriculum: one entry per selected target repository, all `"pending"`. */
export function openTransferCurriculum(skillId, repositoryIds) {
  const entries = {};
  for (const repositoryId of repositoryIds ?? []) {
    entries[repositoryId] = { phase: CurriculumPhase.PENDING, preTest: null, lessonDeliveredAt: null, postTest: null };
  }
  return { version: TRANSFER_CURRICULUM_VERSION, skillId, entries };
}

function entryFor(curriculum, repositoryId) {
  return curriculum.entries?.[repositoryId] ?? null;
}

function withEntry(curriculum, repositoryId, entry) {
  return { ...curriculum, entries: { ...curriculum.entries, [repositoryId]: entry } };
}

/**
 * Record a pre-test result, but only from `"pending"` — a repository whose
 * lesson has already been delivered, or whose pre-test was already recorded,
 * refuses rather than overwriting what the learner knew *before* exposure.
 */
export function administerPreTest(curriculum, repositoryId, result) {
  const entry = entryFor(curriculum, repositoryId);
  if (!entry) return { ok: false, reason: "unknown-repository", curriculum };
  if (entry.phase !== CurriculumPhase.PENDING) {
    return { ok: false, reason: entry.phase === CurriculumPhase.PRE_TESTED ? "pre-test-already-recorded" : "lesson-already-delivered", curriculum };
  }
  const updated = withEntry(curriculum, repositoryId, { ...entry, phase: CurriculumPhase.PRE_TESTED, preTest: result });
  return { ok: true, reason: null, curriculum: updated };
}

/**
 * Record that the target repository's lesson was shown, but only once a
 * pre-test is already on record for it — this is the isolation guarantee
 * itself: it is structurally impossible to reach `"lessoned"` from
 * `"pending"`.
 */
export function recordLessonDelivered(curriculum, repositoryId, options = {}) {
  const entry = entryFor(curriculum, repositoryId);
  if (!entry) return { ok: false, reason: "unknown-repository", curriculum };
  if (entry.phase === CurriculumPhase.PENDING) return { ok: false, reason: "pre-test-required-first", curriculum };
  if (entry.phase !== CurriculumPhase.PRE_TESTED) return { ok: false, reason: "lesson-already-delivered", curriculum };
  const updated = withEntry(curriculum, repositoryId, { ...entry, phase: CurriculumPhase.LESSONED, lessonDeliveredAt: options.now ?? new Date().toISOString() });
  return { ok: true, reason: null, curriculum: updated };
}

/** Record a post-test result, but only once the lesson has actually been delivered. */
export function administerPostTest(curriculum, repositoryId, result) {
  const entry = entryFor(curriculum, repositoryId);
  if (!entry) return { ok: false, reason: "unknown-repository", curriculum };
  if (entry.phase !== CurriculumPhase.LESSONED) {
    return { ok: false, reason: entry.phase === CurriculumPhase.POST_TESTED ? "post-test-already-recorded" : "lesson-not-delivered-yet", curriculum };
  }
  const updated = withEntry(curriculum, repositoryId, { ...entry, phase: CurriculumPhase.POST_TESTED, postTest: result });
  return { ok: true, reason: null, curriculum: updated };
}

/**
 * Which of an answer's mentioned symbols are names the *home* repository's
 * index knows but the *target* repository's index does not — evidence the
 * answer was produced from memorizing the home repository rather than
 * engaging with the target one, however correct it otherwise reads.
 */
export function detectMemorizedSymbolLeak(answerText, homeRepository, targetRepository) {
  const homeNames = new Set((homeRepository?.symbols ?? []).map((symbol) => symbol.name));
  const targetNames = new Set((targetRepository?.symbols ?? []).map((symbol) => symbol.name));
  const mentioned = mentionedSymbols(answerText, homeNames);
  const leaked = mentioned.filter((entry) => homeNames.has(entry.name) && !targetNames.has(entry.name)).map((entry) => entry.name);
  return { leaked, hasLeak: leaked.length > 0 };
}

/**
 * Score one repository's pre→post pair: `evaluation.mjs`'s own grounding
 * score on each answer (unmodified), the raw gain, and whether the post-test
 * answer leaked a memorized home-repository symbol. A gain that coexists
 * with a leak is reported as `"leaked"`, not `"transferred"` — a higher
 * score produced partly by repeating a name the target repository could not
 * have supplied is not evidence the concept itself transferred.
 */
export function evaluateTransferGain(preAnswer, postAnswer, homeRepository, targetRepository, options = {}) {
  const preScore = evaluateTutorAnswer(preAnswer, targetRepository, options).score;
  const postScore = evaluateTutorAnswer(postAnswer, targetRepository, options).score;
  const leak = detectMemorizedSymbolLeak(postAnswer?.text ?? postAnswer ?? "", homeRepository, targetRepository);
  const gain = round(postScore - preScore);
  return {
    preScore: round(preScore),
    postScore: round(postScore),
    gain,
    leak,
    verdict: leak.hasLeak ? "leaked" : gain !== null && gain > 0 ? "transferred" : gain === 0 ? "no-change" : "regressed",
  };
}

/** Prompt/report-ready text rendering of a transfer curriculum's current state. */
export function renderTransferCurriculum(curriculum) {
  const lines = [`# Cross-repository transfer curriculum for \`${curriculum.skillId}\``, ""];
  for (const [repositoryId, entry] of Object.entries(curriculum.entries ?? {})) {
    lines.push(`- \`${repositoryId}\`: ${entry.phase}`);
  }
  return lines.join("\n");
}
