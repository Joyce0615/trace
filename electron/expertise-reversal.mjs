/**
 * Test prior-knowledge and expertise-reversal effects (item 59).
 *
 * The expertise-reversal effect is a specific, well-documented prediction
 * cognitive-load theory makes that this app has never tested: a scaffold
 * that helps a novice (removing it is harmful — "under-guidance") can
 * actively hurt an advanced learner on the *identical* task (adding it is
 * harmful — "redundant load", because reading a worked step the learner
 * already has to re-derive is extraneous load, not help). Confirmed by
 * grep before writing a line here: zero prior matches for
 * `expertise`/`under-guidance`/`underGuidance`/`redundantLoad`/`reversal`
 * as implementation identifiers anywhere in `electron/*.mjs`.
 *
 * `cognitive-load-regulation.mjs` (item 44, this cycle) already separates
 * extraneous load from germane load and already never lets *intrinsic*
 * load (the task's own structural difficulty) be an adjustment input —
 * but it regulates *one* learner's pacing over time, it never compares
 * *between* prior-knowledge profiles on a fixed task.
 * `accessibility-learning-experiments.mjs`'s own `buildPathComparison` and
 * `counterbalanced-assistance-experiments.mjs`'s own
 * `buildAssistanceComparison` both already show the right way to reuse
 * `experiments.mjs`'s own `analyzeExperiment` for an ad hoc two-arm
 * comparison that was never registered in `experiments.mjs`'s own
 * `EXPERIMENTS` list — this item needs the identical trick, run once per
 * prior-knowledge profile, comparing a low-scaffold arm against a
 * high-scaffold arm on the *same* fixed-difficulty task.
 *
 * The item's own text draws a hard line this module enforces
 * structurally, not just by convention: **the evidence target and the
 * assessment difficulty must be declared identical across all tested
 * profiles.** [`verifyFixedAssessment`] checks this and refuses to run any
 * comparison at all — not just scores it with a caveat — if a caller's own
 * fixtures let difficulty or the evidence target drift between profiles,
 * because a score difference on a *harder* task for one profile would
 * answer a different, confounded question, not the expertise-reversal
 * question this item asks.
 *
 * Harm detection is deliberately asymmetric by profile, because the
 * predicted effect itself is asymmetric:
 *
 *   - **under-guidance** — for the `"novice"` profile, if the high-scaffold
 *     arm scores significantly *better* than the low-scaffold arm
 *     (`analyzeExperiment`'s own `"variant-better"` verdict, unmodified),
 *     that is evidence the low-scaffold arm was already harming novices by
 *     withholding guidance they needed.
 *   - **redundant-load** — for the `"advanced"` profile, if the
 *     low-scaffold arm scores significantly *better* than the
 *     high-scaffold arm (`"control-better"`), that is the expertise-
 *     reversal signature itself: added scaffolding backfired for a
 *     learner who did not need it.
 *   - the `"intermediate"` profile is reported for completeness but is
 *     never scored for either harm kind — the item names novice/advanced
 *     as the two extremes the effect reverses between, and scoring a harm
 *     label for the middle profile from the same logic would manufacture a
 *     claim the literature this item is testing does not make.
 *
 * `analyzeExperiment`'s own `"underpowered"`/`"no-difference"` verdicts
 * are passed straight through as `harm: null` rather than guessed in
 * either direction — the same abstain-rather-than-overclaim discipline
 * every other gate in this app already keeps.
 */

import { MIN_SAMPLE } from "./analytics.mjs";
import { analyzeExperiment } from "./experiments.mjs";

export const EXPERTISE_REVERSAL_VERSION = 1;

/** Fixed order, matching the item's own stated extremes plus the middle profile. */
export const PRIOR_KNOWLEDGE_PROFILES = ["novice", "intermediate", "advanced"];

export const HARM_KINDS = Object.freeze({ UNDER_GUIDANCE: "under-guidance", REDUNDANT_LOAD: "redundant-load" });

/**
 * Refuse to compare profiles whose own declared evidence target or
 * declared difficulty differ from each other. `evidenceTarget` is
 * compared as a sorted set (order-independent); `difficulty` is compared
 * as the exact declared label. Fewer than two declared profiles is also
 * refused: a single profile cannot demonstrate a *reversal* at all.
 */
export function verifyFixedAssessment(profileFixtures) {
  const declared = PRIOR_KNOWLEDGE_PROFILES
    .map((profile) => profileFixtures?.[profile])
    .filter((fixture) => fixture && fixture.evidenceTarget !== undefined && fixture.difficulty !== undefined);
  if (declared.length < 2) {
    return { ok: false, reason: "insufficient-declared-profiles", declaredCount: declared.length };
  }
  const evidenceTargetKeys = new Set(declared.map((fixture) => JSON.stringify([...fixture.evidenceTarget].sort())));
  if (evidenceTargetKeys.size > 1) {
    return { ok: false, reason: "evidence-target-varies-across-profiles", values: [...evidenceTargetKeys] };
  }
  const difficultyValues = new Set(declared.map((fixture) => fixture.difficulty));
  if (difficultyValues.size > 1) {
    return { ok: false, reason: "difficulty-varies-across-profiles", values: [...difficultyValues] };
  }
  return { ok: true, evidenceTarget: declared[0].evidenceTarget, difficulty: declared[0].difficulty };
}

/**
 * One profile's own low-scaffold-vs-high-scaffold comparison, built as an
 * ad hoc two-arm experiment and handed to `experiments.mjs`'s own
 * `analyzeExperiment` unmodified — the same `buildPathComparison`/
 * `buildAssistanceComparison` trick this app already uses twice, applied
 * to a third domain's raw scores instead of re-deriving the Welch-interval
 * arithmetic a third time.
 */
export function buildScaffoldIntensityComparison(profile, lowScaffoldScores, highScaffoldScores, options = {}) {
  const experiment = {
    id: `expertise-reversal:${profile}`,
    arms: [{ id: "low-scaffold", control: true }, { id: "high-scaffold", control: false }],
    metric: "task-score",
    minimumSample: options.minimumSample ?? MIN_SAMPLE,
    higherIsBetter: true,
  };
  const observations = [
    ...(lowScaffoldScores ?? []).map((value) => ({ experimentId: experiment.id, arm: "low-scaffold", metric: "task-score", value })),
    ...(highScaffoldScores ?? []).map((value) => ({ experimentId: experiment.id, arm: "high-scaffold", metric: "task-score", value })),
  ];
  return analyzeExperiment(experiment, observations);
}

/**
 * The asymmetric harm classification described above. `comparison` is a
 * real `analyzeExperiment` result (own `buildScaffoldIntensityComparison`
 * or an equivalent ad hoc call); `profile` selects which direction, if
 * any, counts as harm for that profile.
 */
export function classifyExpertiseReversalHarm(profile, comparison) {
  if (!comparison.powered) return { profile, verdict: "underpowered", harm: null };
  if (comparison.verdict === "no-difference") return { profile, verdict: "no-difference", harm: null };
  if (profile === "novice") {
    return comparison.verdict === "variant-better"
      ? { profile, verdict: comparison.verdict, harm: HARM_KINDS.UNDER_GUIDANCE }
      : { profile, verdict: comparison.verdict, harm: null };
  }
  if (profile === "advanced") {
    return comparison.verdict === "control-better"
      ? { profile, verdict: comparison.verdict, harm: HARM_KINDS.REDUNDANT_LOAD }
      : { profile, verdict: comparison.verdict, harm: null };
  }
  // "intermediate": reported, never scored for either harm kind (see module docstring).
  return { profile, verdict: comparison.verdict, harm: null };
}

/**
 * The combined report: refuse if the assessment is not held fixed across
 * profiles, otherwise run and classify every declared profile's own
 * comparison independently. `harmsDetected` names exactly which harm
 * kinds were found and on which profile, never collapsed into one
 * "scaffolding worked/did not work" verdict.
 */
export function evaluateExpertiseReversal(profileFixtures, options = {}) {
  const assessment = verifyFixedAssessment(profileFixtures);
  if (!assessment.ok) return { version: EXPERTISE_REVERSAL_VERSION, ok: false, assessment, results: null, harmsDetected: [] };

  const results = {};
  for (const profile of PRIOR_KNOWLEDGE_PROFILES) {
    const fixture = profileFixtures?.[profile];
    if (!fixture) {
      results[profile] = { profile, verdict: "not-tested", harm: null, comparison: null };
      continue;
    }
    const comparison = buildScaffoldIntensityComparison(profile, fixture.lowScaffoldScores, fixture.highScaffoldScores, options);
    results[profile] = { ...classifyExpertiseReversalHarm(profile, comparison), comparison };
  }

  const harmsDetected = PRIOR_KNOWLEDGE_PROFILES
    .filter((profile) => results[profile].harm)
    .map((profile) => ({ profile, harm: results[profile].harm }));

  return { version: EXPERTISE_REVERSAL_VERSION, ok: true, assessment, results, harmsDetected };
}

export function renderExpertiseReversalReport(report) {
  if (!report.ok) return `Expertise-reversal evaluation: REFUSED (${report.assessment.reason})`;
  const lines = [`Expertise-reversal evaluation: fixed difficulty=${report.assessment.difficulty}, evidence target=[${[...report.assessment.evidenceTarget].sort().join(", ")}]`];
  for (const profile of PRIOR_KNOWLEDGE_PROFILES) {
    const result = report.results[profile];
    lines.push(`  ${profile}: ${result.verdict}${result.harm ? ` — HARM: ${result.harm}` : ""}`);
  }
  lines.push(report.harmsDetected.length ? `Harms detected: ${report.harmsDetected.map((item) => `${item.profile}/${item.harm}`).join(", ")}` : "Harms detected: none");
  return lines.join("\n");
}
