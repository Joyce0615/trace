/**
 * Grading code explanations against traced behavior.
 *
 * Item 28 grades a plan against the *static* index: what the code says. This
 * grades an explanation against what the code actually *did*. That distinction
 * matters because the explanations learners get wrong are almost never
 * incoherent — they are fluent, plausible, and contradicted by the run:
 *
 *   - naming a function that never executed (over-claiming from the call graph);
 *   - describing the calls in an order the trace did not take;
 *   - reporting a return value the function did not return;
 *   - inventing an error path in a run that raised nothing, or omitting the
 *     exception in a run that failed.
 *
 * Each of those is checkable, so each is a criterion with the trace event that
 * settles it attached as evidence. The rubric predicates and the observed
 * behavior stay in the main process: the learner writes the explanation first
 * and the trace is revealed as feedback, otherwise the answer is the question.
 *
 * There is no model in the loop. Everything below is derived from the recorded
 * trace and the indexed source.
 */

export const EXPLANATION_GRADER_VERSION = 1;

// Weights sum to 1. Behavior beats vocabulary: coverage plus correctness of the
// observed order and result is 0.60 of the score, and the two "did you claim
// something that never happened" criteria are worth another 0.25, because those
// are the failures a fluent explanation hides best.
const CRITERIA = [
  { id: "names-entry", title: "Names the function that ran", weight: 0.10, description: "Identify the entry point the run started from." },
  { id: "covers-observed", title: "Covers what actually executed", weight: 0.22, description: "Mention the functions the run really entered, not just the ones nearby in the file." },
  { id: "call-order", title: "Gets the call order right", weight: 0.18, description: "Describe the functions in the order the run entered them." },
  { id: "return-value", title: "Reports the observed result", weight: 0.20, description: "State the value the entry point returned or printed." },
  { id: "no-unobserved", title: "Claims nothing that did not run", weight: 0.15, description: "Do not describe functions that this run never entered." },
  { id: "error-path", title: "Is honest about failure", weight: 0.10, description: "Mention the exception if the run raised one, and do not invent one if it did not." },
  { id: "cites-source", title: "Cites real source", weight: 0.05, description: "Point at a `path:line` that exists in this repository." },
];

const BANDS = [
  { id: "expert", minimum: 0.85 },
  { id: "proficient", minimum: 0.65 },
  { id: "developing", minimum: 0.4 },
  { id: "novice", minimum: 0 },
];

// A short answer that happens to contain the right words is not an explanation,
// so credit is scaled by length until the answer is substantial.
const FULL_CREDIT_WORDS = 30;

const ERROR_WORDS = /\b(?:raise[sd]?|raising|throw[sn]?|exception|error|fail(?:s|ed|ure)?|traceback|crash(?:es|ed)?)\b/gi;
const NEGATORS = /\b(?:no|not|nothing|none|never|without|cannot|can[\u2019']?t|won[\u2019']?t|doesn[\u2019']?t|didn[\u2019']?t|isn[\u2019']?t|aren[\u2019']?t|rather than|instead of|free of|avoids?)\b/i;

/**
 * Does the explanation claim the run failed?
 *
 * "Nothing raises" and "it raises" contain the same word and mean the opposite
 * thing, so a bare keyword match would mark a *correct* explanation of a
 * successful run as inventing a failure. Each occurrence is therefore checked
 * against the negators in front of it, within its own sentence.
 */
export function claimsFailure(text) {
  for (const sentence of String(text ?? "").split(/(?<=[.!?;])\s+|\n+/)) {
    for (const match of sentence.matchAll(ERROR_WORDS)) {
      const before = sentence.slice(Math.max(0, match.index - 45), match.index);
      if (!NEGATORS.test(before)) return true;
    }
  }
  return false;
}

/** A frame a learner could name: not `<module>`, `<lambda>`, or a comprehension. */
export function isNamedFunction(name) {
  return typeof name === "string" && name.length > 0 && !name.startsWith("<");
}

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

/**
 * Identifiers a learner referred to. Back-quoted names and `name(...)` calls are
 * unambiguous; bare words only count when they match a name the index knows, so
 * ordinary prose does not become a symbol claim.
 */
export function mentionedSymbols(text, knownNames) {
  const value = String(text ?? "");
  const known = new Set(knownNames ?? []);
  const found = new Map();
  const note = (name, index) => {
    if (!name) return;
    if (!found.has(name) || index < found.get(name)) found.set(name, index);
  };
  for (const match of value.matchAll(/`([A-Za-z_][A-Za-z0-9_.]*)`/g)) note(match[1].split(".").at(-1), match.index);
  for (const match of value.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) note(match[1], match.index);
  for (const name of known) {
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    const match = pattern.exec(value);
    if (match) note(name, match.index);
  }
  return [...found.entries()]
    .map(([name, index]) => ({ name, index }))
    .sort((left, right) => left.index - right.index);
}

/** `path:line` citations, with each one checked against the index. */
export function checkCitations(text, repository) {
  const files = new Map((repository?.files ?? []).map((file) => [file.path, file]));
  const citations = [];
  for (const match of String(text ?? "").matchAll(/([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,6}):(\d{1,7})/g)) {
    const [, filePath, rawLine] = match;
    const line = Number(rawLine);
    const file = files.get(filePath);
    citations.push({
      path: filePath,
      line,
      valid: Boolean(file),
      reason: file ? null : "unknown-file",
    });
  }
  return citations;
}

/**
 * Build a grading task from a real recorded run.
 *
 * `observed` is the answer key: the functions that executed, the order they
 * executed in, the values they returned, and whether anything raised. It never
 * leaves the main process before the learner has answered.
 */
export function buildExplanationTask(repository, summary, options = {}) {
  // Importing a module executes its body, which the tracer records as
  // `<module>`, and comprehensions and lambdas get synthetic names too. None of
  // those are things a learner can be asked to name, so they are not part of
  // the observed behavior being graded.
  const functions = (summary?.functions ?? []).filter((item) => isNamedFunction(item.name));
  if (!summary || summary.callCount === 0 || !functions.length) {
    return { available: false, version: EXPLANATION_GRADER_VERSION, reason: "The run recorded no calls, so there is no behavior to explain." };
  }
  const transitions = (summary.transitions ?? []).filter((transition) => isNamedFunction(transition.from.name) && isNamedFunction(transition.to.name));
  const entry = functions.reduce(
    (best, candidate) => (best === null || (candidate.calls ?? 0) > (best.calls ?? 0) ? candidate : best),
    null,
  );
  // The entry point of a run is the first frame the tracer entered, not the
  // busiest one, so prefer the function nothing else called.
  const called = new Set(transitions.map((transition) => `${transition.to.path}#${transition.to.name}`));
  const root = functions.find((candidate) => !called.has(`${candidate.path}#${candidate.name}`)) ?? entry;

  const order = [];
  for (const transition of transitions) {
    if (!order.includes(transition.from.name)) order.push(transition.from.name);
    if (!order.includes(transition.to.name)) order.push(transition.to.name);
  }
  for (const item of functions) if (!order.includes(item.name)) order.push(item.name);

  const returnValues = (summary.returnValues ?? []).filter((item) => item.value && isNamedFunction(item.function ?? item.name));
  const rootReturn = returnValues.find((item) => item.name === root.name || item.function === root.name) ?? returnValues.at(-1) ?? null;
  const raised = (summary.exceptionCount ?? 0) > 0;

  return {
    available: true,
    version: EXPLANATION_GRADER_VERSION,
    id: `explain-${root.path}#${root.name}@${summary.callCount}`,
    entry: { path: root.path, line: root.line, name: root.name },
    anchor: { path: root.path, line: root.line, symbol: root.name },
    prompt: `Without looking at the run, explain what happens when \`${root.name}\` executes: which functions it reaches, in what order, and what comes back. Trace recorded the real run and will grade your explanation against it.`,
    criteria: CRITERIA.map(({ id, title, weight, description }) => ({ id, title, weight, description })),
    // The answer key.
    observed: {
      functions: functions.map((item) => ({ name: item.name, path: item.path, line: item.line, calls: item.calls })),
      order,
      transitions: transitions.map((transition) => ({ from: transition.from.name, to: transition.to.name, count: transition.count })),
      returnValue: rootReturn ? { function: rootReturn.function ?? rootReturn.name, value: rootReturn.value, path: rootReturn.path, line: rootReturn.line } : null,
      returnValues: returnValues.map((item) => ({ function: item.function, value: item.value })),
      raised,
      maxDepth: summary.maxDepth ?? 0,
      status: summary.status,
    },
    // Symbols the index knows about in the traced files, so an over-claim can be
    // distinguished from ordinary prose.
    neighborhood: (repository?.symbols ?? [])
      .filter((symbol) => summary.files?.includes(symbol.path))
      .map((symbol) => symbol.name),
  };
}

/** What the renderer may see: the prompt, the anchor, and the rubric headings. */
export function publicExplanationTask(task) {
  if (!task?.available) return task;
  return {
    available: true,
    version: task.version,
    id: task.id,
    anchor: task.anchor,
    prompt: task.prompt,
    criteria: task.criteria,
    entry: { name: task.entry.name },
  };
}

/**
 * Grade one explanation against the recorded run.
 *
 * Every verdict carries the trace evidence that decided it, so a learner can
 * check the grading rather than being asked to trust it.
 */
export function gradeExplanation(task, submission, repository) {
  const text = String(submission ?? "");
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const lengthFactor = Math.min(1, words / FULL_CREDIT_WORDS);
  const observed = task.observed;
  const observedNames = observed.functions.map((item) => item.name);
  const known = new Set([...observedNames, ...(task.neighborhood ?? [])]);
  const mentions = mentionedSymbols(text, known);
  const mentionedNames = mentions.map((item) => item.name);

  const namedObserved = observedNames.filter((name) => mentionedNames.includes(name));
  const missed = observedNames.filter((name) => !mentionedNames.includes(name));
  // A symbol the index knows, in a file this run touched, that never executed:
  // that is an over-claim, and it is the failure mode a fluent answer hides.
  const unsupported = mentionedNames.filter((name) => !observedNames.includes(name) && (task.neighborhood ?? []).includes(name));

  // Order accuracy compares the sequence of first mentions with the observed
  // sequence, over adjacent pairs the learner actually named.
  const mentionOrder = mentions.filter((item) => observedNames.includes(item.name)).map((item) => item.name);
  let orderedPairs = 0;
  let correctPairs = 0;
  for (let index = 0; index + 1 < mentionOrder.length; index += 1) {
    const left = observed.order.indexOf(mentionOrder[index]);
    const right = observed.order.indexOf(mentionOrder[index + 1]);
    if (left === -1 || right === -1 || left === right) continue;
    orderedPairs += 1;
    if (left < right) correctPairs += 1;
  }
  const orderAccuracy = orderedPairs ? correctPairs / orderedPairs : 0;

  const returnValue = observed.returnValue?.value ?? null;
  const bareReturn = returnValue ? returnValue.replace(/^['"]|['"]$/g, "") : null;
  const statesReturn = Boolean(bareReturn) && bareReturn.length > 0
    && new RegExp(`(?:^|[^A-Za-z0-9_])${bareReturn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^A-Za-z0-9_]|$)`).test(text);
  const claimsError = claimsFailure(text);
  const citations = checkCitations(text, repository);

  const coverage = observedNames.length ? namedObserved.length / observedNames.length : 0;
  const contradictions = [];
  if (orderedPairs && orderAccuracy < 1) {
    for (let index = 0; index + 1 < mentionOrder.length; index += 1) {
      const left = observed.order.indexOf(mentionOrder[index]);
      const right = observed.order.indexOf(mentionOrder[index + 1]);
      if (left > right && right !== -1 && left !== -1) {
        contradictions.push({
          claim: `${mentionOrder[index]} before ${mentionOrder[index + 1]}`,
          reason: "the run entered them the other way round",
          evidence: `observed order: ${observed.order.join(" → ")}`,
        });
      }
    }
  }
  for (const name of unsupported) {
    contradictions.push({ claim: `${name} runs`, reason: "this run never entered it", evidence: `observed functions: ${observedNames.join(", ")}` });
  }
  if (claimsError && !observed.raised) {
    contradictions.push({ claim: "the run fails", reason: "the run completed without raising", evidence: `status: ${observed.status}` });
  }
  if (!claimsError && observed.raised) {
    contradictions.push({ claim: "the run completes", reason: "the run raised an exception", evidence: `status: ${observed.status}` });
  }
  if (returnValue && !statesReturn) {
    contradictions.push({ claim: "the result is not stated", reason: "the run produced a value the explanation does not report", evidence: `${observed.returnValue.function} returned ${returnValue}` });
  }

  const verdicts = [
    {
      id: "names-entry",
      passed: mentionedNames.includes(task.entry.name),
      evidence: `${task.entry.path}:${task.entry.line}`,
      detail: mentionedNames.includes(task.entry.name) ? `Named \`${task.entry.name}\`.` : `The run started in \`${task.entry.name}\`, which the explanation never names.`,
      credit: mentionedNames.includes(task.entry.name) ? 1 : 0,
    },
    {
      id: "covers-observed",
      passed: coverage >= 0.75,
      evidence: `${namedObserved.length}/${observedNames.length} observed functions named`,
      detail: missed.length ? `Never mentioned: ${missed.slice(0, 4).join(", ")}.` : "Every function that ran is accounted for.",
      credit: coverage,
    },
    {
      id: "call-order",
      passed: orderedPairs > 0 && orderAccuracy === 1,
      evidence: `observed order: ${observed.order.join(" → ")}`,
      detail: orderedPairs === 0 ? "The explanation does not describe an order to check." : `${correctPairs}/${orderedPairs} adjacent pairs match the run.`,
      credit: orderedPairs === 0 ? 0 : orderAccuracy,
    },
    {
      id: "return-value",
      passed: returnValue === null ? false : statesReturn,
      evidence: returnValue === null ? "the run recorded no return value" : `${observed.returnValue.function} returned ${returnValue}`,
      detail: statesReturn ? "The reported result matches the run." : "The explanation does not state what came back.",
      credit: statesReturn ? 1 : 0,
    },
    {
      id: "no-unobserved",
      passed: unsupported.length === 0,
      evidence: `observed functions: ${observedNames.join(", ")}`,
      detail: unsupported.length ? `Described as running, but did not: ${unsupported.slice(0, 4).join(", ")}.` : "Nothing was claimed that the run did not do.",
      credit: unsupported.length === 0 ? 1 : Math.max(0, 1 - unsupported.length * 0.5),
    },
    {
      id: "error-path",
      passed: claimsError === observed.raised,
      evidence: `status: ${observed.status}, exceptions: ${observed.raised ? "yes" : "none"}`,
      detail: claimsError === observed.raised
        ? (observed.raised ? "The failure is described." : "No failure was invented.")
        : (observed.raised ? "The run raised, and the explanation does not say so." : "The explanation describes a failure that did not happen."),
      credit: claimsError === observed.raised ? 1 : 0,
    },
    {
      id: "cites-source",
      passed: citations.some((citation) => citation.valid),
      evidence: citations.length ? citations.map((citation) => `${citation.path}:${citation.line}${citation.valid ? "" : " (unknown)"}`).join(", ") : "no citation",
      detail: citations.length ? `${citations.filter((citation) => citation.valid).length}/${citations.length} citations resolve in this repository.` : "No `path:line` citation was given.",
      credit: citations.length ? citations.filter((citation) => citation.valid).length / citations.length : 0,
    },
  ];

  const criteria = CRITERIA.map((criterion) => {
    const verdict = verdicts.find((item) => item.id === criterion.id);
    return {
      ...criterion,
      passed: verdict.passed,
      // Keyword stuffing is capped the same way item 28 caps it: a five-word
      // answer containing every right name scores a fraction, not full marks.
      credit: round(Math.max(0, Math.min(1, verdict.credit)) * lengthFactor),
      evidence: verdict.evidence,
      detail: verdict.detail,
    };
  });

  const score = round(criteria.reduce((sum, criterion) => sum + criterion.credit * criterion.weight, 0));
  const weakest = [...criteria].sort((left, right) => (left.credit * left.weight) - (right.credit * right.weight))[0];
  return {
    version: EXPLANATION_GRADER_VERSION,
    taskId: task.id,
    score,
    band: BANDS.find((band) => score >= band.minimum).id,
    lengthFactor: round(lengthFactor),
    words,
    criteria,
    coverage: round(coverage),
    orderAccuracy: round(orderAccuracy),
    named: namedObserved,
    missed,
    unsupported,
    contradictions,
    citations,
    weakest: weakest?.id ?? null,
    next: weakest
      ? `Strongest gain: ${weakest.title.toLowerCase()} — ${weakest.detail}`
      : "This explanation matches the recorded run.",
    // Revealed only now that the learner has answered.
    observed: task.observed,
  };
}
