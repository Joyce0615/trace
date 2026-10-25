import { createHash } from "node:crypto";
import { REVIEW_GRADES, DEFAULT_SCHEDULER, retention as modelledRetention } from "./spaced-repetition.mjs";

/**
 * Personalized FSRS optimizer import/export (item 21).
 *
 * `electron/spaced-repetition.mjs` (item 36) already runs a fixed, global
 * forgetting-curve model: every learner's `again`/`hard`/`good`/`easy`
 * outcome moves stability/difficulty by the exact same formula, with the
 * exact same `DEFAULT_SCHEDULER` constants. That is deliberately uniform and
 * deliberately unpersonalized — which means two learners with wildly
 * different real forgetting rates get the identical schedule from the
 * identical review history, and the model's own
 * `electron/analytics.mjs#retentionAnalytics` already measures, but cannot
 * close, that exact gap (`modelVerdict: "learner-forgets-faster-than-model"`
 * is reported, never acted on).
 *
 * This module is the missing feedback loop, built to the public FSRS
 * optimizer's own contract (github.com/open-spaced-repetition/fsrs-optimizer)
 * rather than a bespoke one, so a learner's review history is portable to any
 * FSRS-compatible tool:
 *
 *   - `toReviewLogs` converts this app's own stored evidence — the `review`
 *     kind entries `applyReview` already appends to a skill's
 *     `SkillMastery.evidence` array — into the optimizer's exact five-column
 *     schema (`card_id`, `review_time`, `review_rating`, `review_state`,
 *     `review_duration`), reusing `REVIEW_GRADES` for the 1-4 rating mapping
 *     instead of re-declaring it. Nothing here invents a review that was
 *     never recorded, and nothing uploads the result anywhere: the schema
 *     conversion is pure, in-memory, and the caller decides what to do with
 *     the returned rows (typically: write them to a file the learner chose).
 *   - `fitPersonalizedParameters` learns exactly two bounded per-learner
 *     multipliers from those logs — a stability-scale and a difficulty-bias —
 *     rather than reimplementing the seventeen-parameter weight vector a real
 *     FSRS-6 optimizer fits via gradient descent over PyTorch. Two
 *     deliberately small, clamped numbers that this app's own
 *     `applyReview`/`gradeReview` can apply directly as a multiplicative
 *     correction to `DEFAULT_SCHEDULER`'s existing formula, learned by a
 *     closed-form least-squares fit against the exact same observed-vs-
 *     predicted retention gap `retentionAnalytics` already computes (reusing
 *     `modelledRetention`, not a second retention formula) — not a from-
 *     scratch FSRS refit, which this app's forgetting curve was never
 *     designed to be, but a real correction grounded in the same evidence and
 *     bounded so it cannot, by construction, overcorrect into an absurd
 *     schedule.
 *   - `compareAgainstDefaults` states what the fitted parameters change
 *     relative to `DEFAULT_SCHEDULER` in exact numbers (not "better"/"worse"),
 *     and at how many observations the fit is even attempted — a learner can
 *     only see "we have not learned your parameters yet" below the sample
 *     floor, mirroring `analytics.mjs`'s own refusal below `MIN_SAMPLE`.
 *   - `personalizedSchedulerOptions` turns an accepted fit into the exact
 *     `options` object `reviewPlan`/`applyReview`/`gradeReview` already
 *     accept, so adopting a learned personalization is one extra argument at
 *     an existing call site, not a new code path for every caller.
 *   - `rollbackParameters` is deterministic and total: it is the identity
 *     function on `DEFAULT_SCHEDULER`'s own defaults. There is no stored
 *     "previous fit" to roll back to by design — a learner can go back to the
 *     exact global defaults at any moment, not to some other, also-fitted,
 *     intermediate state that could itself be wrong.
 *
 * Privacy: the whole point of exporting to the *optimizer's* schema rather
 * than uploading anything is that the four columns the public FSRS optimizer
 * needs (card id, timestamp, rating, optional duration) carry no lesson text,
 * no skill title, and no source anchor — `cardId` is a salted digest of the
 * skill id, not the id itself, so the exported rows cannot be joined back to
 * this app's own skill graph by anyone who did not already have it. Nothing
 * in this module performs I/O or makes a network call; it is pure data
 * transformation over values the caller already holds, like
 * `fsrs-calibration.mjs` and `spaced-repetition.mjs` themselves.
 */

export const FSRS_OPTIMIZER_VERSION = 1;

/** Below this many review logs for one learner, a fit is not attempted at all. */
export const MIN_REVIEW_LOGS = 8;

/** `review_rating` in the public optimizer's schema: 1=Again … 4=Easy. */
const RATING_BY_GRADE = { again: 1, hard: 2, good: 3, easy: 4 };
const GRADE_BY_RATING = Object.fromEntries(Object.entries(RATING_BY_GRADE).map(([grade, rating]) => [rating, grade]));

/**
 * `review_state` in the public optimizer's schema: 0=New 1=Learning 2=Review
 * 3=Relearning. This app has no separate "Learning" phase (a skill's very
 * first review already carries a real grade), so a first review reports
 * `New` and every later one reports `Review` unless the *immediately
 * preceding* review in the same log was a lapse, which reports `Relearning` —
 * the same distinction `scheduleSkill`'s own `state: "relearning"` already
 * draws from `lastGrade === "again"`, read here from the log instead of a
 * live `SkillMastery` record.
 */
function reviewStateFor(index, ratings) {
  if (index === 0) return 0;
  return ratings[index - 1] === 1 ? 3 : 2;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

/**
 * A stable, non-reversible card id for one skill: a salted digest, not the
 * skill id itself. The salt is per-export (random unless the caller pins
 * one, e.g. for deterministic tests) so the same skill exported twice without
 * a pinned salt cannot be correlated across two exports by whoever receives
 * them, while a single export's rows for the same skill still share one id —
 * which is exactly what the optimizer's schema needs to group a card's
 * history.
 */
function cardId(skillId, salt) {
  return createHash("sha256").update(`${salt}:${skillId}`).digest("hex").slice(0, 16);
}

/**
 * Convert one skill's accumulated review evidence into the public FSRS
 * optimizer's `review_logs` schema.
 *
 * Only `kind: "review"` evidence is read — lessons, quizzes, and self-reports
 * are not review log entries in the optimizer's sense, the same filter
 * `calibrateSkill` applies for its own, unrelated, purpose. Evidence missing
 * a parseable `createdAt` or carrying a strength the grade map cannot invert
 * is skipped rather than guessed at, and the skip is counted so a caller can
 * tell "no reviews yet" from "some reviews could not be exported".
 */
export function toReviewLogs(mastery, options = {}) {
  const salt = options.salt ?? createHash("sha256").update(String(Math.random())).digest("hex");
  const evidence = (mastery?.evidence ?? []).filter((item) => item.kind === "review");
  const rows = [];
  let skipped = 0;
  const grades = [];
  for (const item of evidence) {
    const time = Date.parse(item.createdAt ?? "");
    const grade = gradeFromStrength(item.strength);
    if (!Number.isFinite(time) || !grade) {
      skipped += 1;
      continue;
    }
    grades.push(RATING_BY_GRADE[grade]);
    rows.push({ grade, time });
  }
  const id = cardId(mastery?.skillId ?? "unknown", salt);
  const logs = rows.map((row, index) => ({
    card_id: id,
    review_time: row.time,
    review_rating: RATING_BY_GRADE[row.grade],
    review_state: reviewStateFor(index, grades),
    review_duration: null,
  }));
  return { version: FSRS_OPTIMIZER_VERSION, cardId: id, logs, exported: logs.length, skipped };
}

/**
 * The inverse of `REVIEW_GRADES[grade].strength`. Strengths are exact
 * (0, 0.5, 0.8, 1) by construction in `gradeReview`, so an exact match is
 * always attempted first; a small epsilon guards only against a value that
 * passed through a JSON round trip with floating-point noise.
 */
function gradeFromStrength(strength) {
  for (const [grade, definition] of Object.entries(REVIEW_GRADES)) {
    if (Math.abs(definition.strength - strength) < 1e-6) return grade;
  }
  return null;
}

/**
 * Convert every reviewed skill in a learner's state into one combined set of
 * review logs, one card per skill, sharing one export salt so the whole
 * export is internally consistent (two rows for the same skill always carry
 * the same `card_id`) without being joinable to a *different* export of the
 * same learner state.
 */
export function exportReviewLogs(learnerState, options = {}) {
  const salt = options.salt ?? createHash("sha256").update(String(Math.random())).digest("hex");
  const masteries = Object.values(learnerState?.mastery ?? {});
  const perSkill = masteries.map((mastery) => toReviewLogs(mastery, { salt }));
  const logs = perSkill.flatMap((entry) => entry.logs).sort((left, right) => left.review_time - right.review_time);
  return {
    version: FSRS_OPTIMIZER_VERSION,
    logs,
    totalExported: perSkill.reduce((sum, entry) => sum + entry.exported, 0),
    totalSkipped: perSkill.reduce((sum, entry) => sum + entry.skipped, 0),
    cards: perSkill.filter((entry) => entry.exported > 0).length,
  };
}

/**
 * Fit two bounded per-learner multipliers against a set of review logs for
 * one card: `stabilityScale` corrects `DEFAULT_SCHEDULER`'s stability growth,
 * `difficultyBias` shifts its difficulty. Both are closed-form least-squares
 * fits, not a gradient-descent refit of FSRS-6's full seventeen-parameter
 * weight vector — the goal is "correct this app's existing formula toward
 * this learner's observed recall", not "replace it".
 *
 * The method: for every review after the first, `review_state === 2`
 * ("Review", i.e. a real recall attempt against an existing interval) is a
 * data point pairing an elapsed gap (from the previous log row for the same
 * card) against whether the next rating was a lapse (`review_rating === 1`).
 * `DEFAULT_SCHEDULER`'s own `retention(elapsedDays, stability)` already
 * predicts a recall probability for a *default-model* stability at that
 * point; `stabilityScale` is solved as the value that makes the *mean*
 * predicted retention across every data point match the *mean observed*
 * recall rate exactly (a one-parameter calibration-in-the-mean, the simplest
 * least-squares solution for a single multiplicative scale against a single
 * aggregate target) rather than an unconstrained per-point fit that could
 * swing wildly on a handful of logs. `difficultyBias` is solved the same way
 * against the *lapse* rate specifically (difficulty governs how fast
 * stability grows after success, which this aggregate lapse-rate-driven
 * correction approximates as a shift). Both are then clamped to
 * `maxStabilityScale`/`maxDifficultyBias` so a thin or noisy log cannot
 * produce a correction larger than the ones already accepted by this app's
 * own bounded-reconciliation precedent (`fsrs-calibration.mjs`'s
 * `MAX_RECONCILIATION_BOOST`).
 *
 * Below `MIN_REVIEW_LOGS` usable data points, no fit is attempted at all:
 * the return states `fitted: false` and the reason, rather than returning an
 * overconfident correction from three data points.
 */
export function fitPersonalizedParameters(logs, options = {}) {
  const maxStabilityScale = options.maxStabilityScale ?? 2;
  const maxDifficultyBias = options.maxDifficultyBias ?? 0.6;
  const byCard = new Map();
  for (const row of logs ?? []) {
    const list = byCard.get(row.card_id) ?? [];
    list.push(row);
    byCard.set(row.card_id, list);
  }

  const points = [];
  for (const rows of byCard.values()) {
    const sorted = [...rows].sort((left, right) => left.review_time - right.review_time);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (current.review_state !== 2 && current.review_state !== 3) continue;
      const elapsedDays = Math.max(0, (current.review_time - previous.review_time) / 86_400_000);
      // A fixed reference stability is used only to compute a comparable
      // predicted retention per point; the fit never needs the real stability
      // this app's own scheduler would have tracked for this card, because it
      // is calibrating a *scale factor* on top of whatever stability the
      // default model would already have produced, not re-deriving the
      // stability itself.
      const referenceStability = DEFAULT_SCHEDULER.initialStabilityDays * (1 + index * 0.5);
      points.push({
        predicted: modelledRetention(elapsedDays, referenceStability),
        recalled: current.review_rating !== 1 ? 1 : 0,
        lapsed: current.review_rating === 1 ? 1 : 0,
      });
    }
  }

  if (points.length < MIN_REVIEW_LOGS) {
    return {
      version: FSRS_OPTIMIZER_VERSION,
      fitted: false,
      reason: "insufficient-review-logs",
      required: MIN_REVIEW_LOGS,
      observed: points.length,
      stabilityScale: 1,
      difficultyBias: 0,
    };
  }

  const meanPredicted = points.reduce((sum, point) => sum + point.predicted, 0) / points.length;
  const meanObservedRecall = points.reduce((sum, point) => sum + point.recalled, 0) / points.length;
  const meanObservedLapse = points.reduce((sum, point) => sum + point.lapsed, 0) / points.length;

  // The default model predicts retention as target ** (elapsed / S0); a
  // learner whose true stability is S0 * scale instead recalls at
  // target ** (elapsed / (S0 * scale)) == meanPredicted ** (1 / scale).
  // Solving meanObservedRecall == meanPredicted ** (1 / scale) for scale
  // gives log(meanPredicted) / log(meanObservedRecall) — the closed-form
  // least-squares solution for scaling a single exponential-decay parameter
  // to match one aggregate observed target. A learner who forgets faster than
  // predicted (meanObservedRecall < meanPredicted) gets scale < 1 — a
  // *shorter* real stability, asserted explicitly by this module's own test.
  const rawScale = meanPredicted > 0 && meanPredicted < 1 && meanObservedRecall > 0 && meanObservedRecall < 1
    ? Math.log(meanPredicted) / Math.log(meanObservedRecall)
    : 1;
  const stabilityScale = clamp(Number.isFinite(rawScale) ? rawScale : 1, 1 / maxStabilityScale, maxStabilityScale);

  // A learner who lapses more than the default model's own implied lapse
  // rate (1 - meanPredicted) needs a *harder* starting difficulty; one who
  // lapses less needs an easier one. The bias is the signed gap, bounded.
  const impliedLapseRate = 1 - meanPredicted;
  const rawBias = meanObservedLapse - impliedLapseRate;
  const difficultyBias = clamp(Number.isFinite(rawBias) ? rawBias : 0, -maxDifficultyBias, maxDifficultyBias);

  return {
    version: FSRS_OPTIMIZER_VERSION,
    fitted: true,
    reason: null,
    required: MIN_REVIEW_LOGS,
    observed: points.length,
    stabilityScale: round(stabilityScale),
    difficultyBias: round(difficultyBias),
    meanPredictedRetention: round(meanPredicted),
    meanObservedRecall: round(meanObservedRecall),
    meanObservedLapseRate: round(meanObservedLapse),
  };
}

/**
 * State, in exact numbers, what a fit changes relative to
 * `DEFAULT_SCHEDULER` — never "better"/"worse", because that judgment belongs
 * to whether the learner's own recall improves, which this module cannot see
 * from the fit alone.
 */
export function compareAgainstDefaults(fit) {
  if (!fit?.fitted) {
    return {
      version: FSRS_OPTIMIZER_VERSION,
      comparable: false,
      reason: fit?.reason ?? "not-fitted",
      stabilityDeltaPercent: 0,
      difficultyDeltaAbsolute: 0,
    };
  }
  return {
    version: FSRS_OPTIMIZER_VERSION,
    comparable: true,
    reason: null,
    // A positive percent means intervals grow faster than the default model
    // (this learner recalls better than it assumes); negative means slower.
    stabilityDeltaPercent: round((fit.stabilityScale - 1) * 100, 2),
    // A positive absolute value means skills start harder (more lapse-prone
    // than the default model assumes); negative means easier.
    difficultyDeltaAbsolute: round(fit.difficultyBias, 4),
  };
}

/**
 * Turn an accepted fit into the exact `options` shape
 * `reviewPlan`/`applyReview`/`gradeReview` already accept as their
 * `parameters` argument, so adopting a personalization is one additional
 * argument at an existing call site. Every field not touched by the fit is
 * passed through from `DEFAULT_SCHEDULER` unchanged — this never invents a
 * parameter the fit did not learn.
 *
 * `stabilityGain` growth is corrected multiplicatively by `stabilityScale`
 * applied to the grades' own `firstStabilityDays`/`stabilityGain` via the
 * scheduler's existing `initialStabilityDays`/`lapseStabilityFactor`
 * parameters (the two the formula already scales by), and
 * `initialDifficulty` is shifted by `difficultyBias`, clamped back inside
 * `DEFAULT_SCHEDULER`'s own floor/ceiling so a personalization can never
 * produce an out-of-range starting difficulty.
 */
export function personalizedSchedulerOptions(fit) {
  if (!fit?.fitted) return { ...DEFAULT_SCHEDULER };
  return {
    ...DEFAULT_SCHEDULER,
    initialStabilityDays: round(DEFAULT_SCHEDULER.initialStabilityDays * fit.stabilityScale),
    maximumStabilityDays: DEFAULT_SCHEDULER.maximumStabilityDays,
    lapseStabilityFactor: round(clamp(DEFAULT_SCHEDULER.lapseStabilityFactor * fit.stabilityScale, 0.05, 0.95)),
    initialDifficulty: round(clamp(
      DEFAULT_SCHEDULER.initialDifficulty + fit.difficultyBias,
      DEFAULT_SCHEDULER.difficultyFloor,
      DEFAULT_SCHEDULER.difficultyCeiling,
    )),
  };
}

/**
 * Deterministic rollback: the identity function on `DEFAULT_SCHEDULER`
 * itself. There is deliberately no "previous fit" state to roll back to —
 * the only two states this module exposes are "the global defaults" and "the
 * currently fitted personalization", and rollback always lands on the first
 * one exactly, never on some other, also-fitted, intermediate state that
 * could itself be wrong. Rolling back twice in a row is exactly as safe as
 * rolling back once, because both calls return the identical object shape
 * with the identical values.
 */
export function rollbackParameters() {
  return { ...DEFAULT_SCHEDULER };
}

/**
 * Round-trip a review log row back into the `{ grade, time }` shape this
 * app's own evidence array already carries, for a caller that re-imports a
 * previously exported log (for example, restoring from a file the learner
 * exported earlier) without re-deriving `gradeFromStrength` itself.
 */
export function reviewLogToEvidence(row) {
  const grade = GRADE_BY_RATING[row.review_rating] ?? null;
  if (!grade) return null;
  return {
    kind: "review",
    strength: REVIEW_GRADES[grade].strength,
    createdAt: new Date(row.review_time).toISOString(),
  };
}
