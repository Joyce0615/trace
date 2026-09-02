import { createHash } from "node:crypto";
import { symbolBodyRange } from "./call-chain.mjs";
import { scoreLocalization } from "./localization.mjs";

/**
 * RACE-bench-style grading of *intermediate* work.
 *
 * Final correctness hides where understanding actually broke down, so a task is
 * graded in three separate stages with three separate rubrics:
 *
 *   1. understanding - can the learner restate the defect in repository terms?
 *   2. localization  - can they name the files that matter? (scored by item 27)
 *   3. plan          - is the proposed change ordered, validated, and bounded?
 *
 * Every rubric criterion is derived from the indexed source (real parameter
 * names, real callers, real test files), and every verdict carries the evidence
 * that justified it, so a score can always be traced back to the repository.
 */

export const RACE_GRADER_VERSION = 1;

const STAGE_WEIGHTS = { understanding: 0.3, localization: 0.35, plan: 0.35 };
// Below this many words an answer cannot be a complete explanation, so keyword
// stuffing is capped rather than rewarded.
const FULL_CREDIT_WORDS = 25;

function words(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean);
}

function normalize(text) {
  return String(text ?? "").toLowerCase();
}

/** Parameter names from a definition header, used as rubric evidence. */
export function signatureParameters(source, line) {
  const header = source.split(/\r?\n/)[Math.max(0, line - 1)] ?? "";
  const open = header.indexOf("(");
  if (open < 0) return [];
  const close = header.indexOf(")", open);
  const inside = header.slice(open + 1, close < 0 ? undefined : close);
  return inside
    .split(",")
    .map((part) => part.trim().split(/[:=\s]/)[0].replace(/[*&]/g, "").trim())
    .filter((name) => /^[A-Za-z_]\w*$/.test(name) && !["self", "cls", "void"].includes(name))
    .slice(0, 6);
}

function criterion(id, description, weight, test, evidence) {
  return { id, description, weight, test, evidence };
}

/**
 * Build a three-stage task around one symbol, with rubrics grounded in source.
 * `sources` maps repository-relative paths to file contents.
 */
export function buildRaceTask(repository, localizationExercise, sources = {}) {
  if (!localizationExercise) return null;
  const definition = localizationExercise.definition;
  const definitionSource = sources[definition.path] ?? "";
  const parameters = definitionSource ? signatureParameters(definitionSource, definition.line) : [];
  const callerFiles = localizationExercise.goldFiles.filter((filePath) => filePath !== definition.path);
  const callerSymbols = (repository.callEdges ?? [])
    .filter((edge) => edge.resolved && edge.callee === localizationExercise.symbol && edge.caller)
    .map((edge) => edge.caller);
  const testFiles = (repository.files ?? [])
    .filter((file) => /(^|\/)(tests?|spec)(\/|$)/i.test(file.directory) || /^test_|\.(test|spec)\./i.test(file.name))
    .map((file) => file.path)
    .slice(0, 8);
  const goldTopLevels = new Set(localizationExercise.goldFiles.map((filePath) => filePath.split("/")[0]));
  // Tests, docs, and examples are legitimate places for a bounded fix to reach,
  // so they are never counted as scope creep — the validation criterion below
  // actively rewards naming them.
  const supportingDirectories = /^(tests?|spec|specs|docs?|examples?|benchmarks?|\.github)$/i;
  const otherTopLevels = [...new Set((repository.files ?? []).map((file) => file.path.split("/")[0]))]
    .filter((directory) => !goldTopLevels.has(directory) && !directory.includes(".") && !supportingDirectories.test(directory))
    .slice(0, 12);
  const range = definitionSource ? symbolBodyRange(definitionSource, definition.line, (repository.files ?? []).find((file) => file.path === definition.path)?.language ?? "python") : null;

  const understanding = [
    criterion("names-symbol", `Names the failing function \`${localizationExercise.symbol}\`.`, 0.3,
      (text) => normalize(text).includes(localizationExercise.symbol.toLowerCase()),
      `${definition.path}:${definition.line}`),
    criterion("names-module", "Identifies the module or file that owns the behavior.", 0.2,
      (text) => normalize(text).includes(definition.path.split("/").at(-1).toLowerCase()) || normalize(text).includes(definition.path.toLowerCase()),
      definition.path),
    criterion("names-input", parameters.length ? `Refers to an actual input (${parameters.join(", ")}).` : "Describes the inputs the function receives.", 0.2,
      (text) => (parameters.length
        ? parameters.some((parameter) => new RegExp(`\\b${parameter.toLowerCase()}\\b`).test(normalize(text)))
        : /\binput|argument|parameter|request\b/.test(normalize(text))),
      range ? `${definition.path}:${range.start}-${range.end}` : definition.path),
    criterion("names-caller", callerFiles.length ? "Connects the defect to a caller that depends on it." : "Describes who depends on this behavior.", 0.15,
      (text) => callerFiles.some((filePath) => normalize(text).includes(filePath.split("/").at(-1).toLowerCase()))
        || callerSymbols.some((symbol) => new RegExp(`\\b${symbol.toLowerCase()}\\b`).test(normalize(text))),
      callerFiles[0] ?? definition.path),
    criterion("expected-vs-actual", "Contrasts the expected behavior with the observed behavior.", 0.15,
      (text) => /\b(expected|should|instead|actually|but|rather than|incorrect|wrong)\b/.test(normalize(text)),
      "issue report"),
  ];

  const plan = [
    criterion("target-file", `Changes the file that defines \`${localizationExercise.symbol}\`.`, 0.3,
      (text) => normalize(text).includes(definition.path.toLowerCase()) || normalize(text).includes(definition.path.split("/").at(-1).toLowerCase()),
      definition.path),
    criterion("validation", "States how the change will be validated.", 0.2,
      (text) => /\b(test|tests|pytest|unittest|assert|regression|verify|reproduce)\b/.test(normalize(text))
        || testFiles.some((filePath) => normalize(text).includes(filePath.split("/").at(-1).toLowerCase())),
      testFiles[0] ?? "repository tests"),
    criterion("check-callers", "Checks the callers that would be affected.", 0.2,
      (text) => callerFiles.some((filePath) => normalize(text).includes(filePath.split("/").at(-1).toLowerCase()))
        || /\bcaller|call site|dependent|downstream\b/.test(normalize(text)),
      callerFiles[0] ?? definition.path),
    criterion("ordered-steps", "Breaks the work into at least three ordered steps.", 0.15,
      (text) => String(text ?? "").split(/\r?\n/).filter((line) => /^\s*(\d+[.)]|[-*•])\s+\S/.test(line)).length >= 3
        || (String(text ?? "").match(/\b(first|then|next|after that|finally)\b/gi) ?? []).length >= 3,
      "plan structure"),
    criterion("bounded-scope", "Stays inside the affected modules instead of proposing a rewrite.", 0.15,
      (text) => !/\b(rewrite|refactor everything|redesign the whole|rearchitect)\b/.test(normalize(text))
        && otherTopLevels.filter((directory) => new RegExp(`\\b${directory.toLowerCase()}/`).test(normalize(text))).length === 0,
      [...goldTopLevels].join(", ")),
  ];

  return {
    id: `race-${createHash("sha1").update(`${repository.versionId ?? repository.id}:${localizationExercise.id}`).digest("hex").slice(0, 12)}`,
    version: RACE_GRADER_VERSION,
    symbol: localizationExercise.symbol,
    localizationExerciseId: localizationExercise.id,
    issue: `Issue: calls to \`${localizationExercise.symbol}()\` return an unexpected result for some inputs. ${callerFiles.length} caller file${callerFiles.length === 1 ? "" : "s"} depend${callerFiles.length === 1 ? "s" : ""} on it. Before writing any code, (1) restate what is going wrong in this repository's own terms, (2) name the files involved, and (3) describe a bounded plan to fix and validate it.`,
    stages: { understanding, localization: { exercise: localizationExercise }, plan },
    weights: STAGE_WEIGHTS,
  };
}

/** Renderer-safe projection: criteria descriptions are shown, tests are not. */
export function publicRaceTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    version: task.version,
    symbol: task.symbol,
    issue: task.issue,
    localizationExerciseId: task.localizationExerciseId,
    weights: task.weights,
    rubric: {
      understanding: task.stages.understanding.map(({ id, description, weight }) => ({ id, description, weight })),
      plan: task.stages.plan.map(({ id, description, weight }) => ({ id, description, weight })),
    },
  };
}

function gradeText(criteria, text) {
  const wordCount = words(text).length;
  // A short answer can satisfy keywords without demonstrating understanding, so
  // credit ramps with length instead of jumping straight to full marks.
  const lengthFactor = Math.min(1, wordCount / FULL_CREDIT_WORDS);
  const results = criteria.map((item) => {
    const met = wordCount > 0 && Boolean(item.test(text));
    return { id: item.id, description: item.description, weight: item.weight, met, evidence: item.evidence };
  });
  const raw = results.filter((result) => result.met).reduce((sum, result) => sum + result.weight, 0);
  return {
    score: Math.max(0, Math.min(1, raw * lengthFactor)),
    rawScore: raw,
    lengthFactor,
    wordCount,
    criteria: results,
    met: results.filter((result) => result.met).map((result) => result.id),
    missed: results.filter((result) => !result.met).map((result) => result.id),
  };
}

function band(score) {
  return score >= 0.85 ? "expert" : score >= 0.65 ? "competent" : score >= 0.4 ? "emerging" : "novice";
}

/**
 * Grade a full submission. Each stage is scored independently so a learner who
 * understands the defect but cannot plan the fix sees exactly that.
 */
export function gradeRaceSubmission(task, submission, repository) {
  const understanding = gradeText(task.stages.understanding, submission.understanding ?? "");
  const plan = gradeText(task.stages.plan, submission.plan ?? "");
  const localization = scoreLocalization(
    task.stages.localization.exercise,
    { inspected: submission.inspected ?? [], selected: submission.files ?? [], hintsUsed: submission.hintsUsed ?? [] },
    repository,
  );
  const stageScores = {
    understanding: understanding.score,
    localization: localization.f1,
    plan: plan.score,
  };
  const overall = Object.entries(STAGE_WEIGHTS).reduce((sum, [stage, weight]) => sum + weight * stageScores[stage], 0);
  // The weakest stage is the actionable feedback, not the average.
  const weakest = Object.entries(stageScores).sort((left, right) => left[1] - right[1])[0][0];

  return {
    taskId: task.id,
    version: RACE_GRADER_VERSION,
    stages: { understanding, localization, plan },
    stageScores,
    stageBands: Object.fromEntries(Object.entries(stageScores).map(([stage, score]) => [stage, band(score)])),
    overall,
    band: band(overall),
    weakestStage: weakest,
    nextStep: {
      understanding: "Re-read the definition and restate the defect using the real parameter and caller names.",
      localization: "Follow the call edges out of the definition before answering; name every file that would have to change.",
      plan: "Write an ordered plan that names the file to change, the callers to check, and the test that proves it.",
    }[weakest],
  };
}
