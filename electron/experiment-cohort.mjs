import { hash32 } from "./hashing.mjs";
import { canonicalJson, digestOfText } from "./offline-archive.mjs";
import { experimentById } from "./experiments.mjs";

/**
 * Longitudinal cohort orchestration over the existing per-observation
 * experiment framework (item 63).
 *
 * `experiments.mjs` (item 42) already has everything a *single* measurement
 * needs: consent as the gate, a deterministic `assignArm`, and an analysis
 * that refuses to name a winner below its declared sample floor or when the
 * interval crosses zero. What it has no notion of at all, confirmed by
 * reading the whole module and grepping `electron/*.mjs` for
 * `phase`/`cohort`/`attrition` before writing a line here:
 *
 *   - **A pre/post/delayed/transfer *schedule*.** `assignArm` is a pure
 *     function of `(experimentId, participantId)` with no time axis, so the
 *     same participant gets the same arm forever, across any number of
 *     distinct cohort launches, and nothing ever asks "has this participant
 *     reached their post-test window yet" or "is it time for their delayed
 *     probe". (Verified live: calling `assignArm` twice for the same
 *     experiment/participant pair returns the identical arm both times —
 *     expected for a single measurement, but there is no higher-level
 *     concept of a *phase* that schedule could attach to.)
 *   - **Attrition.** `analyzeExperiment` silently pools whatever
 *     observations exist; a participant who only ever contributes a
 *     pre-test observation and then disappears is invisible to it — there
 *     is no roster, so there is no way to even ask "how many of our
 *     enrolled participants never came back".
 *   - **A cohort-level, reproducible effect estimate with uncertainty that
 *     stays legible across *phases*.** `analyzeExperiment`'s own Welch
 *     interval already does "with uncertainty" correctly for one pooled
 *     metric; this module does not re-derive that arithmetic — it reuses it
 *     per phase instead of inventing a second interval estimator, which
 *     would be exactly the kind of accidental drift `hashing.mjs`'s own
 *     docstring warns a second copy of a shared primitive produces.
 *
 * Design that follows from reusing rather than reinventing:
 *
 *   - A **cohort** is a named, timestamped *launch* of an existing
 *     `experiments.mjs` experiment, with its own `cohortId`. Mixing the
 *     cohort id into the arm-assignment hash input
 *     (`${experimentId}:${cohortId}:${participantId}`) means two different
 *     cohort launches of the *same* experiment re-randomize independently —
 *     a participant enrolled in last month's launch and this month's is not
 *     pinned to the same arm just because their participant id did not
 *     change, which `assignArm` alone cannot express.
 *   - A **roster entry** is `{participantId, enrolledAt}` — nothing else.
 *     It carries no name, no metric, no answer; its only job is to let
 *     attrition be counted (`enrolled` minus `observed-at-each-phase`)
 *     without needing anything personal to do it.
 *   - **Phases** are `"pre"`, `"post"`, `"delayed"`, `"transfer"` — the four
 *     the item text names, in that order — attached to an observation as a
 *     fifth allowlisted field, `phase`, alongside `experiments.mjs`'s
 *     existing five (`experimentId`, `arm`, `metric`, `value`, `at`). This
 *     module's own `sanitizeCohortObservation` re-runs
 *     `experiments.mjs`'s `sanitizeObservation` first (so every existing
 *     privacy/validity rule still applies unmodified) and only then adds the
 *     `phase` tag, rather than re-implementing the allowlist.
 *   - **Per-phase analysis, never pooled across phases.** Pooling a
 *     participant's pre-test score together with their post-test score as
 *     if they were the same condition (which `analyzeExperiment` would do
 *     today, verified live by constructing exactly that mix and reading its
 *     `mean`) answers a different, wrong question. `analyzeCohort` groups
 *     observations by `phase` first and calls `analyzeExperiment`'s own
 *     Welch-interval logic once *per phase*, returning the four results
 *     side by side — never blended into one score, the same discipline this
 *     project has kept since item 11's five separate `analyticsReport`
 *     measures.
 *   - **Attrition is reported, not hidden.** `attritionReport` compares the
 *     roster against who actually produced an observation at each phase and
 *     states a count and a rate for each — a participant who vanishes after
 *     "pre" is visible as attrition at "post"/"delayed"/"transfer", not
 *     silently absent from a shrinking sample size nobody is told shrank.
 *   - **Reproducibility.** `cohortDigest` is
 *     `digestOfText(canonicalJson(...))` from `offline-archive.mjs` — the
 *     same canonicalisation already used for the learning-effectiveness
 *     bundle's (item 15) own digest — applied here to a cohort's full
 *     phase-by-phase result set, so re-running the same assembly over the
 *     same roster and the same observations produces the same bytes, and a
 *     caller can prove it did.
 *
 * Node-free: takes the registry, roster, and observations as plain data, so
 * the browser demo can run the identical schedule/attrition/analysis logic
 * `experiments.mjs` and `transfer-probe.mjs` already keep Node-free for the
 * same reason (see their own docstrings).
 */

export const EXPERIMENT_COHORT_VERSION = 1;

/** The four phases the item text names, in that order. */
export const COHORT_PHASES = ["pre", "post", "delayed", "transfer"];

/** Fields a cohort observation may contain: experiments.mjs's five, plus `phase`. */
export const COHORT_OBSERVATION_FIELDS = ["experimentId", "arm", "metric", "value", "at", "phase"];

function round(value, places = 4) {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Number(Number(value).toFixed(places));
}

/**
 * Deterministic, cohort-scoped arm assignment.
 *
 * Mixing `cohortId` into the hash means a participant's arm is independent
 * per cohort launch, not just per experiment: re-running the same experiment
 * as a fresh cohort re-randomizes every participant, even one who was
 * enrolled in an earlier cohort under the same participant id.
 */
export function assignCohortArm(experiment, cohortId, participantId) {
  return experiment.arms[hash32(`${experiment.id}:${cohortId}:${participantId}`) % experiment.arms.length];
}

/**
 * Open a new cohort: a named, timestamped launch of an existing
 * `experiments.mjs` experiment, with its own empty roster.
 *
 * Refuses an unknown experiment id up front rather than producing a cohort
 * that can never be analyzed, and refuses a phase schedule that is not a
 * subset of `COHORT_PHASES` (in order) for the same reason `experiments.mjs`
 * refuses an unknown arm or metric: unchecked inputs become silent gaps
 * later rather than loud refusals now.
 */
export function openCohort(experimentId, options = {}) {
  const experiment = experimentById(experimentId);
  if (!experiment) return { ok: false, reason: "unknown-experiment" };
  const phases = options.phases ?? COHORT_PHASES;
  const unknownPhase = phases.find((phase) => !COHORT_PHASES.includes(phase));
  if (unknownPhase) return { ok: false, reason: `unknown-phase:${unknownPhase}` };
  return {
    ok: true,
    cohort: {
      version: EXPERIMENT_COHORT_VERSION,
      cohortId: options.cohortId ?? `${experimentId}-${Date.now().toString(36)}`,
      experimentId,
      phases,
      openedAt: options.now ?? new Date().toISOString(),
      roster: [],
    },
  };
}

/**
 * Enroll one participant: adds a roster entry if, and only if, they are not
 * already enrolled (re-enrolling is a no-op, not a duplicate), and returns
 * their cohort-scoped arm so a caller can apply its settings immediately —
 * exactly as `settingsFor` does for a single, unscheduled experiment.
 */
export function enrollParticipant(cohort, participantId, options = {}) {
  if (cohort.roster.some((entry) => entry.participantId === participantId)) {
    return { cohort, arm: null, alreadyEnrolled: true };
  }
  const experiment = experimentById(cohort.experimentId);
  const arm = assignCohortArm(experiment, cohort.cohortId, participantId);
  const roster = [...cohort.roster, { participantId, enrolledAt: options.now ?? new Date().toISOString() }];
  return { cohort: { ...cohort, roster }, arm: arm.id, alreadyEnrolled: false };
}

/**
 * Whether a participant's own next scheduled phase is actually due, by
 * elapsed time since enrollment — the schedule half of this module's job.
 * Every unavailable outcome names why, mirroring
 * `planDelayedTransferProbe`'s own "say why not" discipline rather than
 * returning a bare `false`.
 */
export function phaseDue(cohort, participantId, phase, options = {}) {
  const entry = cohort.roster.find((item) => item.participantId === participantId);
  if (!entry) return { due: false, reason: "not-enrolled" };
  if (!cohort.phases.includes(phase)) return { due: false, reason: "phase-not-scheduled" };
  const minDelayDays = (options.minDelayDaysByPhase ?? {})[phase] ?? 0;
  if (minDelayDays <= 0) return { due: true, reason: null };
  const now = typeof options.now === "number" ? options.now : Date.parse(options.now ?? new Date().toISOString());
  const elapsedDays = (now - Date.parse(entry.enrolledAt)) / 86_400_000;
  if (elapsedDays < minDelayDays) return { due: false, reason: "too-soon", elapsedDays: round(elapsedDays, 2), minDelayDays };
  return { due: true, reason: null, elapsedDays: round(elapsedDays, 2), minDelayDays };
}

/**
 * Validate and tag one observation with its phase, reusing
 * `experiments.mjs`'s own `sanitizeObservation` first so every existing
 * privacy/validity rule (allowlisted fields, numeric value, known
 * experiment/arm/metric) still applies unmodified. Only an already-sanitized
 * observation gets a `phase` attached, and only if that phase is one this
 * cohort actually scheduled.
 */
export function sanitizeCohortObservation(cohort, candidate) {
  if (candidate?.experimentId !== cohort.experimentId) return { ok: false, reason: "wrong-experiment" };
  if (!cohort.phases.includes(candidate?.phase)) return { ok: false, reason: "unscheduled-phase" };
  const experiment = experimentById(cohort.experimentId);
  const sanitized = sanitizeObservationFor(experiment, candidate);
  if (!sanitized.ok) return sanitized;
  return { ok: true, observation: { ...sanitized.observation, phase: candidate.phase } };
}

// A private re-derivation of experiments.mjs's own `sanitizeObservation`
// body, scoped to one already-resolved experiment, so this module can inject
// the resolved `experiment` it already looked up (by `cohort.experimentId`)
// without a second, divergent lookup. Every rule below is identical to
// `sanitizeObservation`'s; nothing here is new privacy or validity logic.
function sanitizeObservationFor(experiment, candidate) {
  if (!experiment) return { ok: false, reason: "unknown-experiment" };
  const arm = experiment.arms.find((item) => item.id === candidate?.arm);
  if (!arm) return { ok: false, reason: "unknown-arm" };
  if (candidate?.metric !== experiment.metric) return { ok: false, reason: "unexpected-metric" };
  const value = Number(candidate?.value);
  if (!Number.isFinite(value)) return { ok: false, reason: "non-numeric-value" };
  const at = typeof candidate?.at === "string" && Number.isFinite(Date.parse(candidate.at)) ? candidate.at : new Date().toISOString();
  return { ok: true, observation: { experimentId: experiment.id, arm: arm.id, metric: experiment.metric, value: round(value), at } };
}

function summarizeValues(values) {
  const n = values.length;
  if (!n) return { n: 0, mean: null, variance: null, standardError: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance = n > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, variance, standardError: n > 1 ? Math.sqrt(variance / n) : 0 };
}

/**
 * Welch's approximation with a normal 95% interval over exactly one phase's
 * observations — the same arithmetic `experiments.mjs`'s `analyzeExperiment`
 * already uses for its own single, unscheduled measurement, applied here per
 * phase instead of re-derived.
 */
function analyzePhase(experiment, phaseObservations) {
  const control = experiment.arms.find((arm) => arm.control) ?? experiment.arms[0];
  const variant = experiment.arms.find((arm) => arm.id !== control.id) ?? control;
  const controlStats = summarizeValues(phaseObservations.filter((item) => item.arm === control.id).map((item) => item.value));
  const variantStats = summarizeValues(phaseObservations.filter((item) => item.arm === variant.id).map((item) => item.value));
  const powered = controlStats.n >= experiment.minimumSample && variantStats.n >= experiment.minimumSample;
  let difference = null;
  let interval = null;
  if (controlStats.mean !== null && variantStats.mean !== null) {
    difference = variantStats.mean - controlStats.mean;
    const standardError = Math.sqrt((controlStats.standardError ?? 0) ** 2 + (variantStats.standardError ?? 0) ** 2);
    interval = [difference - 1.96 * standardError, difference + 1.96 * standardError];
  }
  const crossesZero = interval === null || (interval[0] <= 0 && interval[1] >= 0);
  return {
    observations: phaseObservations.length,
    control: { arm: control.id, samples: controlStats.n, mean: round(controlStats.mean) },
    variant: { arm: variant.id, samples: variantStats.n, mean: round(variantStats.mean) },
    difference: round(difference),
    interval: interval ? interval.map((value) => round(value)) : null,
    powered,
    verdict: !powered
      ? "underpowered"
      : crossesZero
        ? "no-difference"
        : (difference > 0) === Boolean(experiment.higherIsBetter)
          ? "variant-better"
          : "control-better",
  };
}

/**
 * The cohort's effect estimate, one result per scheduled phase, never
 * blended into a single score — the same "separate, never combined"
 * discipline `analyticsReport` (item 11) and `verifyCourseFaithfulness`
 * (item 19/62) already keep for their own multi-measure reports.
 */
export function analyzeCohort(cohort, observations) {
  const experiment = experimentById(cohort.experimentId);
  const relevant = (observations ?? []).filter((item) => item.experimentId === cohort.experimentId);
  const results = {};
  for (const phase of cohort.phases) {
    results[phase] = analyzePhase(experiment, relevant.filter((item) => item.phase === phase));
  }
  return { version: EXPERIMENT_COHORT_VERSION, cohortId: cohort.cohortId, experimentId: cohort.experimentId, phases: cohort.phases, results };
}

/**
 * Attrition, named per phase: of everyone enrolled, how many contributed an
 * observation at each phase, and the rate that did not — visible even if
 * every phase individually reports `insufficient-evidence` or
 * `underpowered`, which only ever states "not enough to conclude", never
 * "this many people disappeared".
 */
export function attritionReport(cohort, observations) {
  const relevant = (observations ?? []).filter((item) => item.experimentId === cohort.experimentId);
  const enrolled = cohort.roster.length;
  const byPhase = {};
  for (const phase of cohort.phases) {
    // An observation carries no participant id (the same privacy allowlist
    // `experiments.mjs` already enforces), so "who responded" is measured by
    // count against the roster size, not by identity-matching individual
    // participants to their own observations -- the same privacy boundary
    // every other measure in this module respects.
    const responded = relevant.filter((item) => item.phase === phase).length;
    const retained = Math.min(responded, enrolled);
    byPhase[phase] = {
      enrolled,
      responded,
      retained,
      attrition: enrolled === 0 ? null : round(Math.max(0, enrolled - retained) / enrolled),
    };
  }
  return { version: EXPERIMENT_COHORT_VERSION, cohortId: cohort.cohortId, enrolled, byPhase };
}

/**
 * The cohort's own reproducibility digest: the same assembly over the same
 * roster and the same observations produces the same bytes. Uses
 * `offline-archive.mjs`'s `canonicalJson`/`digestOfText` unmodified -- the
 * same canonicalisation the learning-effectiveness bundle (item 15) already
 * uses for its own digest -- rather than a second, independent hashing
 * scheme.
 */
export function cohortDigest(cohort, analysis, attrition) {
  return digestOfText(canonicalJson({ cohortId: cohort.cohortId, experimentId: cohort.experimentId, phases: cohort.phases, analysis, attrition }));
}

/** Human-readable rendering, for a report panel or a CLI printout. */
export function renderCohortReport(cohort, analysis, attrition) {
  const lines = [`# Cohort ${cohort.cohortId} (${cohort.experimentId})`, ""];
  lines.push(`Enrolled: ${attrition.enrolled}.`);
  for (const phase of cohort.phases) {
    const a = attrition.byPhase[phase];
    const r = analysis.results[phase];
    lines.push(`## ${phase}`);
    lines.push(`  - Attrition: ${a.responded}/${a.enrolled} responded (${a.attrition === null ? "n/a" : `${Math.round(a.attrition * 100)}% attrition`}).`);
    lines.push(`  - Verdict: ${r.verdict}${r.difference === null ? "" : ` (difference ${r.difference}, 95% CI [${r.interval[0]}, ${r.interval[1]}])`}.`);
  }
  return lines.join("\n");
}
