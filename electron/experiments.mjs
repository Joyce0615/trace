/**
 * Controlled local experiments, with consent as the gate rather than a banner.
 *
 * Trace makes pedagogical choices — how deep a tutor's context should be, how
 * many reviews a day is too many — and it has no evidence for any of them. This
 * module lets those choices be *tested* on the learner's own machine, under
 * three rules that are enforced rather than promised:
 *
 *   1. **No consent, no experiment.** Without a recorded, revocable grant there
 *      is no assignment, no observation, and no analysis: every caller gets the
 *      control arm, which is the behavior the app would have had anyway. Consent
 *      is not assumed from use.
 *   2. **Nothing personal is recordable.** An observation is reduced to
 *      `{experimentId, arm, metric, value, at}` with a numeric value, by an
 *      allowlist. There is no field a path, a code excerpt, or a free-text
 *      answer could travel in, so privacy does not depend on callers being
 *      careful.
 *   3. **No winner without evidence.** The metric, the direction, and the
 *      minimum sample are declared when the experiment is defined, not chosen
 *      after looking. The analysis reports `underpowered` below that sample and
 *      `no-difference` whenever the confidence interval crosses zero, so an
 *      experiment can fail to conclude — which is the normal outcome.
 *
 * Everything is local: assignment is a hash of a locally generated participant
 * id, and no observation leaves the machine.
 */

import { hash32 } from "./hashing.mjs";

export const EXPERIMENT_VERSION = 1;

/** Fields an observation may contain. Everything else is dropped. */
export const OBSERVATION_FIELDS = ["experimentId", "arm", "metric", "value", "at"];

/**
 * The registry. `arms[0]` is always the control — the behavior the app has
 * without the experiment — so a learner who never consents is never worse off.
 */
export const EXPERIMENTS = [
  {
    id: "review-daily-limit",
    question: "Does a shorter daily review queue produce better recall than a long one?",
    applies: "Caps how many due skills the review scheduler offers in one sitting.",
    arms: [
      { id: "twelve", label: "12 reviews a day", control: true, settings: { dailyLimit: 12 } },
      { id: "six", label: "6 reviews a day", control: false, settings: { dailyLimit: 6 } },
    ],
    metric: "review-success",
    metricLabel: "share of reviews recalled",
    higherIsBetter: true,
    minimumSample: 12,
  },
  {
    id: "tutor-context-depth",
    question: "Do learners do better with a lean tutor context or a balanced one?",
    applies: "Sets the context depth a fresh workspace starts with; the learner can still change it.",
    arms: [
      { id: "lean", label: "Lean context", control: true, settings: { mode: "lean" } },
      { id: "balanced", label: "Balanced context", control: false, settings: { mode: "balanced" } },
    ],
    metric: "activity-score",
    metricLabel: "mean graded activity score",
    higherIsBetter: true,
    minimumSample: 10,
  },
];

const BY_ID = new Map(EXPERIMENTS.map((experiment) => [experiment.id, experiment]));

export function experimentById(id) {
  return BY_ID.get(id) ?? null;
}

function round(value, places = 4) {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Number(Number(value).toFixed(places));
}

/** The control arm, which is what every unconsented caller gets. */
export function controlArm(experiment) {
  return experiment.arms.find((arm) => arm.control) ?? experiment.arms[0];
}

/**
 * Arm assignment is not a security boundary — it decides which of two equally
 * available behaviours a consenting learner sees — so it needs determinism and
 * a flat distribution, not cryptographic strength. The hash is shared with the
 * migration matcher rather than copied, and it keeps this module Node-free so
 * the browser demo enforces the same consent gate and assignment rules.
 */
export { hash32 } from "./hashing.mjs";

/**
 * Deterministic arm assignment.
 *
 * Hashing the participant id with the experiment id means assignment is stable
 * across restarts, reproducible in a test, independent per experiment, and
 * needs no server. It also means a learner cannot be silently re-rolled into a
 * different arm because someone reloaded the app.
 */
export function assignArm(experiment, participantId) {
  return experiment.arms[hash32(`${experiment.id}:${participantId}`) % experiment.arms.length];
}

/**
 * The privacy allowlist. An observation is rebuilt from scratch rather than
 * filtered, so there is no field for anything sensitive to survive in, and a
 * non-numeric value is refused instead of coerced.
 */
export function sanitizeObservation(candidate) {
  const experiment = experimentById(candidate?.experimentId);
  if (!experiment) return { ok: false, reason: "unknown-experiment" };
  const arm = experiment.arms.find((item) => item.id === candidate?.arm);
  if (!arm) return { ok: false, reason: "unknown-arm" };
  if (candidate?.metric !== experiment.metric) return { ok: false, reason: "unexpected-metric" };
  const value = Number(candidate?.value);
  if (!Number.isFinite(value)) return { ok: false, reason: "non-numeric-value" };
  const at = typeof candidate?.at === "string" && Number.isFinite(Date.parse(candidate.at)) ? candidate.at : new Date().toISOString();
  return { ok: true, observation: { experimentId: experiment.id, arm: arm.id, metric: experiment.metric, value: round(value), at } };
}

/** The consent record. Absent or false means no experiment is running. */
export function consentState(state) {
  return {
    granted: Boolean(state?.consent?.granted),
    grantedAt: state?.consent?.grantedAt ?? null,
    revokedAt: state?.consent?.revokedAt ?? null,
    // A locally generated identifier that encodes nothing about the machine,
    // the repository, or the learner.
    participantId: typeof state?.consent?.participantId === "string" ? state.consent.participantId : null,
  };
}

/**
 * What is running right now. Without consent this is deliberately empty and the
 * settings are the control arm's, so the app behaves exactly as it would with
 * the experiment framework removed.
 */
export function activeAssignments(state) {
  const consent = consentState(state);
  return EXPERIMENTS.map((experiment) => {
    const arm = consent.granted && consent.participantId ? assignArm(experiment, consent.participantId) : controlArm(experiment);
    return {
      experimentId: experiment.id,
      question: experiment.question,
      applies: experiment.applies,
      metric: experiment.metric,
      metricLabel: experiment.metricLabel,
      minimumSample: experiment.minimumSample,
      arm: arm.id,
      armLabel: arm.label,
      isControl: Boolean(arm.control),
      settings: arm.settings,
      enrolled: consent.granted,
    };
  });
}

/** The settings one experiment contributes, honoring the consent gate. */
export function settingsFor(experimentId, state) {
  const assignment = activeAssignments(state).find((item) => item.experimentId === experimentId);
  return assignment ? { ...assignment.settings, arm: assignment.arm, enrolled: assignment.enrolled } : {};
}

function summarize(values) {
  const n = values.length;
  if (!n) return { n: 0, mean: null, variance: null, standardError: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance = n > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, variance, standardError: n > 1 ? Math.sqrt(variance / n) : 0 };
}

/**
 * Compare the arms.
 *
 * Welch's approximation with a normal 95% interval: the sample sizes here are
 * small and unequal, and pretending otherwise would be the whole problem. The
 * verdict refuses to name a winner when the experiment is underpowered or when
 * the interval crosses zero, and says which of those it was.
 */
export function analyzeExperiment(experiment, observations) {
  const relevant = (observations ?? []).filter((item) => item.experimentId === experiment.id && item.metric === experiment.metric);
  const arms = experiment.arms.map((arm) => {
    const values = relevant.filter((item) => item.arm === arm.id).map((item) => item.value);
    const stats = summarize(values);
    return {
      arm: arm.id,
      label: arm.label,
      control: Boolean(arm.control),
      samples: stats.n,
      mean: round(stats.mean),
      standardDeviation: round(stats.variance === null ? null : Math.sqrt(stats.variance)),
    };
  });

  const control = experiment.arms.find((arm) => arm.control) ?? experiment.arms[0];
  const variant = experiment.arms.find((arm) => arm.id !== control.id) ?? control;
  const controlStats = summarize(relevant.filter((item) => item.arm === control.id).map((item) => item.value));
  const variantStats = summarize(relevant.filter((item) => item.arm === variant.id).map((item) => item.value));

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
    version: EXPERIMENT_VERSION,
    experimentId: experiment.id,
    question: experiment.question,
    metric: experiment.metric,
    metricLabel: experiment.metricLabel,
    minimumSample: experiment.minimumSample,
    observations: relevant.length,
    arms,
    control: control.id,
    variant: variant.id,
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
    // The honest headline: what is still missing before this can conclude.
    needed: powered ? 0 : Math.max(experiment.minimumSample - controlStats.n, experiment.minimumSample - variantStats.n, 0),
  };
}

/** Every experiment's current state and result, for the privacy panel. */
export function experimentReport(state) {
  const consent = consentState(state);
  const observations = Array.isArray(state?.observations) ? state.observations : [];
  return {
    version: EXPERIMENT_VERSION,
    consent,
    assignments: activeAssignments(state),
    observations: observations.length,
    // Exactly what is stored, so "what do you keep about me" has a literal answer.
    storedFields: OBSERVATION_FIELDS,
    results: EXPERIMENTS.map((experiment) => analyzeExperiment(experiment, observations)),
  };
}
