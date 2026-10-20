import { calibrateSkill } from "./misconception.mjs";

/**
 * Reconcile learner-state calibration around explicit FSRS-6 semantics
 * (item 16).
 *
 * Three independent systems already compute a number from the same evidence
 * and disagree, each for its own good reason: `src/learning.ts`'s
 * `addEvidence` accumulates a sequential noisy-OR mastery number on every
 * lesson/practice/self-report/diagnostic; `electron/misconception.mjs`'s
 * `calibrateSkill` turns that same evidence array into a Beta-Bernoulli
 * posterior mean with a stated 95% credible interval; and
 * `electron/spaced-repetition.mjs`'s `applyReview` runs an FSRS-style
 * exponential forgetting curve with its own explicit `difficulty`/`stability`
 * once a skill enters the review cycle. Item 10 already gave the *status*
 * field one writer per skill (the reviewer owns it once a `review` record
 * exists; `recommend()` owns it before that) — but the first time a skill
 * crosses that boundary, `gradeReview`'s first-exposure branch starts the
 * forgetting curve from the graded outcome alone:
 *
 *     stability = grade.firstStabilityDays * (initialStabilityDays / 1)
 *
 * completely blind to whatever `addEvidence`/`calibrateSkill` already knew
 * about the skill. A skill the learner has read ten lessons about and passed
 * three quizzes on, and a skill they have never opened, both start their
 * review curve from the exact same number on a `good` grade — the "two
 * incompatible numbers depending only on which panel is looking" bug from
 * item 10's investigation, still open for the one transition item 10 did not
 * touch: entering the review cycle for the first time.
 *
 * This module is the fix: `reconcileInitialState` reads `calibrateSkill`'s
 * own calibrated mastery and confidence — it does not recompute or duplicate
 * either number — and uses them to scale the *existing* grade-only baseline
 * stability/difficulty that `gradeReview` would otherwise use unconditionally.
 * A skill with no prior evidence reconciles to exactly that baseline,
 * unchanged: the pre-existing contract for an unevidenced first review is
 * preserved byte-for-byte, not replaced. `unifiedMasteryState` is the
 * read-only counterpart: an explicit difficulty/stability/retrievability
 * snapshot for *any* `SkillMastery`, whichever of the three systems last
 * wrote it, so a caller never has to know which panel's number it is reading.
 *
 * "Migration" in this app has no separate batch script for learner state —
 * `electron/skill-graph.mjs`'s `reconcileLearnerState` already re-derives
 * status on every reopen, and `gradeReview`'s first-exposure branch is the one
 * and only place a pre-item-16 record (evidence accumulated, no `review` yet)
 * crosses into FSRS semantics. Reconciling *there* is therefore the complete
 * migration path for every learner-state file written before this item,
 * exercised by loading such a record and taking it through its first review.
 *
 * Pure and Node-free, like `misconception.mjs` and `spaced-repetition.mjs`
 * themselves, so the browser demo can share the exact same reconciliation.
 */

export const FSRS_CALIBRATION_VERSION = 1;

/**
 * At full calibration confidence and mastery, a reconciled skill starts with
 * up to 3x (1 + MAX_RECONCILIATION_BOOST) the grade-only baseline stability.
 * Bounded deliberately: strong prior evidence should buy a longer first
 * interval, but not one longer than a skill could earn through several
 * genuine spaced reviews.
 */
const MAX_RECONCILIATION_BOOST = 2;

/**
 * Mirrors `DEFAULT_SCHEDULER.difficultyFloor`/`difficultyCeiling` in
 * `electron/spaced-repetition.mjs`. Duplicated rather than imported to avoid
 * a circular module dependency (`spaced-repetition.mjs` imports
 * `reconcileInitialState` from this module to drive `applyReview`); every
 * real call site in this app passes its own `parameters` explicitly instead
 * of relying on these, so the only drift risk is a caller of
 * `unifiedMasteryState` that supplies no `options.parameters` at all — stated
 * as residual risk, same pattern already accepted for `scale-tiers.mjs`'s
 * `TIER_BUDGETS` being kept separate from `performance.mjs`'s `BUDGETS`.
 */
const MIRRORED_DEFAULTS = { difficultyFloor: 1.3, difficultyCeiling: 2.9 };

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

/**
 * Reconcile a skill's accumulated non-review evidence into the explicit
 * starting point for its first spaced review.
 *
 * `baselineStability`/`baselineDifficulty` are whatever `gradeReview` would
 * have produced for this grade with no reconciliation at all (its existing,
 * unconditional first-exposure formula) — this function only scales them, it
 * never invents a number `calibrateSkill` itself would not stand behind.
 */
export function reconcileInitialState(mastery, baseline) {
  const { baselineStability, baselineDifficulty, difficultyFloor, difficultyCeiling, minimumStabilityDays, maximumStabilityDays } = baseline;
  const calibrated = calibrateSkill(mastery);

  if (calibrated.evidenceCount === 0) {
    // No prior evidence to reconcile: the existing grade-only contract for an
    // unevidenced first review is preserved exactly, not replaced.
    return {
      version: FSRS_CALIBRATION_VERSION,
      stability: clamp(baselineStability, minimumStabilityDays, maximumStabilityDays),
      difficulty: clamp(baselineDifficulty, difficultyFloor, difficultyCeiling),
      source: "none",
      priorMastery: null,
      priorConfidence: 0,
    };
  }

  // A confidently-calibrated, high-mastery skill reconciles to a longer first
  // interval and a lower (easier) starting difficulty; a shaky or low-mastery
  // one reconciles close to the grade-only baseline. Both calibrateSkill
  // outputs already live in [0, 1], so their product is a single [0, 1]
  // "how much do we already trust this" weight — not a second posterior.
  const weight = clamp(calibrated.confidence * calibrated.mastery, 0, 1);
  const stability = clamp(baselineStability * (1 + MAX_RECONCILIATION_BOOST * weight), minimumStabilityDays, maximumStabilityDays);
  const difficulty = clamp(baselineDifficulty - weight * (baselineDifficulty - difficultyFloor), difficultyFloor, difficultyCeiling);

  return {
    version: FSRS_CALIBRATION_VERSION,
    stability: round(stability),
    difficulty: round(difficulty),
    source: "reconciled",
    priorMastery: calibrated.mastery,
    priorConfidence: calibrated.confidence,
  };
}

/**
 * An explicit difficulty/stability/retrievability snapshot for one skill,
 * regardless of which of the three systems last wrote its mastery record.
 *
 * This never writes anything and never contradicts item 10's one-writer rule:
 * a skill already owned by the reviewer (`mastery.review` present) is read
 * back exactly as the reviewer left it, computing retrievability the same way
 * `scheduleSkill` does for consistency with the review queue's own math. A
 * skill not yet in the review cycle has no stability or retrievability yet —
 * calibration alone carries no time axis, so those are honestly reported as
 * `null` rather than invented — but its calibrated mastery is still exposed
 * as an explicit difficulty estimate on the same documented scale, so a
 * caller can compare "a reviewed skill" and "a not-yet-reviewed one" without
 * knowing which subsystem is behind either number.
 */
export function unifiedMasteryState(mastery, options = {}) {
  const parameters = { ...MIRRORED_DEFAULTS, ...(options.parameters ?? {}) };
  const now = options.now ?? new Date().toISOString();
  const targetRetention = options.targetRetention ?? 0.9;

  if (mastery?.review) {
    const review = mastery.review;
    const elapsedDays = review.lastReviewedAt
      ? Math.max(0, (Date.parse(now) - Date.parse(review.lastReviewedAt)) / 86_400_000)
      : 0;
    const retrievability = review.reviews > 0
      ? clamp(targetRetention ** (elapsedDays / Math.max(1e-6, Number(review.stability) || 0)), 0, 1)
      : null;
    return {
      version: FSRS_CALIBRATION_VERSION,
      skillId: mastery.skillId ?? null,
      difficulty: review.difficulty,
      stability: review.stability,
      retrievability: retrievability === null ? null : round(retrievability),
      source: "review",
    };
  }

  const calibrated = calibrateSkill(mastery);
  if (calibrated.evidenceCount === 0) {
    return {
      version: FSRS_CALIBRATION_VERSION,
      skillId: mastery?.skillId ?? null,
      difficulty: null,
      stability: null,
      retrievability: null,
      source: "none",
    };
  }

  return {
    version: FSRS_CALIBRATION_VERSION,
    skillId: mastery?.skillId ?? null,
    // Lower confidence maps to higher (harder) difficulty on the same scale
    // `applyReview` uses, so a not-yet-reviewed skill's number is already
    // comparable to a reviewed one's, not merely similarly-shaped.
    difficulty: round(parameters.difficultyCeiling - calibrated.confidence * (parameters.difficultyCeiling - parameters.difficultyFloor)),
    stability: null,
    retrievability: round(calibrated.mastery),
    source: "calibration",
  };
}
