import { detectMisconceptions } from "./misconception.mjs";

/**
 * Three activities that exercise understanding in ways reading cannot.
 *
 *   - **Teach-back.** Explaining to a newcomer is a different skill from
 *     answering a question, and it fails differently: the giveaway is not a
 *     wrong fact but a restatement of the signature with no mechanism, no
 *     example, and a confident phrasing that would *plant* a misconception in
 *     the listener. So a teach-back is graded on its explanatory moves and run
 *     through item 35's misconception detectors, because what a learner would
 *     teach is the sharpest evidence of what they believe.
 *
 *   - **Prediction before reveal.** Committing to an answer before seeing it is
 *     what turns reading into retrieval. Every prediction here has an answer
 *     the index can settle exactly — how many files call this, how many
 *     parameters it takes, where this import resolves — and every prediction
 *     carries a stated confidence, so the activity produces calibration data
 *     (a Brier score) rather than only a mark.
 *
 *   - **Contrastive examples.** Two definitions of the same name in different
 *     files is the ambiguity that actually costs people time in a real
 *     repository. The learner is shown a real call site and both real
 *     definitions and has to say which one it reaches, then sees the concrete
 *     differences between them.
 *
 * Every answer key is derived from the index and stays in the main process.
 * The module is Node-free and takes its sources as a parameter, so the browser
 * demo runs this exact code.
 */

export const ACTIVITY_VERSION = 1;

const CAUSAL_WORDS = /\b(?:because|so that|which means|therefore|as a result|that is why|the reason|otherwise|in order to|this lets|this allows|since)\b/i;
const EXAMPLE_WORDS = /\b(?:for example|for instance|say you|imagine|suppose|e\.g\.|concretely|in practice)\b/i;

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

function tokens(text) {
  return new Set(String(text ?? "").toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? []);
}

// Ordinary English is shared by every explanation, so counting it would make a
// paraphrase and a real explanation look equally derivative.
const STOPWORDS = new Set([
  "the", "and", "that", "this", "with", "from", "for", "are", "but", "you", "your", "its",
  "has", "have", "had", "was", "were", "will", "would", "can", "could", "should", "then",
  "than", "into", "out", "not", "all", "any", "some", "one", "two", "when", "where", "which",
  "what", "who", "how", "why", "there", "here", "they", "them", "their", "our", "just", "only",
  "also", "very", "more", "most", "much", "many", "own", "same", "such", "other", "another",
  "get", "gets", "got", "use", "uses", "used", "using", "make", "makes", "made", "does", "did",
  "been", "being", "over", "after", "before", "because", "about", "each", "every", "these",
  "those", "while", "still", "even", "both", "case", "cases", "thing", "things", "way", "ways",
]);

/**
 * How much of the learner's *content* vocabulary is borrowed from the source.
 *
 * Ordinary English words are excluded: they appear in every explanation, and
 * counting them would make a genuine explanation look as derivative as a
 * paraphrase of the declaration.
 */
export function restatementRatio(text, source) {
  const written = (String(text ?? "").toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? [])
    .filter((word) => !STOPWORDS.has(word));
  if (!written.length) return 0;
  const original = new Set([...tokens(source)].filter((word) => !STOPWORDS.has(word)));
  if (!original.size) return 0;
  return round(written.filter((word) => original.has(word)).length / written.length);
}

function sourceLines(sources, filePath) {
  const source = sources?.[filePath];
  return typeof source === "string" ? source.split(/\r?\n/) : null;
}

/** The excerpt around a definition, bounded so a contrast stays readable. */
export function excerptFor(sources, filePath, line, span = 8) {
  const lines = sourceLines(sources, filePath);
  if (!lines) return null;
  const start = Math.max(0, line - 1);
  return {
    path: filePath,
    startLine: start + 1,
    text: lines.slice(start, start + span).join("\n"),
  };
}

/** Parameter names from a `def`/`function` header, or null if it cannot be read. */
export function headerParameters(sources, filePath, line) {
  const lines = sourceLines(sources, filePath);
  const header = lines?.[Math.max(0, line - 1)];
  const inside = header ? /\(([^)]*)\)/.exec(header)?.[1] : null;
  if (inside === null || inside === undefined) return null;
  return inside
    .split(",")
    .map((piece) => piece.split(/[:=]/)[0].trim().replace(/^[*&]+/, ""))
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name !== "self" && name !== "cls");
}

// ---------------------------------------------------------------------------
// Teach-back
// ---------------------------------------------------------------------------

const TEACH_BACK_MOVES = [
  { id: "names-target", title: "Names the thing", weight: 0.15, description: "Say what you are explaining." },
  { id: "gives-mechanism", title: "Explains why, not just what", weight: 0.25, description: "Use causal language: what makes this happen, and what would break without it." },
  { id: "gives-example", title: "Grounds it in an example", weight: 0.2, description: "Walk through one concrete case rather than staying abstract." },
  { id: "cites-source", title: "Points at the code", weight: 0.15, description: "Give a `path:line` a newcomer could open." },
  { id: "not-restatement", title: "Says more than the signature", weight: 0.15, description: "Do not paraphrase the declaration back; say what it does." },
  { id: "teaches-no-misconception", title: "Would not mislead the listener", weight: 0.1, description: "Avoid phrasings that plant a known misunderstanding." },
];

/** Build a teach-back task about a real, well-connected symbol. */
export function buildTeachBack(repository, sources, options = {}) {
  const callers = new Map();
  for (const edge of repository?.callEdges ?? []) {
    if (!edge.resolved || !edge.targetPath || !edge.caller) continue;
    const key = `${edge.targetPath}#${edge.callee}`;
    if (!callers.has(key)) callers.set(key, new Set());
    callers.get(key).add(edge.path);
  }
  const candidates = (repository?.symbols ?? [])
    .filter((symbol) => symbol.kind === "function" && (!options.symbol || symbol.name === options.symbol))
    .map((symbol) => ({ symbol, fanIn: callers.get(`${symbol.path}#${symbol.name}`)?.size ?? 0 }))
    .sort((left, right) => right.fanIn - left.fanIn || left.symbol.path.localeCompare(right.symbol.path));
  const chosen = candidates[0];
  if (!chosen) return { available: false, kind: "teach-back", reason: "This repository has no indexed function to teach back." };

  const { symbol, fanIn } = chosen;
  const excerpt = excerptFor(sources, symbol.path, symbol.line, 12);
  return {
    available: true,
    kind: "teach-back",
    version: ACTIVITY_VERSION,
    id: `teach-${symbol.path}#${symbol.name}@${symbol.line}`,
    symbol: symbol.name,
    anchor: { path: symbol.path, line: symbol.line, symbol: symbol.name },
    fanIn,
    prompt: `A new teammate has never seen this repository. In your own words, teach them what \`${symbol.name}\` does and why it exists. Use one concrete example and point them at the code.`,
    moves: TEACH_BACK_MOVES.map(({ id, title, weight, description }) => ({ id, title, weight, description })),
    excerpt,
    // The answer key: the source the learner must say more than.
    reference: excerpt?.text ?? "",
  };
}

/**
 * Grade a teach-back on its explanatory moves.
 *
 * The misconception check is the point: a teach-back that is *fluent* and
 * *wrong* is worse than one that is hesitant and right, because the listener
 * will believe it.
 */
export function gradeTeachBack(task, submission, repository) {
  const text = String(submission ?? "");
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const lengthFactor = Math.min(1, words / 40);
  const namesTarget = new RegExp(`\\b${task.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
  const causal = CAUSAL_WORDS.test(text);
  const example = EXAMPLE_WORDS.test(text) || /\b[A-Za-z_][A-Za-z0-9_]*\((?:[^)]|\n)*?[^\s)]\)/.test(text);
  const files = new Set((repository?.files ?? []).map((file) => file.path));
  const citations = [...text.matchAll(/([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,6}):(\d{1,7})/g)]
    .map((match) => ({ path: match[1], line: Number(match[2]), valid: files.has(match[1]) }));
  const restatement = restatementRatio(text, task.reference);
  const misconceptions = detectMisconceptions(text, { source: "teach-back" });

  const credits = {
    "names-target": namesTarget ? 1 : 0,
    "gives-mechanism": causal ? 1 : 0,
    "gives-example": example ? 1 : 0,
    "cites-source": citations.some((citation) => citation.valid) ? 1 : 0,
    // Above 60% shared vocabulary the learner is echoing the declaration back.
    "not-restatement": restatement > 0.6 ? 0 : restatement > 0.45 ? 0.5 : 1,
    "teaches-no-misconception": misconceptions.length ? 0 : 1,
  };
  const moves = TEACH_BACK_MOVES.map((move) => ({
    ...move,
    passed: credits[move.id] >= 1,
    credit: round(credits[move.id] * lengthFactor),
    detail: move.id === "not-restatement"
      ? `${Math.round(restatement * 100)}% of your words also appear in the declaration.`
      : move.id === "teaches-no-misconception"
        ? (misconceptions.length ? `This would teach: ${misconceptions.map((finding) => finding.title).join("; ")}.` : "Nothing here would mislead a newcomer.")
        : credits[move.id] >= 1 ? "Done." : move.description,
  }));
  const score = round(moves.reduce((sum, move) => sum + move.credit * move.weight, 0));
  return {
    version: ACTIVITY_VERSION,
    kind: "teach-back",
    taskId: task.id,
    score,
    words,
    lengthFactor: round(lengthFactor),
    restatement,
    moves,
    citations,
    // Named so the learner can fix the belief, not just the paragraph.
    misconceptions,
    passed: score >= 0.7 && misconceptions.length === 0,
    next: moves.filter((move) => !move.passed).map((move) => move.title)[0] ?? "This is ready to teach.",
  };
}

// ---------------------------------------------------------------------------
// Prediction before reveal
// ---------------------------------------------------------------------------

/**
 * Predictions whose answers the index settles exactly. Each one is committed to
 * with a confidence, so the set produces calibration and not only a score.
 */
export function buildPredictions(repository, sources, options = {}) {
  const limit = options.limit ?? 4;
  const predictions = [];
  const callers = new Map();
  const callees = new Map();
  for (const edge of repository?.callEdges ?? []) {
    if (!edge.resolved || !edge.targetPath) continue;
    const target = `${edge.targetPath}#${edge.callee}`;
    if (!callers.has(target)) callers.set(target, new Set());
    callers.get(target).add(edge.path);
    if (edge.caller) {
      const source = `${edge.path}#${edge.caller}`;
      if (!callees.has(source)) callees.set(source, new Set());
      callees.get(source).add(edge.callee);
    }
  }

  const byFanIn = [...callers.entries()]
    .map(([key, paths]) => ({ key, paths, count: paths.size }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));

  for (const entry of byFanIn) {
    if (predictions.length >= limit) break;
    const [targetPath, name] = entry.key.split("#");
    const symbol = (repository?.symbols ?? []).find((candidate) => candidate.path === targetPath && candidate.name === name);
    if (!symbol) continue;
    predictions.push({
      id: `predict-fanin-${targetPath}#${name}`,
      kind: "numeric",
      metric: "fan-in",
      prompt: `Before you look: how many different files call \`${name}\`?`,
      unit: "files",
      anchor: { path: targetPath, line: symbol.line, symbol: name },
      answer: entry.count,
      // A near miss on a count is worth partial credit; a guess of zero is not.
      tolerance: Math.max(1, Math.round(entry.count * 0.25)),
      reveal: `\`${name}\` is called from ${entry.count} file${entry.count === 1 ? "" : "s"}: ${[...entry.paths].slice(0, 5).join(", ")}.`,
    });

    const parameters = headerParameters(sources, targetPath, symbol.line);
    if (parameters && predictions.length < limit) {
      predictions.push({
        id: `predict-params-${targetPath}#${name}`,
        kind: "numeric",
        metric: "parameters",
        prompt: `Before you look: how many parameters does \`${name}\` take?`,
        unit: "parameters",
        anchor: { path: targetPath, line: symbol.line, symbol: name },
        answer: parameters.length,
        tolerance: 0,
        reveal: `\`${name}\` takes ${parameters.length} parameter${parameters.length === 1 ? "" : "s"}: ${parameters.join(", ") || "none"}.`,
      });
    }

    const outgoing = callees.get(entry.key);
    if (outgoing?.size && predictions.length < limit) {
      predictions.push({
        id: `predict-callees-${targetPath}#${name}`,
        kind: "numeric",
        metric: "fan-out",
        prompt: `Before you look: how many different functions does \`${name}\` itself call?`,
        unit: "functions",
        anchor: { path: targetPath, line: symbol.line, symbol: name },
        answer: outgoing.size,
        tolerance: Math.max(1, Math.round(outgoing.size * 0.25)),
        reveal: `\`${name}\` calls ${outgoing.size} distinct function${outgoing.size === 1 ? "" : "s"}: ${[...outgoing].slice(0, 5).join(", ")}.`,
      });
    }
  }

  const resolvedImport = (repository?.imports ?? []).find((item) => item.resolved && item.targetPath);
  if (resolvedImport && predictions.length < limit + 1) {
    predictions.push({
      id: `predict-import-${resolvedImport.path}:${resolvedImport.line}`,
      kind: "path",
      metric: "import-target",
      prompt: `Before you look: \`${resolvedImport.path}\` imports \`${resolvedImport.specifier}\`. Which file in this repository does that resolve to?`,
      unit: "path",
      anchor: { path: resolvedImport.path, line: resolvedImport.line, symbol: null },
      answer: resolvedImport.targetPath,
      tolerance: 0,
      reveal: `It resolves to ${resolvedImport.targetPath}.`,
    });
  }

  return predictions.slice(0, limit + 1);
}

/**
 * Grade one prediction and score the confidence that came with it.
 *
 * The Brier contribution is what makes this more than a quiz: a learner who is
 * right at 60% confidence is better calibrated than one who is right at 100%
 * and wrong the next time at 100%.
 */
export function gradePrediction(prediction, guess, confidence) {
  const stated = Math.max(0, Math.min(1, Number(confidence ?? 0.5)));
  let correct = false;
  let close = false;
  let distance = null;
  if (prediction.kind === "numeric") {
    const value = Number(guess);
    if (Number.isFinite(value)) {
      distance = Math.abs(value - prediction.answer);
      correct = distance === 0;
      close = !correct && distance <= prediction.tolerance;
    }
  } else {
    const normalized = String(guess ?? "").trim().replace(/^\.\//, "");
    correct = normalized === prediction.answer;
    close = !correct && normalized.length > 0 && prediction.answer.endsWith(`/${normalized}`);
  }
  const credit = correct ? 1 : close ? 0.5 : 0;
  return {
    version: ACTIVITY_VERSION,
    kind: "prediction",
    predictionId: prediction.id,
    correct,
    close,
    credit,
    distance,
    confidence: round(stated),
    // Brier: the squared gap between what they claimed and what happened.
    brier: round((stated - (correct ? 1 : 0)) ** 2),
    calibration: correct
      ? (stated >= 0.7 ? "confident-and-right" : "underconfident")
      : (stated >= 0.7 ? "overconfident" : "appropriately-unsure"),
    answer: prediction.answer,
    reveal: prediction.reveal,
    anchor: prediction.anchor,
  };
}

/** Roll a set of graded predictions into a calibration summary. */
export function summarizePredictions(grades) {
  if (!grades?.length) return { predictions: 0, accuracy: 0, meanConfidence: 0, brier: null, overconfident: 0, underconfident: 0 };
  const correct = grades.filter((grade) => grade.correct).length;
  return {
    predictions: grades.length,
    accuracy: round(correct / grades.length),
    creditedAccuracy: round(grades.reduce((sum, grade) => sum + grade.credit, 0) / grades.length),
    meanConfidence: round(grades.reduce((sum, grade) => sum + grade.confidence, 0) / grades.length),
    brier: round(grades.reduce((sum, grade) => sum + grade.brier, 0) / grades.length),
    overconfident: grades.filter((grade) => grade.calibration === "overconfident").length,
    underconfident: grades.filter((grade) => grade.calibration === "underconfident").length,
  };
}

// ---------------------------------------------------------------------------
// Contrastive examples
// ---------------------------------------------------------------------------

/** The concrete differences between two definitions, for post-answer feedback. */
export function contrastDifferences(left, right) {
  const differences = [];
  if (left.parameters && right.parameters) {
    if (left.parameters.length !== right.parameters.length) {
      differences.push({ id: "arity", detail: `${left.path} takes ${left.parameters.length} parameter(s); ${right.path} takes ${right.parameters.length}.` });
    } else if (left.parameters.join(",") !== right.parameters.join(",")) {
      differences.push({ id: "parameter-names", detail: `Parameters differ: (${left.parameters.join(", ")}) versus (${right.parameters.join(", ")}).` });
    }
  }
  if (left.bodyLines !== right.bodyLines) {
    differences.push({ id: "size", detail: `${left.path} is ${left.bodyLines} line(s); ${right.path} is ${right.bodyLines}.` });
  }
  const leftTokens = tokens(left.excerpt?.text);
  const rightTokens = tokens(right.excerpt?.text);
  const onlyLeft = [...leftTokens].filter((token) => !rightTokens.has(token)).slice(0, 6);
  const onlyRight = [...rightTokens].filter((token) => !leftTokens.has(token)).slice(0, 6);
  if (onlyLeft.length || onlyRight.length) {
    differences.push({ id: "vocabulary", detail: `Only in ${left.path}: ${onlyLeft.join(", ") || "—"}. Only in ${right.path}: ${onlyRight.join(", ") || "—"}.` });
  }
  return differences;
}

/**
 * Build a contrast from a real ambiguity: the same function name defined in two
 * different files, with a real call site that resolves to exactly one of them.
 */
export function buildContrast(repository, sources, options = {}) {
  const byName = new Map();
  for (const symbol of repository?.symbols ?? []) {
    if (symbol.kind !== "function" || symbol.container) continue;
    if (!byName.has(symbol.name)) byName.set(symbol.name, []);
    byName.get(symbol.name).push(symbol);
  }
  const ambiguous = [...byName.entries()]
    .filter(([name, definitions]) => (!options.symbol || name === options.symbol)
      && new Set(definitions.map((symbol) => symbol.path)).size >= 2)
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]));

  for (const [name, definitions] of ambiguous) {
    const edge = (repository?.callEdges ?? []).find((candidate) => candidate.resolved
      && candidate.callee === name
      && definitions.some((symbol) => symbol.path === candidate.targetPath && symbol.line === candidate.targetLine));
    if (!edge) continue;
    const unique = [];
    for (const symbol of definitions) {
      if (unique.some((item) => item.path === symbol.path)) continue;
      unique.push(symbol);
      if (unique.length === 2 && unique.some((item) => item.path === edge.targetPath)) break;
    }
    const pair = unique.filter((symbol) => symbol.path === edge.targetPath).concat(unique.filter((symbol) => symbol.path !== edge.targetPath)).slice(0, 2);
    if (pair.length < 2) continue;
    const described = pair.map((symbol) => ({
      id: `${symbol.path}:${symbol.line}`,
      path: symbol.path,
      line: symbol.line,
      parameters: headerParameters(sources, symbol.path, symbol.line),
      bodyLines: Math.max(1, (symbol.endLine ?? symbol.line) - symbol.line),
      excerpt: excerptFor(sources, symbol.path, symbol.line, 10),
    }));
    const answerId = `${edge.targetPath}:${edge.targetLine}`;
    // Present the options in a stable but not answer-revealing order.
    const ordered = [...described].sort((left, right) => left.id.localeCompare(right.id));
    return {
      available: true,
      kind: "contrast",
      version: ACTIVITY_VERSION,
      id: `contrast-${name}@${edge.path}:${edge.line}`,
      symbol: name,
      callSite: { path: edge.path, line: edge.line, caller: edge.caller ?? null },
      prompt: `\`${name}\` is defined in more than one file. The call at ${edge.path}:${edge.line} reaches exactly one of them. Which, and what tells the two apart?`,
      options: ordered.map((item) => ({ id: item.id, path: item.path, line: item.line, excerpt: item.excerpt })),
      answerId,
      differences: contrastDifferences(described[0], described[1]),
    };
  }
  return { available: false, kind: "contrast", reason: "No function name in this repository is defined in two files with a resolved call site." };
}

/** Grade a contrast choice and reveal what actually separates the two. */
export function gradeContrast(task, choiceId) {
  const correct = choiceId === task.answerId;
  const chosen = task.options.find((option) => option.id === choiceId) ?? null;
  return {
    version: ACTIVITY_VERSION,
    kind: "contrast",
    taskId: task.id,
    correct,
    choiceId: choiceId ?? null,
    answerId: task.answerId,
    differences: task.differences,
    explanation: correct
      ? `Right: the call at ${task.callSite.path}:${task.callSite.line} resolves to ${task.answerId}.`
      : chosen
        ? `Not quite. ${chosen.path} also defines \`${task.symbol}\`, but this call resolves to ${task.answerId}.`
        : `That is not one of the definitions of \`${task.symbol}\`.`,
    anchor: { path: task.answerId.split(":")[0], line: Number(task.answerId.split(":").at(-1)), symbol: task.symbol },
  };
}

// ---------------------------------------------------------------------------
// The set, and what may cross the IPC boundary
// ---------------------------------------------------------------------------

export function buildActivitySet(repository, sources, options = {}) {
  return {
    version: ACTIVITY_VERSION,
    teachBack: buildTeachBack(repository, sources, options),
    predictions: buildPredictions(repository, sources, options),
    contrast: buildContrast(repository, sources, options),
  };
}

/** Strip every answer: counts, resolved paths, correct option, and differences. */
export function publicActivitySet(set) {
  return {
    version: set.version,
    teachBack: set.teachBack.available
      ? { available: true, kind: "teach-back", id: set.teachBack.id, symbol: set.teachBack.symbol, anchor: set.teachBack.anchor, prompt: set.teachBack.prompt, moves: set.teachBack.moves, excerpt: set.teachBack.excerpt }
      : set.teachBack,
    predictions: set.predictions.map((prediction) => ({
      id: prediction.id,
      kind: prediction.kind,
      metric: prediction.metric,
      prompt: prediction.prompt,
      unit: prediction.unit,
      anchor: prediction.anchor,
    })),
    contrast: set.contrast.available
      ? { available: true, kind: "contrast", id: set.contrast.id, symbol: set.contrast.symbol, callSite: set.contrast.callSite, prompt: set.contrast.prompt, options: set.contrast.options }
      : set.contrast,
  };
}
