import { appendEvent } from "./activity-log.mjs";
import { runExecutionTrace } from "./execution-trace.mjs";
import { calibrateSkill, misconceptionById } from "./misconception.mjs";

/**
 * Misconception counterexample laboratories.
 *
 * `misconception.mjs` already names eight wrong mental models and gives each
 * one a probe whose distractor *encodes* it, but a multiple-choice probe is
 * a claim about what a learner would predict, not a demonstration of what
 * the code actually does. This module adds the demonstration: for each
 * taxonomy entry, a minimal Python snippet whose two competing predictions
 * — "what the correct model expects" and "what the misconception predicts"
 * — are different strings. Because the two predictions genuinely differ,
 * whichever one the real interpreter actually prints is a counterexample
 * against whichever model predicted the other string.
 *
 * The learner is required to commit to one of the two predictions *before*
 * the snippet runs (`gradeCounterexamplePrediction`), the same before-you-
 * look discipline `activities.mjs`'s predictions and
 * `program-state-tracing.mjs`'s hypotheses already use, scored with the same
 * confidence-weighted Brier calculation.
 *
 * The snippet is then actually executed through `execution-trace.mjs`'s own
 * `runExecutionTrace` (unmodified) — never simulated or looked up — and
 * `runCounterexampleLab` reports whether the run *resolved* the
 * misconception: only when the run completed (`status: "ok"`), the lab's
 * own two predictions truly differ (a lab that does not discriminate proves
 * nothing), and the observed output is the correct model's prediction.
 *
 * Mastery evidence is the point of the gate: `applyCounterexampleResolution`
 * only ever adds an evidence item — reusing `misconception.mjs`'s own
 * `calibrateSkill` (unmodified) to turn it into mastery — when
 * `run.resolved` is true. A lab that failed to run, or that (by a bug in
 * this module) failed to discriminate, updates nothing, and says why.
 */

export const COUNTEREXAMPLE_LAB_VERSION = 1;

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

// One minimal, self-contained Python snippet per discriminated misconception.
// Every snippet prints exactly one `OBSERVED:<value>` line; `correctPrediction`
// is what actually happens, `misconceptionPrediction` is what the named wrong
// model would predict instead, and the two are always different strings —
// enforced by `listCounterexampleLabs`' own integrity check below.
const LAB_SPECS = [
  {
    misconceptionId: "execution-order",
    snippet: [
      "order = []",
      "",
      "",
      "def alpha():",
      '    order.append("alpha")',
      "",
      "",
      "def beta():",
      '    order.append("beta")',
      "",
      "",
      "beta()",
      "alpha()",
      'print("OBSERVED:" + ",".join(order))',
      "",
    ].join("\n"),
    correctPrediction: "beta,alpha",
    misconceptionPrediction: "alpha,beta",
  },
  {
    misconceptionId: "call-vs-definition",
    snippet: [
      "def make_greeter():",
      '    greeting = "hello-from-definition-scope"',
      "",
      "    def greet():",
      "        return greeting",
      "    return greet",
      "",
      "",
      'greeting = "hello-from-call-site"',
      "say_hello = make_greeter()",
      'print("OBSERVED:" + say_hello())',
      "",
    ].join("\n"),
    correctPrediction: "hello-from-definition-scope",
    misconceptionPrediction: "hello-from-call-site",
  },
  {
    misconceptionId: "single-caller",
    snippet: [
      "_calls = []",
      "",
      "",
      "def record(label):",
      "    _calls.append(label)",
      "    return len(_calls)",
      "",
      "",
      "def consumer_one():",
      '    return record("one")',
      "",
      "",
      "def consumer_two():",
      '    return record("two")',
      "",
      "",
      "consumer_one()",
      "result = consumer_two()",
      'print("OBSERVED:" + str(result))',
      "",
    ].join("\n"),
    correctPrediction: "2",
    misconceptionPrediction: "1",
  },
  {
    misconceptionId: "mutation-vs-copy",
    snippet: [
      "def mutate(items):",
      "    items.append(99)",
      "",
      "",
      "original = [1, 2, 3]",
      "mutate(original)",
      'print("OBSERVED:" + str(original))',
      "",
    ].join("\n"),
    correctPrediction: "[1, 2, 3, 99]",
    misconceptionPrediction: "[1, 2, 3]",
  },
  {
    misconceptionId: "interface-vs-implementation",
    snippet: [
      "def sanitize(value):",
      '    """Returns the value unchanged."""',
      "    return value.strip().lower()",
      "",
      "",
      'print("OBSERVED:" + sanitize("  HeLLo  "))',
      "",
    ].join("\n"),
    correctPrediction: "hello",
    misconceptionPrediction: "  HeLLo  ",
  },
  {
    misconceptionId: "sync-assumption",
    snippet: [
      "trace = []",
      "",
      "",
      "def steps():",
      '    trace.append("A")',
      "    yield 1",
      '    trace.append("B")',
      "    yield 2",
      "",
      "",
      "gen = steps()",
      'trace.append("created")',
      "next(gen)",
      'print("OBSERVED:" + ",".join(trace))',
      "",
    ].join("\n"),
    correctPrediction: "created,A",
    misconceptionPrediction: "A,created",
  },
  {
    misconceptionId: "error-path-blindness",
    snippet: [
      "def risky(value):",
      "    if value < 0:",
      '        raise ValueError("negative")',
      "    return value * 2",
      "",
      "",
      "def handle(value):",
      "    try:",
      "        return risky(value)",
      "    except ValueError:",
      "        return -1",
      "",
      "",
      "result = handle(-5)",
      'print("OBSERVED:" + str(result))',
      "",
    ].join("\n"),
    correctPrediction: "-1",
    misconceptionPrediction: "-10",
  },
  {
    misconceptionId: "global-state",
    snippet: [
      "_cache = {}",
      "",
      "",
      "def compute(key):",
      "    if key in _cache:",
      "        return _cache[key]",
      "    _cache[key] = key * 2",
      "    return _cache[key]",
      "",
      "",
      "compute(3)",
      "_cache[3] = 999",
      "result = compute(3)",
      'print("OBSERVED:" + str(result))',
      "",
    ].join("\n"),
    correctPrediction: "999",
    misconceptionPrediction: "6",
  },
];

const LAB_BY_MISCONCEPTION = new Map(LAB_SPECS.map((spec) => [spec.misconceptionId, spec]));

/**
 * Which taxonomy ids this laboratory can actually discriminate. Deliberately
 * not just "every id in `MISCONCEPTIONS`" — if the taxonomy grows a new entry
 * before a lab is written for it, this list must not silently claim coverage
 * it does not have.
 */
export function listCounterexampleLabs() {
  return LAB_SPECS.map((spec) => spec.misconceptionId);
}

/** Build the full lab (snippet, both predictions, which one is correct). */
export function buildCounterexampleLab(misconceptionId) {
  const spec = LAB_BY_MISCONCEPTION.get(misconceptionId);
  if (!spec) return null;
  const entry = misconceptionById(misconceptionId);
  return {
    version: COUNTEREXAMPLE_LAB_VERSION,
    id: `counterexample-${misconceptionId}`,
    misconceptionId,
    title: entry?.title ?? misconceptionId,
    summary: entry?.summary ?? null,
    remediation: entry?.remediation ?? null,
    snippet: spec.snippet,
    prompt: "Before you run this, predict exactly what the OBSERVED: line will print.",
    options: [
      { id: "model-correct", text: spec.correctPrediction },
      { id: "model-misconception", text: spec.misconceptionPrediction },
    ],
    correctOptionId: "model-correct",
  };
}

/** The learner-facing projection: which option is correct is hidden. */
export function publicCounterexampleLab(lab) {
  if (!lab) return lab;
  return {
    version: lab.version,
    id: lab.id,
    misconceptionId: lab.misconceptionId,
    title: lab.title,
    summary: lab.summary,
    snippet: lab.snippet,
    prompt: lab.prompt,
    options: lab.options.map((option) => ({ id: option.id, text: option.text })),
  };
}

/**
 * Actually run the lab's snippet (never simulated) and decide whether the
 * observed behavior resolves the misconception: the run must complete, the
 * lab's own two predictions must genuinely differ, and the observed output
 * must be the correct model's prediction.
 */
export async function runCounterexampleLab(lab, repository, options = {}) {
  const spec = LAB_BY_MISCONCEPTION.get(lab?.misconceptionId);
  if (!spec) return { available: false, labId: lab?.id ?? null, status: "unknown-lab", reason: "No lab is defined for this misconception.", observed: null, resolved: false };

  const trace = await runExecutionTrace(repository ?? { rootPath: options.rootPath ?? process.cwd() }, {
    language: "python",
    snippet: spec.snippet,
    ...(options.traceOptions ?? {}),
  });
  if (trace.status !== "ok") {
    return {
      available: false,
      labId: lab.id,
      misconceptionId: lab.misconceptionId,
      status: trace.status,
      reason: trace.error ?? trace.reason ?? "The counterexample did not run to completion.",
      observed: null,
      resolved: false,
    };
  }

  const match = /OBSERVED:(.+)/.exec(trace.stdout ?? "");
  const observed = match ? match[1].trim() : null;
  const discriminates = spec.correctPrediction !== spec.misconceptionPrediction;
  const matchesCorrect = observed === spec.correctPrediction;
  const matchesMisconception = observed === spec.misconceptionPrediction;

  return {
    available: true,
    labId: lab.id,
    misconceptionId: lab.misconceptionId,
    status: trace.status,
    observed,
    matchesCorrect,
    matchesMisconception,
    discriminates,
    // Mastery evidence is gated on this, not on the learner's guess.
    resolved: discriminates && matchesCorrect,
  };
}

/**
 * Grade the prediction the learner committed to before the run, with the
 * same confidence-weighted Brier scoring `activities.mjs`'s `gradePrediction`
 * and `program-state-tracing.mjs`'s `gradeHypothesis` already use.
 */
export function gradeCounterexamplePrediction(lab, choiceOptionId, confidence) {
  const stated = Math.max(0, Math.min(1, Number(confidence ?? 0.5)));
  const correct = choiceOptionId === lab.correctOptionId;
  return {
    version: COUNTEREXAMPLE_LAB_VERSION,
    labId: lab.id,
    choiceOptionId: choiceOptionId ?? null,
    correct,
    heldMisconception: !correct,
    confidence: round(stated),
    brier: round((stated - (correct ? 1 : 0)) ** 2),
    calibration: correct
      ? (stated >= 0.7 ? "confident-and-right" : "underconfident")
      : (stated >= 0.7 ? "overconfident" : "appropriately-unsure"),
  };
}

/**
 * One mastery evidence item, or `null` when the run did not resolve the
 * misconception. `kind: "diagnostic"` is the same evidence kind
 * `misconception.mjs`'s own `calibrateSkill` already weighs (its private
 * `EVIDENCE_WEIGHT` table), so this is read by that function unmodified.
 */
export function buildMasteryEvidence(run, predictionGrade) {
  if (!run?.resolved) return null;
  return {
    kind: "diagnostic",
    strength: predictionGrade?.correct ? 1 : 0,
    detail: `Counterexample for '${run.misconceptionId}' resolved; the learner ${predictionGrade?.correct ? "had already predicted" : "had predicted the misconception's answer before seeing"} the real observed behavior (${run.observed}).`,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Update mastery only when the run actually resolved the misconception.
 * Reuses `misconception.mjs`'s own `calibrateSkill` (unmodified) over the
 * mastery evidence list with the new item appended; when the run did not
 * resolve anything, `calibrateSkill` is still run so a caller always gets a
 * calibration back, but over the *unchanged* evidence list.
 */
export function applyCounterexampleResolution(mastery, run, predictionGrade) {
  const evidence = buildMasteryEvidence(run, predictionGrade);
  if (!evidence) {
    const reason = run?.available === false
      ? (run.reason ?? "The lab did not run.")
      : "The lab did not resolve the misconception (it either failed to run or failed to discriminate the two models), so no mastery evidence was recorded.";
    return { updated: false, reason, mastery: mastery ?? null, calibration: calibrateSkill(mastery) };
  }
  const nextMastery = { ...(mastery ?? {}), evidence: [...(mastery?.evidence ?? []), evidence] };
  return { updated: true, reason: null, mastery: nextMastery, calibration: calibrateSkill(nextMastery) };
}

/**
 * Preserve one attempt as learning evidence through the same append-only,
 * main-process-only activity log every other graded activity in this app
 * writes to (`activity-log.mjs`'s `appendEvent`, unmodified).
 */
export function recordCounterexampleAttempt(directory, repository, run, predictionGrade) {
  return appendEvent(directory, repository.id, {
    kind: "counterexample-lab",
    misconceptionId: run.misconceptionId,
    labId: run.labId,
    status: run.status ?? null,
    observed: run.observed ?? null,
    resolved: Boolean(run.resolved),
    correct: Boolean(predictionGrade?.correct),
    confidence: predictionGrade?.confidence ?? null,
    brier: predictionGrade?.brier ?? null,
  });
}
