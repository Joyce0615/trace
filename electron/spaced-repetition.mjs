/**
 * Spaced repetition, forgetting curves, and mastery decay.
 *
 * Mastery recorded once is not mastery held. Everything before this module
 * treated a completed lesson as permanent, which quietly overstates what a
 * learner can still do a month later. This module adds the missing time axis:
 *
 *   - a forgetting curve per skill, parameterised so that `stability` is simply
 *     "days until recall falls to the target retention". That makes the number
 *     readable (`stability = 12` means "you will still recall this in 12 days")
 *     instead of an opaque decay constant;
 *   - a review scheduler that grows stability more when a successful recall was
 *     *hard* (the spacing effect) and shrinks it on a lapse, so the schedule
 *     reflects retrieval difficulty rather than raw attendance;
 *   - mastery decay, reported separately from recorded mastery, so the skill
 *     map can say "you knew this, it has faded" without erasing the evidence;
 *   - source-change invalidation: retention of code that has since changed is
 *     not evidence, so a changed source fingerprint resets stability and puts
 *     the skill at the front of the queue.
 *
 * Everything is deterministic and takes `now` explicitly, so a schedule can be
 * tested at any point on the curve without waiting for real time to pass. The
 * module has no Node dependencies, so the browser demo runs this exact code.
 */

export const SPACED_REPETITION_VERSION = 1;

export const DEFAULT_SCHEDULER = {
  /** Recall probability at which a skill becomes due. */
  targetRetention: 0.9,
  /** Stability, in days, granted by a first `good` recall. */
  initialStabilityDays: 1,
  minimumStabilityDays: 0.25,
  maximumStabilityDays: 365,
  initialDifficulty: 2.2,
  difficultyFloor: 1.3,
  difficultyCeiling: 2.9,
  /** A lapse keeps some of the old stability: relearning is faster than learning. */
  lapseStabilityFactor: 0.4,
  /** Forgetting never returns a skill all the way to zero. */
  masteryFloor: 0.25,
  /** How far one review moves recorded mastery toward the graded strength. */
  masteryLearningRate: 0.35,
  dailyLimit: 12,
};

/**
 * The four review outcomes. `strength` is the evidence strength recorded for
 * calibration; `stabilityGain` is how much this outcome multiplies the interval.
 */
export const REVIEW_GRADES = {
  again: { id: "again", label: "Forgot", recalled: false, strength: 0, stabilityGain: 0, difficultyDelta: 0.6, firstStabilityDays: 0.25 },
  hard: { id: "hard", label: "Hard", recalled: true, strength: 0.5, stabilityGain: 0.6, difficultyDelta: 0.15, firstStabilityDays: 0.6 },
  good: { id: "good", label: "Good", recalled: true, strength: 0.8, stabilityGain: 1, difficultyDelta: 0, firstStabilityDays: 1 },
  easy: { id: "easy", label: "Easy", recalled: true, strength: 1, stabilityGain: 1.5, difficultyDelta: -0.2, firstStabilityDays: 2.5 },
};

export const REVIEW_GRADE_IDS = Object.keys(REVIEW_GRADES);

const DAY_MS = 86_400_000;

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * Merge caller options over the defaults.
 *
 * Callers routinely forward optional request fields straight through
 * (`{ now: request.now, dailyLimit: request.dailyLimit }`), and a plain spread
 * would let an absent field overwrite a default with `undefined`. That produced
 * a `NaN` daily limit and an empty queue while the summary still reported work
 * as due, so undefined entries are dropped rather than merged.
 */
function withDefaults(options) {
  const merged = { ...DEFAULT_SCHEDULER };
  for (const [key, value] of Object.entries(options ?? {})) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

function toTime(value, fallback) {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : fallback;
}

/**
 * Recall probability after `elapsedDays`.
 *
 * `stability` is calibrated so that R(stability) === targetRetention exactly,
 * which is what makes the number meaningful to a learner.
 */
export function retention(elapsedDays, stabilityDays, options = {}) {
  const target = options.targetRetention ?? DEFAULT_SCHEDULER.targetRetention;
  const stability = Math.max(1e-6, Number(stabilityDays) || 0);
  const elapsed = Math.max(0, Number(elapsedDays) || 0);
  return clamp(target ** (elapsed / stability), 0, 1);
}

/** Days until recall decays to `wanted`, the inverse of `retention`. */
export function intervalForRetention(stabilityDays, wanted, options = {}) {
  const target = options.targetRetention ?? DEFAULT_SCHEDULER.targetRetention;
  const stability = Math.max(1e-6, Number(stabilityDays) || 0);
  const level = clamp(Number(wanted) || 0, 1e-6, 0.999999);
  return Math.max(0, stability * (Math.log(level) / Math.log(target)));
}

/** The scheduling state carried on a `SkillMastery`, with defaults filled in. */
export function reviewStateOf(mastery, options = {}) {
  const parameters = withDefaults(options);
  const saved = mastery?.review ?? null;
  return {
    stability: clamp(Number(saved?.stability) || parameters.initialStabilityDays, parameters.minimumStabilityDays, parameters.maximumStabilityDays),
    difficulty: clamp(Number(saved?.difficulty) || parameters.initialDifficulty, parameters.difficultyFloor, parameters.difficultyCeiling),
    reviews: Math.max(0, Math.trunc(Number(saved?.reviews) || 0)),
    lapses: Math.max(0, Math.trunc(Number(saved?.lapses) || 0)),
    lastReviewedAt: typeof saved?.lastReviewedAt === "string" ? saved.lastReviewedAt : null,
    lastGrade: typeof saved?.lastGrade === "string" ? saved.lastGrade : null,
  };
}

/**
 * Apply one graded recall attempt to a scheduling state.
 *
 * The stability multiplier deliberately rewards *difficult* successful recalls:
 * `spacingBonus` rises as retrievability falls, so reviewing a skill the moment
 * after learning it barely extends the interval while recalling it when it had
 * nearly faded extends it a lot. That is the spacing effect, and without it a
 * scheduler just rewards clicking.
 */
export function gradeReview(state, request = {}) {
  const parameters = withDefaults(request.parameters);
  const grade = REVIEW_GRADES[request.grade] ?? null;
  if (!grade) throw new Error(`Unknown review grade: ${request.grade}`);
  const previous = reviewStateOf({ review: state }, parameters);
  const nowTime = toTime(request.now, Date.now());
  const elapsedDays = typeof request.elapsedDays === "number"
    ? Math.max(0, request.elapsedDays)
    : previous.lastReviewedAt
      ? Math.max(0, (nowTime - toTime(previous.lastReviewedAt, nowTime)) / DAY_MS)
      : 0;
  const retrievability = previous.reviews > 0 ? retention(elapsedDays, previous.stability, parameters) : null;
  const difficulty = clamp(previous.difficulty + grade.difficultyDelta, parameters.difficultyFloor, parameters.difficultyCeiling);

  let stability;
  if (previous.reviews === 0) {
    // First exposure: the grade itself sets the starting interval.
    stability = grade.firstStabilityDays * (parameters.initialStabilityDays / DEFAULT_SCHEDULER.initialStabilityDays);
  } else if (!grade.recalled) {
    // A lapse costs interval but keeps a relearning head start; repeated lapses cost more.
    stability = previous.stability * parameters.lapseStabilityFactor * 0.9 ** previous.lapses;
  } else {
    const spacingBonus = 1 + 2 * (1 - retrievability);
    stability = previous.stability * (1 + grade.stabilityGain * spacingBonus / difficulty);
  }
  stability = clamp(stability, parameters.minimumStabilityDays, parameters.maximumStabilityDays);

  const nextState = {
    stability: round(stability),
    difficulty: round(difficulty),
    reviews: previous.reviews + 1,
    lapses: previous.lapses + (grade.recalled ? 0 : 1),
    lastReviewedAt: new Date(nowTime).toISOString(),
    lastGrade: grade.id,
  };
  return {
    version: SPACED_REPETITION_VERSION,
    grade: grade.id,
    recalled: grade.recalled,
    strength: grade.strength,
    elapsedDays: round(elapsedDays),
    retrievability: retrievability === null ? null : round(retrievability),
    previous: { stability: previous.stability, difficulty: previous.difficulty, reviews: previous.reviews, lapses: previous.lapses },
    state: nextState,
    intervalDays: round(stability),
    dueAt: new Date(nowTime + stability * DAY_MS).toISOString(),
  };
}

/**
 * Recorded mastery seen through the forgetting curve. The floor encodes that a
 * skill once held is never fully lost, which is why the report always keeps the
 * recorded value alongside the decayed one.
 */
export function decayedMastery(recorded, retentionNow, options = {}) {
  const parameters = withDefaults(options);
  const base = clamp(Number(recorded) || 0, 0, 1);
  if (retentionNow === null || retentionNow === undefined) return round(base);
  const factor = parameters.masteryFloor + (1 - parameters.masteryFloor) * clamp(retentionNow, 0, 1);
  return round(base * factor);
}

/** Sampled points on one skill's forgetting curve, for drawing. */
export function forgettingCurve(state, options = {}) {
  const parameters = withDefaults(options);
  const stability = clamp(Number(state?.stability) || parameters.initialStabilityDays, parameters.minimumStabilityDays, parameters.maximumStabilityDays);
  const horizon = options.horizonDays ?? Math.max(1, stability * 3);
  const points = Math.max(2, Math.trunc(options.points ?? 12));
  return {
    stabilityDays: round(stability),
    horizonDays: round(horizon),
    dueDay: round(stability),
    points: Array.from({ length: points }, (_unused, index) => {
      const day = (horizon * index) / (points - 1);
      return { day: round(day, 3), retention: round(retention(day, stability, parameters)) };
    }),
  };
}

/**
 * Schedule one skill. A skill whose source fingerprint no longer matches the
 * index is `stale`: whatever the learner retained, they retained about code
 * that has since changed, so the retention estimate is withheld rather than
 * reported as if it still applied.
 */
export function scheduleSkill(mastery, node, options = {}) {
  const parameters = withDefaults(options);
  const nowTime = toTime(options.now, Date.now());
  const state = reviewStateOf(mastery, parameters);
  const sourceChanged = Boolean(node?.sourceFingerprint)
    && Boolean(mastery?.sourceFingerprint)
    && node.sourceFingerprint !== mastery.sourceFingerprint;
  const recorded = clamp(Number(mastery?.mastery) || 0, 0, 1);
  const importance = clamp((Number(node?.importance) || 50) / 100, 0, 1);

  if (sourceChanged) {
    return {
      skillId: node?.id ?? mastery?.skillId ?? null,
      title: node?.title ?? null,
      state: "stale",
      reason: "source-changed",
      explanation: "The source behind this skill changed, so the previous recall no longer proves anything.",
      recordedMastery: round(recorded),
      retention: null,
      retainedMastery: round(recorded * parameters.masteryFloor),
      stability: parameters.minimumStabilityDays,
      difficulty: state.difficulty,
      reviews: state.reviews,
      lapses: state.lapses,
      lastReviewedAt: state.lastReviewedAt,
      elapsedDays: null,
      dueAt: new Date(nowTime).toISOString(),
      overdueDays: 0,
      due: true,
      priority: round(3 + importance),
      anchors: node?.anchors ?? [],
    };
  }

  if (state.reviews === 0) {
    const locked = mastery?.status === "locked";
    return {
      skillId: node?.id ?? mastery?.skillId ?? null,
      title: node?.title ?? null,
      state: locked ? "locked" : "new",
      reason: locked ? "prerequisite-pending" : "never-reviewed",
      explanation: locked
        ? "A prerequisite skill has not been reached yet."
        : "This skill has never been recalled from memory, only read.",
      recordedMastery: round(recorded),
      retention: null,
      retainedMastery: round(recorded * parameters.masteryFloor),
      stability: state.stability,
      difficulty: state.difficulty,
      reviews: 0,
      lapses: state.lapses,
      lastReviewedAt: null,
      elapsedDays: null,
      dueAt: new Date(nowTime).toISOString(),
      overdueDays: 0,
      due: !locked,
      priority: locked ? 0 : round(0.5 + importance * 0.5),
      anchors: node?.anchors ?? [],
    };
  }

  const elapsedDays = Math.max(0, (nowTime - toTime(state.lastReviewedAt, nowTime)) / DAY_MS);
  const retentionNow = retention(elapsedDays, state.stability, parameters);
  const overdueDays = elapsedDays - state.stability;
  const due = overdueDays >= 0;
  const lapsed = state.lastGrade === "again";
  return {
    skillId: node?.id ?? mastery?.skillId ?? null,
    title: node?.title ?? null,
    state: lapsed ? "relearning" : due ? "due" : "retained",
    reason: lapsed ? "recent-lapse" : due ? "retention-below-target" : "on-track",
    explanation: due
      ? `Recall has decayed to ${Math.round(retentionNow * 100)}%, below the ${Math.round(parameters.targetRetention * 100)}% target.`
      : `Recall is still ${Math.round(retentionNow * 100)}%; the next review is scheduled, not overdue.`,
    recordedMastery: round(recorded),
    retention: round(retentionNow),
    retainedMastery: decayedMastery(recorded, retentionNow, parameters),
    stability: state.stability,
    difficulty: state.difficulty,
    reviews: state.reviews,
    lapses: state.lapses,
    lastReviewedAt: state.lastReviewedAt,
    elapsedDays: round(elapsedDays),
    dueAt: new Date(toTime(state.lastReviewedAt, nowTime) + state.stability * DAY_MS).toISOString(),
    overdueDays: round(overdueDays),
    due,
    // Lapsed material outranks ordinary reviews at the same retention because a
    // second failure is more expensive than a first.
    priority: due ? round((lapsed ? 1.5 : 1) + (1 - retentionNow) + clamp(overdueDays / state.stability, 0, 1)) : round(retentionNow * 0.1),
    anchors: node?.anchors ?? [],
  };
}

/**
 * Order the review queue.
 *
 * Stale skills come first (their evidence is invalid), then due reviews worst
 * first, then never-reviewed skills. Reviews outrank new material because
 * forgetting is happening now while new material can wait a day without cost.
 * The final pass enforces prerequisites: a skill never appears before a
 * prerequisite that is itself queued, so a learner is never asked to recall
 * something built on a foundation they are about to be shown they have lost.
 */
export function orderQueue(entries, skillGraph) {
  const rank = { stale: 0, relearning: 1, due: 1, new: 2 };
  const ordered = [...entries].sort((left, right) => {
    const bucket = (rank[left.state] ?? 3) - (rank[right.state] ?? 3);
    if (bucket !== 0) return bucket;
    if (right.priority !== left.priority) return right.priority - left.priority;
    return String(left.skillId).localeCompare(String(right.skillId));
  });

  const prerequisites = new Map((skillGraph?.nodes ?? []).map((node) => [node.id, node.prerequisites ?? []]));
  const queued = new Set(ordered.map((entry) => entry.skillId));
  const emitted = new Set();
  const result = [];
  const pending = [...ordered];
  while (pending.length) {
    const index = pending.findIndex((entry) => (prerequisites.get(entry.skillId) ?? [])
      .every((id) => !queued.has(id) || emitted.has(id)));
    // A prerequisite cycle would deadlock the queue; fall back to priority order.
    const [next] = pending.splice(index === -1 ? 0 : index, 1);
    emitted.add(next.skillId);
    result.push(next);
  }
  return result;
}

/**
 * The whole review plan for one learner: what is due now, what has quietly
 * decayed, and what the curve says will happen next.
 */
export function reviewPlan(learnerState, skillGraph, options = {}) {
  const parameters = withDefaults(options);
  const nowTime = toTime(options.now, Date.now());
  const now = new Date(nowTime).toISOString();
  const entries = (skillGraph?.nodes ?? []).map((node) => scheduleSkill(learnerState?.mastery?.[node.id], node, { ...parameters, now }));
  const actionable = entries.filter((entry) => entry.due && entry.state !== "locked");
  const dailyLimit = Math.max(1, Math.trunc(Number(parameters.dailyLimit) || DEFAULT_SCHEDULER.dailyLimit));
  const queue = orderQueue(actionable, skillGraph).slice(0, dailyLimit);
  const upcoming = entries
    .filter((entry) => !entry.due && entry.state === "retained")
    .sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt));

  const withRetention = entries.filter((entry) => entry.retention !== null);
  const recordedTotal = entries.reduce((sum, entry) => sum + entry.recordedMastery, 0);
  const retainedTotal = entries.reduce((sum, entry) => sum + entry.retainedMastery, 0);
  return {
    version: SPACED_REPETITION_VERSION,
    generatedAt: now,
    parameters: { targetRetention: parameters.targetRetention, dailyLimit, masteryFloor: parameters.masteryFloor },
    queue,
    upcoming: upcoming.slice(0, 12),
    skills: entries,
    curves: Object.fromEntries(queue.slice(0, 6).map((entry) => [entry.skillId, forgettingCurve(entry, parameters)])),
    summary: {
      skills: entries.length,
      due: actionable.length,
      queued: queue.length,
      stale: entries.filter((entry) => entry.state === "stale").length,
      new: entries.filter((entry) => entry.state === "new").length,
      relearning: entries.filter((entry) => entry.state === "relearning").length,
      retained: entries.filter((entry) => entry.state === "retained").length,
      locked: entries.filter((entry) => entry.state === "locked").length,
      meanRetention: withRetention.length
        ? round(withRetention.reduce((sum, entry) => sum + entry.retention, 0) / withRetention.length)
        : null,
      // The headline the learner actually needs: how much of what they recorded
      // they can still produce today.
      recordedMastery: round(entries.length ? recordedTotal / entries.length : 0),
      retainedMastery: round(entries.length ? retainedTotal / entries.length : 0),
      decayLoss: round(entries.length ? (recordedTotal - retainedTotal) / entries.length : 0),
      nextDueAt: upcoming[0]?.dueAt ?? null,
    },
  };
}

/**
 * Record one review into the learner state and return the updated state.
 *
 * Reviewing a stale skill re-fingerprints it: the learner has now demonstrated
 * recall against the current source, which is exactly what staleness was
 * waiting for.
 */
export function applyReview(learnerState, skillGraph, request = {}) {
  const parameters = withDefaults(request.parameters);
  const node = (skillGraph?.nodes ?? []).find((candidate) => candidate.id === request.skillId);
  if (!node) throw new Error("That skill is not part of this repository's skill graph.");
  if (!REVIEW_GRADES[request.grade]) throw new Error(`Unknown review grade: ${request.grade}`);
  const nowTime = toTime(request.now, Date.now());
  const now = new Date(nowTime).toISOString();
  const previous = learnerState?.mastery?.[node.id] ?? { skillId: node.id, mastery: 0, confidence: 0, status: "available", evidence: [] };
  const sourceChanged = Boolean(node.sourceFingerprint) && Boolean(previous.sourceFingerprint) && node.sourceFingerprint !== previous.sourceFingerprint;
  // A stale skill starts its curve again: the code it was about is different now.
  const startingState = sourceChanged
    ? { ...reviewStateOf(previous, parameters), reviews: 0, stability: parameters.minimumStabilityDays }
    : reviewStateOf(previous, parameters);
  const graded = gradeReview(startingState, { grade: request.grade, now, parameters });

  const recorded = clamp(Number(previous.mastery) || 0, 0, 1);
  const nextMastery = clamp(recorded + (graded.strength - recorded) * parameters.masteryLearningRate, 0, 1);
  const evidence = [
    ...(Array.isArray(previous.evidence) ? previous.evidence : []),
    {
      id: `review-${node.id}-${nowTime}`,
      skillId: node.id,
      kind: "review",
      strength: graded.strength,
      detail: `Spaced review graded ${graded.grade} after ${graded.elapsedDays} day(s).`,
      createdAt: now,
    },
  ].slice(-30);

  const nextState = {
    ...learnerState,
    mastery: {
      ...(learnerState?.mastery ?? {}),
      [node.id]: {
        ...previous,
        skillId: node.id,
        mastery: round(nextMastery),
        // Staleness is detected from the fingerprint, so it must be cleared from
        // the fingerprint too: a record still labelled "mastered" whose source
        // changed is exactly as stale as one labelled "stale", and reviewing it
        // is what re-establishes the claim. A forgotten skill leaves "mastered".
        status: sourceChanged || previous.status === "stale"
          ? "active"
          : graded.recalled
            ? previous.status
            : previous.status === "mastered" ? "active" : previous.status,
        sourceFingerprint: node.sourceFingerprint ?? previous.sourceFingerprint,
        evidence,
        review: graded.state,
      },
    },
    updatedAt: now,
  };

  const plan = reviewPlan(nextState, skillGraph, { ...parameters, now });
  return {
    learnerState: nextState,
    review: graded,
    // A successful review removes the skill from the queue, so its new curve
    // would otherwise vanish at exactly the moment the learner earned it.
    plan: { ...plan, curves: { ...plan.curves, [node.id]: forgettingCurve(graded.state, parameters) } },
  };
}
