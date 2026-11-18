import { appendEvent } from "./activity-log.mjs";
import { DEFAULT_COGNITIVE_BUDGET } from "./progressive-discovery.mjs";
import { CONTEXT_PACK_BUDGETS } from "./context-engine.mjs";
import { DEFAULT_SCHEDULER } from "./spaced-repetition.mjs";

/**
 * Adaptive cognitive-load regulation.
 *
 * Cognitive Load Theory separates three loads that a single "this felt hard"
 * signal cannot tell apart:
 *
 *   - **intrinsic** load — effort inherent to the task's own structure (how
 *     many files a navigation answer genuinely spans, how many call hops a
 *     chain crosses, how many checkpoints a trace has). This is read, never
 *     re-derived, from the real structures `localization.mjs`'s own
 *     `buildLocalizationExercise`, `call-chain.mjs`'s own `buildCallChains`,
 *     and `program-state-tracing.mjs`'s own `buildStateTraceTask` already
 *     produce.
 *   - **extraneous** load — effort spent fighting the *presentation*, not
 *     the problem: reading noise that was not relevant
 *     (`localization.mjs`'s own `fileEfficiency`/`byteEfficiency`), leaning
 *     on hints more than the trend would predict
 *     (`analytics.mjs`'s own `hintAnalytics`), or mistiming tracing
 *     annotations (`program-state-tracing.mjs`'s own `gradeStateTrace`
 *     `omitted`/`swapped` counts).
 *   - **germane** load — effort that is actually building a schema:
 *     targeted revision (`process-trace-assessment.mjs`'s own
 *     `scoreRevisionStep`'s `targetedFix`), unassisted success
 *     (`hintAnalytics`'s own `successWithoutHints`), and correct tracing
 *     (`gradeStateTrace`'s own `correct`/`checkpointCount`).
 *
 * The item's own text draws a hard line this module enforces structurally,
 * not just by convention: **intrinsic load is estimated and reported, but is
 * never an input to any adjustment.** Every `regulate*` function below is a
 * pure function of `extraneous`/`germane` only — it does not even accept an
 * `intrinsic` argument — so a task that is genuinely harder (more gold
 * files, more checkpoints) is never made structurally easier by this module.
 * What *does* change under load is purely presentational/pacing: how much of
 * the repository is disclosed per expansion, when a hint becomes available
 * to request (never what the hint costs or reveals — `answer-guard.mjs`'s
 * own ladder and `MAX_HINT_PENALTY` are untouched), how many tracing
 * checkpoints are shown in one batch (the full checkpoint set set by
 * `buildStateTraceTask` is still eventually required), and how many new
 * reviews are scheduled per day (`spaced-repetition.mjs`'s own
 * `DEFAULT_SCHEDULER.dailyLimit`).
 */

export const COGNITIVE_LOAD_REGULATION_VERSION = 1;

/** Verdicts/adjustments only ever trigger above/below these bands. */
export const HIGH_LOAD_THRESHOLD = 0.6;
export const LOW_LOAD_THRESHOLD = 0.3;

/** Hint reliance above this many hints per attempt reads as maximal load. */
const HINT_RELIANCE_CAP = 3;

const DEFAULT_OFFER_AFTER_ATTEMPTS = 2;
const MIN_OFFER_AFTER_ATTEMPTS = 1;
const MAX_OFFER_AFTER_ATTEMPTS = 3;

const PACING_FLOOR = 3;
const PACING_CEILING = DEFAULT_SCHEDULER.dailyLimit * 2;

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

function average(values) {
  const usable = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (!usable.length) return null;
  return round(usable.reduce((sum, value) => sum + value, 0) / usable.length);
}

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

/**
 * Intrinsic load from real task structure. `localization` is a real
 * `buildLocalizationExercise` exercise (or `scoreLocalization` result, both
 * carry `goldFiles`); `chain` is one real `buildCallChains` entry (carries
 * `crossFileHops`); `trace` is a real `buildStateTraceTask` task (carries
 * `checkpoints`). Any of the three may be omitted; the estimate averages
 * whichever structural signals are actually present.
 */
export function estimateIntrinsicLoad({ localization, chain, trace } = {}) {
  const goldFileCount = Array.isArray(localization?.goldFiles) ? localization.goldFiles.length : null;
  const crossFileHops = typeof chain?.crossFileHops === "number" ? chain.crossFileHops : null;
  const checkpointCount = Array.isArray(trace?.checkpoints) ? trace.checkpoints.length : null;

  const components = {
    goldFileCount,
    crossFileHops,
    checkpointCount,
    // Normalized against a generous bound for each signal's own typical
    // range, never against the other two signals.
    goldFileLoad: goldFileCount === null ? null : clamp(goldFileCount / 6, 0, 1),
    crossFileHopLoad: crossFileHops === null ? null : clamp(crossFileHops / 4, 0, 1),
    checkpointLoad: checkpointCount === null ? null : clamp(checkpointCount / 12, 0, 1),
  };

  const value = average([components.goldFileLoad, components.crossFileHopLoad, components.checkpointLoad]);
  return {
    version: COGNITIVE_LOAD_REGULATION_VERSION,
    kind: "intrinsic",
    value,
    reason: value === null ? "no-structural-evidence" : null,
    components,
  };
}

/**
 * Extraneous load from observed behavior that reflects friction with the
 * *presentation*, not the problem: `localizationScore` is a real
 * `scoreLocalization` result (`fileEfficiency`/`byteEfficiency`),
 * `hintAnalytics` is a real `analytics.mjs` `hintAnalytics` result
 * (`hintsPerAttempt`), `tracingGrade` is a real `gradeStateTrace` result
 * (`omitted`/`swapped`/`checkpointCount`).
 */
export function estimateExtraneousLoad({ localizationScore, hintAnalytics: hints, tracingGrade } = {}) {
  const navigationFriction = localizationScore
    ? clamp(1 - ((localizationScore.fileEfficiency ?? 0) + (localizationScore.byteEfficiency ?? 0)) / 2, 0, 1)
    : null;
  const hintReliance = typeof hints?.hintsPerAttempt === "number"
    ? clamp(hints.hintsPerAttempt / HINT_RELIANCE_CAP, 0, 1)
    : null;
  const tracingSlips = tracingGrade && tracingGrade.checkpointCount > 0
    ? clamp(((tracingGrade.omitted ?? 0) + (tracingGrade.swapped ?? 0)) / tracingGrade.checkpointCount, 0, 1)
    : null;

  const value = average([navigationFriction, hintReliance, tracingSlips]);
  return {
    version: COGNITIVE_LOAD_REGULATION_VERSION,
    kind: "extraneous",
    value,
    reason: value === null ? "no-behavioral-evidence" : null,
    components: { navigationFriction, hintReliance, tracingSlips },
  };
}

/**
 * Germane load from observed behavior that reflects productive engagement
 * with the material's own structure: `revision` is a real
 * `process-trace-assessment.mjs` `scoreRevisionStep` result (`targetedFix`),
 * `hintAnalytics` is a real `hintAnalytics` result
 * (`successWithoutHints.value`), `tracingGrade` is a real `gradeStateTrace`
 * result (`correct`/`checkpointCount`).
 */
export function estimateGermaneLoad({ revision, hintAnalytics: hints, tracingGrade } = {}) {
  const revisionEffectiveness = revision?.targetedFix && revision.targetedFix.attempted > 0
    ? clamp(revision.targetedFix.fixed / revision.targetedFix.attempted, 0, 1)
    : null;
  const unassistedSuccess = typeof hints?.successWithoutHints?.value === "number"
    ? hints.successWithoutHints.value
    : null;
  const tracingMastery = tracingGrade && tracingGrade.checkpointCount > 0
    ? clamp((tracingGrade.correct ?? 0) / tracingGrade.checkpointCount, 0, 1)
    : null;

  const value = average([revisionEffectiveness, unassistedSuccess, tracingMastery]);
  return {
    version: COGNITIVE_LOAD_REGULATION_VERSION,
    kind: "germane",
    value,
    reason: value === null ? "no-behavioral-evidence" : null,
    components: { revisionEffectiveness, unassistedSuccess, tracingMastery },
  };
}

/**
 * A verdict over extraneous/germane load only. Deliberately takes no
 * `intrinsic` argument at all: a verdict (and everything derived from it
 * below) must be answerable without ever looking at how hard the task
 * structurally is.
 */
export function classifyLoad({ extraneous, germane } = {}) {
  if (typeof extraneous === "number" && extraneous >= HIGH_LOAD_THRESHOLD) return "extraneous-overload";
  if (typeof germane === "number" && germane >= HIGH_LOAD_THRESHOLD
    && !(typeof extraneous === "number" && extraneous >= HIGH_LOAD_THRESHOLD)) return "productive-engagement";
  if (typeof extraneous === "number" && extraneous <= LOW_LOAD_THRESHOLD
    && (germane === null || typeof germane !== "number" || germane <= LOW_LOAD_THRESHOLD)) return "underengaged";
  return "balanced";
}

// ---------------------------------------------------------------------------
// Regulation: repository disclosure, hints, tracing state, pacing
// ---------------------------------------------------------------------------

/**
 * Adjust `progressive-discovery.mjs`'s own two independent budgets
 * (`cognitiveBudget`/`contextTokenBudget`, both reused unmodified by name).
 * Under high extraneous load, both shrink toward a floor; under low
 * extraneous load with high germane load, both relax back toward their
 * defaults — never beyond them, so disclosure never becomes more generous
 * than the module's own stated default pacing.
 */
export function regulateDisclosure(current = {}, { extraneous, germane } = {}) {
  let cognitiveBudget = current.cognitiveBudget ?? DEFAULT_COGNITIVE_BUDGET;
  let contextTokenBudget = current.contextTokenBudget ?? CONTEXT_PACK_BUDGETS.balanced;
  let reason = "steady";

  if (typeof extraneous === "number" && extraneous >= HIGH_LOAD_THRESHOLD) {
    cognitiveBudget = Math.max(1, Math.floor(cognitiveBudget / 2));
    contextTokenBudget = Math.min(contextTokenBudget, CONTEXT_PACK_BUDGETS.lean);
    reason = "extraneous-load-high";
  } else if (typeof extraneous === "number" && extraneous <= LOW_LOAD_THRESHOLD
    && typeof germane === "number" && germane >= HIGH_LOAD_THRESHOLD) {
    cognitiveBudget = Math.min(DEFAULT_COGNITIVE_BUDGET, cognitiveBudget);
    contextTokenBudget = Math.min(CONTEXT_PACK_BUDGETS.balanced, Math.max(contextTokenBudget, CONTEXT_PACK_BUDGETS.balanced));
    reason = "productive-engagement";
  }

  return {
    cognitiveBudget,
    contextTokenBudget,
    changed: cognitiveBudget !== (current.cognitiveBudget ?? DEFAULT_COGNITIVE_BUDGET)
      || contextTokenBudget !== (current.contextTokenBudget ?? CONTEXT_PACK_BUDGETS.balanced),
    reason,
  };
}

/**
 * Adjust only *when* a hint becomes available to request, never what the
 * hint says or costs. `answer-guard.mjs`'s own `buildScaffold`/
 * `nextHintRung`/`scaffoldPenalty` are untouched by this module; this only
 * returns a recommended attempt count after which a caller should let a
 * learner ask for the first rung.
 */
export function regulateHintAvailability(current = {}, { extraneous, germane } = {}) {
  let offerAfterAttempts = current.offerAfterAttempts ?? DEFAULT_OFFER_AFTER_ATTEMPTS;
  let reason = "steady";

  if (typeof extraneous === "number" && extraneous >= HIGH_LOAD_THRESHOLD) {
    offerAfterAttempts = MIN_OFFER_AFTER_ATTEMPTS;
    reason = "extraneous-load-high";
  } else if (typeof extraneous === "number" && extraneous <= LOW_LOAD_THRESHOLD
    && typeof germane === "number" && germane >= HIGH_LOAD_THRESHOLD) {
    offerAfterAttempts = MAX_OFFER_AFTER_ATTEMPTS;
    reason = "productive-engagement";
  }

  offerAfterAttempts = clamp(offerAfterAttempts, MIN_OFFER_AFTER_ATTEMPTS, MAX_OFFER_AFTER_ATTEMPTS);
  return {
    offerAfterAttempts,
    changed: offerAfterAttempts !== (current.offerAfterAttempts ?? DEFAULT_OFFER_AFTER_ATTEMPTS),
    reason,
  };
}

/**
 * Adjust how many of a trace's real checkpoints (`program-state-tracing.mjs`'s
 * own `buildStateCheckpoints`/`buildStateTraceTask`, unmodified) are
 * presented in one batch. `checkpointCount` is the real, full count the task
 * actually has — this function never changes it, only `chunkLimit`, the
 * recommended slice size a caller should annotate before seeing the next
 * slice. Under high extraneous load the trace is chunked smaller; the full
 * set is still eventually required, so target difficulty (every real
 * checkpoint must still be traced correctly) is unchanged.
 */
export function regulateTracingState(checkpointCount, current = {}, { extraneous, germane } = {}) {
  const total = Math.max(0, Number(checkpointCount) || 0);
  let chunkLimit = current.chunkLimit ?? total;
  let reason = "steady";

  if (typeof extraneous === "number" && extraneous >= HIGH_LOAD_THRESHOLD) {
    chunkLimit = total > 0 ? Math.max(1, Math.ceil(total / 2)) : 0;
    reason = "extraneous-load-high";
  } else if (typeof extraneous === "number" && extraneous <= LOW_LOAD_THRESHOLD
    && typeof germane === "number" && germane >= HIGH_LOAD_THRESHOLD) {
    chunkLimit = total;
    reason = "productive-engagement";
  }

  return {
    chunkLimit,
    totalCheckpoints: total,
    changed: chunkLimit !== (current.chunkLimit ?? total),
    reason,
  };
}

/**
 * Adjust `spaced-repetition.mjs`'s own `DEFAULT_SCHEDULER.dailyLimit`
 * (reused by name, unmodified default), never the retention target, the
 * difficulty floor/ceiling, or any grading rule — only how many new reviews
 * are scheduled per day. Bounded so pacing can neither starve a learner
 * below a usable floor nor double-load them beyond a documented ceiling.
 */
export function regulatePacing(current = {}, { extraneous, germane } = {}) {
  let dailyLimit = current.dailyLimit ?? DEFAULT_SCHEDULER.dailyLimit;
  let reason = "steady";

  if (typeof extraneous === "number" && extraneous >= HIGH_LOAD_THRESHOLD) {
    dailyLimit = Math.max(PACING_FLOOR, Math.round(dailyLimit / 2));
    reason = "extraneous-load-high";
  } else if (typeof extraneous === "number" && extraneous <= LOW_LOAD_THRESHOLD
    && typeof germane === "number" && germane >= HIGH_LOAD_THRESHOLD) {
    dailyLimit = Math.min(PACING_CEILING, Math.round(dailyLimit * 1.25));
    reason = "productive-engagement";
  }

  return {
    dailyLimit,
    changed: dailyLimit !== (current.dailyLimit ?? DEFAULT_SCHEDULER.dailyLimit),
    reason,
  };
}

/**
 * The combined report: estimate all three loads from real structure/behavior,
 * classify, and adjust all four knobs. `intrinsic` is reported for a human
 * reader (and for `tracingState`'s own checkpoint-count default) but is
 * never passed into `classifyLoad` or any `regulate*` call — those four
 * calls below only ever receive `extraneous`/`germane`, which is what makes
 * "never reduces target difficulty" an enforced property of this function's
 * own wiring rather than a claim about it.
 */
export function regulateCognitiveLoad({ structure = {}, behavior = {}, current = {} } = {}) {
  const intrinsic = estimateIntrinsicLoad(structure);
  const extraneous = estimateExtraneousLoad(behavior);
  const germane = estimateGermaneLoad(behavior);
  const verdict = classifyLoad({ extraneous: extraneous.value, germane: germane.value });
  const loadInputs = { extraneous: extraneous.value, germane: germane.value };

  const disclosure = regulateDisclosure(current.disclosure, loadInputs);
  const hints = regulateHintAvailability(current.hints, loadInputs);
  const tracingState = regulateTracingState(
    current.checkpointCount ?? intrinsic.components.checkpointCount ?? 0,
    current.tracingState,
    loadInputs,
  );
  const pacing = regulatePacing(current.pacing, loadInputs);

  return {
    version: COGNITIVE_LOAD_REGULATION_VERSION,
    intrinsic,
    extraneous,
    germane,
    verdict,
    disclosure,
    hints,
    tracingState,
    pacing,
  };
}

/**
 * Preserve one regulation decision as learning evidence, through
 * `activity-log.mjs`'s own `appendEvent` (unmodified) — the same
 * append-only, main-process-only log every other graded/measured activity in
 * this app already writes to.
 */
export function recordLoadRegulation(directory, repositoryId, report) {
  return appendEvent(directory, repositoryId, {
    kind: "cognitive-load-regulation",
    intrinsic: report.intrinsic.value,
    extraneous: report.extraneous.value,
    germane: report.germane.value,
    verdict: report.verdict,
    disclosureCognitiveBudget: report.disclosure.cognitiveBudget,
    disclosureContextTokenBudget: report.disclosure.contextTokenBudget,
    hintsOfferAfterAttempts: report.hints.offerAfterAttempts,
    tracingChunkLimit: report.tracingState.chunkLimit,
    pacingDailyLimit: report.pacing.dailyLimit,
  });
}
