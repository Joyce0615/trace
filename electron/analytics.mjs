import { retention as modelledRetention, reviewStateOf } from "./spaced-repetition.mjs";

/**
 * Learning analytics: retention, transfer, time-on-task, and hint dependence.
 *
 * Four measures, reported separately and never averaged — for the same reason
 * item 34 refuses a combined quality score. A learner who retains well but
 * cannot transfer, and one who transfers well but has not revisited anything,
 * have different problems, and a single "learning score" would hide both.
 *
 * The design constraint that matters here is honesty about the evidence:
 *
 *   - **Every rate states its sample size**, and a rate computed from fewer
 *     than `MIN_SAMPLE` observations is reported as `null` with the reason
 *     `insufficient-evidence` rather than as a confident-looking percentage.
 *     Three activities is not a retention curve.
 *   - **Retention is reported twice**: what the item-36 model predicts, and
 *     what the learner actually recalled at each delay. Where those disagree,
 *     the model is wrong about this learner, and saying so is the point.
 *   - **Time-on-task is time between recorded events**, which is not attention.
 *     It is labelled that way, gaps longer than the session threshold are
 *     excluded rather than counted, and the report says how much was excluded.
 *
 * The module is Node-free and takes an event log as a parameter, so the browser
 * demo runs the same analytics.
 */

export const ANALYTICS_VERSION = 1;

/** Below this many observations a rate is not reported at all. */
export const MIN_SAMPLE = 3;

/** A gap longer than this ends a working session rather than being counted. */
export const SESSION_GAP_MS = 30 * 60 * 1000;

/** Delay buckets, in days, for the measured retention curve. */
export const RETENTION_BUCKETS = [
  { id: "same-day", maxDays: 1, label: "under a day" },
  { id: "days", maxDays: 7, label: "1–7 days" },
  { id: "weeks", maxDays: 30, label: "1–4 weeks" },
  { id: "months", maxDays: Number.POSITIVE_INFINITY, label: "over a month" },
];

const GRADED_KINDS = new Set(["executable-quiz", "explanation", "teach-back", "prediction", "contrast", "call-chain", "localization", "race", "probe", "review"]);

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

/** A rate that refuses to exist below the sample floor. */
export function rate(successes, total, minimum = MIN_SAMPLE) {
  if (total < minimum) return { value: null, samples: total, reason: "insufficient-evidence", required: minimum };
  return { value: round(successes / total), samples: total, reason: null, required: minimum };
}

function timeOf(event) {
  const parsed = Date.parse(event?.at ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

/** Events sorted oldest first, with unusable entries dropped. */
export function normalizeEvents(events) {
  return (events ?? [])
    .filter((event) => event && typeof event.kind === "string" && timeOf(event) !== null)
    .map((event) => ({ ...event, time: timeOf(event) }))
    .sort((left, right) => left.time - right.time);
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Modelled retention (item 36's curve) alongside what the learner actually
 * recalled at each delay. A model that disagrees with the observations is
 * reported as disagreeing, not quietly trusted.
 */
export function retentionAnalytics(events, learnerState, skillGraph, options = {}) {
  const now = Date.parse(options.now ?? new Date().toISOString());
  const nodes = skillGraph?.nodes ?? [];
  const modelled = [];
  for (const node of nodes) {
    const mastery = learnerState?.mastery?.[node.id];
    const state = reviewStateOf(mastery);
    if (!state.reviews || !state.lastReviewedAt) continue;
    const elapsedDays = Math.max(0, (now - Date.parse(state.lastReviewedAt)) / 86_400_000);
    modelled.push({
      skillId: node.id,
      title: node.title,
      elapsedDays: round(elapsedDays, 2),
      predicted: round(modelledRetention(elapsedDays, state.stability)),
      stability: state.stability,
    });
  }

  const recalls = normalizeEvents(events).filter((event) => event.kind === "review" && typeof event.elapsedDays === "number");
  const buckets = RETENTION_BUCKETS.map((bucket, index) => {
    const lower = index === 0 ? 0 : RETENTION_BUCKETS[index - 1].maxDays;
    const inBucket = recalls.filter((event) => event.elapsedDays >= lower && event.elapsedDays < bucket.maxDays);
    const succeeded = inBucket.filter((event) => event.correct).length;
    const predicted = inBucket.length
      ? round(inBucket.reduce((sum, event) => sum + modelledRetention(event.elapsedDays, event.stability ?? 1), 0) / inBucket.length)
      : null;
    const observed = rate(succeeded, inBucket.length);
    return {
      id: bucket.id,
      label: bucket.label,
      observed,
      predicted,
      // Only meaningful once both numbers exist.
      gap: observed.value === null || predicted === null ? null : round(observed.value - predicted),
    };
  });

  const measured = buckets.filter((bucket) => bucket.gap !== null);
  return {
    kind: "retention",
    trackedSkills: modelled.length,
    meanPredicted: modelled.length ? round(modelled.reduce((sum, item) => sum + item.predicted, 0) / modelled.length) : null,
    weakest: [...modelled].sort((left, right) => left.predicted - right.predicted)[0] ?? null,
    recalls: recalls.length,
    successRate: rate(recalls.filter((event) => event.correct).length, recalls.length),
    buckets,
    // A positive calibration gap means the learner remembers more than the model
    // expects, which is a reason to lengthen their intervals.
    modelGap: measured.length ? round(measured.reduce((sum, bucket) => sum + bucket.gap, 0) / measured.length) : null,
    modelVerdict: !measured.length
      ? "not-enough-reviews"
      : Math.abs(measured.reduce((sum, bucket) => sum + bucket.gap, 0) / measured.length) <= 0.15
        ? "model-matches-learner"
        : (measured.reduce((sum, bucket) => sum + bucket.gap, 0) / measured.length) > 0
          ? "learner-outperforms-model"
          : "learner-forgets-faster-than-model",
  };
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

/**
 * Does what the learner studied help where they have not been?
 *
 * An activity is *near* transfer if it touches a file the learner has already
 * worked in, and *far* transfer if it does not. The gap between those two
 * success rates is the number worth looking at: high near and low far means the
 * learner has memorised a neighbourhood rather than learned the codebase.
 */
export function transferAnalytics(events, learnerState, options = {}) {
  const ordered = normalizeEvents(events).filter((event) => GRADED_KINDS.has(event.kind) && typeof event.correct === "boolean");
  // Studied ground is what the learner *read*: files they opened, and files
  // anchored to a skill they have mastery in. Doing an exercise about a file is
  // an attempt, not study, so an activity never reclassifies itself as near.
  const studied = new Set(options.studiedPaths ?? []);
  for (const anchor of options.masteredAnchors ?? []) studied.add(anchor);

  const classified = ordered.map((event) => ({
    ...event,
    transfer: event.path ? (studied.has(event.path) ? "near" : "far") : "unanchored",
  }));

  const near = classified.filter((event) => event.transfer === "near");
  const far = classified.filter((event) => event.transfer === "far");
  const nearRate = rate(near.filter((event) => event.correct).length, near.length);
  const farRate = rate(far.filter((event) => event.correct).length, far.length);
  return {
    kind: "transfer",
    activities: classified.length,
    studiedFiles: studied.size,
    novelFiles: new Set(far.map((event) => event.path)).size,
    near: nearRate,
    far: farRate,
    gap: nearRate.value === null || farRate.value === null ? null : round(nearRate.value - farRate.value),
    verdict: nearRate.value === null || farRate.value === null
      ? "insufficient-evidence"
      : nearRate.value - farRate.value > 0.3
        ? "familiar-ground-only"
        : farRate.value >= nearRate.value
          ? "transfers-freely"
          : "transfers-with-effort",
    byKind: [...new Set(classified.map((event) => event.kind))].map((kind) => {
      const forKind = classified.filter((event) => event.kind === kind);
      return { kind, attempts: forKind.length, success: rate(forKind.filter((event) => event.correct).length, forKind.length) };
    }),
  };
}

// ---------------------------------------------------------------------------
// Time on task
// ---------------------------------------------------------------------------

/**
 * Sessions and active minutes derived from the gaps between recorded events.
 *
 * This is time *between recorded actions*, not attention: a learner who leaves
 * the app open contributes nothing until they act again. Gaps longer than the
 * session threshold are excluded rather than counted, and the report says how
 * much time was excluded so the number is not mistaken for wall-clock usage.
 */
export function timeOnTaskAnalytics(events, options = {}) {
  const ordered = normalizeEvents(events);
  const gapMs = options.sessionGapMs ?? SESSION_GAP_MS;
  if (!ordered.length) {
    return { kind: "time-on-task", sessions: 0, events: 0, activeMs: 0, excludedMs: 0, medianSessionMs: 0, byKind: [], longestSessionMs: 0, note: "No recorded activity yet." };
  }

  const sessions = [];
  let current = { start: ordered[0].time, end: ordered[0].time, events: 1 };
  let excludedMs = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const gap = ordered[index].time - ordered[index - 1].time;
    if (gap > gapMs) {
      sessions.push(current);
      excludedMs += gap;
      current = { start: ordered[index].time, end: ordered[index].time, events: 1 };
    } else {
      current.end = ordered[index].time;
      current.events += 1;
    }
  }
  sessions.push(current);

  const durations = sessions.map((session) => session.end - session.start).sort((left, right) => left - right);
  const activeMs = durations.reduce((sum, value) => sum + value, 0);
  const byKind = [...new Set(ordered.map((event) => event.kind))].map((kind) => ({
    kind,
    events: ordered.filter((event) => event.kind === kind).length,
  })).sort((left, right) => right.events - left.events);

  return {
    kind: "time-on-task",
    sessions: sessions.length,
    events: ordered.length,
    activeMs,
    activeMinutes: round(activeMs / 60_000, 2),
    excludedMs,
    excludedMinutes: round(excludedMs / 60_000, 2),
    medianSessionMs: durations[Math.floor(durations.length / 2)] ?? 0,
    longestSessionMs: durations.at(-1) ?? 0,
    eventsPerSession: round(ordered.length / sessions.length, 2),
    firstAt: new Date(ordered[0].time).toISOString(),
    lastAt: new Date(ordered.at(-1).time).toISOString(),
    byKind,
    note: "Measured between recorded actions; idle time longer than the session gap is excluded, not counted.",
  };
}

// ---------------------------------------------------------------------------
// Hint dependence
// ---------------------------------------------------------------------------

/**
 * How much the learner leans on scaffolding, and whether that is changing.
 *
 * The trend matters more than the level: needing hints on a hard new area is
 * fine, still needing them on the same material after several attempts is not.
 */
export function hintAnalytics(events, options = {}) {
  const ordered = normalizeEvents(events);
  const attempts = ordered.filter((event) => GRADED_KINDS.has(event.kind));
  const hinted = attempts.filter((event) => (event.hints ?? 0) > 0);
  const unhinted = attempts.filter((event) => (event.hints ?? 0) === 0);
  const scored = (list) => {
    const withScore = list.filter((event) => typeof event.score === "number");
    return withScore.length >= MIN_SAMPLE
      ? round(withScore.reduce((sum, event) => sum + event.score, 0) / withScore.length)
      : null;
  };

  const half = Math.floor(attempts.length / 2);
  const early = attempts.slice(0, half);
  const late = attempts.slice(attempts.length - half);
  const hintRateFor = (list) => (list.length ? list.reduce((sum, event) => sum + (event.hints ?? 0), 0) / list.length : null);
  const earlyRate = hintRateFor(early);
  const lateRate = hintRateFor(late);

  return {
    kind: "hint-dependence",
    attempts: attempts.length,
    hintsRevealed: attempts.reduce((sum, event) => sum + (event.hints ?? 0), 0),
    hintedAttempts: hinted.length,
    hintedShare: rate(hinted.length, attempts.length),
    hintsPerAttempt: attempts.length ? round(attempts.reduce((sum, event) => sum + (event.hints ?? 0), 0) / attempts.length) : 0,
    // Success with and without help, so "I only got it with a hint" is visible.
    successWithHints: rate(hinted.filter((event) => event.correct).length, hinted.length),
    successWithoutHints: rate(unhinted.filter((event) => event.correct).length, unhinted.length),
    scoreWithHints: scored(hinted),
    scoreWithoutHints: scored(unhinted),
    penaltyCarried: round(attempts.reduce((sum, event) => sum + (event.hintPenalty ?? 0), 0)),
    trend: half < MIN_SAMPLE || earlyRate === null || lateRate === null
      ? { direction: "unknown", reason: "insufficient-evidence", early: null, late: null }
      : {
        direction: lateRate < earlyRate - 0.2 ? "decreasing" : lateRate > earlyRate + 0.2 ? "increasing" : "steady",
        reason: null,
        early: round(earlyRate),
        late: round(lateRate),
      },
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * All four analytics, side by side and deliberately never combined. `warnings`
 * lists the measures that could not be computed and why, so an empty panel is
 * always explained rather than simply blank.
 */
export function analyticsReport(input = {}) {
  const events = normalizeEvents(input.events);
  const report = {
    version: ANALYTICS_VERSION,
    separate: true,
    generatedAt: input.now ?? new Date().toISOString(),
    events: events.length,
    retention: retentionAnalytics(events, input.learnerState, input.skillGraph, { now: input.now }),
    transfer: transferAnalytics(events, input.learnerState, {
      studiedPaths: input.studiedPaths,
      // A skill the learner has mastery in counts its anchors as studied ground.
      masteredAnchors: (input.skillGraph?.nodes ?? [])
        .filter((node) => (input.learnerState?.mastery?.[node.id]?.mastery ?? 0) > 0)
        .flatMap((node) => (node.anchors ?? []).map((anchor) => anchor.path)),
    }),
    timeOnTask: timeOnTaskAnalytics(events, { sessionGapMs: input.sessionGapMs }),
    hints: hintAnalytics(events),
    warnings: [],
  };
  if (report.retention.successRate.value === null) report.warnings.push({ measure: "retention", reason: "insufficient-evidence", have: report.retention.recalls, need: MIN_SAMPLE });
  if (report.transfer.gap === null) report.warnings.push({ measure: "transfer", reason: "insufficient-evidence", have: report.transfer.activities, need: MIN_SAMPLE * 2 });
  if (!report.timeOnTask.events) report.warnings.push({ measure: "time-on-task", reason: "no-recorded-activity", have: 0, need: 1 });
  if (report.hints.trend.direction === "unknown") report.warnings.push({ measure: "hint-dependence", reason: "insufficient-evidence", have: report.hints.attempts, need: MIN_SAMPLE * 2 });
  return report;
}
