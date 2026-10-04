import { redactValue } from "./secret-scanner.mjs";
import { budgetIds } from "./performance.mjs";

/*
 * `PLUGIN_KINDS` is repeated here rather than imported. `plugins.mjs` needs
 * `node:child_process` to run a plugin, and this module is shared with the
 * browser demo, where a Node builtin anywhere in the import closure is a hard
 * failure — there is a structural test that walks the whole closure and rejects
 * one. A test asserts the two lists stay equal, which is the cheap half of the
 * trade and the half that actually breaks.
 */
const PLUGIN_KINDS = ["indexer", "agent", "course-generator", "grader", "visualization"];

/**
 * Opt-in local telemetry (item 60).
 *
 * `docs/privacy.md` says nothing leaves this machine, and item 60 must not make
 * that sentence false. So this is telemetry in the sense of *measuring the
 * application's own behaviour* and nothing else: there is no endpoint, no
 * queue, no identifier, no upload, and no code that could add one. The learner
 * can read what was collected and can delete it. That is the whole product.
 *
 * Four properties do the work, and each of them is a way telemetry usually goes
 * wrong:
 *
 *   - **Opt-in means nothing is recorded.** Not "recorded anonymously", not
 *     "recorded and discarded on withdrawal" — without consent `record` returns
 *     the state it was given and says why. Withdrawal deletes what came before,
 *     because consent that cannot be taken back retroactively is not consent.
 *
 *   - **Free text cannot get in.** There is no string dimension. A dimension is
 *     an enum with a declared value set; an unlisted value becomes `other`. A
 *     measure is a number that is immediately bucketed. There is no field a
 *     file path, a symbol name, a query, or an answer could occupy — which is a
 *     stronger guarantee than redacting them afterwards, because redaction is
 *     something you can forget to call.
 *
 *   - **Cardinality is bounded twice.** Once per dimension, by its value set;
 *     and once per event, by a ceiling on how many distinct dimension
 *     combinations may exist. Beyond that ceiling new combinations collapse
 *     into a single `overflow` series and the collapse is *counted*, so the
 *     report says "31 combinations were folded" rather than quietly losing
 *     them. Unbounded cardinality is how telemetry becomes both a
 *     de-anonymisation vector and a disk-filling bug.
 *
 *   - **Counters, not a stream.** Nothing stores one event at one moment. The
 *     store holds daily counts and bucket histograms. A stream of individually
 *     timestamped events is a behavioural trace of somebody's working day; a
 *     day's counters are not, and cannot be turned back into one.
 *
 * Retention is enforced on read as well as on write, so a file left behind by
 * an old version expires rather than surviving because nothing wrote to it.
 */

export const TELEMETRY_VERSION = 1;
export const TELEMETRY_FORMAT = "trace-telemetry-v1";

/** Days a daily counter survives. */
export const RETENTION_DAYS = 30;

/** Distinct dimension combinations one event may have before folding. */
export const MAX_SERIES_PER_EVENT = 64;

/** Distinct series across everything, so the file cannot grow without bound. */
export const MAX_TOTAL_SERIES = 400;

const YES_NO = ["yes", "no"];

/** Bucket ladders. A duration to the millisecond is a fingerprint; a band is not. */
export const LADDERS = {
  duration: [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000],
  latency: [5, 10, 25, 50, 100, 250, 1_000],
  count: [1, 5, 10, 50, 100, 500, 2_000, 10_000],
};

/**
 * Every event that may be recorded, and every value it may carry.
 *
 * Anything not in this table is refused. That is the design: the schema is an
 * allow list rather than a validator, so adding a field means editing this file
 * — which means somebody reads the privacy consequences at the moment they add
 * it, rather than a year later.
 */
export const TELEMETRY_EVENTS = {
  "repository.opened": {
    what: "How long indexing took and how well it worked. No name, no path, no remote.",
    dimensions: { indexer: ["tree-sitter", "regex", "none"], degraded: YES_NO, size: ["tiny", "small", "medium", "large"] },
    measures: { durationMs: "duration", files: "count" },
  },
  "exercise.graded": {
    what: "Which kind of exercise was graded and roughly how it went. Never the answer, never the score.",
    dimensions: {
      kind: ["call-chain", "localization", "race", "quiz", "explanation", "teach-back", "prediction", "contrast"],
      outcome: ["pass", "partial", "fail"],
      hinted: YES_NO,
    },
    measures: { durationMs: "duration" },
  },
  "search.performed": {
    what: "That a search happened and how fast it was. Never the query.",
    dimensions: { strategy: ["lexical", "symbol", "graph", "embedding", "fused"], hadResults: YES_NO },
    measures: { latencyMs: "latency", results: "count" },
  },
  "review.recorded": {
    what: "A spaced-repetition review, by grade. Never the skill.",
    dimensions: { grade: ["again", "hard", "good", "easy"], overdue: YES_NO },
    measures: {},
  },
  "agent.asked": {
    what: "That a local agent was asked something, and whether the cache answered. Never the question.",
    dimensions: { provider: ["codex", "claude"], mode: ["lean", "balanced", "deep"], cached: YES_NO },
    measures: { latencyMs: "duration" },
  },
  "panel.viewed": {
    what: "Which panel was opened, and how long the switch took.",
    dimensions: { panel: ["lesson", "diagram", "code", "chains", "locate", "review", "notes"] },
    measures: { switchMs: "latency" },
  },
  "plugin.ran": {
    what: "That an extension ran and how it ended. Never its id, which would identify the learner's setup.",
    dimensions: { kind: PLUGIN_KINDS, outcome: ["ok", "refused", "timeout", "error"] },
    measures: { durationMs: "duration" },
  },
  "budget.exceeded": {
    what: "A performance budget crossed its warning or failure line.",
    dimensions: { budget: budgetIds(), verdict: ["warn", "fail"] },
    measures: {},
  },
};

export function telemetryEventNames() {
  return Object.keys(TELEMETRY_EVENTS).sort();
}

/** A fresh, empty, consent-less state. */
export function createTelemetryState() {
  return {
    format: TELEMETRY_FORMAT,
    version: TELEMETRY_VERSION,
    consent: { granted: false, changedAt: null },
    series: [],
    folded: { dimensionValues: 0, series: 0 },
    // Where this goes. Recorded in the file so the answer travels with it.
    destination: "local-only",
    destinationNote: "There is no endpoint, no queue, and no identifier. This file is read by the application that wrote it and by nobody else.",
  };
}

export function setConsent(state, granted, now = new Date()) {
  const next = { ...createTelemetryState(), ...state, consent: { granted: Boolean(granted), changedAt: now.toISOString() } };
  if (granted) return next;
  // Withdrawal is retroactive. Consent that cannot be taken back for what was
  // already collected is not consent, it is a notification.
  return { ...next, series: [], folded: { dimensionValues: 0, series: 0 } };
}

/** Which band a measurement falls in. Never the measurement. */
export function bucketFor(value, ladderName) {
  const ladder = LADDERS[ladderName];
  if (!ladder) return "unknown";
  if (!Number.isFinite(value) || value < 0) return "invalid";
  for (let index = 0; index < ladder.length; index += 1) {
    if (value <= ladder[index]) return index === 0 ? `<=${ladder[0]}` : `${ladder[index - 1]}-${ladder[index]}`;
  }
  return `>${ladder.at(-1)}`;
}

function dayOf(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Turn a call into the tuple that may be stored, or explain the refusal.
 *
 * Unlisted dimension *values* fold to `other` rather than being refused,
 * because a new grade or a new panel should degrade a chart rather than drop an
 * event. Unlisted dimension *names* are refused, because a field nobody
 * declared is a field nobody thought about.
 */
export function normalizeEvent(name, payload = {}) {
  const declared = TELEMETRY_EVENTS[name];
  if (!declared) return { ok: false, reason: "unknown-event", detail: `“${name}” is not a declared telemetry event.` };

  const dimensions = payload.dimensions ?? {};
  const measures = payload.measures ?? {};
  const unknownDimension = Object.keys(dimensions).find((key) => !(key in declared.dimensions));
  if (unknownDimension) return { ok: false, reason: "unknown-dimension", detail: `“${unknownDimension}” is not a dimension of ${name}.` };
  const unknownMeasure = Object.keys(measures).find((key) => !(key in declared.measures));
  if (unknownMeasure) return { ok: false, reason: "unknown-measure", detail: `“${unknownMeasure}” is not a measure of ${name}.` };

  const resolved = {};
  let foldedValues = 0;
  for (const [key, allowed] of Object.entries(declared.dimensions)) {
    const supplied = dimensions[key];
    if (supplied === undefined || supplied === null) {
      resolved[key] = "unset";
      continue;
    }
    // Only a declared value survives. Anything else — including a path, a
    // symbol name, or an entire file — becomes the four letters "other".
    if (typeof supplied === "string" && allowed.includes(supplied)) resolved[key] = supplied;
    else {
      resolved[key] = "other";
      foldedValues += 1;
    }
  }

  const buckets = {};
  for (const [key, ladder] of Object.entries(declared.measures)) {
    if (measures[key] === undefined || measures[key] === null) continue;
    if (typeof measures[key] !== "number") return { ok: false, reason: "non-numeric-measure", detail: `${name}.${key} must be a number.` };
    buckets[key] = bucketFor(measures[key], ladder);
  }

  return { ok: true, reason: null, event: name, dimensions: resolved, buckets, foldedValues };
}

function seriesKey(name, dimensions) {
  return `${name}|${Object.keys(dimensions).sort().map((key) => `${key}=${dimensions[key]}`).join(",")}`;
}

/**
 * Record one event, returning a new state.
 *
 * Pure, so every rule here is testable without a filesystem, a clock, or a
 * window.
 */
export function recordEvent(state, name, payload = {}, now = new Date()) {
  const current = { ...createTelemetryState(), ...state };
  if (!current.consent.granted) {
    // Not "recorded anonymously". Nothing happens, and the caller is told so.
    return { state: current, recorded: false, reason: "no-consent", detail: "Telemetry is off. Nothing was recorded." };
  }
  const normalized = normalizeEvent(name, payload);
  if (!normalized.ok) return { state: current, recorded: false, reason: normalized.reason, detail: normalized.detail };

  const day = dayOf(now);
  const pruned = pruneRetention(current, now);
  const series = [...pruned.series];
  const folded = { ...pruned.folded, dimensionValues: pruned.folded.dimensionValues + normalized.foldedValues };

  const key = seriesKey(name, normalized.dimensions);
  const overflowKey = `${name}|__overflow__`;
  let index = series.findIndex((entry) => entry.key === key && entry.day === day);
  if (index === -1) {
    /*
     * The ceiling is per event *per day*, and it counts only real series.
     *
     * The first attempt counted every row for the event across all days and
     * included the overflow rows in that count, which did not bound anything:
     * each new day added one more overflow row, so the total kept climbing —
     * a ceiling of 64 held 83 rows. Counting within a day, and excluding the
     * fold's own row, makes the bound hold. The absolute backstop below then
     * bounds the whole file regardless of how many events exist.
     */
    const forEventToday = series.filter((entry) => entry.event === name && entry.day === day && entry.key !== overflowKey).length;
    if (forEventToday >= MAX_SERIES_PER_EVENT) {
      // Fold into one series per event per day rather than growing. The fold is
      // counted so a chart can say how much it is not showing, and it is still
      // day-scoped so retention expires it like everything else.
      folded.series += 1;
      index = series.findIndex((entry) => entry.key === overflowKey && entry.day === day);
      if (index === -1) {
        series.push({ key: overflowKey, event: name, day, dimensions: { overflow: "yes" }, count: 0, buckets: {} });
        index = series.length - 1;
      }
    } else {
      series.push({ key, event: name, day, dimensions: normalized.dimensions, count: 0, buckets: {} });
      index = series.length - 1;
    }
  }

  const entry = { ...series[index], count: series[index].count + 1, buckets: { ...series[index].buckets } };
  for (const [measure, bucket] of Object.entries(normalized.buckets)) {
    entry.buckets[measure] = { ...(entry.buckets[measure] ?? {}) };
    entry.buckets[measure][bucket] = (entry.buckets[measure][bucket] ?? 0) + 1;
  }
  series[index] = entry;

  /*
   * The absolute backstop. Whatever the per-event rules do, the file never
   * holds more than `MAX_TOTAL_SERIES` rows: the oldest day goes first, because
   * old counters are the ones a learner is least likely to miss and the ones
   * retention would have removed soonest anyway.
   */
  let dropped = 0;
  while (series.length > MAX_TOTAL_SERIES) {
    const oldest = series.reduce((earliest, candidate) => (candidate.day < earliest ? candidate.day : earliest), series[0].day);
    const before = series.length;
    for (let scan = series.length - 1; scan >= 0; scan -= 1) {
      if (series[scan].day === oldest && scan !== index) series.splice(scan, 1);
    }
    if (series.length === before) break;
    dropped += before - series.length;
  }
  if (dropped) folded.series += dropped;

  return { state: { ...pruned, series, folded }, recorded: true, reason: null, detail: null };
}

/**
 * Drop days past the retention window.
 *
 * Applied on read as well as on write. A file an old version left behind must
 * expire because time passed, not because something happened to touch it.
 */
export function pruneRetention(state, now = new Date(), retentionDays = RETENTION_DAYS) {
  const current = { ...createTelemetryState(), ...state };
  const cutoff = new Date(new Date(now).getTime() - retentionDays * 86_400_000).toISOString().slice(0, 10);
  const kept = current.series.filter((entry) => entry.day >= cutoff);
  if (kept.length === current.series.length) return current;
  return { ...current, series: kept };
}

/** Delete everything, or everything for one event. Counted, never silent. */
export function forget(state, { event = null } = {}) {
  const current = { ...createTelemetryState(), ...state };
  const removed = event ? current.series.filter((entry) => entry.event === event) : current.series;
  const kept = event ? current.series.filter((entry) => entry.event !== event) : [];
  return {
    state: {
      ...current,
      series: kept,
      folded: event ? current.folded : { dimensionValues: 0, series: 0 },
    },
    deletedSeries: removed.length,
    deletedEvents: removed.reduce((sum, entry) => sum + entry.count, 0),
  };
}

/**
 * What was collected, in a shape a person can read.
 *
 * `folded` is part of the summary rather than an internal detail: a chart that
 * does not say how much it is not showing is a chart that misleads.
 */
export function summarize(state, now = new Date()) {
  const current = pruneRetention(state, now);
  const byEvent = new Map();
  for (const entry of current.series) {
    if (!byEvent.has(entry.event)) byEvent.set(entry.event, { event: entry.event, what: TELEMETRY_EVENTS[entry.event]?.what ?? null, count: 0, series: 0, days: new Set(), buckets: {} });
    const bucketed = byEvent.get(entry.event);
    bucketed.count += entry.count;
    bucketed.series += 1;
    bucketed.days.add(entry.day);
    for (const [measure, distribution] of Object.entries(entry.buckets)) {
      bucketed.buckets[measure] = { ...(bucketed.buckets[measure] ?? {}) };
      for (const [bucket, count] of Object.entries(distribution)) {
        bucketed.buckets[measure][bucket] = (bucketed.buckets[measure][bucket] ?? 0) + count;
      }
    }
  }
  const events = [...byEvent.values()]
    .map((entry) => ({ ...entry, days: entry.days.size }))
    .sort((left, right) => left.event.localeCompare(right.event));
  return {
    version: TELEMETRY_VERSION,
    consent: current.consent,
    destination: current.destination,
    destinationNote: current.destinationNote,
    totalEvents: events.reduce((sum, entry) => sum + entry.count, 0),
    totalSeries: current.series.length,
    retentionDays: RETENTION_DAYS,
    limits: { seriesPerEvent: MAX_SERIES_PER_EVENT, totalSeries: MAX_TOTAL_SERIES },
    folded: current.folded,
    events,
    // The declared schema travels with the summary, so "what could this
    // possibly know about me" is answerable without reading the source.
    schema: telemetryEventNames().map((name) => ({
      event: name,
      what: TELEMETRY_EVENTS[name].what,
      dimensions: Object.fromEntries(Object.entries(TELEMETRY_EVENTS[name].dimensions).map(([key, values]) => [key, values.length])),
      measures: Object.keys(TELEMETRY_EVENTS[name].measures),
    })),
  };
}

/**
 * Exactly what a learner could hand to somebody else.
 *
 * Everything here is already an enum label or a bucket name, so `redactValue`
 * has nothing to find. It runs anyway: the cost is nothing and the alternative
 * is trusting that no future event ever introduces a string.
 */
export function exportTelemetry(state, now = new Date()) {
  const summary = summarize(state, now);
  return {
    format: TELEMETRY_FORMAT,
    exportedAt: new Date(now).toISOString(),
    note: "Collected locally, stored locally, and never transmitted. Nothing here is free text; every value is a declared label or a bucket.",
    ...JSON.parse(redactValue(JSON.stringify(summary))),
  };
}

/**
 * Does this state contain anything that is not a declared label?
 *
 * The invariant the whole design rests on, checkable at any moment rather than
 * argued for in a comment.
 */
export function containsOnlyDeclaredValues(state) {
  const offenders = [];
  for (const entry of state.series ?? []) {
    const declared = TELEMETRY_EVENTS[entry.event];
    if (!declared) {
      offenders.push(`unknown event ${entry.event}`);
      continue;
    }
    for (const [key, value] of Object.entries(entry.dimensions ?? {})) {
      if (key === "overflow") continue;
      const allowed = declared.dimensions[key];
      if (!allowed) { offenders.push(`${entry.event}.${key} is not a declared dimension`); continue; }
      if (!allowed.includes(value) && value !== "other" && value !== "unset") offenders.push(`${entry.event}.${key} holds “${value}”`);
    }
    for (const [measure, distribution] of Object.entries(entry.buckets ?? {})) {
      if (!(measure in declared.measures)) { offenders.push(`${entry.event}.${measure} is not a declared measure`); continue; }
      for (const bucket of Object.keys(distribution)) {
        if (!/^(<=|>)?\d+(-\d+)?$|^(invalid|unknown)$/.test(bucket)) offenders.push(`${entry.event}.${measure} has bucket “${bucket}”`);
      }
    }
  }
  return { clean: offenders.length === 0, offenders };
}
