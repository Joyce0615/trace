import { createHash } from "node:crypto";

/**
 * Repository localization exercises (SWE-Explore style).
 *
 * Navigation skill is not "did you eventually find it" but "how much did you
 * have to read to find it". Every exercise therefore carries a gold file set
 * derived from the index, and every submission is scored on three independent
 * axes:
 *
 *   - coverage: how much of the gold set the learner selected (recall);
 *   - precision: how much of the selection was actually relevant;
 *   - efficiency: how much of what the learner *read* was relevant, measured in
 *     files and in bytes, because reading a 400 kB file is not free.
 *
 * Hints are progressive and never reveal the answer outright; each hint used
 * discounts the final score so scaffolding stays honest.
 */

export const LOCALIZATION_VERSION = 1;

function fileSizes(repository) {
  return new Map((repository.files ?? []).map((file) => [file.path, file.size ?? 0]));
}

/**
 * Build a localization exercise around the symbol with the widest cross-file
 * caller set, so the gold answer is a genuine multi-file neighbourhood.
 */
export function buildLocalizationExercise(repository, options = {}) {
  const maxGold = Math.max(2, options.maxGold ?? 4);
  const edges = (repository.callEdges ?? []).filter((edge) => edge.resolved && edge.targetPath);
  const byTarget = new Map();
  for (const edge of edges) {
    const key = `${edge.targetPath}#${edge.callee}`;
    if (!byTarget.has(key)) byTarget.set(key, new Set());
    byTarget.get(key).add(edge.path);
  }

  const importance = new Map((repository.files ?? []).map((file) => [file.path, file.importance ?? 0]));
  const candidates = [...byTarget.entries()]
    .map(([key, callers]) => {
      const targetPath = key.slice(0, key.lastIndexOf("#"));
      const symbol = key.slice(key.lastIndexOf("#") + 1);
      const external = [...callers].filter((caller) => caller !== targetPath);
      return { targetPath, symbol, callers: external, importance: importance.get(targetPath) ?? 0 };
    })
    .filter((candidate) => candidate.callers.length >= 1)
    .sort((left, right) => right.callers.length - left.callers.length
      || right.importance - left.importance
      || left.targetPath.localeCompare(right.targetPath));

  const chosen = options.symbol
    ? candidates.find((candidate) => candidate.symbol === options.symbol) ?? candidates[0]
    : candidates[0];
  if (!chosen) return null;

  const definition = (repository.symbols ?? []).find((symbol) => symbol.name === chosen.symbol && symbol.path === chosen.targetPath);
  const gold = [chosen.targetPath, ...chosen.callers].slice(0, maxGold);
  const sizes = fileSizes(repository);
  const language = (repository.files ?? []).find((file) => file.path === chosen.targetPath)?.language ?? "plaintext";

  return {
    id: `locate-${createHash("sha1").update(`${repository.versionId ?? repository.id}:${chosen.targetPath}:${chosen.symbol}`).digest("hex").slice(0, 12)}`,
    version: LOCALIZATION_VERSION,
    symbol: chosen.symbol,
    prompt: `A caller reports that \`${chosen.symbol}()\` returns the wrong result. Without reading the whole repository, find every file you would need to open to diagnose it: the file that defines \`${chosen.symbol}\` and the files that call it.`,
    goldFiles: gold,
    goldBytes: gold.reduce((sum, filePath) => sum + (sizes.get(filePath) ?? 0), 0),
    definition: definition ? { path: definition.path, line: definition.line, symbol: definition.name } : { path: chosen.targetPath, line: 1, symbol: chosen.symbol },
    hints: [
      { id: "language", text: `The definition is written in ${language}, and ${gold.length} file${gold.length > 1 ? "s are" : " is"} relevant in total.`, cost: 0.05 },
      { id: "directory", text: `Start under \`${chosen.targetPath.split("/")[0]}/\`.`, cost: 0.1 },
      { id: "filename", text: `The definition lives in a file named \`${chosen.targetPath.split("/").at(-1)}\`.`, cost: 0.2 },
    ],
    repositoryFiles: (repository.files ?? []).length,
  };
}

/** Renderer-safe projection: the gold set stays in the main process. */
export function publicLocalizationExercise(exercise) {
  if (!exercise) return null;
  return {
    id: exercise.id,
    version: exercise.version,
    symbol: exercise.symbol,
    prompt: exercise.prompt,
    goldCount: exercise.goldFiles.length,
    repositoryFiles: exercise.repositoryFiles,
    hints: exercise.hints.map((hint) => ({ id: hint.id, cost: hint.cost })),
  };
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Math.min(1, numerator / denominator) : 0;
}

/**
 * Score one submission.
 * `inspected` is the ordered navigation trail, `selected` is the final answer.
 */
export function scoreLocalization(exercise, submission, repository) {
  const gold = new Set(exercise.goldFiles);
  const selected = [...new Set(submission.selected ?? [])];
  const inspected = [...new Set(submission.inspected ?? [])];
  const hintsUsed = [...new Set(submission.hintsUsed ?? [])].filter((id) => exercise.hints.some((hint) => hint.id === id));
  const sizes = fileSizes(repository ?? { files: [] });

  const hits = selected.filter((filePath) => gold.has(filePath));
  const missed = exercise.goldFiles.filter((filePath) => !selected.includes(filePath));
  const coverage = ratio(hits.length, gold.size);
  const precision = ratio(hits.length, selected.length);
  const f1 = coverage + precision > 0 ? (2 * coverage * precision) / (coverage + precision) : 0;

  const inspectedGold = inspected.filter((filePath) => gold.has(filePath));
  const inspectedBytes = inspected.reduce((sum, filePath) => sum + (sizes.get(filePath) ?? 0), 0);
  const relevantBytes = inspectedGold.reduce((sum, filePath) => sum + (sizes.get(filePath) ?? 0), 0);
  // Reading exactly the gold files is a perfect trail; every extra file dilutes
  // it. Reading nothing at all is not efficiency, so it scores zero.
  const fileEfficiency = inspected.length ? ratio(gold.size, Math.max(inspected.length, gold.size)) : 0;
  const byteEfficiency = inspectedBytes > 0 ? relevantBytes / inspectedBytes : 0;
  const firstHitRank = (submission.inspected ?? []).findIndex((filePath) => gold.has(filePath));

  const hintPenalty = hintsUsed.reduce((sum, id) => sum + (exercise.hints.find((hint) => hint.id === id)?.cost ?? 0), 0);
  const score = Math.max(0, Math.min(1, (0.5 * f1 + 0.3 * fileEfficiency + 0.2 * byteEfficiency) * (1 - hintPenalty)));

  return {
    exerciseId: exercise.id,
    coverage,
    precision,
    f1,
    fileEfficiency,
    byteEfficiency,
    score,
    // Passing requires finding the files *and* not shotgunning the answer:
    // selecting every file reaches full coverage but fails the precision gate.
    passed: coverage >= 0.75 && precision >= 0.75,
    grade: score >= 0.8 ? "excellent" : score >= 0.6 ? "solid" : score >= 0.35 ? "developing" : "scattered",
    inspectedCount: inspected.length,
    inspectedBytes,
    relevantBytes,
    optimalCount: gold.size,
    wastedInspections: inspected.filter((filePath) => !gold.has(filePath)).length,
    firstHitRank: firstHitRank >= 0 ? firstHitRank + 1 : null,
    hintsUsed,
    hintPenalty,
    hits,
    missed,
    falsePositives: selected.filter((filePath) => !gold.has(filePath)),
    goldFiles: exercise.goldFiles,
    definition: exercise.definition,
  };
}

/** One hint at a time, in order, so scaffolding cannot be skipped ahead. */
export function nextHint(exercise, used = []) {
  return exercise.hints.find((hint) => !used.includes(hint.id)) ?? null;
}
