import { buildContextPack } from "./context-engine.mjs";
import { evaluateTutorAnswer } from "./evaluation.mjs";
import { extractCallClaims, Verdict, verifyAnswerFaithfulness } from "./faithfulness-guard.mjs";
import { verifyFixedIngestionSnapshot } from "./rag-eval.mjs";
import { languageFamily } from "./repository.mjs";
import { MIN_SAMPLE, rate } from "./analytics.mjs";

/**
 * Curriculum-distance generalization tests (item 24).
 *
 * `rag-eval.mjs` (item 17) already holds a question set and a context-budget
 * axis fixed while varying model family, and refuses to run on an
 * inconsistent index/repository pairing (`verifyFixedIngestionSnapshot`).
 * `faithfulness-guard.mjs` (item 19) already produces a three-state
 * faithful/unfaithful/abstain verdict for a relational claim, with
 * abstention as its own honest outcome rather than folded into pass/fail.
 * `analytics.mjs`'s `transferAnalytics`/`misconceptionHintAnalytics`
 * already compute a near-vs-far or targeted-vs-generic performance gap with
 * a sample-size floor below which the gap is reported as
 * "insufficient-evidence" rather than guessed.
 *
 * None of that, on its own, answers this item's question: does the *same*
 * fixed question set, run against the *same* fixed per-target retrieval
 * snapshot, keep working as the target repository gets less and less like
 * the one the question was written against? Confirmed by grep: no prior
 * `domain.distance`/`curriculum.distance`/`languageFamily` co-occurrence,
 * and `rag-eval.mjs`'s own suite never varies the *target repository* at
 * all — every provider/mode combination in that suite runs against one
 * repository, not an ordered sequence of increasingly distant ones.
 *
 * This module adds exactly that ordering, plus the four axes the item
 * names, reusing rather than re-deriving the machinery for three of them:
 *
 *   - **Domain distance** is purely structural, derived from data this
 *     repository already indexes — no framework/project-type detector
 *     exists anywhere in this codebase (confirmed by grep for `framework`
 *     as an implementation identifier; only prose comments use the word),
 *     so distance here is language-family based, the one axis
 *     `repository.mjs`'s own `languageFamily` already names. [`DOMAIN_DISTANCE_LEVELS`]
 *     has three rungs: the home repository itself (`same-repository`), a
 *     different repository whose dominant language is in the same family
 *     (`same-language-family`), and a different repository in a different
 *     family entirely (`cross-language-family`). [`computeDomainDistance`]
 *     never guesses a framework it cannot see.
 *   - **Retrieval snapshot fixed per target.** [`runCurriculumDistanceSuite`]
 *     calls `verifyFixedIngestionSnapshot` (item 17, unmodified) on every
 *     target `{ repository, index }` pair before running a single case
 *     against it, refusing the whole suite rather than silently scoring a
 *     target whose index does not match the repository state being tested.
 *   - **Context precision** is new: of the context sections `buildContextPack`
 *     (item 2/57) actually included, what fraction cite a path on the
 *     question's own gold-file list? The formula mirrors `localization.mjs`
 *     (item ~30)'s own `hits / selected` precision exactly — a context pack
 *     is simply treated as the model's "selection", with the same honest
 *     floor localization.mjs uses: a pack with no sourced sections at all
 *     scores a true `0` (an attempt that cited nothing relevant), while a
 *     case with no gold files supplied scores `null` (unscoreable, not a
 *     fabricated `0`).
 *   - **Faithfulness and abstention** are not re-derived: every case's
 *     answer text is run through item 19's own `extractCallClaims` +
 *     `verifyAnswerFaithfulness` unmodified, so a case with no checkable
 *     relational claim abstains honestly (exactly the semantics
 *     `faithfulness-guard.mjs`'s own module doc requires) rather than being
 *     scored as faithful by default.
 *   - **Learning lift** reuses `analytics.mjs`'s `rate`/`MIN_SAMPLE` floor
 *     discipline and its "gap" arithmetic (`transferAnalytics`'s
 *     `near.value - far.value`): the lift at a given distance level is the
 *     home level's average grounding score minus that level's, so a
 *     positive lift means performance degrades with distance (the
 *     generalization failure this item exists to surface) and a lift of
 *     `null` means either side lacked enough cases to trust, never a
 *     guessed number.
 *
 * Pure except for `provider.answer(...)`, the same caller-supplied,
 * possibly-async answer function `rag-eval.mjs` already requires — this
 * module spawns no model, reads no filesystem, and opens no network
 * connection of its own.
 */

export const CURRICULUM_DISTANCE_VERSION = 1;

/** The three rungs of domain distance this module can structurally detect. */
export const DOMAIN_DISTANCE_LEVELS = Object.freeze([
  Object.freeze({ level: 0, id: "same-repository", label: "Same repository" }),
  Object.freeze({ level: 1, id: "same-language-family", label: "Different repository, same language family" }),
  Object.freeze({ level: 2, id: "cross-language-family", label: "Different repository, different language family" }),
]);

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

/**
 * The language family of a repository's single most common language, via
 * `repository.mjs`'s own `languageFamily` (unmodified). `"unknown"` when the
 * repository carries no language stats at all, rather than guessing one.
 */
export function dominantLanguageFamily(repository) {
  const languages = repository?.stats?.languages ?? {};
  const entries = Object.entries(languages).filter(([, count]) => count > 0);
  if (!entries.length) return "unknown";
  const [dominant] = entries.sort((left, right) => right[1] - left[1])[0];
  return languageFamily(dominant);
}

/**
 * Where `targetRepository` sits relative to `homeRepository` on the
 * three-rung ladder above. Same `id` is always `same-repository` regardless
 * of `versionId` drift (it is still the one repository the question set was
 * written against); otherwise the comparison is purely by dominant language
 * family, never by anything this codebase cannot already name.
 */
export function computeDomainDistance(homeRepository, targetRepository) {
  if (homeRepository?.id && homeRepository.id === targetRepository?.id) {
    return DOMAIN_DISTANCE_LEVELS[0];
  }
  const homeFamily = dominantLanguageFamily(homeRepository);
  const targetFamily = dominantLanguageFamily(targetRepository);
  if (homeFamily !== "unknown" && homeFamily === targetFamily) {
    return DOMAIN_DISTANCE_LEVELS[1];
  }
  return DOMAIN_DISTANCE_LEVELS[2];
}

/**
 * Context precision: of the context pack's sections that cite a source path
 * at all, what fraction cite one of the question's own gold files? Mirrors
 * `localization.mjs`'s `hits / selected` precision formula. `null` (not a
 * fabricated `0`) when the case supplies no gold files to check against;
 * `0` (a real, scoreable zero) when the pack cited nothing relevant, or
 * nothing at all.
 */
export function contextPrecisionOf(pack, goldFiles) {
  const gold = new Set(goldFiles ?? []);
  if (!gold.size) return null;
  const sourced = (pack?.sections ?? []).filter((section) => section.source);
  if (!sourced.length) return 0;
  const relevant = sourced.filter((section) => gold.has(String(section.source).split(":")[0]));
  return round(relevant.length / sourced.length);
}

/**
 * Run one fixed question against one target repository at one context
 * mode, scoring all four axes for that single case.
 */
export async function evaluateCurriculumDistanceCase({
  homeRepository,
  targetRepository,
  provider,
  mode,
  questionCase,
  now = Date.now,
  lineCounts,
}) {
  const distance = computeDomainDistance(homeRepository, targetRepository);
  const pack = await buildContextPack(targetRepository, { ...questionCase, mode });
  const started = now();
  const response = await provider.answer({ question: questionCase.question, contextPack: pack, provider });
  const finished = now();
  const tookMs = Number.isFinite(response?.tookMs) ? response.tookMs : Math.max(0, finished - started);

  const grounding = evaluateTutorAnswer(response, targetRepository, { lineCounts });
  const claims = extractCallClaims(response?.text ?? response ?? "");
  const faithfulness = verifyAnswerFaithfulness(claims, targetRepository);

  return {
    questionId: questionCase.id,
    providerId: provider.id,
    mode,
    repositoryId: targetRepository.id,
    distanceLevel: distance.level,
    distanceId: distance.id,
    distanceLabel: distance.label,
    contextPrecision: contextPrecisionOf(pack, questionCase.goldFiles),
    grounding,
    faithfulness: {
      status: faithfulness.status,
      abstained: faithfulness.status === Verdict.ABSTAIN,
      unfaithful: faithfulness.status === Verdict.UNFAITHFUL,
    },
    tookMs,
  };
}

function summarizeLevel(level, cases) {
  const scored = cases.filter((entry) => Number.isFinite(entry.grounding?.score));
  const withPrecision = cases.filter((entry) => entry.contextPrecision !== null);
  const checkedFaithfulness = cases.filter((entry) => !entry.faithfulness.abstained);
  const faithfulCount = checkedFaithfulness.filter((entry) => !entry.faithfulness.unfaithful).length;

  return {
    level: level.level,
    id: level.id,
    label: level.label,
    cases: cases.length,
    averageGrounding: scored.length ? round(scored.reduce((sum, entry) => sum + entry.grounding.score, 0) / scored.length) : null,
    averageContextPrecision: withPrecision.length
      ? round(withPrecision.reduce((sum, entry) => sum + entry.contextPrecision, 0) / withPrecision.length)
      : null,
    faithfulnessRate: rate(faithfulCount, checkedFaithfulness.length),
    abstentionRate: rate(cases.filter((entry) => entry.faithfulness.abstained).length, cases.length),
  };
}

/**
 * Run `questions` through every provider/mode combination against every
 * target repository, bucket the results by domain distance from
 * `homeRepository`, and report context precision / faithfulness /
 * abstention / learning lift per distance level.
 *
 * `targets` is `[{ repository, index }]` — every target's retrieval
 * snapshot must be internally fixed (`verifyFixedIngestionSnapshot`,
 * item 17, unmodified); the whole suite refuses to run if any one target
 * fails that check, rather than scoring the others and silently omitting
 * the mismatched one.
 */
export async function runCurriculumDistanceSuite({
  homeRepository,
  targets,
  questions,
  providers,
  modes,
  now = Date.now,
  lineCounts,
}) {
  for (const target of targets ?? []) {
    const snapshot = verifyFixedIngestionSnapshot(target.index, target.repository);
    if (!snapshot.valid) {
      throw new Error(
        `Fixed ingestion snapshot required for every target in a curriculum-distance suite (repository ${target.repository?.id ?? "unknown"}): ${snapshot.reason}`,
      );
    }
  }

  const cases = [];
  for (const target of targets ?? []) {
    for (const provider of providers ?? []) {
      for (const mode of modes ?? []) {
        for (const questionCase of questions ?? []) {
          cases.push(
            await evaluateCurriculumDistanceCase({
              homeRepository,
              targetRepository: target.repository,
              provider,
              mode,
              questionCase,
              now,
              lineCounts,
            }),
          );
        }
      }
    }
  }

  const byLevel = DOMAIN_DISTANCE_LEVELS.map((level) => summarizeLevel(level, cases.filter((entry) => entry.distanceLevel === level.level)));
  const home = byLevel.find((entry) => entry.level === 0);

  const learningLift = byLevel.map((entry) => {
    if (entry.level === 0 || !home || home.averageGrounding === null || entry.averageGrounding === null) {
      return { level: entry.level, id: entry.id, lift: null, reason: entry.level === 0 ? "baseline-level" : "insufficient-evidence" };
    }
    return { level: entry.level, id: entry.id, lift: round(home.averageGrounding - entry.averageGrounding), reason: null };
  });

  return {
    version: CURRICULUM_DISTANCE_VERSION,
    kind: "curriculum-distance",
    homeRepositoryId: homeRepository?.id ?? null,
    cases,
    byLevel,
    learningLift,
    generatedAt: new Date().toISOString(),
    minSample: MIN_SAMPLE,
  };
}

/** Prompt/report-ready text rendering of a curriculum-distance suite run. */
export function renderCurriculumDistanceSuite(report) {
  const lines = [
    "# Curriculum-distance generalization suite",
    "",
    `Home repository: \`${report.homeRepositoryId}\`.`,
    "",
    "| distance | cases | avg grounding | avg context precision | faithfulness rate | abstention rate | learning lift |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const level of report.byLevel) {
    const lift = report.learningLift.find((entry) => entry.level === level.level);
    const liftText = lift?.lift === null || lift?.lift === undefined ? (lift?.reason ?? "n/a") : (lift.lift >= 0 ? `+${lift.lift}` : `${lift.lift}`);
    lines.push(
      `| ${level.label} | ${level.cases} | ${level.averageGrounding ?? "n/a"} | ${level.averageContextPrecision ?? "n/a"} | ${level.faithfulnessRate.value ?? "n/a"} | ${level.abstentionRate.value ?? "n/a"} | ${liftText} |`,
    );
  }
  return lines.join("\n");
}
