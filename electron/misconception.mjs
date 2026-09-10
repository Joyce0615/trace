/**
 * Misconception models and calibrated confidence.
 *
 * A mastery percentage says how much a learner has done, not what they believe.
 * This module adds the two things that make a diagnostic honest:
 *
 *   - a misconception taxonomy with detectors that read what the learner wrote
 *     and with probes whose distractors *encode* a specific wrong model, so a
 *     wrong answer names the misunderstanding instead of just being wrong;
 *   - calibrated confidence from a Beta-Bernoulli posterior over the evidence,
 *     so "80% mastery from one quiz" and "80% mastery from ten activities" are
 *     no longer reported as the same thing, plus a Brier score that compares
 *     what the learner predicted about themselves with what they then did.
 *
 * Everything is deterministic and local: no model call is involved in deciding
 * what a learner misunderstands.
 */

export const MISCONCEPTION_VERSION = 1;

/**
 * The taxonomy. Each entry carries detector patterns for free text, a probe
 * whose distractor encodes the misconception, and concrete remediation.
 */
export const MISCONCEPTIONS = [
  {
    id: "execution-order",
    title: "Reads the file as the execution order",
    summary: "Assumes code runs in the order it appears in the file rather than in call order.",
    patterns: [/\bruns? (?:from )?top(?:\s|-)to(?:\s|-)bottom\b/i, /\bin the order (?:it|they) (?:appear|are written)\b/i, /\bexecutes? line by line down the file\b/i],
    remediation: "Follow one call edge at a time from the entry point; the file order is only a layout.",
    activity: "call-chain",
  },
  {
    id: "call-vs-definition",
    title: "Confuses the call site with the definition",
    summary: "Treats the place a function is called as the place its behaviour is decided.",
    patterns: [/\bdefined (?:where|at) (?:it|the function) is (?:called|used)\b/i, /\bthe call (?:site )?(?:defines|implements)\b/i, /\bbehaviou?r (?:is )?(?:decided|defined) (?:by|at) the caller\b/i],
    remediation: "Open the definition anchor and compare it with the call site; the caller only supplies arguments.",
    activity: "localization",
  },
  {
    id: "single-caller",
    title: "Assumes a single caller",
    summary: "Changes the function as if only one call site exists, ignoring fan-in.",
    patterns: [/\bonly (?:one|a single) (?:caller|call site|place)\b/i, /\bnothing else (?:calls|uses) (?:it|this)\b/i, /\bsafe to change because it is used once\b/i],
    remediation: "List every caller before changing a signature; the architecture view reports fan-in.",
    activity: "architecture",
  },
  {
    id: "mutation-vs-copy",
    title: "Assumes values are copied",
    summary: "Expects a passed object to be copied rather than shared and mutated in place.",
    patterns: [/\bpasses? (?:a )?copy\b/i, /\bcopied (?:when|before) (?:it is )?passed\b/i, /\bcannot (?:be )?(?:modify|modified) (?:the )?(?:caller|original)\b/i],
    remediation: "Trace the object's identity through the call; the execution trace shows the mutation in place.",
    activity: "execution-trace",
  },
  {
    id: "interface-vs-implementation",
    title: "Describes the interface instead of the behaviour",
    summary: "Restates the signature or docstring rather than what the code does.",
    patterns: [/\bit (?:just )?(?:takes|accepts) .* and returns\b/i, /\bas the (?:docstring|documentation|comment) says\b/i, /\bthe name says it all\b/i],
    remediation: "Read the body and name one state change the signature does not reveal.",
    activity: "lesson",
  },
  {
    id: "sync-assumption",
    title: "Assumes everything is synchronous",
    summary: "Reads concurrent or deferred work as if it completes before the next line.",
    patterns: [/\bwaits? for (?:it|the result) (?:to finish )?before (?:continuing|the next line)\b/i, /\bhappens? immediately\b/i, /\bblocks? until (?:it is )?done\b/i],
    remediation: "Find where the result is awaited or joined; that is where the ordering is actually decided.",
    activity: "execution-trace",
  },
  {
    id: "error-path-blindness",
    title: "Only accounts for the happy path",
    summary: "Explains the successful flow and omits failure handling entirely.",
    patterns: [/\balways (?:returns|succeeds|works)\b/i, /\bnothing (?:can )?(?:go wrong|fails?)\b/i, /\bassuming (?:it|everything) works\b/i],
    remediation: "Follow the raise or error return in the same function and say who handles it.",
    activity: "lesson",
  },
  {
    id: "global-state",
    title: "Treats shared state as local",
    summary: "Assumes module-level or cached state is created fresh for each call.",
    patterns: [/\b(?:fresh|new) (?:each|every) (?:call|time)\b/i, /\blocal to (?:the|this) (?:call|function)\b/i, /\bno shared state\b/i],
    remediation: "Look for module-level assignments and caches; they outlive the call you are reading.",
    activity: "architecture",
  },
];

const BY_ID = new Map(MISCONCEPTIONS.map((entry) => [entry.id, entry]));

export function misconceptionById(id) {
  return BY_ID.get(id) ?? null;
}

/** Detect misconceptions in a learner's own words. */
export function detectMisconceptions(text, options = {}) {
  const value = String(text ?? "");
  if (!value.trim()) return [];
  const findings = [];
  for (const entry of MISCONCEPTIONS) {
    const matches = entry.patterns.filter((pattern) => pattern.test(value));
    if (!matches.length) continue;
    findings.push({
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      // More independent matching patterns means a stronger signal, but a single
      // phrase is never treated as certain.
      confidence: Number(Math.min(0.9, 0.45 + 0.2 * (matches.length - 1)).toFixed(3)),
      evidence: matches.map((pattern) => value.match(pattern)?.[0]).filter(Boolean).slice(0, 3),
      remediation: entry.remediation,
      activity: entry.activity,
      source: options.source ?? null,
    });
  }
  return findings.sort((left, right) => right.confidence - left.confidence);
}

/**
 * Build a source-anchored probe for one skill. Each distractor is tagged with
 * the misconception it encodes, so a wrong answer is diagnostic.
 */
export function buildProbe(skill, repository) {
  const anchor = skill.anchors?.[0] ?? null;
  const symbol = anchor?.symbol ?? (repository.symbols ?? []).find((candidate) => candidate.path === anchor?.path)?.name ?? null;
  const label = symbol ? `\`${symbol}\`` : anchor?.path ?? skill.title;
  const callers = (repository.callEdges ?? []).filter((edge) => edge.resolved && edge.callee === symbol && edge.targetPath === anchor?.path);
  const options = [
    { id: "correct", text: `Follow the call edges into ${label} and read what it changes before it returns.`, misconception: null },
    { id: "execution-order", text: `Read ${anchor?.path ?? "the file"} from the top; the lines run in the order they are written.`, misconception: "execution-order" },
    { id: "call-vs-definition", text: `Read the call site: that is where ${label}'s behaviour is decided.`, misconception: "call-vs-definition" },
    { id: "interface-vs-implementation", text: `Read the signature and docstring of ${label}; that is what it does.`, misconception: "interface-vs-implementation" },
  ];
  return {
    id: `probe-${skill.id}`,
    skillId: skill.id,
    prompt: `To predict what changes when ${label} runs, what do you do first?`,
    anchor,
    options: options.map(({ id, text }) => ({ id, text })),
    answerId: "correct",
    misconceptionByOption: Object.fromEntries(options.filter((option) => option.misconception).map((option) => [option.id, option.misconception])),
    fanIn: new Set(callers.map((edge) => `${edge.path}#${edge.caller}`)).size,
  };
}

/** Grade a probe answer, naming the misconception a wrong choice encodes. */
export function gradeProbe(probe, choiceId) {
  const correct = choiceId === probe.answerId;
  const misconceptionId = probe.misconceptionByOption[choiceId] ?? null;
  const entry = misconceptionId ? misconceptionById(misconceptionId) : null;
  return {
    probeId: probe.id,
    skillId: probe.skillId,
    correct,
    choiceId: choiceId ?? null,
    misconception: entry
      ? { id: entry.id, title: entry.title, summary: entry.summary, confidence: 0.8, remediation: entry.remediation, activity: entry.activity }
      : null,
    anchor: probe.anchor,
  };
}

// Evidence kinds differ in how much they say about understanding, so they carry
// different weight in the posterior.
// A spaced review is a retrieval attempt against a delay, which is stronger
// evidence of durable understanding than answering a quiz immediately after
// reading the lesson.
const EVIDENCE_WEIGHT = { diagnostic: 0.6, lesson: 0.8, quiz: 1.4, practice: 1.6, review: 1.8, "self-report": 0.4, note: 0.2 };
const PRIOR_ALPHA = 1;
const PRIOR_BETA = 1;
const SUCCESS_THRESHOLD = 0.6;

/**
 * Calibrated mastery for one skill.
 *
 * The posterior mean is the estimate; the width of the 95% credible interval is
 * what turns it into a confidence. Ten consistent activities and one lucky quiz
 * can produce the same mean, and this reports them differently.
 */
export function calibrateSkill(mastery) {
  const evidence = (mastery?.evidence ?? []).filter((item) => typeof item.strength === "number");
  let alpha = PRIOR_ALPHA;
  let beta = PRIOR_BETA;
  const predictions = [];
  let selfReport = null;
  for (const item of evidence) {
    const weight = EVIDENCE_WEIGHT[item.kind] ?? 0.5;
    const success = Math.max(0, Math.min(1, item.strength));
    alpha += weight * success;
    beta += weight * (1 - success);
    if (item.kind === "self-report") selfReport = success;
    else if (["quiz", "practice", "diagnostic", "review"].includes(item.kind)) {
      // Compare what the learner predicted about themselves with what happened.
      predictions.push({ predicted: selfReport ?? alpha / (alpha + beta), outcome: success >= SUCCESS_THRESHOLD ? 1 : 0 });
    }
  }

  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / (((alpha + beta) ** 2) * (alpha + beta + 1));
  const deviation = Math.sqrt(variance);
  const interval = [Math.max(0, mean - 1.96 * deviation), Math.min(1, mean + 1.96 * deviation)];
  const width = interval[1] - interval[0];
  const brier = predictions.length
    ? predictions.reduce((sum, item) => sum + (item.predicted - item.outcome) ** 2, 0) / predictions.length
    : null;
  const bias = predictions.length
    ? predictions.reduce((sum, item) => sum + (item.predicted - item.outcome), 0) / predictions.length
    : null;

  return {
    skillId: mastery?.skillId ?? null,
    mastery: Number(mean.toFixed(4)),
    // A wide interval means "we do not know yet", which is different from "weak".
    // The interval is already clipped to [0, 1], so its width *is* the scale:
    // normalizing by anything smaller collapses every realistic case to zero.
    confidence: Number(Math.max(0, Math.min(1, 1 - width)).toFixed(4)),
    interval: interval.map((value) => Number(value.toFixed(4))),
    intervalWidth: Number(width.toFixed(4)),
    evidenceCount: evidence.length,
    effectiveObservations: Number((alpha + beta - PRIOR_ALPHA - PRIOR_BETA).toFixed(3)),
    brier: brier === null ? null : Number(brier.toFixed(4)),
    calibrationBias: bias === null ? null : Number(bias.toFixed(4)),
    calibration: bias === null ? "unknown" : bias > 0.15 ? "overconfident" : bias < -0.15 ? "underconfident" : "calibrated",
    status: mastery?.status ?? "locked",
  };
}

/**
 * Calibrate a whole learner state and attach the misconceptions detected in the
 * learner's own notes and answers.
 */
export function diagnoseLearner(learnerState, skillGraph, repository, options = {}) {
  const skills = (skillGraph?.nodes ?? []).map((node) => {
    const calibrated = calibrateSkill(learnerState?.mastery?.[node.id]);
    const written = (learnerState?.mastery?.[node.id]?.evidence ?? [])
      .filter((item) => typeof item.detail === "string")
      .flatMap((item) => detectMisconceptions(item.detail, { source: `${item.kind}:${item.id}` }));
    const fromMemory = (learnerState?.memory ?? [])
      .filter((item) => !item.skillId || item.skillId === node.id)
      .flatMap((item) => detectMisconceptions(item.text, { source: `memory:${item.id}` }));
    const merged = new Map();
    for (const finding of [...written, ...fromMemory, ...(options.findings?.[node.id] ?? [])]) {
      const existing = merged.get(finding.id);
      if (!existing || finding.confidence > existing.confidence) merged.set(finding.id, finding);
    }
    return {
      skillId: node.id,
      title: node.title,
      ...calibrated,
      misconceptions: [...merged.values()].sort((left, right) => right.confidence - left.confidence),
      probe: buildProbe(node, repository ?? { symbols: [], callEdges: [] }),
    };
  });

  const withEvidence = skills.filter((skill) => skill.evidenceCount > 0);
  const briers = withEvidence.filter((skill) => skill.brier !== null);
  return {
    version: MISCONCEPTION_VERSION,
    skills: skills.map((skill) => ({ ...skill, probe: { ...skill.probe, answerId: undefined, misconceptionByOption: undefined } })),
    probes: Object.fromEntries(skills.map((skill) => [skill.probe.id, skill.probe])),
    summary: {
      skills: skills.length,
      assessed: withEvidence.length,
      // The average interval width is the honest headline: how much is actually known.
      meanConfidence: withEvidence.length ? Number((withEvidence.reduce((sum, skill) => sum + skill.confidence, 0) / withEvidence.length).toFixed(4)) : 0,
      meanBrier: briers.length ? Number((briers.reduce((sum, skill) => sum + skill.brier, 0) / briers.length).toFixed(4)) : null,
      overconfidentSkills: withEvidence.filter((skill) => skill.calibration === "overconfident").length,
      underconfidentSkills: withEvidence.filter((skill) => skill.calibration === "underconfident").length,
      misconceptionCounts: skills
        .flatMap((skill) => skill.misconceptions.map((finding) => finding.id))
        .reduce((counts, id) => ({ ...counts, [id]: (counts[id] ?? 0) + 1 }), {}),
    },
    taxonomy: MISCONCEPTIONS.map(({ id, title, summary, remediation, activity }) => ({ id, title, summary, remediation, activity })),
  };
}
