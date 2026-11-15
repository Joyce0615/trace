/**
 * Multi-session project-learning continuity (item 42, this cycle).
 *
 * Note on numbering: `experiments.mjs`/`experiment-cohort.mjs`/
 * `experiment-store.mjs`/`docs/privacy.md` carry comments that say
 * "item 42" — that is the *previous* cycle's numbering (local A/B
 * experiments, consent-gated). Item numbers were reused across cycles; this
 * module is the *current* cycle's item 42 ("Add multi-session project-
 * learning continuity") and has nothing to do with that experiment
 * machinery. The two are unrelated features that happen to share a label
 * from different ten-day windows.
 *
 * The gap: every cross-session fact a learner builds up while asking
 * cumulative questions about one repository — a working *hypothesis* about
 * how something behaves, which pieces of *evidence* support or contradict it,
 * which *misconceptions* have already been named, which *goal* the learner is
 * pursuing, and whether they have *consented* to this continuity being kept
 * at all — lived in exactly one place before this module: `askMessages`, a
 * component-local React array that is thrown away by `setAskMessages([])`
 * every time `activateWorkspace` runs (on reopen, on course regeneration, on
 * migration). `LearnerState.memory` (`learning-store.mjs`) is close but
 * answers a different question — "what should the tutor's context pack
 * remember" — and is not keyed per repository-question-thread, carries no
 * hypothesis/goal/consent shape, and has no notion of "this fact is now
 * stale because the code or the curriculum changed under it".
 *
 * Grep confirmed before writing a line here: zero prior matches for
 * `continuity`/`multiSession`/`crossSession`/`projectHypothesis` anywhere in
 * `electron/*.mjs`.
 *
 * This module is the Node-free rules half (shared with the browser demo,
 * like `skill-graph.mjs`/`misconception.mjs`/`change-impact.mjs`); its
 * persistence half (`project-continuity-store.mjs`) is the one with
 * `node:crypto`/`node:fs`, following `notes.mjs`/`notes-store.mjs`'s split
 * for exactly the reason stated there: a Node-only import reaching into a
 * module the demo bundles breaks the demo at the externalized-import layer,
 * not at review time.
 *
 * Design, reusing rather than reinventing:
 *
 *   - **Staleness detection** reuses `course-migration.mjs`'s own
 *     `buildSymbolSnapshot` fingerprints exactly the way `change-impact.mjs`
 *     already does for callers/tests/lessons/notes/mastery-evidence — a
 *     hypothesis or a piece of evidence is anchored to one or more
 *     `path:name` symbol keys, and `continuitySnapshotDigest` is the same
 *     fingerprint comparison, extended to one more kind of claim. This is
 *     deliberately *not* a new "has anything changed" heuristic; it is the
 *     one this app already trusts, applied to one more artifact.
 *   - **Misconceptions** are references into `misconception.mjs`'s own
 *     `MISCONCEPTIONS` taxonomy by id only (`assertKnownMisconception`), the
 *     same discipline `knowledge-components.mjs` already applies — this
 *     module carries no detector pattern and no remediation text of its own.
 *   - **Goals** are validated against `goal-keywords.mjs`'s own
 *     `canonicalGoalId`, so a continuity record can never name a goal the
 *     rest of the app does not recognize.
 *   - **Consent** is its own explicit, revocable gate, modeled on
 *     `experiments.mjs`'s own rule ("no consent, no [...]") even though this
 *     is an unrelated feature: without a recorded grant, nothing is kept
 *     across sessions and every question is answered from a fresh, empty
 *     thread, which is the same behavior the app would have without this
 *     module at all. Revoking does not blank fields — it deletes the record,
 *     the same "delete the file, not the contents" rule
 *     `experiment-store.mjs`/`telemetry-store.mjs` already apply.
 *
 * Everything here is deterministic and pure: no fs, no network, no Node
 * builtin.
 */

import { canonicalGoalId } from "./goal-keywords.mjs";
import { misconceptionById } from "./misconception.mjs";

export const PROJECT_CONTINUITY_VERSION = 1;

export const MAX_HYPOTHESES = 100;
export const MAX_EVIDENCE = 300;
export const MAX_THREAD_QUESTIONS = 500;
const MAX_TEXT_CHARS = 4_000;

/** The consent record. Absent or false means "keep nothing across sessions". */
export function consentState(record) {
  return {
    granted: Boolean(record?.consent?.granted),
    grantedAt: record?.consent?.grantedAt ?? null,
    revokedAt: record?.consent?.revokedAt ?? null,
  };
}

/** An empty, unconsented continuity record for a repository. */
export function emptyContinuity(repositoryId) {
  return {
    version: PROJECT_CONTINUITY_VERSION,
    repositoryId,
    consent: { granted: false, grantedAt: null, revokedAt: null },
    goal: null,
    hypotheses: [],
    evidence: [],
    misconceptions: [],
    thread: [],
    updatedAt: new Date(0).toISOString(),
  };
}

function clampText(value) {
  return String(value ?? "").slice(0, MAX_TEXT_CHARS);
}

function normalizeSymbolRef(ref) {
  if (!ref || typeof ref !== "object") return null;
  const path = typeof ref.path === "string" ? ref.path : null;
  const name = typeof ref.name === "string" ? ref.name : null;
  if (!path || !name) return null;
  return { path, name };
}

/**
 * Grant or revoke consent. Granting never implies the record already holds
 * anything; revoking clears every kept fact rather than merely flipping a
 * flag, so "withdraw consent" and "forget everything recorded under it" are
 * the same action, not two the caller must remember to perform separately.
 */
export function setContinuityConsent(record, granted, now = new Date().toISOString()) {
  const base = record ?? emptyContinuity(record?.repositoryId ?? null);
  if (!granted) {
    return {
      ...emptyContinuity(base.repositoryId),
      consent: { granted: false, grantedAt: base.consent?.grantedAt ?? null, revokedAt: now },
      updatedAt: now,
    };
  }
  return {
    ...base,
    consent: { granted: true, grantedAt: now, revokedAt: null },
    updatedAt: now,
  };
}

/**
 * Set (or clear, with `goalId = null`) the learner's pursued goal for this
 * repository's continuity thread. Refuses silently-wrong input: an unknown
 * goal id is rejected rather than stored as something nothing else in the
 * app recognizes.
 */
export function setContinuityGoal(record, goalId, now = new Date().toISOString()) {
  if (!record?.consent?.granted) return { ok: false, reason: "no-consent", record };
  if (goalId !== null && goalId !== undefined) {
    const canonical = canonicalGoalId(goalId);
    if (!canonical) return { ok: false, reason: "unknown-goal", record };
    return { ok: true, reason: null, record: { ...record, goal: canonical, updatedAt: now } };
  }
  return { ok: true, reason: null, record: { ...record, goal: null, updatedAt: now } };
}

/**
 * Record (or update, by `id`) one hypothesis: a learner's standing claim
 * about how some part of the repository behaves, anchored to the symbols it
 * is actually about. `status` starts `"open"`; `resolveHypothesis` below is
 * the only path that moves it to `"confirmed"`/`"refuted"`/`"stale"`.
 */
export function recordHypothesis(record, candidate, now = new Date().toISOString()) {
  if (!record?.consent?.granted) return { ok: false, reason: "no-consent", record };
  const text = clampText(candidate?.text);
  if (!text.trim()) return { ok: false, reason: "empty-text", record };
  const anchors = (candidate?.anchors ?? []).map(normalizeSymbolRef).filter(Boolean).slice(0, 20);
  const id = typeof candidate?.id === "string" && candidate.id ? candidate.id : `hyp-${now}-${record.hypotheses.length}`;
  const existing = record.hypotheses.find((item) => item.id === id);
  const next = {
    id,
    text,
    anchors,
    status: existing?.status ?? "open",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const hypotheses = existing
    ? record.hypotheses.map((item) => (item.id === id ? next : item))
    : [...record.hypotheses, next].slice(-MAX_HYPOTHESES);
  return { ok: true, reason: null, record: { ...record, hypotheses, updatedAt: now } };
}

const HYPOTHESIS_RESOLUTIONS = new Set(["confirmed", "refuted", "stale"]);

/** Move a hypothesis out of `"open"`. Only this path may do so. */
export function resolveHypothesis(record, hypothesisId, resolution, now = new Date().toISOString()) {
  if (!record?.consent?.granted) return { ok: false, reason: "no-consent", record };
  if (!HYPOTHESIS_RESOLUTIONS.has(resolution)) return { ok: false, reason: "unknown-resolution", record };
  const hypothesis = record.hypotheses.find((item) => item.id === hypothesisId);
  if (!hypothesis) return { ok: false, reason: "unknown-hypothesis", record };
  const hypotheses = record.hypotheses.map((item) => (item.id === hypothesisId ? { ...item, status: resolution, updatedAt: now } : item));
  return { ok: true, reason: null, record: { ...record, hypotheses, updatedAt: now } };
}

/**
 * Record one piece of evidence linked to a hypothesis (or standing alone),
 * anchored to the symbols it actually names. `supports` is `true`/`false`/
 * `null` ("neutral/contextual", e.g. a clarifying fact that neither confirms
 * nor refutes anything by itself).
 */
export function recordEvidence(record, candidate, now = new Date().toISOString()) {
  if (!record?.consent?.granted) return { ok: false, reason: "no-consent", record };
  const text = clampText(candidate?.text);
  if (!text.trim()) return { ok: false, reason: "empty-text", record };
  if (candidate?.hypothesisId && !record.hypotheses.some((item) => item.id === candidate.hypothesisId)) {
    return { ok: false, reason: "unknown-hypothesis", record };
  }
  const anchors = (candidate?.anchors ?? []).map(normalizeSymbolRef).filter(Boolean).slice(0, 20);
  const item = {
    id: `evi-${now}-${record.evidence.length}`,
    hypothesisId: candidate?.hypothesisId ?? null,
    text,
    anchors,
    supports: candidate?.supports === true ? true : candidate?.supports === false ? false : null,
    createdAt: now,
  };
  const evidence = [...record.evidence, item].slice(-MAX_EVIDENCE);
  return { ok: true, reason: null, record: { ...record, evidence, updatedAt: now } };
}

/**
 * Record a misconception already surfaced in this continuity thread, by id
 * only — validated against `misconception.mjs`'s own taxonomy so a record
 * can never carry an id nothing else in the app recognizes. Re-recording the
 * same id updates its last-seen anchor/time rather than duplicating it.
 */
export function recordMisconception(record, misconceptionId, anchor, now = new Date().toISOString()) {
  if (!record?.consent?.granted) return { ok: false, reason: "no-consent", record };
  if (!misconceptionById(misconceptionId)) return { ok: false, reason: "unknown-misconception", record };
  const normalizedAnchor = normalizeSymbolRef(anchor);
  const existing = record.misconceptions.find((item) => item.id === misconceptionId);
  const next = {
    id: misconceptionId,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
    anchors: normalizedAnchor
      ? [...(existing?.anchors ?? []).filter((item) => !(item.path === normalizedAnchor.path && item.name === normalizedAnchor.name)), normalizedAnchor]
      : (existing?.anchors ?? []),
  };
  const misconceptions = existing
    ? record.misconceptions.map((item) => (item.id === misconceptionId ? next : item))
    : [...record.misconceptions, next];
  return { ok: true, reason: null, record: { ...record, misconceptions, updatedAt: now } };
}

/**
 * Append one cumulative question/answer turn to the thread (the actual
 * "cumulative repository questions" the item names), bounded to the most
 * recent `MAX_THREAD_QUESTIONS`. Carries only what is needed to notice
 * staleness later: the question, a short answer summary, and the symbol
 * anchors the answer actually named — never the full context pack or raw
 * agent text, which already live in `context-engine.mjs`'s own response
 * cache.
 */
export function appendThreadTurn(record, turn, now = new Date().toISOString()) {
  if (!record?.consent?.granted) return { ok: false, reason: "no-consent", record };
  const question = clampText(turn?.question);
  if (!question.trim()) return { ok: false, reason: "empty-question", record };
  const anchors = (turn?.anchors ?? []).map(normalizeSymbolRef).filter(Boolean).slice(0, 20);
  const item = {
    id: `turn-${now}-${record.thread.length}`,
    question,
    answerSummary: clampText(turn?.answerSummary),
    anchors,
    at: now,
  };
  const thread = [...record.thread, item].slice(-MAX_THREAD_QUESTIONS);
  return { ok: true, reason: null, record: { ...record, thread, updatedAt: now } };
}

/** Every distinct `path#name` anchor named anywhere in a continuity record. */
export function continuityAnchors(record) {
  const keys = new Set();
  const collect = (anchors) => { for (const anchor of anchors ?? []) if (anchor?.path && anchor?.name) keys.add(`${anchor.path}#${anchor.name}`); };
  for (const hypothesis of record?.hypotheses ?? []) collect(hypothesis.anchors);
  for (const item of record?.evidence ?? []) collect(item.anchors);
  for (const item of record?.misconceptions ?? []) collect(item.anchors);
  for (const turn of record?.thread ?? []) collect(turn.anchors);
  return [...keys];
}

/**
 * Detect staleness after a code change: which open hypotheses, which
 * evidence, and which thread turns named a symbol that
 * `change-impact.mjs`'s own `changedSymbols` (reused unmodified, passed in
 * as `changedSymbolEntries`) reports as added/removed/modified. This is
 * deliberately the *same* "changed" this app already computes everywhere
 * else — not a second notion of staleness.
 *
 * Open hypotheses anchored to a changed symbol are *not* silently
 * reinterpreted as still true or auto-resolved; they are reported as
 * `staleHypotheses` so a caller can show the learner "this claim you made
 * was about code that has since changed", exactly the honesty
 * `skill-graph.mjs`'s own `reconcileLearnerState` already applies to mastery
 * (marking `"stale"` rather than silently carrying a now-wrong number
 * forward).
 */
export function detectStaleContinuity(record, changedSymbolEntries) {
  const changedKeys = new Set((changedSymbolEntries ?? []).map((symbol) => `${symbol.path}#${symbol.name}`));
  const anchoredToChange = (anchors) => (anchors ?? []).some((anchor) => changedKeys.has(`${anchor.path}#${anchor.name}`));

  const staleHypotheses = (record?.hypotheses ?? []).filter((item) => item.status === "open" && anchoredToChange(item.anchors));
  const staleEvidence = (record?.evidence ?? []).filter((item) => anchoredToChange(item.anchors));
  const staleThreadTurns = (record?.thread ?? []).filter((item) => anchoredToChange(item.anchors));

  return {
    staleHypotheses: staleHypotheses.map((item) => item.id),
    staleEvidence: staleEvidence.map((item) => item.id),
    staleThreadTurns: staleThreadTurns.map((item) => item.id),
    changedAnchorCount: changedKeys.size,
  };
}

/**
 * Detect staleness after a curriculum change (a new course version, a
 * migration, a different generated goal): anything anchored outside the
 * course's own current anchor set. `currentCourseAnchors` is expected to be
 * the set this caller's own course actually carries (e.g. derived once via
 * `course-migration.mjs`'s `courseAnchorSites`), so this function never
 * invents a second notion of "the curriculum knows about this".
 */
export function detectCurriculumDrift(record, currentCourseAnchorKeys) {
  const knownKeys = new Set(currentCourseAnchorKeys ?? []);
  const anchoredOutsideCurriculum = (anchors) => (anchors ?? []).length > 0 && anchors.every((anchor) => !knownKeys.has(`${anchor.path}#${anchor.name}`));

  const orphanedHypotheses = (record?.hypotheses ?? []).filter((item) => item.status === "open" && anchoredOutsideCurriculum(item.anchors));
  const orphanedEvidence = (record?.evidence ?? []).filter((item) => anchoredOutsideCurriculum(item.anchors));

  return {
    orphanedHypotheses: orphanedHypotheses.map((item) => item.id),
    orphanedEvidence: orphanedEvidence.map((item) => item.id),
  };
}

/** Mark a specific set of hypothesis ids `"stale"` — the one path that acts on `detectStaleContinuity`'s report, so staleness is reported once and applied once, not recomputed differently at each call site. */
export function markHypothesesStale(record, hypothesisIds, now = new Date().toISOString()) {
  const ids = new Set(hypothesisIds ?? []);
  if (!ids.size) return record;
  const hypotheses = (record?.hypotheses ?? []).map((item) => (ids.has(item.id) && item.status === "open" ? { ...item, status: "stale", updatedAt: now } : item));
  return { ...record, hypotheses, updatedAt: now };
}

/** A render-ready summary for the renderer or a prompt — never the raw thread text, only counts and the open/unresolved state. */
export function renderContinuitySummary(record) {
  const consent = consentState(record);
  if (!consent.granted) return "No cross-session memory is kept for this repository (continuity is off).";
  const open = (record?.hypotheses ?? []).filter((item) => item.status === "open");
  const stale = (record?.hypotheses ?? []).filter((item) => item.status === "stale");
  const lines = [
    `${record?.thread?.length ?? 0} question(s) carried across sessions${record?.goal ? ` toward the "${record.goal}" goal` : ""}.`,
    `${open.length} open hypothesis(es), ${stale.length} marked stale by a later change, ${record?.evidence?.length ?? 0} piece(s) of evidence.`,
  ];
  if (record?.misconceptions?.length) lines.push(`${record.misconceptions.length} misconception(s) already named: ${record.misconceptions.map((item) => item.id).join(", ")}.`);
  return lines.join(" ");
}

/** What this record carries, so "what do you keep about me" has a literal, field-level answer, mirroring `experiments.mjs`'s own `OBSERVATION_FIELDS` discipline. */
export const CONTINUITY_FIELDS = ["goal", "hypotheses", "evidence", "misconceptions", "thread"];
