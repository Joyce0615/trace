import { GRADED_KINDS, MIN_SAMPLE, normalizeEvents, rate, retentionAnalytics, transferAnalytics } from "./analytics.mjs";
import { evaluatePromotionGates } from "./curriculum-portfolio.mjs";

/**
 * Enforce pedagogical reward-hacking invariants (item 52, this cycle).
 *
 * `analytics.mjs` already measures five learner-outcome axes
 * (`retentionAnalytics`, `transferAnalytics`, `delayedTransferAnalytics`,
 * `timeOnTaskAnalytics`, `hintAnalytics`) and `curriculum-portfolio.mjs`'s
 * own `evaluatePromotionGates` already turns outcome evidence into a named
 * promotion verdict — but nothing anywhere in this app has ever looked at
 * the *proxy* side of the ledger: how long a dialogue ran, how many
 * requests a learner sent, how often they marked a lesson "familiar"
 * (`src/App.tsx`'s own `kind: "self-report"` evidence, already excluded
 * from audited mastery by `knowledge-components.mjs`'s own
 * `rebuildComponentMastery` for exactly this reason — it is a *satisfaction*
 * signal, not an outcome), or how often an immediate quiz passes — and
 * asked whether *those* numbers are rising while the genuine-learning
 * numbers this app already trusts are flat or falling. That is precisely
 * the reward-hacking failure mode this item names: an engagement metric
 * climbing because a tutor got easier to satisfy, not because the learner
 * got better.
 *
 * Grep confirmed before writing a line here: zero prior matches for
 * `engagementProxy`/`rewardHack`/`proxyOptimization`/`genuineLearningGain`
 * anywhere in `electron/*.mjs`.
 *
 * Design, reusing rather than reinventing:
 *
 *   - **Genuine-learning evidence** is `retentionAnalytics`'s own
 *     `modelGap`/`modelVerdict` and `transferAnalytics`'s own `gap`/
 *     `verdict`, reused unmodified — this module never recomputes a
 *     retention or transfer number, it only reads the two fields that
 *     already say whether a learner is actually retaining and transferring.
 *   - **Engagement proxies** are read from the same already-recorded
 *     activity-log event shape `analytics.mjs` itself reads
 *     (`event.at`/`event.kind`/`event.correct`/`event.hints`), split into an
 *     early and a late half of the same trajectory the same way
 *     `hintAnalytics`'s own early/late split already does, so "is this
 *     proxy rising" is answered by the identical halving comparison this
 *     app already trusts for hint dependence, not a new trend heuristic:
 *       - **dialogue length** — events per task (`GRADED_KINDS` events,
 *         the same set every other analytics function already scopes to),
 *       - **click/request volume** — `event.requestCount` where a caller
 *         supplies it (a renderer-counted interaction tally; absent for an
 *         event that never recorded one, honestly, not defaulted to zero),
 *       - **satisfaction** — the rate of `kind: "self-report"` evidence
 *         entries with `strength` at or above a declared threshold, read
 *         from `learnerState.mastery[*].evidence` exactly the way
 *         `misconception.mjs`'s own `calibrateSkill` already reads a
 *         self-report entry, not a parallel satisfaction field,
 *       - **immediate pass rate** — `rate()` over `GRADED_KINDS` events'
 *         own `event.correct`, the identical sample-floor-gated rate every
 *         other analytics function already returns.
 *   - **The one new decision**: [`detectRewardHacking`] flags a proxy as
 *     hacked only when it rose by more than `PROXY_RISE_THRESHOLD` between
 *     the early and late half *and* every genuine-learning signal that has
 *     enough evidence to judge did not rise with it (stayed flat or fell).
 *     A proxy rising alongside real retention/transfer gains is not
 *     reward hacking, it is a curriculum working — the gate only fires on
 *     the specific divergence this item names. Each of the four proxies is
 *     evaluated and reported independently, never blended into one score,
 *     the same discipline `evaluatePromotionGates` already established.
 *   - **Promotion enforcement**: [`guardPromotionAgainstRewardHacking`]
 *     wraps `curriculum-portfolio.mjs`'s own `evaluatePromotionGates`
 *     unmodified and adds exactly one more named gate,
 *     `"reward-hacking"`, so a portfolio that would otherwise promote on
 *     six clean gates is refused the moment any proxy is found hacked —
 *     the enforcement this item explicitly asks for ("forbid promotion"),
 *     not a report a caller could choose to ignore.
 *
 * Node-free: every input here is already a plain event/learner-state object
 * the browser demo already has access to, exactly like `analytics.mjs`.
 */

export const REWARD_HACKING_GUARD_VERSION = 1;

/** The four proxies this item names, in the item's own stated order. */
export const ENGAGEMENT_PROXIES = ["dialogue-length", "request-volume", "satisfaction", "immediate-pass-rate"];

/** A proxy must rise by more than this (as a fraction of the early value, or
 * an absolute rate-point delta for a bounded rate) to count as "rising". */
export const PROXY_RISE_THRESHOLD = 0.2;

/** A self-report entry at or above this strength counts as "satisfied". */
export const SATISFACTION_STRENGTH_FLOOR = 0.7;

function round(value, places = 4) {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Number(Number(value).toFixed(places));
}

/** Split a chronologically-ordered list into an early and a late half,
 * mirroring `analytics.mjs`'s own `hintAnalytics` halving exactly. */
function halve(list) {
  const half = Math.floor(list.length / 2);
  return { early: list.slice(0, half), late: list.slice(list.length - half), half };
}

/**
 * A fractional rise from `early` to `late`, or `null` if either half has no
 * usable value — never a divide-by-zero guess.
 */
function fractionalRise(early, late) {
  if (early === null || late === null) return null;
  if (early === 0) return late === 0 ? 0 : null;
  return round((late - early) / Math.abs(early));
}

/**
 * Dialogue-length proxy: graded-task events per task, early half vs. late
 * half of the same trajectory. Rising dialogue length for the same kind of
 * task is the proxy this item names first.
 */
export function measureDialogueLengthProxy(events) {
  const ordered = normalizeEvents(events).filter((event) => GRADED_KINDS.has(event.kind));
  const { early, late, half } = halve(ordered);
  if (half < MIN_SAMPLE) return { proxy: "dialogue-length", early: null, late: null, rise: null, reason: "insufficient-evidence", samples: ordered.length };
  const earlyTurns = early.reduce((sum, event) => sum + (event.turns ?? 1), 0) / early.length;
  const lateTurns = late.reduce((sum, event) => sum + (event.turns ?? 1), 0) / late.length;
  return { proxy: "dialogue-length", early: round(earlyTurns), late: round(lateTurns), rise: fractionalRise(earlyTurns, lateTurns), reason: null, samples: ordered.length };
}

/**
 * Request-volume proxy: how many interactions (clicks, requests) a caller
 * declared per task, read from `event.requestCount` where present. A task
 * that never recorded a request count contributes nothing — it is absent
 * from the average, not treated as zero requests.
 */
export function measureRequestVolumeProxy(events) {
  const ordered = normalizeEvents(events).filter((event) => GRADED_KINDS.has(event.kind) && typeof event.requestCount === "number");
  const { early, late, half } = halve(ordered);
  if (half < MIN_SAMPLE) return { proxy: "request-volume", early: null, late: null, rise: null, reason: "insufficient-evidence", samples: ordered.length };
  const earlyRequests = early.reduce((sum, event) => sum + event.requestCount, 0) / early.length;
  const lateRequests = late.reduce((sum, event) => sum + event.requestCount, 0) / late.length;
  return { proxy: "request-volume", early: round(earlyRequests), late: round(lateRequests), rise: fractionalRise(earlyRequests, lateRequests), reason: null, samples: ordered.length };
}

/**
 * Satisfaction proxy: the share of `kind: "self-report"` evidence entries
 * across every tracked skill's own `evidence` list whose `strength` clears
 * `SATISFACTION_STRENGTH_FLOOR`, early half of the recorded entries vs. late
 * half, in the order they were created. This reads the exact same
 * self-report evidence shape `misconception.mjs`'s own `calibrateSkill`
 * already reads — it is not a second, parallel satisfaction signal.
 */
export function measureSatisfactionProxy(learnerState) {
  const entries = Object.values(learnerState?.mastery ?? {})
    .flatMap((mastery) => mastery?.evidence ?? [])
    .filter((item) => item?.kind === "self-report" && typeof item.strength === "number" && typeof item.createdAt === "string")
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const { early, late, half } = halve(entries);
  if (half < MIN_SAMPLE) return { proxy: "satisfaction", early: null, late: null, rise: null, reason: "insufficient-evidence", samples: entries.length };
  const satisfiedShare = (list) => list.filter((item) => item.strength >= SATISFACTION_STRENGTH_FLOOR).length / list.length;
  const earlyShare = satisfiedShare(early);
  const lateShare = satisfiedShare(late);
  return { proxy: "satisfaction", early: round(earlyShare), late: round(lateShare), rise: round(lateShare - earlyShare), reason: null, samples: entries.length };
}

/**
 * Immediate-pass-rate proxy: `rate()` over `GRADED_KINDS` events' own
 * `event.correct`, early half vs. late half — the identical sample-floor
 * rate `analytics.mjs` already returns, split the same way `hintAnalytics`
 * already splits its own hint rate.
 */
export function measureImmediatePassRateProxy(events) {
  const ordered = normalizeEvents(events).filter((event) => GRADED_KINDS.has(event.kind) && typeof event.correct === "boolean");
  const { early, late, half } = halve(ordered);
  if (half < MIN_SAMPLE) return { proxy: "immediate-pass-rate", early: null, late: null, rise: null, reason: "insufficient-evidence", samples: ordered.length };
  const earlyRate = rate(early.filter((event) => event.correct).length, early.length).value;
  const lateRate = rate(late.filter((event) => event.correct).length, late.length).value;
  if (earlyRate === null || lateRate === null) return { proxy: "immediate-pass-rate", early: earlyRate, late: lateRate, rise: null, reason: "insufficient-evidence", samples: ordered.length };
  return { proxy: "immediate-pass-rate", early: earlyRate, late: lateRate, rise: round(lateRate - earlyRate), reason: null, samples: ordered.length };
}

/**
 * All four proxies, reported independently and never blended into one
 * "engagement score" — the same discipline `analytics.mjs`'s own five
 * measures already keep.
 */
export function measureEngagementProxies(input = {}) {
  return {
    "dialogue-length": measureDialogueLengthProxy(input.events),
    "request-volume": measureRequestVolumeProxy(input.events),
    satisfaction: measureSatisfactionProxy(input.learnerState),
    "immediate-pass-rate": measureImmediatePassRateProxy(input.events),
  };
}

/**
 * Genuine-learning signals, read unmodified from `retentionAnalytics` and
 * `transferAnalytics` — this function never re-measures either one.
 */
export function measureGenuineLearningSignals(input = {}) {
  const retention = retentionAnalytics(input.events ?? [], input.learnerState ?? null, input.skillGraph ?? null, { now: input.now });
  const transfer = transferAnalytics(input.events ?? [], input.learnerState ?? null, { studiedPaths: input.studiedPaths ?? [] });
  return {
    retention: { verdict: retention.modelVerdict, gap: retention.modelGap, available: retention.modelVerdict !== "not-enough-reviews" },
    transfer: { verdict: transfer.verdict, gap: transfer.gap, available: transfer.verdict !== "insufficient-evidence" },
  };
}

/**
 * The one new decision: a proxy is flagged `hacked` only when it rose past
 * `PROXY_RISE_THRESHOLD` *and* every genuine-learning signal with enough
 * evidence to judge did not also rise. A signal with no evidence yet is
 * treated as "not corroborating" rather than silently excused — a reward-
 * hacking check that lets a proxy through just because nobody measured
 * retention yet would defeat the point of the gate.
 */
export function detectRewardHacking(proxies, learningSignals) {
  const corroborated = Object.values(learningSignals).some((signal) => signal.available && typeof signal.gap === "number" && signal.gap > 0);
  const findings = ENGAGEMENT_PROXIES.map((proxyName) => {
    const proxy = proxies[proxyName];
    if (!proxy || proxy.rise === null) return { proxy: proxyName, hacked: false, reason: "insufficient-evidence", rise: null };
    const rose = proxy.rise > PROXY_RISE_THRESHOLD;
    if (!rose) return { proxy: proxyName, hacked: false, reason: null, rise: proxy.rise };
    return {
      proxy: proxyName,
      hacked: !corroborated,
      reason: corroborated ? null : `${proxyName} rose ${proxy.rise} without a corroborating rise in retention or transfer.`,
      rise: proxy.rise,
    };
  });
  const hackedProxies = findings.filter((finding) => finding.hacked).map((finding) => finding.proxy);
  return { findings, hackedProxies, anyHacked: hackedProxies.length > 0, corroborated };
}

/**
 * `curriculum-portfolio.mjs`'s own `evaluatePromotionGates`, unmodified,
 * plus exactly one more named gate: `"reward-hacking"`. A portfolio with
 * six clean gates but a hacked proxy is refused promotion here, which is
 * the enforcement this item asks for, not merely a report.
 */
export function guardPromotionAgainstRewardHacking(content, proxyInput) {
  const baseGates = evaluatePromotionGates(content);
  const proxies = measureEngagementProxies(proxyInput);
  const learningSignals = measureGenuineLearningSignals(proxyInput);
  const hacking = detectRewardHacking(proxies, learningSignals);
  const rewardHackingGate = {
    gate: "reward-hacking",
    verdict: hacking.anyHacked ? "fail" : "pass",
    detail: { hackedProxies: hacking.hackedProxies, corroborated: hacking.corroborated },
  };
  return { gates: [...baseGates, rewardHackingGate], proxies, learningSignals, hacking };
}

/** Human-readable rendering for a review panel or CLI printout. */
export function renderRewardHackingReport(proxies, learningSignals, hacking) {
  const lines = [`# Reward-hacking guard (v${REWARD_HACKING_GUARD_VERSION})`, ""];
  lines.push(hacking.anyHacked ? `REWARD HACKING DETECTED: ${hacking.hackedProxies.join(", ")}` : "No reward hacking detected.");
  lines.push("");
  for (const proxyName of ENGAGEMENT_PROXIES) {
    const proxy = proxies[proxyName];
    lines.push(`  - ${proxyName}: early=${proxy.early ?? "n/a"} late=${proxy.late ?? "n/a"} rise=${proxy.rise ?? "n/a"} (${proxy.reason ?? "ok"})`);
  }
  lines.push("");
  lines.push(`Retention verdict: ${learningSignals.retention.verdict} (gap ${learningSignals.retention.gap ?? "n/a"}).`);
  lines.push(`Transfer verdict: ${learningSignals.transfer.verdict} (gap ${learningSignals.transfer.gap ?? "n/a"}).`);
  return lines.join("\n");
}
