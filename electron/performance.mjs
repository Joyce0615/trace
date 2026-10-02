/**
 * Performance budgets for startup, indexing, memory, search, and rendering
 * (item 57).
 *
 * A budget is not a measurement. Fifty-two items of this project have measured
 * things — `tookMs` on a search, `buildMs` on a quiz, an 8-second index in the
 * smoke test's report — and printed them. Printed numbers do not stop anything.
 * A budget is a *declared* ceiling with a name, a reason, and something that
 * fails when it is crossed.
 *
 * Four decisions carry most of the value here, and each of them is a way this
 * could have been useless instead:
 *
 *   - **Budgets scale with the input.** "Index in under ten seconds" is a
 *     statement about the fixture, not about the code: run it on a repository
 *     twice the size and it fails without anything having got slower. Budgets
 *     that vary with work are expressed *per unit* — milliseconds per file,
 *     bytes per file — with a `floor` for the fixed cost that a tiny input
 *     cannot amortise, so a two-file fixture does not have to meet a
 *     steady-state rate.
 *
 *   - **A percentile of five samples is not a percentile.** `summarize`
 *     reports `reliable: false` below a minimum count and `evaluateBudget`
 *     returns `insufficient-data` rather than `pass`. This is the same rule the
 *     dependency scanner follows when it has no advisory feed: not knowing must
 *     never be reported as being fine.
 *
 *   - **Regression detection needs a noise floor.** Without one, every run
 *     "regresses", people stop reading the output, and the check is worse than
 *     nothing. A change counts only when it clears both a relative and an
 *     absolute threshold.
 *
 *   - **Warnings are not enforcement.** `evaluateAll` fails the run when any
 *     budget is exceeded, and the failure names the budget, the measurement,
 *     the ceiling, and why the ceiling exists.
 *
 * Pure except for `sampleMemory`, so the arithmetic can be tested without
 * running anything.
 */

export const PERFORMANCE_VERSION = 1;

/** Below this many samples a percentile is a rumour. */
export const MIN_SAMPLES_FOR_PERCENTILE = 8;

export const BUDGET_VERDICTS = ["pass", "warn", "fail", "insufficient-data"];

/**
 * The budgets themselves.
 *
 * `limit` fails, `warnAt` warns. `per` names the unit the measurement scales
 * with, and `floor` is the fixed cost below which the rate does not apply.
 * `why` exists because a ceiling nobody can justify is a ceiling somebody will
 * raise the first time it is inconvenient.
 */
export const BUDGETS = {
  "startup.firstWindowMs": {
    label: "Time to first window",
    unit: "ms",
    limit: 8_000,
    warnAt: 4_000,
    why: "Past a few seconds with nothing on screen a learner assumes the application did not start.",
  },
  "startup.interactiveMs": {
    label: "Time to an interactive workspace",
    unit: "ms",
    limit: 20_000,
    warnAt: 12_000,
    why: "The first window is not the product; the first moment something can be clicked is.",
  },
  // The three scaled budgets. `limit` is a *rate* — per file — and the
  // measurement is the *total*, so the ceiling is `limit × files` but never
  // below `floor`. Comparing a rate with a scaled total, or a total with an
  // unscaled rate, silently makes the ceiling meaningless in one direction or
  // the other; the unit strings here name what is measured, not what is
  // budgeted, for exactly that reason.
  "index.totalMs": {
    label: "Indexing time",
    unit: "ms",
    limit: 12,
    warnAt: 6,
    per: "files",
    floor: 3_000,
    why: "Indexing is the one unavoidable wait, and it is the cost that grows with the repository rather than with the app.",
  },
  "index.peakRssBytes": {
    label: "Peak resident memory while indexing",
    unit: "bytes",
    limit: 1_200_000,
    warnAt: 700_000,
    per: "files",
    // Measured, not guessed: a nine-file fixture already peaks around 253 MB,
    // because loading the tree-sitter runtime and a handful of WebAssembly
    // grammars costs that much before a single definition is found. A floor
    // below the fixed cost fails every small repository for being small.
    floor: 400_000_000,
    why: "Peak, not final: the moment that exhausts a laptop is the high-water mark, and it is dominated by the parser's WebAssembly memory rather than by the JavaScript heap.",
  },
  "index.peakHeapBytes": {
    label: "Peak JavaScript heap while indexing",
    unit: "bytes",
    limit: 200_000,
    warnAt: 120_000,
    per: "files",
    floor: 120_000_000,
    why: "Separated from resident memory so a regression in what this code retains is not hidden by what the parser allocates.",
  },
  "search.coldMs": {
    label: "First query after the index is built",
    unit: "ms",
    limit: 400,
    warnAt: 150,
    why: "The first search is the one a learner judges the feature by.",
  },
  "search.p95Ms": {
    label: "Query latency, 95th percentile",
    unit: "ms",
    limit: 250,
    warnAt: 100,
    percentile: true,
    why: "A mean hides the queries that are slow, and the slow ones are the whole complaint.",
  },
  "search.indexBuildMs": {
    label: "Search index construction",
    unit: "ms",
    limit: 3,
    warnAt: 1.5,
    per: "files",
    floor: 500,
    why: "Built once per repository; if it grows super-linearly the largest repositories are the ones that suffer.",
  },
  "render.entryBundleBytes": {
    label: "Bytes downloaded before any interaction",
    unit: "bytes",
    limit: 320_000,
    warnAt: 280_000,
    why: "Item 19 moved Monaco out of the entry chunk; without a ceiling it drifts straight back in.",
  },
  "render.domNodes": {
    label: "Elements in the document",
    unit: "nodes",
    limit: 4_000,
    warnAt: 2_500,
    why: "Item 50 virtualized the long lists; a ceiling is how that stays true as panels are added.",
  },
  "render.viewSwitchMs": {
    label: "Switching between panels",
    unit: "ms",
    limit: 2_500,
    warnAt: 1_200,
    why: "Panels are lazy chunks, so a slow switch means a chunk that grew or work that should not be on the click path.",
  },
  "render.longTaskMs": {
    label: "Longest uninterrupted main-thread task",
    unit: "ms",
    limit: 800,
    warnAt: 300,
    why: "A long task is the frame budget being missed many times in a row: nothing responds, including the scroll.",
  },
};

export function budgetIds() {
  return Object.keys(BUDGETS).sort();
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

/** Nearest-rank percentile, which needs no interpolation and no assumptions. */
export function percentile(samples, fraction) {
  const sorted = [...(samples ?? [])].filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Describe a set of samples, including whether it is big enough to describe.
 *
 * `reliable` is the field that matters. A p95 over five samples is the maximum
 * with a decimal point on it.
 */
export function summarize(samples, { minimum = MIN_SAMPLES_FOR_PERCENTILE } = {}) {
  const values = [...(samples ?? [])].filter((value) => Number.isFinite(value));
  if (!values.length) {
    return { count: 0, reliable: false, min: null, max: null, mean: null, p50: null, p95: null, p99: null };
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    reliable: values.length >= minimum,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: round(total / values.length),
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    p99: round(percentile(values, 0.99)),
  };
}

function round(value) {
  return value === null || value === undefined ? null : Number(Number(value).toFixed(3));
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * The ceiling that actually applies to a measurement.
 *
 * For a scaled budget it is `limit × size`, but never below `floor`: a two-file
 * fixture has to pay the same fixed start-up cost as a two-thousand-file one,
 * and holding it to a steady-state rate would fail a build for being small.
 */
export function effectiveCeiling(budget, size, field = "limit") {
  const value = budget[field];
  if (!budget.per) return value;
  const scaled = value * Math.max(0, Number(size ?? 0));
  return Math.max(scaled, budget.floor ?? 0);
}

/**
 * Judge one measurement.
 *
 * `measurement` is either a number, or `{ samples, size }` for a percentile
 * budget. The result always carries the ceiling and the reason, because a
 * failure that does not say what it was measured against is a failure nobody
 * can act on.
 */
export function evaluateBudget(id, measurement, options = {}) {
  const budget = BUDGETS[id];
  if (!budget) throw new Error(`Unknown performance budget: ${id}`);
  const size = options.size ?? measurement?.size ?? null;

  let value = null;
  let samples = null;
  if (measurement !== null && typeof measurement === "object") {
    samples = summarize(measurement.samples, options);
    value = samples.p95;
    if (!samples.reliable) {
      return {
        id,
        label: budget.label,
        verdict: "insufficient-data",
        value,
        samples,
        ceiling: effectiveCeiling(budget, size),
        unit: budget.unit,
        // Reported rather than passed, for the same reason a dependency scan
        // with no feed reports `null`: not knowing is not the same as being fine.
        detail: `${samples.count} sample(s) is below the ${options.minimum ?? MIN_SAMPLES_FOR_PERCENTILE} needed before a percentile means anything.`,
        why: budget.why,
      };
    }
  } else {
    // `Number(null)` is 0 and `Number("")` is 0, so coercing first would score
    // a missing measurement as a perfect one — the precise failure this module
    // exists to prevent. Only an actual number is a measurement.
    value = typeof measurement === "number" ? measurement : Number.NaN;
  }

  if (!Number.isFinite(value)) {
    return { id, label: budget.label, verdict: "insufficient-data", value: null, samples, ceiling: effectiveCeiling(budget, size), unit: budget.unit, detail: "No measurement was taken.", why: budget.why };
  }

  const ceiling = effectiveCeiling(budget, size, "limit");
  const warnCeiling = effectiveCeiling(budget, size, "warnAt");
  const verdict = value > ceiling ? "fail" : value > warnCeiling ? "warn" : "pass";
  return {
    id,
    label: budget.label,
    verdict,
    value: round(value),
    samples,
    ceiling: round(ceiling),
    warnAt: round(warnCeiling),
    unit: budget.unit,
    size: size ?? null,
    headroom: round(ceiling - value),
    headroomRatio: ceiling > 0 ? round(1 - value / ceiling) : null,
    detail: verdict === "pass"
      ? `${round(value)} ${budget.unit} against a ceiling of ${round(ceiling)}.`
      : `${round(value)} ${budget.unit} ${verdict === "fail" ? "exceeds" : "is within warning distance of"} the ceiling of ${round(ceiling)}.`,
    why: budget.why,
  };
}

/**
 * Judge everything measured, and fail the run if anything is over.
 *
 * `unmeasured` is deliberately part of the result: a suite that quietly stopped
 * measuring startup would otherwise report a clean sheet.
 */
export function evaluateAll(measurements, options = {}) {
  const results = [];
  for (const [id, measurement] of Object.entries(measurements ?? {})) {
    results.push(evaluateBudget(id, measurement, options[id] ?? {}));
  }
  results.sort((left, right) => left.id.localeCompare(right.id));
  const failures = results.filter((result) => result.verdict === "fail");
  const warnings = results.filter((result) => result.verdict === "warn");
  const unknown = results.filter((result) => result.verdict === "insufficient-data");
  const unmeasured = budgetIds().filter((id) => !(id in (measurements ?? {})));
  return {
    version: PERFORMANCE_VERSION,
    results,
    passed: failures.length === 0,
    failures: failures.map((result) => result.id),
    warnings: warnings.map((result) => result.id),
    unknown: unknown.map((result) => result.id),
    unmeasured,
    summary: failures.length
      ? `${failures.length} budget(s) exceeded: ${failures.map((result) => `${result.id} at ${result.value} ${result.unit} against ${result.ceiling}`).join("; ")}`
      : `${results.length} budget(s) within ceiling${warnings.length ? `, ${warnings.length} in the warning band` : ""}${unknown.length ? `, ${unknown.length} without enough data` : ""}${unmeasured.length ? `, ${unmeasured.length} not measured` : ""}.`,
  };
}

// ---------------------------------------------------------------------------
// Regression against a baseline
// ---------------------------------------------------------------------------

/** Nothing under both thresholds counts, or every run reports a regression. */
export const DEFAULT_NOISE = { ratio: 0.2, absolute: { ms: 25, bytes: 8_000, nodes: 100 } };

/**
 * Compare this run with a stored one.
 *
 * A budget says "not worse than this ceiling"; a baseline says "not worse than
 * last time", which catches the slow drift that never crosses a ceiling until
 * the day it does. Both thresholds must be cleared: a 20% change of 3 ms is
 * scheduler noise, and a 30 ms change of 3 seconds is nothing.
 */
export function compareToBaseline(current, baseline, options = {}) {
  const noise = { ...DEFAULT_NOISE, ...(options.noise ?? {}) };
  const baselineById = new Map((baseline?.results ?? []).map((result) => [result.id, result]));
  const changes = [];
  for (const result of current?.results ?? []) {
    const previous = baselineById.get(result.id);
    if (!previous || !Number.isFinite(previous.value) || !Number.isFinite(result.value)) {
      changes.push({ id: result.id, kind: "new", value: result.value, previous: previous?.value ?? null, delta: null, ratio: null });
      continue;
    }
    const delta = result.value - previous.value;
    const ratio = previous.value === 0 ? null : delta / previous.value;
    const absoluteThreshold = noise.absolute[result.unit] ?? 0;
    const significant = Math.abs(delta) >= absoluteThreshold && ratio !== null && Math.abs(ratio) >= noise.ratio;
    changes.push({
      id: result.id,
      kind: !significant ? "unchanged" : delta > 0 ? "regression" : "improvement",
      value: result.value,
      previous: previous.value,
      delta: round(delta),
      ratio: ratio === null ? null : round(ratio),
      unit: result.unit,
    });
  }
  const missing = [...baselineById.keys()].filter((id) => !(current?.results ?? []).some((result) => result.id === id));
  const regressions = changes.filter((change) => change.kind === "regression");
  return {
    changes: changes.sort((left, right) => left.id.localeCompare(right.id)),
    regressions: regressions.map((change) => change.id),
    improvements: changes.filter((change) => change.kind === "improvement").map((change) => change.id),
    // A metric that stopped being measured is not an improvement.
    stoppedMeasuring: missing,
    clean: regressions.length === 0 && missing.length === 0,
    summary: regressions.length
      ? `${regressions.length} regression(s): ${regressions.map((change) => `${change.id} ${change.previous} → ${change.value} ${change.unit} (${Math.round(change.ratio * 100)}%)`).join("; ")}`
      : missing.length ? `No regressions, but ${missing.length} metric(s) are no longer measured: ${missing.join(", ")}.` : "No regressions.",
  };
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Watch resident memory while something runs.
 *
 * The number that matters is the high-water mark, not the value at the end: by
 * the time a phase finishes, whatever nearly exhausted the machine has usually
 * been collected. Sampling on a timer is approximate, and says so — `samples`
 * is reported so a peak drawn from three readings is not mistaken for a
 * continuous trace.
 */
export function watchMemory({ intervalMs = 25, now = () => process.memoryUsage() } = {}) {
  let peakRss = 0;
  let peakHeap = 0;
  let samples = 0;
  const take = () => {
    const usage = now();
    peakRss = Math.max(peakRss, usage.rss ?? 0);
    peakHeap = Math.max(peakHeap, usage.heapUsed ?? 0);
    samples += 1;
  };
  take();
  const timer = setInterval(take, intervalMs);
  // Never hold the process open for a measurement.
  timer.unref?.();
  return {
    sample: take,
    /** The high-water mark so far, for a guard that has to decide mid-run. */
    peak: () => ({ peakRss, peakHeap, samples }),
    stop() {
      clearInterval(timer);
      take();
      return { peakRss, peakHeap, samples, intervalMs };
    },
  };
}

/**
 * What an indexer should do when memory gets tight.
 *
 * Measured behaviour on a real repository: peak resident memory during analysis
 * is roughly four times what remains after it, because most of it is the
 * parser's WebAssembly arena plus uncollected garbage. So the guard has two
 * rungs rather than one switch. Crossing the soft threshold *narrows
 * concurrency*, which lowers the high-water mark without changing a single
 * result; crossing the hard threshold *stops using tree-sitter*, which does
 * change results — the regex indexer finds fewer symbols and no call edges —
 * and is therefore a last resort that must be reported rather than silently
 * applied.
 */
export function memoryPressureAction(peakRss, { softLimit, hardLimit }) {
  if (Number.isFinite(hardLimit) && peakRss >= hardLimit) {
    return { action: "degrade-indexer", reason: `Peak resident memory ${Math.round(peakRss / 1e6)} MB reached the hard limit of ${Math.round(hardLimit / 1e6)} MB; the remaining files are indexed with the regex indexer, which finds fewer symbols and no call edges.` };
  }
  if (Number.isFinite(softLimit) && peakRss >= softLimit) {
    return { action: "narrow-concurrency", reason: `Peak resident memory ${Math.round(peakRss / 1e6)} MB passed the soft limit of ${Math.round(softLimit / 1e6)} MB; analysis concurrency was narrowed, which lowers the high-water mark without changing any result.` };
  }
  return { action: "none", reason: null };
}

/** One line per budget, for a log a human will actually read. */
export function describeBudgets(report) {
  return report.results.map((result) => `${result.verdict.toUpperCase().padEnd(18)} ${result.id} — ${result.detail}`).join("\n");
}
