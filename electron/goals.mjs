/**
 * Learner goals.
 *
 * "Learn this codebase" is not a goal; it is an absence of one. Someone chasing
 * a bug, someone joining the team, someone reviewing for security, and someone
 * chasing a regression need the *same* repository presented through completely
 * different entry points, and a curriculum that ignores that difference is
 * optimised for nobody.
 *
 * Each goal declares what evidence in the source is relevant to it, and the
 * plan it produces is ranked from real counts in the real index — how many
 * error paths a file actually contains, how many modules actually import it,
 * how many kernel loops it actually has. Every target carries the signals that
 * put it there, so a learner can disagree with the ranking on the evidence
 * rather than on faith.
 *
 * The module is Node-free and takes its sources as a parameter, so the browser
 * demo ranks with the same code.
 */

import { GOAL_LESSON_KEYWORDS, LEGACY_GOAL_ALIASES, canonicalGoalId, goalKeywords } from "./goal-keywords.mjs";

export { LEGACY_GOAL_ALIASES, goalKeywords };

export const GOALS_VERSION = 1;

/**
 * Signals are counted against real file contents. Each carries the weight it
 * contributes and the wording used to explain itself to the learner.
 */
export const GOALS = [
  {
    id: "debugging",
    title: "Track down a bug",
    summary: "Find where things go wrong: error paths, failure handling, and the call chains that reach them.",
    lessonKeywords: GOAL_LESSON_KEYWORDS.debugging,
    activities: ["execution-trace", "call-chain", "explanation"],
    signals: [
      { id: "error-paths", weight: 3, pattern: /\b(?:raise|throw|except|catch|panic!|rescue)\b/g, detail: (count) => `${count} explicit error path${count === 1 ? "" : "s"}` },
      { id: "assertions", weight: 1.5, pattern: /\b(?:assert|invariant|precondition|require)\b/g, detail: (count) => `${count} assertion${count === 1 ? "" : "s"}` },
      { id: "logging", weight: 1, pattern: /\b(?:logger|logging|log\.|warn|warning|traceback)\b/g, detail: (count) => `${count} logging or diagnostic call${count === 1 ? "" : "s"}` },
    ],
  },
  {
    id: "onboarding",
    title: "Get oriented",
    summary: "Start where a newcomer should: the entry points, the public surface, and the documentation that explains them.",
    lessonKeywords: GOAL_LESSON_KEYWORDS.onboarding,
    activities: ["teach-back", "localization", "lesson"],
    signals: [
      { id: "entry-point", weight: 4, pattern: /\b(?:def main|if __name__|func main|int main|export default|module\.exports|argparse|ArgumentParser|click\.command)\b/g, detail: (count) => `${count} program entry point${count === 1 ? "" : "s"}` },
      { id: "public-api", weight: 2, pattern: /^\s*(?:__all__|export\s|public\s)/gm, detail: (count) => `${count} public export declaration${count === 1 ? "" : "s"}` },
      { id: "explained", weight: 1.5, pattern: /(?:"""|'''|\/\*\*|^\s*#\s\w)/gm, detail: (count) => `${count} documentation block${count === 1 ? "" : "s"}` },
    ],
  },
  {
    id: "architecture",
    title: "Understand the structure",
    summary: "See the module boundaries: what depends on what, which files everything routes through, and where the layers break.",
    lessonKeywords: GOAL_LESSON_KEYWORDS.architecture,
    activities: ["architecture", "contrast", "diagram"],
    signals: [
      { id: "imports", weight: 2, pattern: /^\s*(?:import|from|#include|use |require\()/gm, detail: (count) => `${count} import${count === 1 ? "" : "s"}` },
      { id: "abstractions", weight: 2, pattern: /\b(?:class|interface|trait|protocol|abstract|@abstractmethod)\b/g, detail: (count) => `${count} abstraction${count === 1 ? "" : "s"} declared` },
      { id: "dispatch", weight: 1.5, pattern: /\b(?:registry|factory|dispatch|router|plugin|backend|adapter)\b/gi, detail: (count) => `${count} indirection point${count === 1 ? "" : "s"}` },
    ],
  },
  {
    id: "security",
    title: "Review for security",
    summary: "Look where trust boundaries are crossed: input handling, credentials, dynamic execution, and anything that leaves the process.",
    lessonKeywords: GOAL_LESSON_KEYWORDS.security,
    activities: ["localization", "race", "explanation"],
    signals: [
      { id: "dynamic-execution", weight: 4, pattern: /\b(?:eval|exec|pickle\.loads?|yaml\.load|os\.system|subprocess|Function\(|deserialize)\b/g, detail: (count) => `${count} dynamic-execution or deserialisation site${count === 1 ? "" : "s"}` },
      { id: "credentials", weight: 3, pattern: /\b(?:token|secret|password|credential|api_key|apikey|private_key|auth)\b/gi, detail: (count) => `${count} credential reference${count === 1 ? "" : "s"}` },
      { id: "external-io", weight: 2, pattern: /\b(?:socket|urlopen|requests\.|http|fetch\(|open\(|read_file|download)\b/g, detail: (count) => `${count} external input or output call${count === 1 ? "" : "s"}` },
    ],
  },
  {
    id: "performance",
    title: "Find the hot path",
    summary: "Follow the work: the loops, kernels, batching, and caches where the time is actually spent.",
    lessonKeywords: GOAL_LESSON_KEYWORDS.performance,
    activities: ["execution-trace", "call-chain", "architecture"],
    signals: [
      { id: "kernels", weight: 4, pattern: /\b(?:kernel|cuda|__global__|__device__|simd|vectoriz|tensor|matmul|gemm)\b/gi, detail: (count) => `${count} compute-kernel reference${count === 1 ? "" : "s"}` },
      { id: "loops", weight: 1.5, pattern: /^\s*(?:for|while)\b/gm, detail: (count) => `${count} loop${count === 1 ? "" : "s"}` },
      { id: "caching", weight: 2, pattern: /\b(?:cache|memo|pool|prefetch|reuse|lru_cache|batch_size|chunk)\b/gi, detail: (count) => `${count} caching or batching reference${count === 1 ? "" : "s"}` },
    ],
  },
];

const BY_ID = new Map(GOALS.map((goal) => [goal.id, goal]));

export function resolveGoal(id) {
  return BY_ID.get(canonicalGoalId(id)) ?? null;
}

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

function countMatches(text, pattern) {
  // A fresh regex per call, because a shared /g pattern carries `lastIndex`
  // between files and would silently skip matches in every file after the first.
  const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let count = 0;
  while (matcher.exec(text) !== null) {
    count += 1;
    if (count > 10_000) break;
  }
  return count;
}

/**
 * Rank the repository's files for one goal.
 *
 * Scores are normalized by file size so a 4,000-line file does not win every
 * goal simply by being long, and every target carries the counted signals that
 * put it there.
 */
export function rankTargets(repository, goalId, sources, options = {}) {
  const goal = resolveGoal(goalId);
  if (!goal) return [];
  const limit = options.limit ?? 8;
  const importers = new Map();
  for (const item of repository?.imports ?? []) {
    if (!item.resolved || !item.targetPath) continue;
    if (!importers.has(item.targetPath)) importers.set(item.targetPath, new Set());
    importers.get(item.targetPath).add(item.path);
  }
  const callersByPath = new Map();
  for (const edge of repository?.callEdges ?? []) {
    if (!edge.resolved || !edge.targetPath) continue;
    if (!callersByPath.has(edge.targetPath)) callersByPath.set(edge.targetPath, new Set());
    callersByPath.get(edge.targetPath).add(edge.path);
  }

  const ranked = [];
  for (const [filePath, source] of Object.entries(sources ?? {})) {
    if (typeof source !== "string" || !source) continue;
    const lines = Math.max(1, source.split("\n").length);
    const reasons = [];
    let score = 0;
    for (const signal of goal.signals) {
      const count = countMatches(source, signal.pattern);
      if (!count) continue;
      // Density, not raw count: a long file is not automatically the hot path.
      const density = count / Math.sqrt(lines);
      score += signal.weight * density;
      reasons.push({ signal: signal.id, count, detail: signal.detail(count), weight: signal.weight });
    }
    if (!reasons.length) continue;
    const fanIn = (importers.get(filePath)?.size ?? 0) + (callersByPath.get(filePath)?.size ?? 0);
    // Files the rest of the repository depends on matter more for every goal.
    score += Math.min(4, fanIn * 0.4);
    const symbol = (repository?.symbols ?? []).find((candidate) => candidate.path === filePath) ?? null;
    ranked.push({
      path: filePath,
      anchor: { path: filePath, line: symbol?.line ?? 1, symbol: symbol?.name ?? null },
      score: round(score),
      fanIn,
      lines,
      reasons: reasons.sort((left, right) => right.weight * right.count - left.weight * left.count),
    });
  }
  return ranked
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit);
}

/**
 * Reorder a course for a goal.
 *
 * Lessons are re-scored, not filtered: dropping the lessons a goal does not
 * favour would leave a learner with a course that cannot be finished, so the
 * relevant ones move up and everything else stays reachable underneath.
 */
export function orderLessonsForGoal(course, goalId) {
  const keywords = goalKeywords(goalId);
  const lessons = (course?.modules ?? []).flatMap((module) => (module.lessons ?? []).map((lesson) => ({ module: module.title, lesson })));
  return lessons
    .map((entry, index) => ({
      lessonId: entry.lesson.id,
      title: entry.lesson.title,
      module: entry.module,
      // The original order is the tiebreaker, so an unrelated goal leaves the
      // course exactly as the author wrote it.
      relevance: keywords.test(`${entry.module} ${entry.lesson.title} ${entry.lesson.objective ?? ""}`) ? 1 : 0,
      originalIndex: index,
      anchors: entry.lesson.anchors ?? [],
    }))
    .sort((left, right) => right.relevance - left.relevance || left.originalIndex - right.originalIndex);
}

/**
 * The whole plan for one goal: where to look, in what order to study, and which
 * of the app's activities suit this goal.
 */
export function goalPlan(repository, goalId, options = {}) {
  const goal = resolveGoal(goalId);
  if (!goal) {
    return { available: false, version: GOALS_VERSION, reason: `\`${goalId}\` is not a known learning goal.`, goals: publicGoals() };
  }
  const targets = rankTargets(repository, goal.id, options.sources ?? {}, { limit: options.limit ?? 8 });
  const order = options.course ? orderLessonsForGoal(options.course, goal.id) : [];
  const relevantLessons = order.filter((entry) => entry.relevance > 0);
  return {
    available: true,
    version: GOALS_VERSION,
    goal: { id: goal.id, title: goal.title, summary: goal.summary, activities: goal.activities },
    requested: goalId,
    aliased: goalId !== goal.id,
    targets,
    lessonOrder: order,
    recommendedActivities: goal.activities,
    coverage: {
      filesScanned: Object.keys(options.sources ?? {}).length,
      filesMatched: targets.length,
      lessons: order.length,
      relevantLessons: relevantLessons.length,
      // Said plainly: a goal a repository has nothing to say about should
      // report that rather than presenting an arbitrary top eight.
      note: targets.length === 0
        ? "Nothing in the scanned files matches this goal."
        : relevantLessons.length === 0
          ? "The generated course has no lesson aimed at this goal; start from the ranked files instead."
          : null,
    },
    goals: publicGoals(),
  };
}

/** The goal menu, without the detector patterns. */
export function publicGoals() {
  return GOALS.map((goal) => ({ id: goal.id, title: goal.title, summary: goal.summary, activities: goal.activities }));
}
