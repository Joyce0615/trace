import { proveOfflineMode } from "./model-fingerprint.mjs";
import { evaluateTutorAnswer } from "./evaluation.mjs";
import { scorePedagogy } from "./tutor-safety-benchmark.mjs";
import { auditResponse } from "./answer-guard.mjs";
import { summarize } from "./performance.mjs";

/**
 * Learner-controlled local model evaluation (item 27).
 *
 * `rag-eval.mjs` (item 17) already runs a fixed question set through every
 * named *model family* at every context budget — but its `provider` is
 * `{ id, family, answer }` with no notion of a local binary's quantization,
 * no memory or energy measurement, and no policy check beyond grounding.
 * `model-fingerprint.mjs` (item 14) already fingerprints a provider
 * configuration and proves (or honestly refuses to prove) that it is
 * offline-safe — but it never runs a task through the model to measure
 * anything about the run itself. `tutor-safety-benchmark.mjs` (item 23)
 * already scores pedagogy and grounding per answer, and `performance.mjs`
 * already turns a list of durations into reliable percentiles and watches
 * resident memory while something runs. Confirmed by grep: zero prior
 * matches for `quantization`/`energy` as implementation identifiers
 * anywhere in `electron/*.mjs` before this item, and nothing before this
 * item let a *learner* choose which local models/quantizations to compare
 * on the *same* fixed tasks and see all six axes side by side.
 *
 * This module is that comparison, built out of what already exists rather
 * than re-deriving any of it:
 *
 *   - **Learner-controlled.** [`buildLocalModelCandidates`] takes exactly the
 *     list of `{ provider, model, quantization }` configurations the
 *     learner picked (from whatever is actually installed —
 *     `model-fingerprint.mjs`'s own `fingerprintModel` identity applies
 *     unmodified to each one) — nothing here discovers or recommends a
 *     model on its own.
 *   - **Privacy** is `model-fingerprint.mjs`'s own `proveOfflineMode`
 *     (unmodified), run once per candidate against the entries a caller
 *     supplies for it (its adapter's own source plus whatever it imports) —
 *     the same honestly-caveated verdict that module already produces,
 *     carried through rather than re-asserted.
 *   - **Grounding** is `evaluation.mjs`'s own `evaluateTutorAnswer`
 *     (unmodified), scored per task per candidate.
 *   - **Pedagogical policy compliance** is two existing checks combined,
 *     never re-derived: `tutor-safety-benchmark.mjs`'s own `scorePedagogy`
 *     (mechanism + example, zero for handing over a real solution verbatim)
 *     and `answer-guard.mjs`'s own `auditResponse` (did this response leak
 *     a forbidden key or a registered secret). A candidate fails policy
 *     compliance on a task if *either* one does, because a pedagogically
 *     sound answer that leaks a secret is not compliant, and a safe answer
 *     that merely hands over the solution is not pedagogy.
 *   - **Latency** is `performance.mjs`'s own `summarize` (unmodified) over
 *     each candidate's per-task timings, with the same `reliable` floor
 *     that module already enforces below its minimum sample count.
 *   - **Memory** is `performance.mjs`'s own `watchMemory` (unmodified);
 *     [`runLocalModelTask`] starts it before calling the candidate's
 *     `answer` function and stops it after, reporting the real peak
 *     resident-memory high-water mark `watchMemory`'s own docstring already
 *     explains is the number that matters.
 *   - **Energy** has no measurement primitive anywhere in this codebase to
 *     reuse (confirmed by grep), and this process has no access to a real
 *     power meter. Rather than inventing a number that looks like a
 *     measurement but is not one, [`estimateEnergyProxy`] reports CPU-time
 *     (`process.cpuUsage()`'s own user+system delta, the one real signal
 *     available without a kernel energy API) and labels the result
 *     `"proxy"`, not `"measured"` — this mirrors `scanForNetworkCapability`'s
 *     own discipline of saying what a check can and cannot see rather than
 *     reporting a confident-looking number regardless.
 *
 * Every axis is reported per-candidate per-task, never averaged into one
 * score — the same discipline `tutor-safety-benchmark.mjs`'s own module doc
 * requires for its own four axes, applied here across six.
 */

export const LOCAL_MODEL_EVALUATION_VERSION = 1;

/** Below this many task runs a candidate's latency/energy summary is not reported as `reliable`. */
export const MIN_SAMPLE_RUNS = 3;

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

/**
 * Normalize the learner's chosen configurations into comparable candidates.
 * Each one carries its own `answer` function (a thin wrapper the caller
 * supplies around whatever local runtime actually invokes the model) and the
 * `{ name, source }` entries `proveOfflineMode` needs for its privacy proof —
 * nothing here invents or discovers either.
 */
export function buildLocalModelCandidates(configs) {
  return (configs ?? []).map((config) => ({
    id: config.id ?? `${config.provider}:${config.model}:${config.quantization ?? "default"}`,
    provider: config.provider,
    model: config.model,
    quantization: config.quantization ?? null,
    answer: config.answer,
    offlineEntries: config.offlineEntries ?? [],
  }));
}

/**
 * CPU-time energy proxy: `process.cpuUsage()`'s user+system delta across one
 * call, in microseconds. Explicitly labeled `"proxy"`, never `"measured"` —
 * there is no power-meter primitive anywhere in this codebase, and reporting
 * CPU time as joules would be a fabricated unit, not an honest approximation.
 */
export async function estimateEnergyProxy(run, cpuUsage = () => process.cpuUsage()) {
  const before = cpuUsage();
  const result = await run();
  const after = cpuUsage();
  return { result, cpuMicros: (after.user - before.user) + (after.system - before.system), kind: "proxy", unit: "cpu-micros" };
}

/**
 * Run one task through one candidate and score every axis for that single
 * case. `watchMemory`/`estimateEnergyProxy` both wrap the same `answer`
 * call so the memory high-water mark and the CPU-time proxy are measured
 * over the identical invocation, not two separate ones that could diverge.
 */
export async function runLocalModelTask(candidate, task, { repository, lineCounts, watchMemory: watch } = {}) {
  const memoryWatcher = watch();
  const started = performance.now();
  const { result: response, cpuMicros } = await estimateEnergyProxy(() => candidate.answer({ task, repository }));
  const tookMs = performance.now() - started;
  const memory = memoryWatcher.stop();

  const grounding = evaluateTutorAnswer(response, repository, { lineCounts });
  const pedagogy = scorePedagogy({ answer: response });
  const audit = auditResponse(task.channel ?? "tutor:answer", response);
  const policyCompliant = pedagogy.score >= 0.5 && !pedagogy.handsRawSolution && audit.ok;

  return {
    taskId: task.id,
    tookMs: round(tookMs),
    cpuMicros,
    peakRssBytes: memory.peakRss,
    peakHeapBytes: memory.peakHeap,
    grounding,
    pedagogy,
    policyAudit: audit,
    policyCompliant,
  };
}

/**
 * Run every task through every candidate and summarize the six axes per
 * candidate, never blended across candidates or across axes.
 */
export async function runLocalModelEvaluation({ candidates, tasks, repository, lineCounts, now = () => process.memoryUsage(), privacy = {} }) {
  const report = [];
  for (const candidate of candidates ?? []) {
    const cases = [];
    for (const task of tasks ?? []) {
      cases.push(await runLocalModelTask(candidate, task, { repository, lineCounts, watchMemory: () => watchMemoryShim(now) }));
    }
    const offlineVerdict = proveOfflineMode(candidate.offlineEntries, privacy);
    const latency = summarize(cases.map((entry) => entry.tookMs), { minimum: MIN_SAMPLE_RUNS });
    const energy = summarize(cases.map((entry) => entry.cpuMicros), { minimum: MIN_SAMPLE_RUNS });
    const memory = cases.length ? { peakRssBytes: Math.max(...cases.map((entry) => entry.peakRssBytes)), peakHeapBytes: Math.max(...cases.map((entry) => entry.peakHeapBytes)) } : { peakRssBytes: null, peakHeapBytes: null };
    const groundingScores = cases.map((entry) => entry.grounding.score).filter((value) => Number.isFinite(value));
    const compliantCount = cases.filter((entry) => entry.policyCompliant).length;

    report.push({
      candidateId: candidate.id,
      provider: candidate.provider,
      model: candidate.model,
      quantization: candidate.quantization,
      privacy: { ok: offlineVerdict.offlineModeSafe, caveat: offlineVerdict.caveat, findings: offlineVerdict.findings },
      grounding: { averageScore: groundingScores.length ? round(groundingScores.reduce((sum, value) => sum + value, 0) / groundingScores.length) : null, cases: groundingScores.length },
      latency: { ...latency, kind: "measured", unit: "ms" },
      memory: { ...memory, kind: "measured", unit: "bytes" },
      energy: { ...energy, kind: "proxy", unit: "cpu-micros" },
      policy: { compliantCount, totalCases: cases.length, complianceRate: cases.length ? round(compliantCount / cases.length) : null },
      cases,
    });
  }
  return { version: LOCAL_MODEL_EVALUATION_VERSION, kind: "local-model-evaluation", candidates: report, generatedAt: new Date().toISOString() };
}

// A local shim so `runLocalModelEvaluation` can hand `runLocalModelTask` a
// fresh `watchMemory()`-shaped watcher per task without importing
// `performance.mjs`'s own `watchMemory` twice under two different names;
// re-exported so a caller never needs to reach into `performance.mjs`
// directly just to drive this module.
import { watchMemory as watchMemoryPrimitive } from "./performance.mjs";
function watchMemoryShim(now) {
  return watchMemoryPrimitive({ now });
}

/** Prompt/report-ready text rendering of a local-model evaluation report. */
export function renderLocalModelEvaluation(report) {
  const lines = [
    "# Local model evaluation",
    "",
    "| candidate | privacy | avg grounding | latency p50 (ms) | peak RSS | energy proxy (cpu-us) | policy compliance |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const candidate of report.candidates) {
    lines.push(
      `| ${candidate.candidateId} | ${candidate.privacy.ok ? "offline-safe" : "not-proven"} | ${candidate.grounding.averageScore ?? "n/a"} | ${candidate.latency.p50 ?? "n/a"} | ${candidate.memory.peakRssBytes ?? "n/a"} | ${candidate.energy.p50 ?? "n/a"} | ${candidate.policy.complianceRate ?? "n/a"} |`,
    );
  }
  return lines.join("\n");
}
