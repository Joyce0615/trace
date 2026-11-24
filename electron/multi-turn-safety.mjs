import { ALWAYS_FORBIDDEN, findForbiddenKeys, findLeakedValues } from "./answer-guard.mjs";
import { classifyAssistanceSeeking } from "./cognitive-offload-guard.mjs";
import { canonicalGoalId } from "./goal-keywords.mjs";

/**
 * Cumulative pedagogical safety across multi-turn tutoring (item 51, this
 * cycle).
 *
 * Every existing safety check in this app — `answer-guard.mjs`'s egress
 * guard, `cognitive-offload-guard.mjs`'s assistance-seeking classifier,
 * `prompt-isolation.mjs`'s injection detector — looks at *one* turn, or at
 * one IPC response, in isolation. That is the right scope for each of them,
 * and this item does not re-derive any of it. But a tutoring conversation
 * is a trajectory, not a sequence of independent events, and five specific
 * failure modes this item names are each one where *every single turn can
 * pass every existing single-turn check* while the trajectory as a whole is
 * unsafe:
 *
 *   - **Progressive answer leakage.** No one turn's response contains a
 *     registered answer secret (`findLeakedValues` on each turn, alone,
 *     returns nothing) — but turn 3 reveals the input shape, turn 6 reveals
 *     the branch count, turn 9 reveals the entry point, and a learner who
 *     reads all nine turns together has been handed the same information a
 *     single leaked turn would have given away at once. `answer-guard.mjs`
 *     itself cannot see this: it never looks at more than one response.
 *   - **Misconception reinforcement.** Turn 2 states a wrong model ("it
 *     copies the object before passing it"); turn 5's tutor response does
 *     not *correct* it, it just answers the next question as if the wrong
 *     model were true; by turn 8 the learner's own phrasing repeats the
 *     same wrong model with more confidence. No single turn is "wrong" —
 *     each tutor response is a locally accurate answer to the question it
 *     was actually asked — but the trajectory never repaired a named
 *     misconception that kept recurring.
 *   - **Scaffold abandonment.** Turns 1–4 use a hint ladder
 *     (`answer-guard.mjs`'s own rungs); turn 5 onward jumps straight to
 *     full solutions with no hints at all, even though nothing about the
 *     learner's performance justified removing the scaffold. One turn
 *     giving a full answer is not itself a violation (a mastered learner
 *     earns that); a *trend* from scaffolded to unscaffolded with no
 *     earned reason is.
 *   - **Dependency escalation.** `cognitive-offload-guard.mjs`'s own
 *     `classifyAssistanceSeeking` already flags one high-assistance
 *     request; this item asks whether the *rate* of high-assistance
 *     requests is climbing turn over turn, which no single classification
 *     call can answer, because it only ever sees the one turn in front of
 *     it.
 *   - **Goal drift.** Turn 1 declares a goal (`goal-keywords.mjs`'s own
 *     canonical goal id, the same taxonomy `goals.mjs` and
 *     `cognitive-offload-guard.mjs` both already use); by turn 10 the
 *     conversation has silently wandered into a different goal's territory
 *     with no acknowledgment that the original goal was abandoned or
 *     revised. Reusing the goal, not re-deriving a new topic model: this
 *     module never guesses a goal from text itself, it only reuses
 *     `classifyRequestObjective`-equivalent matching already proven in
 *     `cognitive-offload-guard.mjs`, applied once per turn instead of once.
 *
 * Grep confirmed before writing a line here: zero prior matches for
 * `multiTurn`/`trajectorySafety`/`cumulativeSafety`/`scaffoldAbandonment`/
 * `dependencyEscalation`/`goalDrift` anywhere in `electron/*.mjs`.
 *
 * Design, reusing rather than reinventing:
 *
 *   - **Per-turn leakage reuses `answer-guard.mjs`'s own
 *     `findForbiddenKeys`/`findLeakedValues`, unmodified**, but this module
 *     calls them once per turn and *accumulates* the registered secret
 *     fragments a turn reveals (`detail` strings the caller tags each turn
 *     with — e.g. "reveals input shape"), so [`detectProgressiveLeakage`]
 *     can report that turns 3+6+9 together cover three of five fragments
 *     of one withheld answer even though no single turn's own leak check
 *     ever fires.
 *   - **High-assistance rate reuses `cognitive-offload-guard.mjs`'s own
 *     `classifyAssistanceSeeking`, unmodified**, called once per turn;
 *     [`detectDependencyEscalation`] only adds the trend comparison
 *     (first-half rate vs. second-half rate of a trajectory) that no
 *     single call could ever produce.
 *   - **Goal identity reuses `goal-keywords.mjs`'s own `canonicalGoalId`**
 *     so a declared goal is validated against the same five-goal taxonomy
 *     every other module already enforces; a goal id this module has never
 *     heard of is honestly `null`, never guessed.
 *   - **Everything is reported per failure mode, never blended into one
 *     "safety score".** This project's own established discipline
 *     (`analytics.mjs`'s "reported separately and never averaged",
 *     `evaluation-scale.mjs`'s per-domain envelopes) applies here too:
 *     [`scoreTrajectorySafety`] returns five independent findings, and a
 *     caller cannot derive one aggregate pass/fail without looking at all
 *     five.
 *   - **Abstention is honest.** A trajectory shorter than
 *     `MIN_TRAJECTORY_TURNS` (this item's own stated floor, 8) or longer
 *     than `MAX_TRAJECTORY_TURNS` (12) is refused outright with a named
 *     reason rather than scored on a window it was not designed for —
 *     mirroring `evaluation-scale.mjs`'s own abstention envelope.
 *
 * Node-free: every function here is a pure transformation of caller-
 * supplied turn records, exactly like `misconception.mjs`/`skill-graph.mjs`.
 */

export const MULTI_TURN_SAFETY_VERSION = 1;

/** The five failure modes this item names, in the item's own stated order. */
export const TRAJECTORY_FAILURE_MODES = Object.freeze([
  "progressive-answer-leakage",
  "misconception-reinforcement",
  "scaffold-abandonment",
  "dependency-escalation",
  "goal-drift",
]);

/** The item's own stated trajectory-length bounds. */
export const MIN_TRAJECTORY_TURNS = 8;
export const MAX_TRAJECTORY_TURNS = 12;

/** A trend is only reported once the second-half rate exceeds the first-half rate by at least this much. */
export const ESCALATION_THRESHOLD = 0.2;

function round(value, places = 4) {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Number(Number(value).toFixed(places));
}

/**
 * Validate that a trajectory is actually a trajectory this item's bounds
 * apply to. Returns `{ ok, reason }`; `ok: false` is the honest abstention
 * this module uses everywhere else a caller might expect a verdict it has
 * no basis for.
 */
export function validateTrajectoryLength(turns) {
  const count = Array.isArray(turns) ? turns.length : 0;
  if (count < MIN_TRAJECTORY_TURNS) return { ok: false, reason: "too-few-turns", count };
  if (count > MAX_TRAJECTORY_TURNS) return { ok: false, reason: "too-many-turns", count };
  return { ok: true, reason: null, count };
}

/**
 * Progressive answer leakage: no single turn leaks (that is
 * `answer-guard.mjs`'s own job, reused unmodified per turn), but the
 * *union* of what every turn's response structurally or textually reveals
 * can still add up to the whole withheld answer across the trajectory.
 *
 * `turns[i].response` is run through the exact same two checks
 * `answer-guard.mjs`'s egress guard already runs on a live IPC response
 * (`findForbiddenKeys` against `ALWAYS_FORBIDDEN`, `findLeakedValues`
 * against the caller's own registered secrets) — that is the per-turn
 * check this item says can pass on every turn individually. In addition,
 * each turn may carry a `revealsFragmentId` (a caller-declared tag naming
 * which fragment of a withheld answer that turn's response disclosed,
 * e.g. `"input-shape"`); this module does not invent what counts as a
 * fragment, it only accumulates the caller's own declared fragments and
 * reports when their union reaches or exceeds `fragmentThreshold` of the
 * total declared fragment set, which is the actual cross-turn violation no
 * single-turn check can see.
 */
export function detectProgressiveLeakage(turns, { channel = null, secrets = [], totalFragments = [], fragmentThreshold = null } = {}) {
  const perTurn = turns.map((turn, index) => {
    const forbidden = findForbiddenKeys(turn?.response ?? null, ALWAYS_FORBIDDEN);
    const leaked = findLeakedValues(turn?.response ?? null, secrets);
    return {
      index,
      singleTurnLeak: forbidden.length > 0 || leaked.length > 0,
      forbiddenKeys: forbidden,
      leakedValues: leaked.map((value) => `${value.slice(0, 12)}\u2026`),
      revealsFragmentId: turn?.revealsFragmentId ?? null,
    };
  });

  const anySingleTurnLeak = perTurn.some((entry) => entry.singleTurnLeak);
  const revealedFragments = [...new Set(perTurn.map((entry) => entry.revealsFragmentId).filter(Boolean))];
  const total = totalFragments.length;
  const threshold = fragmentThreshold ?? (total > 0 ? Math.ceil(total * 0.6) : null);
  const cumulativeLeak = total > 0 && threshold !== null && revealedFragments.length >= threshold;

  return {
    version: MULTI_TURN_SAFETY_VERSION,
    mode: "progressive-answer-leakage",
    channel,
    detected: anySingleTurnLeak || cumulativeLeak,
    anySingleTurnLeak,
    cumulativeLeak,
    revealedFragments,
    totalFragments: total,
    fragmentThreshold: threshold,
    perTurn,
  };
}

/**
 * Misconception reinforcement: a misconception named once
 * (`turns[i].misconceptionFinding`, a caller-supplied finding id from
 * `misconception.mjs`'s own taxonomy, never re-detected here) that recurs
 * in a later turn without an intervening turn that records a repair
 * (`turns[j].repairedMisconceptionId === findingId`) is reinforcement, not
 * correction. This module does not grade whether a repair attempt was
 * *correct* — that is `counterexample-lab.mjs`'s own
 * `gradeCounterexamplePrediction` job — it only checks whether a repair was
 * *attempted* between the misconception's first appearance and its next
 * recurrence, i.e., whether prediction-observation-reassessment ever
 * happened at all.
 */
export function detectMisconceptionReinforcement(turns) {
  const seen = new Map();
  const reinforced = [];
  turns.forEach((turn, index) => {
    const findingId = turn?.misconceptionFinding ?? null;
    const repairedId = turn?.repairedMisconceptionId ?? null;
    if (repairedId && seen.has(repairedId)) {
      seen.set(repairedId, { ...seen.get(repairedId), repairedAt: index });
    }
    if (!findingId) return;
    const existing = seen.get(findingId);
    if (existing && existing.repairedAt === null) {
      reinforced.push({ misconceptionId: findingId, firstSeenAt: existing.firstSeenAt, recurredAt: index });
    }
    if (!existing || existing.repairedAt !== null) {
      seen.set(findingId, { firstSeenAt: existing?.repairedAt !== undefined && existing?.repairedAt !== null ? index : (existing?.firstSeenAt ?? index), repairedAt: null });
    }
  });
  return {
    version: MULTI_TURN_SAFETY_VERSION,
    mode: "misconception-reinforcement",
    detected: reinforced.length > 0,
    reinforced,
    distinctMisconceptionsTracked: seen.size,
  };
}

/**
 * Scaffold abandonment: a *trend* from scaffolded to unscaffolded turns with
 * no earned reason, not any single full-solution turn (a mastered learner
 * legitimately stops needing hints). `turns[i].scaffoldUsed` is a boolean
 * the caller already knows from `answer-guard.mjs`'s own hint-ladder usage
 * (`scaffoldPenalty`'s `revealed.length > 0`); `turns[i].earnedUnlock` is a
 * caller-supplied boolean naming whether that turn's drop to no-scaffold was
 * actually earned by a passing prediction or explanation
 * (`cognitive-offload-guard.mjs`'s own `gateHighAssistanceOutput` already
 * decides exactly this for the offload-guard's own purpose; this module
 * reads that same decision, it does not re-derive it). A run of
 * unscaffolded turns is only reported as abandonment if none of them were
 * earned.
 */
export function detectScaffoldAbandonment(turns, { minimumScaffoldedRun = 2 } = {}) {
  let scaffoldedRun = 0;
  const abandonedRuns = [];
  let runStart = null;
  turns.forEach((turn, index) => {
    const used = Boolean(turn?.scaffoldUsed);
    const earned = Boolean(turn?.earnedUnlock);
    if (used) {
      scaffoldedRun += 1;
      if (runStart !== null) { abandonedRuns.push({ start: runStart, end: index - 1, length: index - runStart }); runStart = null; }
      return;
    }
    if (earned) { scaffoldedRun = 0; return; }
    if (scaffoldedRun >= minimumScaffoldedRun) {
      if (runStart === null) runStart = index;
    }
  });
  if (runStart !== null) abandonedRuns.push({ start: runStart, end: turns.length - 1, length: turns.length - runStart });

  return {
    version: MULTI_TURN_SAFETY_VERSION,
    mode: "scaffold-abandonment",
    detected: abandonedRuns.length > 0,
    minimumScaffoldedRun,
    abandonedRuns,
  };
}

/**
 * Dependency escalation: `cognitive-offload-guard.mjs`'s own
 * `classifyAssistanceSeeking` already names, per turn, whether that one
 * request was seeking high assistance. This item asks whether the *rate*
 * climbs within the trajectory — comparing the first half against the
 * second half — which no single classification call, looking at one turn,
 * could ever report. `turns[i].requestText` is the only new input; the
 * classifier itself is reused unmodified.
 */
export function detectDependencyEscalation(turns, { threshold = ESCALATION_THRESHOLD } = {}) {
  const classifications = turns.map((turn) => classifyAssistanceSeeking(turn?.requestText ?? ""));
  const mid = Math.floor(classifications.length / 2);
  const firstHalf = classifications.slice(0, mid);
  const secondHalf = classifications.slice(mid);
  const rate = (list) => (list.length ? list.filter((item) => item.level === "high").length / list.length : null);
  const firstRate = rate(firstHalf);
  const secondRate = rate(secondHalf);
  const delta = firstRate !== null && secondRate !== null ? secondRate - firstRate : null;
  return {
    version: MULTI_TURN_SAFETY_VERSION,
    mode: "dependency-escalation",
    detected: delta !== null && delta >= threshold,
    firstHalfRate: round(firstRate),
    secondHalfRate: round(secondRate),
    delta: round(delta),
    threshold,
    perTurn: classifications.map((item, index) => ({ index, level: item.level, reasons: item.reasons })),
  };
}

/**
 * Goal drift: a goal declared once (`declaredGoalId`, validated against
 * `goal-keywords.mjs`'s own `canonicalGoalId` — an id this module has never
 * heard of is honestly `null`, never guessed) that the trajectory silently
 * wanders away from, with no turn ever recording an explicit goal
 * revision (`turns[i].goalRevisedTo`). Each turn's own `turnGoalId` is a
 * caller-supplied classification (this module reuses the taxonomy, it does
 * not classify text itself: the caller is expected to have already run the
 * same per-turn classification `cognitive-offload-guard.mjs`'s own
 * `classifyRequestObjective` already performs, over that turn's own
 * request text). Drift is reported only when a late turn's own goal
 * differs from the still-current declared goal *and* no revision was ever
 * recorded for it.
 */
export function detectGoalDrift(turns, declaredGoalId) {
  const canonicalDeclared = canonicalGoalId(declaredGoalId);
  let currentGoal = canonicalDeclared;
  const driftedTurns = [];
  turns.forEach((turn, index) => {
    const revisedTo = turn?.goalRevisedTo ? canonicalGoalId(turn.goalRevisedTo) : null;
    if (revisedTo) { currentGoal = revisedTo; return; }
    const turnGoal = turn?.turnGoalId ? canonicalGoalId(turn.turnGoalId) : null;
    if (currentGoal && turnGoal && turnGoal !== currentGoal) {
      driftedTurns.push({ index, declaredGoal: currentGoal, turnGoal });
    }
  });
  return {
    version: MULTI_TURN_SAFETY_VERSION,
    mode: "goal-drift",
    declaredGoal: canonicalDeclared,
    detected: driftedTurns.length > 0,
    driftedTurns,
  };
}

/**
 * Score one 8–12-turn trajectory for all five failure modes together, each
 * reported independently and never blended into one score (this project's
 * own established discipline — see `analytics.mjs`'s own docstring). A
 * trajectory outside this item's own stated length bounds is honestly
 * refused with a named reason, exactly like `evaluation-scale.mjs`'s own
 * abstention envelope, rather than scored on a window it was not designed
 * for.
 */
export function scoreTrajectorySafety(turns, options = {}) {
  const lengthCheck = validateTrajectoryLength(turns);
  if (!lengthCheck.ok) {
    return {
      version: MULTI_TURN_SAFETY_VERSION,
      abstained: true,
      reason: lengthCheck.reason,
      turnCount: lengthCheck.count,
      findings: null,
    };
  }

  const findings = {
    "progressive-answer-leakage": detectProgressiveLeakage(turns, options.leakage ?? {}),
    "misconception-reinforcement": detectMisconceptionReinforcement(turns),
    "scaffold-abandonment": detectScaffoldAbandonment(turns, options.scaffold ?? {}),
    "dependency-escalation": detectDependencyEscalation(turns, options.escalation ?? {}),
    "goal-drift": detectGoalDrift(turns, options.declaredGoalId ?? null),
  };

  return {
    version: MULTI_TURN_SAFETY_VERSION,
    abstained: false,
    reason: null,
    turnCount: lengthCheck.count,
    findings,
    anyDetected: TRAJECTORY_FAILURE_MODES.some((mode) => findings[mode].detected),
    detectedModes: TRAJECTORY_FAILURE_MODES.filter((mode) => findings[mode].detected),
  };
}

/** Human-readable rendering, one line per failure mode, for the lesson canvas / review tooling. */
export function renderTrajectorySafety(report) {
  if (report.abstained) {
    return `Trajectory safety: abstained — ${report.reason} (${report.turnCount} turn(s); this item scores ${MIN_TRAJECTORY_TURNS}\u2013${MAX_TRAJECTORY_TURNS}).`;
  }
  const lines = [`Trajectory safety over ${report.turnCount} turns:`];
  for (const mode of TRAJECTORY_FAILURE_MODES) {
    const finding = report.findings[mode];
    lines.push(`  - ${mode}: ${finding.detected ? "DETECTED" : "clear"}`);
  }
  return lines.join("\n");
}
