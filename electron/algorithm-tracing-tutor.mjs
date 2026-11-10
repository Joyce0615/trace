import { appendEvent } from "./activity-log.mjs";
import { answerFromLocalIndex } from "./context-engine.mjs";
import { buildExecutableQuiz, publicQuiz, gradeSubmission } from "./executable-quiz.mjs";
import { runExecutionTrace } from "./execution-trace.mjs";
import { buildStateTraceTask, gradeStateTrace, publicStateCheckpointTask } from "./program-state-tracing.mjs";
import { buildScaffold, nextHintRung, publicScaffold, scaffoldPenalty } from "./answer-guard.mjs";
import { delayedTransferAnalytics, normalizeEvents, rate, transferAnalytics } from "./analytics.mjs";

/**
 * Adaptive algorithm-tracing tutors.
 *
 * An unfamiliar algorithm (a sort, a traversal, a recursive search) is hard
 * for three separate reasons at once: a learner may not be able to retrieve
 * where the real implementation lives, may not be able to track what the
 * interpreter's notional machine actually does step by step, and may not be
 * able to reproduce the algorithm from scratch. This module composes four
 * things this app already built — never re-deriving any of their rules — into
 * one combined tutoring task per self-contained algorithm function:
 *
 *   - **retrieval**: `context-engine.mjs`'s own `answerFromLocalIndex`
 *     (unmodified) answers "where is `<name>` defined" against the real
 *     index, so retrieval is graded against the repository, not invented;
 *   - **notional-machine state**: `execution-trace.mjs`'s real
 *     `runExecutionTrace` and `program-state-tracing.mjs`'s own
 *     `buildStateTraceTask`/`gradeStateTrace` (unmodified), run against the
 *     *reference* implementation, so a learner's step-by-step state
 *     predictions are graded against an actual recorded trace, not a
 *     hand-written sequence of assertions;
 *   - **hidden tests**: `executable-quiz.mjs`'s own
 *     `buildExecutableQuiz`/`gradeSubmission` (unmodified), so the hidden
 *     oracle is the repository's real implementation running in the same
 *     layered sandbox every other executable quiz already uses — this
 *     module adds no new code-execution path of its own;
 *   - **graduated hints**: `answer-guard.mjs`'s own `buildScaffold`
 *     (unmodified) over the `"executable-quiz"` kind it already defines, so
 *     a hint ladder for this task carries the exact same construction-time
 *     "never spell out the answer" guarantee every other scaffolded exercise
 *     already has.
 *
 * **Solution leakage is prevented structurally**, not by a new rule invented
 * here: `publicAlgorithmTracingTask` strips every answer field
 * (`referenceAnswer`, the trace task's own hidden fields via
 * `publicStateCheckpointTask`, the quiz's own hidden fields via
 * `publicQuiz`) before a task crosses into learner-facing shape, and the
 * hint ladder is the one `answer-guard.mjs` already guarantees never spells
 * the code out.
 *
 * **Transfer is measured, not assumed** by reusing `analytics.mjs`'s own
 * `transferAnalytics`/`delayedTransferAnalytics` (unmodified). Those two
 * functions filter internally by `analytics.mjs`'s own private `GRADED_KINDS`
 * set, which this module must never extend or mutate — a brand-new event
 * `kind` would therefore be silently filtered out by both functions,
 * producing a false "insufficient evidence" verdict instead of a real one.
 * So a graded algorithm-tracing attempt is recorded under the one real kind
 * those functions already recognize for this exact grading shape,
 * `"executable-quiz"` (the hidden-test stage's own kind, since that is the
 * one stage with a pass/fail criterion as strict as those functions assume),
 * tagged with `taskKind: "algorithm-tracing"` so this module's own callers
 * can still scope to just these attempts without reading a kind those two
 * functions were never taught to recognize.
 */

export const ALGORITHM_TRACING_TUTOR_VERSION = 1;
/** The task-level tag attached to every event this module records; the
 * event's `kind` itself stays `"executable-quiz"` so analytics.mjs's own
 * functions see it as the graded activity it actually is. */
export const ALGORITHM_TRACING_TASK_KIND = "algorithm-tracing";

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

/**
 * Build the full combined task for one repository: a retrieval answer, a
 * notional-machine state-trace task against the reference implementation,
 * a hidden-test executable quiz, and a hint ladder for the quiz portion.
 * Every stage that is unavailable (no python runtime, no self-contained
 * function, the quiz's own oracle rejected every candidate) is reported by
 * name rather than silently dropped.
 */
export async function buildAlgorithmTracingTask(repository, options = {}) {
  const quiz = await buildExecutableQuiz(repository, options);
  if (!quiz.available) {
    return { available: false, reason: quiz.reason, version: ALGORITHM_TRACING_TUTOR_VERSION, rejectedCandidates: quiz.rejectedCandidates ?? [] };
  }

  const retrievalQuestion = options.retrievalQuestion ?? `where is ${quiz.entry} defined`;
  const retrievalAnswer = answerFromLocalIndex(repository, retrievalQuestion);

  const callArguments = quiz.cases[0].arguments;
  const referenceSnippet = [
    "import json",
    `from ${quiz.path.replace(/\.py$/, "").replace(/\//g, ".")} import ${quiz.entry}`,
    `args = json.loads(${JSON.stringify(JSON.stringify(callArguments))})`,
    `result = ${quiz.entry}(*args)`,
    "",
  ].join("\n");
  const trace = await runExecutionTrace(repository, { language: "python", snippet: referenceSnippet }, options.traceOptions ?? {});
  const stateTask = trace.status === "ok"
    ? buildStateTraceTask(trace)
    : { available: false, reason: trace.error ?? trace.reason ?? "The reference trace did not run to completion.", status: trace.status };

  const scaffold = buildScaffold("executable-quiz", {
    parameters: quiz.header.match(/\(([^)]*)\)/)?.[1]?.split(",").filter((item) => item.trim()).length ?? undefined,
    hiddenCases: quiz.cases.length - 1,
    sampleInput: JSON.stringify(quiz.cases[0]?.arguments ?? []),
  });

  return {
    available: true,
    version: ALGORITHM_TRACING_TUTOR_VERSION,
    id: `algorithm-tracing-${quiz.id}`,
    anchor: quiz.anchor,
    retrieval: { question: retrievalQuestion, referenceAnswer: retrievalAnswer },
    stateTask,
    quiz,
    scaffold,
  };
}

/** The learner-facing projection: every answer field across all four stages is hidden. */
export function publicAlgorithmTracingTask(task) {
  if (!task?.available) return task;
  return {
    available: true,
    version: task.version,
    id: task.id,
    anchor: task.anchor,
    retrieval: { question: task.retrieval.question },
    stateTask: task.stateTask.available ? publicStateCheckpointTask(task.stateTask) : { available: false, reason: task.stateTask.reason },
    quiz: publicQuiz(task.quiz),
    scaffold: publicScaffold(task.scaffold),
  };
}

/**
 * Grade the retrieval stage: did the learner's claim about where the
 * algorithm is defined match the real index's own answer?
 */
export function gradeRetrievalStage(task, learnerClaim) {
  const expected = task.retrieval.referenceAnswer;
  const correct = Boolean(expected) && String(learnerClaim ?? "").trim() !== "" && expected.includes(String(learnerClaim).trim());
  return {
    version: ALGORITHM_TRACING_TUTOR_VERSION,
    stage: "retrieval",
    correct,
    referenceAnswer: expected,
  };
}

/**
 * Grade the notional-machine state-tracing stage against the reference
 * run's own real checkpoints, by delegating to `program-state-tracing.mjs`'s
 * own `gradeStateTrace` (unmodified).
 */
export function gradeStateStage(task, annotations) {
  if (!task.stateTask.available) {
    return { stage: "state-trace", available: false, reason: task.stateTask.reason };
  }
  return { stage: "state-trace", available: true, ...gradeStateTrace(task.stateTask, annotations) };
}

/**
 * Grade the hidden-test stage by delegating to `executable-quiz.mjs`'s own
 * `gradeSubmission` (unmodified) — the hidden oracle never changes.
 */
export async function gradeHiddenTestStage(task, submission, options = {}) {
  const grade = await gradeSubmission(task.quiz, submission, options);
  return { stage: "hidden-tests", ...grade };
}

/** The next graduated hint for the quiz-portion scaffold, and its running cost. */
export function nextAlgorithmHint(task, used = []) {
  const rung = nextHintRung(task.scaffold, used);
  const cost = scaffoldPenalty(task.scaffold, used);
  return { rung, cost };
}

/**
 * Combine the three graded stages into one report. Retrieval and the
 * state trace are formative signal; the hidden-test score is the one that
 * contributes to mastery, since it is the only stage with a pass/fail
 * criterion as strict as the quiz's own oracle. `scaffold` must be the real
 * scaffold the task was built with (`task.scaffold`), not reconstructed here,
 * so the hint cost is computed against the actual rungs and prices a learner
 * was offered.
 */
export function combineAlgorithmTracingGrades(retrievalGrade, stateGrade, hiddenTestGrade, scaffold, hintsUsed = []) {
  const hintCost = scaffold?.rungs?.length ? scaffoldPenalty(scaffold, hintsUsed) : { penalty: 0, revealed: [], ignored: [] };
  const rawScore = hiddenTestGrade?.score ?? 0;
  const penalizedScore = round(Math.max(0, rawScore * (1 - hintCost.penalty)));
  return {
    version: ALGORITHM_TRACING_TUTOR_VERSION,
    retrieval: retrievalGrade,
    stateTrace: stateGrade,
    hiddenTests: hiddenTestGrade,
    hintsUsed: hintCost.revealed,
    hintPenalty: hintCost.penalty,
    score: penalizedScore,
    passed: Boolean(hiddenTestGrade?.passed) && hintCost.penalty === 0,
    correct: Boolean(hiddenTestGrade?.passed),
  };
}

/**
 * Preserve one attempt through the same append-only, main-process-only
 * activity log every other graded activity in this app writes to
 * (`activity-log.mjs`'s own `appendEvent`, unmodified). The event's `kind`
 * is deliberately `"executable-quiz"` — see this module's own doc comment —
 * tagged with `taskKind: "algorithm-tracing"` so `analytics.mjs`'s
 * `GRADED_KINDS`-filtered functions see a kind they already recognize while
 * this module's own callers can still select exactly these attempts.
 */
export function recordAlgorithmTracingAttempt(directory, repository, task, combinedGrade) {
  return appendEvent(directory, repository.id, {
    kind: "executable-quiz",
    taskKind: ALGORITHM_TRACING_TASK_KIND,
    taskId: task.id,
    path: task.anchor?.path ?? null,
    symbol: task.anchor?.symbol ?? null,
    correct: combinedGrade.correct,
    score: combinedGrade.score,
    hintPenalty: combinedGrade.hintPenalty,
  });
}

/**
 * Measure near/far and immediate/delayed transfer for this module's own
 * attempts, reusing `analytics.mjs`'s own `transferAnalytics` and
 * `delayedTransferAnalytics` (unmodified) rather than inventing a third
 * transfer metric. `events` must already be scoped to this module's own
 * `taskKind: "algorithm-tracing"` attempts (plus any `kind:
 * "delayed-transfer"` probes against the same anchors) — this function does
 * not do that scoping itself, since a caller mixing in other
 * `"executable-quiz"` attempts is a choice about what "transfer" should mean
 * here, not something this function can decide on a caller's behalf. Both
 * results are reported side by side, never merged into one number, matching
 * how those two functions already report for every other activity kind.
 */
export function measureAlgorithmTransfer(events, options = {}) {
  const immediate = transferAnalytics(events ?? [], options.learnerState ?? null, options);
  const delayed = delayedTransferAnalytics((events ?? []).filter((event) => event.kind === "delayed-transfer"), options);
  return { version: ALGORITHM_TRACING_TUTOR_VERSION, immediate, delayed };
}

/** Pass-rate over this module's own attempts (already scoped to `taskKind:
 * "algorithm-tracing"` by the caller), reusing `analytics.mjs`'s own
 * sample-floor-gated `rate` so a thin history reports honestly. */
export function algorithmTracingPassRate(events, minimum) {
  const attempts = normalizeEvents(events).filter((event) => event.taskKind === ALGORITHM_TRACING_TASK_KIND && typeof event.correct === "boolean");
  return rate(attempts.filter((event) => event.correct).length, attempts.length, minimum);
}
