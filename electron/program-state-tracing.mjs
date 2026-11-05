import { appendEvent } from "./activity-log.mjs";

/**
 * Externalized program-state tracing.
 *
 * Reading code silently gives no evidence of whether a learner actually
 * tracks variable values, control flow, and the call stack as execution
 * proceeds, or is only pattern-matching the final output. This module makes
 * that tracking explicit: before the real outcome is revealed, the learner
 * commits, checkpoint by checkpoint, what they believe is happening — which
 * function is entered or returned to, at what call-stack depth, and (for a
 * return) what value comes back — plus one end-to-end hypothesis about the
 * run's final status and value.
 *
 * The ground truth for every checkpoint is `execution-trace.mjs`'s own
 * recorded run (`runExecutionTrace`/its `events`), never re-derived here: this
 * module only turns those already-verified call/return events into an
 * annotation task and grades a submission against them. Attempts are
 * preserved as learning evidence through `activity-log.mjs`'s own
 * `appendEvent` (unmodified) — the same append-only, main-process-only log
 * every other graded activity in this app already writes to.
 *
 * Grading distinguishes three failure modes rather than collapsing them into
 * one "wrong" bucket:
 *
 *   - **omission** — no annotation was given for a checkpoint that really
 *     happened. Silently treating a missing answer as merely "incorrect"
 *     would hide that the learner lost track of a step entirely.
 *   - **swap** — the submitted bundle is wrong for this checkpoint but is
 *     *exactly* some other checkpoint's real state. This is the classic
 *     tracing error of attaching the right fact to the wrong moment in time
 *     (e.g. reporting step 5's return value at step 2), and it is a
 *     meaningfully different mistake from a pure guess.
 *   - **wrong** — the submission matches neither this checkpoint nor any
 *     other recorded one.
 */

export const PROGRAM_STATE_TRACE_VERSION = 1;

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

/**
 * Turn a real recorded run (`execution-trace.mjs`'s `runExecutionTrace`
 * result) into an ordered sequence of annotation checkpoints, one per
 * call/return event. Each checkpoint carries the real answer; callers that
 * hand this to a learner must use `publicStateCheckpointTask` instead.
 */
export function buildStateCheckpoints(trace, options = {}) {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  return (trace.events ?? [])
    .filter((event) => event.kind === "call" || event.kind === "return")
    .slice(0, limit)
    .map((event, index) => ({
      id: `checkpoint-${index}`,
      index,
      path: event.path,
      line: event.line,
      kind: event.kind,
      function: event.function,
      depth: event.depth,
      callerFunction: event.callerFunction ?? null,
      callerPath: event.callerPath ?? null,
      // Only a return event carries a captured value; a call checkpoint's
      // value slot is always null, never guessed at.
      value: event.kind === "return" ? event.value ?? null : null,
    }));
}

/**
 * Build the full annotation task (answer key included) plus the one
 * end-to-end hypothesis prompt about the run's final status and value.
 * `trace` must be a real result from `execution-trace.mjs`'s own
 * `runExecutionTrace` (that module's own guard rails for unsupported
 * languages, empty/oversized snippets, timeouts, and event caps are reused
 * as-is; this function does not re-check any of them).
 */
export function buildStateTraceTask(trace, options = {}) {
  if (!trace?.supported) {
    return { available: false, reason: trace?.reason ?? "Tracing is not supported here.", status: trace?.status ?? "unsupported" };
  }
  const checkpoints = buildStateCheckpoints(trace, options);
  if (!checkpoints.length) {
    return { available: false, reason: "The run produced no call or return events to annotate.", status: trace.status };
  }
  // On a raised exception the interpreter still emits a trailing `return`
  // event as each frame unwinds, but that is stack teardown, not a real
  // return value, so a final value is only ever reported for an `ok` run.
  const returns = checkpoints.filter((checkpoint) => checkpoint.kind === "return" && checkpoint.value !== null);
  const finalReturn = trace.status === "ok" ? (returns.at(-1) ?? null) : null;
  return {
    available: true,
    version: PROGRAM_STATE_TRACE_VERSION,
    id: `state-trace-${checkpoints.length}-${trace.durationMs ?? 0}`,
    language: trace.language,
    status: trace.status,
    checkpoints,
    hypothesis: {
      expectedStatus: trace.status,
      expectedFinalValue: finalReturn ? finalReturn.value : null,
      finalFunction: finalReturn ? finalReturn.function : null,
    },
  };
}

/** The learner-facing projection: every answer field is hidden. */
export function publicStateCheckpointTask(task) {
  if (!task?.available) return task;
  return {
    available: true,
    version: task.version,
    id: task.id,
    language: task.language,
    checkpointCount: task.checkpoints.length,
    prompts: task.checkpoints.map((checkpoint) => ({ id: checkpoint.id, index: checkpoint.index, path: checkpoint.path, line: checkpoint.line })),
    hypothesisPrompt: "Before you see the result: will this run complete, or raise an exception — and what does its outer call return?",
  };
}

function checkpointMatches(checkpoint, answer) {
  if (!answer) return false;
  if (checkpoint.kind !== answer.controlFlow) return false;
  if (checkpoint.function !== answer.function) return false;
  if (checkpoint.depth !== answer.depth) return false;
  if (checkpoint.kind === "return" && checkpoint.value !== (answer.value ?? null)) return false;
  return true;
}

/**
 * Grade one submitted set of checkpoint annotations against the real
 * recorded run, detecting omissions and swaps rather than reporting every
 * miss the same way.
 */
export function gradeStateTrace(task, annotations) {
  const submitted = new Map((annotations ?? []).map((entry) => [entry.checkpointId, entry]));
  const results = task.checkpoints.map((checkpoint) => {
    const answer = submitted.get(checkpoint.id);
    if (!answer) {
      return {
        checkpointId: checkpoint.id,
        index: checkpoint.index,
        status: "omitted",
        correct: false,
        detail: `No annotation was given for step ${checkpoint.index + 1} (${checkpoint.function} at ${checkpoint.path}:${checkpoint.line}).`,
      };
    }
    if (checkpointMatches(checkpoint, answer)) {
      return { checkpointId: checkpoint.id, index: checkpoint.index, status: "correct", correct: true, detail: "Matches the real run." };
    }
    const swapTarget = task.checkpoints.find((other) => other.id !== checkpoint.id && checkpointMatches(other, answer));
    if (swapTarget) {
      return {
        checkpointId: checkpoint.id,
        index: checkpoint.index,
        status: "swapped",
        correct: false,
        swappedWithIndex: swapTarget.index,
        detail: `This matches step ${swapTarget.index + 1}'s real state, not step ${checkpoint.index + 1}'s.`,
      };
    }
    return { checkpointId: checkpoint.id, index: checkpoint.index, status: "wrong", correct: false, detail: "Does not match any recorded step." };
  });

  const correct = results.filter((result) => result.correct).length;
  const omitted = results.filter((result) => result.status === "omitted").length;
  const swapped = results.filter((result) => result.status === "swapped").length;
  const wrong = results.filter((result) => result.status === "wrong").length;
  return {
    version: PROGRAM_STATE_TRACE_VERSION,
    taskId: task.id,
    results,
    checkpointCount: task.checkpoints.length,
    correct,
    omitted,
    swapped,
    wrong,
    score: round(correct / task.checkpoints.length),
    passed: correct === task.checkpoints.length,
  };
}

/**
 * Grade the one end-to-end hypothesis, committed before the outcome was
 * revealed, with the same stated-confidence Brier scoring this app's other
 * before-you-look predictions use (`activities.mjs`'s `gradePrediction`) —
 * reimplemented narrowly here because the answer shape (a run status plus an
 * opaque captured value, not a number or a path) does not fit that
 * function's `kind: "numeric" | "path"` cases.
 */
export function gradeHypothesis(task, hypothesis) {
  const statedConfidence = Math.max(0, Math.min(1, Number(hypothesis?.confidence ?? 0.5)));
  const statusCorrect = hypothesis?.status === task.hypothesis.expectedStatus;
  const expectsValue = task.hypothesis.expectedFinalValue !== null;
  const valueCorrect = !expectsValue || String(hypothesis?.finalValue ?? "") === String(task.hypothesis.expectedFinalValue);
  const correct = statusCorrect && valueCorrect;
  return {
    version: PROGRAM_STATE_TRACE_VERSION,
    taskId: task.id,
    statusCorrect,
    valueCorrect,
    correct,
    confidence: round(statedConfidence),
    brier: round((statedConfidence - (correct ? 1 : 0)) ** 2),
    calibration: correct
      ? (statedConfidence >= 0.7 ? "confident-and-right" : "underconfident")
      : (statedConfidence >= 0.7 ? "overconfident" : "appropriately-unsure"),
    expectedStatus: task.hypothesis.expectedStatus,
    expectedFinalValue: task.hypothesis.expectedFinalValue,
  };
}

/**
 * Preserve one attempt as learning evidence. This appends to the same
 * append-only, main-process-only activity log every other graded activity in
 * this app writes to (`activity-log.mjs`'s `appendEvent`, unmodified) —
 * never a renderer-editable record.
 */
export function recordStateTraceAttempt(directory, repository, task, checkpointGrade, hypothesisGrade) {
  return appendEvent(directory, repository.id, {
    kind: "program-state-trace",
    taskId: task.id,
    correct: checkpointGrade.passed && hypothesisGrade.correct,
    score: round((checkpointGrade.score + (hypothesisGrade.correct ? 1 : 0)) / 2),
    checkpointCount: checkpointGrade.checkpointCount,
    correctCheckpoints: checkpointGrade.correct,
    swapped: checkpointGrade.swapped,
    omitted: checkpointGrade.omitted,
    wrong: checkpointGrade.wrong,
    hypothesisCorrect: hypothesisGrade.correct,
    hypothesisBrier: hypothesisGrade.brier,
  });
}

/** A graded attempt rendered as a source-anchored review of what was missed. */
export function renderStateTraceReview(task, checkpointGrade) {
  const byId = new Map(task.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  const missed = checkpointGrade.results.filter((result) => !result.correct);
  return {
    id: "program-state-trace-review",
    type: "timeline",
    title: "Where your trace diverged from the real run",
    steps: missed.map((result) => {
      const checkpoint = byId.get(result.checkpointId);
      return {
        label: `Step ${result.index + 1}: ${checkpoint.function} (${result.status})`,
        detail: result.detail,
        anchor: { path: checkpoint.path, line: checkpoint.line, symbol: checkpoint.function },
      };
    }),
  };
}
