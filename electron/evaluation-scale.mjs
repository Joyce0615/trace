/**
 * Normalized learning-evaluation scales (item 47, this cycle).
 *
 * Six separately-tested graders already exist in this app, and each one
 * invented its own small, locally-sensible vocabulary for "how good was
 * this" — confirmed by grep before writing a line here: zero prior matches
 * for `normalizeEvaluationScale`/`scoreDirection`/`ratingLevel` as
 * implementation identifiers anywhere in `electron/*.mjs`. Reading the six
 * graders side by side turns up three concrete incompatibilities this item
 * names explicitly:
 *
 *   - **Three different four-level band vocabularies for the identical
 *     higher-is-better [0,1] shape, at three different thresholds.**
 *     `explanation-grader.mjs`'s own `BANDS` names `expert`/`proficient`/
 *     `developing`/`novice` at 0.85/0.65/0.4; `race-grader.mjs`'s own
 *     `band()` names `expert`/`competent`/`emerging`/`novice` at the exact
 *     same 0.85/0.65/0.4 thresholds but a different label at two of the
 *     four rungs; `localization.mjs`'s own inline `grade` names
 *     `excellent`/`solid`/`developing`/`scattered` at 0.8/0.6/0.35 — a third
 *     label set *and* a third set of thresholds. None of the three is
 *     wrong for its own domain's display copy, but nothing lets a caller
 *     ask "is this explanation's rating level comparable to this quiz's" at
 *     all, because the three vocabularies do not line up.
 *   - **Score direction is not uniform.** Most graders are higher-is-better
 *     on `[0, 1]`; `program-state-tracing.mjs`'s own `gradeHypothesis`
 *     reports a Brier score that is *lower*-is-better on the same `[0, 1]`;
 *     `transfer-curriculum.mjs`'s own `evaluateTransferGain` reports a
 *     signed, unbounded `gain` where only the *sign* has a "better"
 *     direction, not a bound; and `accessibility-learning-experiments.mjs`'s
 *     own `evaluateDifficultyEquivalence` reports a difference where
 *     *closer to zero* is better, not higher or lower.
 *   - **Abstention exists in some graders and not others, under different
 *     names.** `analytics.mjs`'s own `rate()` already refuses to report a
 *     percentage below `MIN_SAMPLE`, naming the reason
 *     `"insufficient-evidence"`; `experiments.mjs`'s own `analyzeExperiment`
 *     already refuses to name a winner below `minimumSample`, naming the
 *     reason `"underpowered"`; `executable-quiz.mjs`'s own `gradeSubmission`
 *     already reports `status: "refused"/"timeout"/"memory"/"cpu"` instead
 *     of a score when a submission could not be judged at all. Three real,
 *     already-correct abstention mechanisms, three different field names,
 *     and no common shape a caller could check without knowing which
 *     grader produced the record.
 *
 * This module adds the missing common envelope, reusing every grader's own
 * real output unmodified rather than re-deriving a single one of them:
 * [`normalizeQuizScale`]/[`normalizeExplanationScale`]/
 * [`normalizeTracingScale`]/[`normalizeTransferScale`]/
 * [`normalizeRetentionScale`]/[`normalizeAccessibilityScale`] each take the
 * real return value of `executable-quiz.mjs`'s `gradeSubmission`,
 * `explanation-grader.mjs`'s `gradeExplanation`,
 * `program-state-tracing.mjs`'s `gradeStateTrace`/`gradeHypothesis`,
 * `transfer-curriculum.mjs`'s `evaluateTransferGain`, `analytics.mjs`'s
 * `rate()`-shaped retention result, and
 * `accessibility-learning-experiments.mjs`'s `evaluateDifficultyEquivalence`
 * — in each case the exact object the real grader already produced, never
 * recomputed — and project it into one versioned envelope:
 *
 *   - `scoreDirection` is one of three honestly-distinct claims
 *     (`higher-is-better`/`lower-is-better`/`closer-to-zero-is-better`),
 *     stated per record rather than assumed uniform.
 *   - `bounds` is the real range the value can occupy, reused from the
 *     grader itself where one exists (accessibility's own equivalence
 *     `margin` becomes `[-margin, margin]`) and honestly `null` — not a
 *     fabricated `[-Infinity, Infinity]` — for transfer's genuinely
 *     unbounded `gain`.
 *   - `ratingLevel` maps a bounded value onto one canonical, versioned
 *     four-level taxonomy (`RATING_LEVELS`) via [`levelForScore`], which
 *     normalizes by direction and bounds before thresholding — so a
 *     `0.9` quiz score and a Brier `0.1` (both "about as good as it
 *     gets") land on the same `"advanced"` rung. `ratingLevel` is honestly
 *     `null`, never a forced rung, whenever `bounds` is `null` or the
 *     record abstained: thresholding an unbounded signed difference into
 *     four rungs would fabricate precision the value does not carry.
 *   - `tags` always starts with the record's own `domain` (one of the six
 *     this item names) and is extended with the *grader's own* already-
 *     declared enum value for this record (its real `status`/`band`/
 *     `calibration`/`verdict`/abstention `reason`) — never a newly invented
 *     tag vocabulary.
 *   - `uncertainty` carries through whatever real uncertainty figure the
 *     underlying grader already produced (a stated confidence and Brier
 *     score for a tracing hypothesis; the real 95% interval
 *     `analyzeExperiment` already computed for an accessibility
 *     equivalence check) and is honestly `null` — not a fabricated zero-
 *     width interval — for the three domains whose real grader reports
 *     only a point value today.
 *   - `abstention` is always `{ abstained, reason }`; `reason` is always
 *     one of the grader's own already-named reasons (a quiz's own
 *     `status`, `rate()`'s own `"insufficient-evidence"`,
 *     `evaluateDifficultyEquivalence`'s own `"underpowered"`), never an
 *     invented explanation.
 *
 * Pure and Node-free, so the browser demo can normalize the exact same
 * grader output the desktop app does.
 */

export const EVALUATION_SCALE_VERSION = 1;

/** The three honestly-distinct "better" directions a real grader may report. */
export const SCORE_DIRECTIONS = Object.freeze({
  HIGHER_IS_BETTER: "higher-is-better",
  LOWER_IS_BETTER: "lower-is-better",
  CLOSER_TO_ZERO_IS_BETTER: "closer-to-zero-is-better",
});

/** The six domains this item names, and no others. */
export const DOMAINS = ["quiz", "explanation", "tracing", "transfer", "retention", "accessibility"];

/**
 * One canonical, versioned four-level taxonomy every bounded domain's value
 * is mapped onto, independent of whatever domain-specific display label
 * (`explanation-grader.mjs`'s own `"proficient"`, `race-grader.mjs`'s own
 * `"competent"`, `localization.mjs`'s own `"excellent"`) that grader keeps
 * for its own learner-facing copy. This module never replaces those labels
 * — it adds the one additional, comparable rung alongside them.
 */
export const RATING_LEVELS = ["advanced", "proficient", "developing", "emerging"];

function round(value, places = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(places)) : null;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * Map a bounded value onto `RATING_LEVELS`, normalizing by direction and
 * bounds first. Returns `null` — never a forced rung — when the value is
 * missing, the bounds are missing or degenerate, or (for
 * `closer-to-zero-is-better`) the bound span is zero.
 */
export function levelForScore(value, direction = SCORE_DIRECTIONS.HIGHER_IS_BETTER, bounds = [0, 1]) {
  if (value === null || value === undefined || !Number.isFinite(value) || !bounds) return null;
  const [min, max] = bounds;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;

  let effective;
  if (direction === SCORE_DIRECTIONS.CLOSER_TO_ZERO_IS_BETTER) {
    const span = Math.max(Math.abs(min), Math.abs(max));
    if (span === 0) return null;
    effective = clamp(1 - Math.abs(value) / span, 0, 1);
  } else {
    if (min === max) return null;
    const normalized = clamp((value - min) / (max - min), 0, 1);
    effective = direction === SCORE_DIRECTIONS.LOWER_IS_BETTER ? 1 - normalized : normalized;
  }

  if (effective >= 0.85) return "advanced";
  if (effective >= 0.65) return "proficient";
  if (effective >= 0.4) return "developing";
  return "emerging";
}

function envelope({ domain, scoreDirection, bounds, value, tags, evidence, uncertainty, abstained, reason }) {
  if (!DOMAINS.includes(domain)) throw new Error(`Unknown evaluation domain: ${domain}`);
  const effectiveValue = abstained ? null : (value ?? null);
  return {
    version: EVALUATION_SCALE_VERSION,
    domain,
    scoreDirection,
    bounds: bounds ?? null,
    value: effectiveValue,
    ratingLevel: levelForScore(effectiveValue, scoreDirection, bounds ?? null),
    tags: [domain, ...tags],
    evidence,
    uncertainty: uncertainty ?? null,
    abstention: { abstained: Boolean(abstained), reason: abstained ? (reason ?? "unspecified") : null },
  };
}

/**
 * Normalize `executable-quiz.mjs`'s own `gradeSubmission` result, unmodified.
 * A non-`"ran"` status (`refused`/`timeout`/`memory`/`cpu`/`failed`/
 * `unavailable`) is the grader's own real "could not be judged" signal and
 * becomes this record's abstention, named by that exact status rather than
 * a new reason.
 */
export function normalizeQuizScale(result) {
  const abstained = result.status !== "ran";
  return envelope({
    domain: "quiz",
    scoreDirection: SCORE_DIRECTIONS.HIGHER_IS_BETTER,
    bounds: [0, 1],
    value: result.score,
    tags: [result.status],
    evidence: { cases: result.cases ?? [], passedCases: result.passedCases ?? 0, totalCases: result.totalCases ?? 0 },
    uncertainty: null,
    abstained,
    reason: abstained ? result.status : null,
  });
}

/**
 * Normalize `explanation-grader.mjs`'s own `gradeExplanation` result,
 * unmodified. `gradeExplanation` has no abstention concept today (every
 * submission, including an empty one, produces a score), so this record's
 * abstention is always `{ abstained: false, reason: null }` — reported
 * honestly rather than invented.
 */
export function normalizeExplanationScale(result) {
  return envelope({
    domain: "explanation",
    scoreDirection: SCORE_DIRECTIONS.HIGHER_IS_BETTER,
    bounds: [0, 1],
    value: result.score,
    tags: [result.band],
    evidence: { criteria: result.criteria, contradictions: result.contradictions, citations: result.citations },
    uncertainty: null,
    abstained: false,
    reason: null,
  });
}

/**
 * Normalize `program-state-tracing.mjs`'s own checkpoint grade
 * (`gradeStateTrace`'s result) as the primary bounded value, and — when a
 * hypothesis grade (`gradeHypothesis`'s result) is also supplied — carry
 * its own already-stated confidence and Brier score through as this
 * record's `uncertainty`, unmodified in both cases. Neither grader
 * abstains today.
 */
export function normalizeTracingScale(checkpointGrade, hypothesisGrade = null) {
  return envelope({
    domain: "tracing",
    scoreDirection: SCORE_DIRECTIONS.HIGHER_IS_BETTER,
    bounds: [0, 1],
    value: checkpointGrade.score,
    tags: hypothesisGrade ? [hypothesisGrade.calibration] : [],
    evidence: {
      results: checkpointGrade.results,
      correct: checkpointGrade.correct,
      omitted: checkpointGrade.omitted,
      swapped: checkpointGrade.swapped,
      wrong: checkpointGrade.wrong,
      hypothesis: hypothesisGrade,
    },
    uncertainty: hypothesisGrade
      ? { kind: "stated-confidence", value: hypothesisGrade.confidence, calibration: hypothesisGrade.calibration, brier: hypothesisGrade.brier }
      : null,
    abstained: false,
    reason: null,
  });
}

/**
 * Normalize `transfer-curriculum.mjs`'s own `evaluateTransferGain` result,
 * unmodified. `gain` is a genuinely unbounded signed difference (a
 * transferred skill can outperform the home-repository baseline by any
 * margin), so `bounds` is honestly `null` rather than a fabricated range —
 * which in turn makes `ratingLevel` honestly `null` for this domain: a
 * four-rung taxonomy cannot be thresholded onto an unbounded value without
 * inventing a scale nobody measured.
 */
export function normalizeTransferScale(result) {
  return envelope({
    domain: "transfer",
    scoreDirection: SCORE_DIRECTIONS.HIGHER_IS_BETTER,
    bounds: null,
    value: result.gain,
    tags: [result.verdict],
    evidence: { preScore: result.preScore, postScore: result.postScore, leak: result.leak },
    uncertainty: null,
    abstained: false,
    reason: null,
  });
}

/**
 * Normalize an `analytics.mjs`-shaped `rate()` result, unmodified — used
 * for retention in this cycle, but the same `{ value, samples, reason,
 * required }` shape every sample-floored rate in that module already
 * produces. A `null` value is `rate()`'s own real
 * `"insufficient-evidence"` abstention, never re-derived here.
 */
export function normalizeRetentionScale(rateResult) {
  const abstained = rateResult.value === null;
  return envelope({
    domain: "retention",
    scoreDirection: SCORE_DIRECTIONS.HIGHER_IS_BETTER,
    bounds: [0, 1],
    value: rateResult.value,
    tags: [],
    evidence: { samples: rateResult.samples, required: rateResult.required },
    uncertainty: null,
    abstained,
    reason: abstained ? rateResult.reason : null,
  });
}

/**
 * Normalize `accessibility-learning-experiments.mjs`'s own
 * `evaluateDifficultyEquivalence` result, unmodified. The equivalence
 * `margin` *is* the real bound (`[-margin, margin]`), reused rather than
 * invented; the comparison's own already-computed 95% interval
 * (`analyzeExperiment`'s `interval`, carried through unmodified) becomes
 * this record's `uncertainty`. An `"underpowered"` verdict is the real
 * grader's own abstention.
 */
export function normalizeAccessibilityScale(equivalence) {
  const abstained = equivalence.verdict === "underpowered";
  return envelope({
    domain: "accessibility",
    scoreDirection: SCORE_DIRECTIONS.CLOSER_TO_ZERO_IS_BETTER,
    bounds: abstained ? null : [-equivalence.margin, equivalence.margin],
    value: abstained ? null : equivalence.difference,
    tags: [equivalence.verdict],
    evidence: { margin: equivalence.margin },
    uncertainty: abstained ? null : { kind: "confidence-interval", interval: equivalence.interval },
    abstained,
    reason: abstained ? "underpowered" : null,
  });
}

/** Round a normalized record's own numeric fields for stable display/storage. */
export function renderNormalizedScale(record) {
  return {
    ...record,
    value: record.value === null ? null : round(record.value),
    bounds: record.bounds ? record.bounds.map((bound) => round(bound)) : null,
  };
}
