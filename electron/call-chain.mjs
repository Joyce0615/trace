import { createHash } from "node:crypto";

/**
 * Cross-file call-chain reasoning (RepoReasoner-style).
 *
 * Long raw context does not teach a learner how execution moves between files.
 * Instead, this module derives *chains* of resolved call edges that cross at
 * least one file boundary and turns them into prediction exercises:
 *
 *   - `next-call`: given a position in the chain, predict the next callee.
 *   - `output`: given the terminal function, predict what it returns.
 *
 * Both exercise kinds are grounded: every option is a real symbol or a real
 * `return` expression taken from the indexed source, and the answer is kept in
 * the main process so the renderer cannot reveal it.
 */

export const CALL_CHAIN_VERSION = 1;

const MAX_EXPLORED_PATHS = 20_000;

function symbolKey(filePath, name) {
  return `${filePath}#${name}`;
}

/** Deterministic shuffle so an exercise looks varied but never changes between runs. */
function seededOrder(items, seed) {
  return items
    .map((item, index) => ({ item, rank: createHash("sha1").update(`${seed}:${index}:${item.id ?? item.label ?? index}`).digest("hex") }))
    .sort((left, right) => left.rank.localeCompare(right.rank))
    .map((entry) => entry.item);
}

/**
 * Build resolved call chains through the repository.
 *
 * Chains start at symbols that call others but are never called themselves, so
 * they read like an execution path rather than an arbitrary graph walk.
 */
export function buildCallChains(repository, options = {}) {
  const maxDepth = Math.max(2, options.maxDepth ?? 5);
  const limit = Math.max(1, options.limit ?? 12);
  const minCrossFileHops = options.minCrossFileHops ?? 1;

  const edges = (repository.callEdges ?? []).filter((edge) => edge.resolved && edge.caller && edge.targetPath && edge.targetLine);
  if (!edges.length) return [];

  const outgoing = new Map();
  for (const edge of edges) {
    const key = symbolKey(edge.path, edge.caller);
    if (!outgoing.has(key)) outgoing.set(key, []);
    outgoing.get(key).push(edge);
  }
  const called = new Set(edges.map((edge) => symbolKey(edge.targetPath, edge.callee)));
  const importance = new Map((repository.files ?? []).map((file) => [file.path, file.importance ?? 0]));
  const symbolKinds = new Map();
  for (const symbol of repository.symbols ?? []) {
    const key = symbolKey(symbol.path, symbol.name);
    if (!symbolKinds.has(key)) symbolKinds.set(key, symbol.kind);
  }

  const roots = [...outgoing.keys()].filter((key) => !called.has(key));
  const startingPoints = (roots.length ? roots : [...outgoing.keys()]).sort((left, right) => {
    const leftPath = left.split("#")[0];
    const rightPath = right.split("#")[0];
    return (importance.get(rightPath) ?? 0) - (importance.get(leftPath) ?? 0) || left.localeCompare(right);
  });

  const chains = [];
  let explored = 0;
  for (const start of startingPoints) {
    if (chains.length >= limit * 4 || explored > MAX_EXPLORED_PATHS) break;
    const [startPath, startName] = [start.slice(0, start.lastIndexOf("#")), start.slice(start.lastIndexOf("#") + 1)];
    const stack = [{ steps: [{ symbol: startName, path: startPath, line: null, kind: symbolKinds.get(start) ?? "function", callLine: null }], visited: new Set([start]) }];
    while (stack.length) {
      explored += 1;
      if (explored > MAX_EXPLORED_PATHS) break;
      const current = stack.pop();
      const last = current.steps.at(-1);
      const nextEdges = current.steps.length >= maxDepth ? [] : (outgoing.get(symbolKey(last.path, last.symbol)) ?? [])
        .filter((edge) => !current.visited.has(symbolKey(edge.targetPath, edge.callee)));
      if (!nextEdges.length) {
        const crossFileHops = current.steps.reduce((count, step, index) => count + (index > 0 && step.path !== current.steps[index - 1].path ? 1 : 0), 0);
        if (current.steps.length >= 2 && crossFileHops >= minCrossFileHops) chains.push({ steps: current.steps, crossFileHops });
        continue;
      }
      for (const edge of nextEdges.slice(0, 4)) {
        const steps = current.steps.map((step, index) => (index === current.steps.length - 1 ? { ...step, callLine: edge.line } : step));
        steps.push({
          symbol: edge.callee,
          path: edge.targetPath,
          line: edge.targetLine,
          kind: symbolKinds.get(symbolKey(edge.targetPath, edge.callee)) ?? "function",
          callLine: null,
        });
        stack.push({ steps, visited: new Set([...current.visited, symbolKey(edge.targetPath, edge.callee)]) });
      }
    }
  }

  const byId = new Map();
  for (const chain of chains) {
    const steps = chain.steps.map((step) => ({
      ...step,
      line: step.line ?? definitionLine(repository, step.path, step.symbol) ?? 1,
    }));
    const id = `chain-${createHash("sha1").update(steps.map((step) => `${step.path}#${step.symbol}`).join(">")).digest("hex").slice(0, 12)}`;
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      steps,
      crossFileHops: chain.crossFileHops,
      files: [...new Set(steps.map((step) => step.path))],
      summary: steps.map((step) => `${step.symbol}()`).join(" → "),
    });
  }

  return [...byId.values()]
    .sort((left, right) => right.crossFileHops - left.crossFileHops
      || right.steps.length - left.steps.length
      || left.id.localeCompare(right.id))
    .slice(0, limit);
}

function definitionLine(repository, filePath, name) {
  return (repository.symbols ?? []).find((symbol) => symbol.path === filePath && symbol.name === name)?.line ?? null;
}

const INDENTATION_LANGUAGES = new Set(["python", "ruby", "yaml"]);

/**
 * Bounds of a definition body starting at `startLine` (1-based).
 * Indentation-scoped languages end at the first line that dedents; brace
 * languages end at the matching close brace.
 */
export function symbolBodyRange(source, startLine, language = "python") {
  const lines = source.split(/\r?\n/);
  const start = Math.max(1, Math.min(startLine, lines.length));
  if (INDENTATION_LANGUAGES.has(language)) {
    const header = lines[start - 1] ?? "";
    const indent = header.length - header.trimStart().length;
    for (let index = start; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      const currentIndent = line.length - line.trimStart().length;
      if (currentIndent <= indent) return { start, end: index };
    }
    return { start, end: lines.length };
  }
  let depth = 0;
  let opened = false;
  for (let index = start - 1; index < lines.length; index += 1) {
    for (const character of lines[index]) {
      if (character === "{") { depth += 1; opened = true; }
      else if (character === "}") depth -= 1;
    }
    if (opened && depth <= 0) return { start, end: index + 1 };
  }
  return { start, end: Math.min(lines.length, start + 60) };
}

/** Real `return` expressions inside one definition, used as grounded answer options. */
export function extractReturnExpressions(source, startLine, language = "python") {
  const { start, end } = symbolBodyRange(source, startLine, language);
  const lines = source.split(/\r?\n/).slice(start, end);
  const expressions = [];
  for (const line of lines) {
    const match = line.match(/^\s*return\s+(.+?)\s*;?\s*$/);
    if (!match) continue;
    const expression = match[1].trim();
    if (expression && !expressions.includes(expression)) expressions.push(expression);
  }
  return expressions.slice(0, 4);
}

function choice(label, detail, anchor) {
  return { id: `choice-${createHash("sha1").update(`${label}:${detail ?? ""}`).digest("hex").slice(0, 10)}`, label, detail: detail ?? "", anchor: anchor ?? null };
}

/**
 * Build prediction exercises for a set of chains.
 * `sources` maps repository-relative paths to file contents; it is only needed
 * for output prediction, so call-chain prediction still works without file IO.
 */
export function buildCallChainExercises(repository, chains, sources = {}) {
  const exercises = [];
  const symbols = repository.symbols ?? [];

  for (const chain of chains) {
    const hop = chain.steps.findIndex((step, index) => index > 0 && step.path !== chain.steps[index - 1].path);
    const fromIndex = hop > 0 ? hop - 1 : 0;
    const from = chain.steps[fromIndex];
    const to = chain.steps[fromIndex + 1];
    if (!from || !to) continue;

    const distractors = symbols
      .filter((symbol) => symbol.name !== to.symbol && !chain.steps.some((step) => step.symbol === symbol.name))
      .filter((symbol) => symbol.path === from.path || symbol.path === to.path || symbol.path.split("/")[0] === to.path.split("/")[0])
      .slice(0, 12);
    const uniqueDistractors = [];
    for (const symbol of distractors) {
      if (uniqueDistractors.some((candidate) => candidate.name === symbol.name)) continue;
      uniqueDistractors.push(symbol);
      if (uniqueDistractors.length >= 3) break;
    }
    if (uniqueDistractors.length < 2) continue;

    const answer = choice(`${to.symbol}()`, to.path, { path: to.path, line: to.line, symbol: to.symbol });
    const options = seededOrder(
      [answer, ...uniqueDistractors.map((symbol) => choice(`${symbol.name}()`, symbol.path, { path: symbol.path, line: symbol.line, symbol: symbol.name }))],
      chain.id,
    );
    exercises.push({
      id: `predict-${chain.id}-next`,
      chainId: chain.id,
      kind: "next-call",
      prompt: `Execution is inside \`${from.symbol}\` (${from.path}${from.callLine ? `:${from.callLine}` : ""}). Which function does it call next?`,
      context: chain.steps.slice(0, fromIndex + 1).map((step) => `${step.symbol}()`).join(" → "),
      anchor: { path: from.path, line: from.callLine ?? from.line, symbol: from.symbol },
      options: options.map(({ id, label, detail }) => ({ id, label, detail })),
      answerId: answer.id,
      explanation: `\`${from.symbol}\` calls \`${to.symbol}\` at ${from.path}:${from.callLine ?? from.line}; \`${to.symbol}\` is defined at ${to.path}:${to.line}, so the chain crosses a file boundary here.`,
    });

    const terminal = chain.steps.at(-1);
    const terminalSource = sources[terminal.path];
    if (!terminalSource) continue;
    const language = (repository.files ?? []).find((file) => file.path === terminal.path)?.language ?? "python";
    const returns = extractReturnExpressions(terminalSource, terminal.line, language);
    if (!returns.length) continue;
    const otherReturns = [];
    for (const symbol of symbols) {
      if (otherReturns.length >= 3) break;
      if (symbol.path === terminal.path && symbol.name === terminal.symbol) continue;
      const otherSource = sources[symbol.path];
      if (!otherSource) continue;
      const otherLanguage = (repository.files ?? []).find((file) => file.path === symbol.path)?.language ?? "python";
      for (const expression of extractReturnExpressions(otherSource, symbol.line, otherLanguage)) {
        if (returns.includes(expression) || otherReturns.includes(expression)) continue;
        otherReturns.push(expression);
        break;
      }
    }
    if (otherReturns.length < 2) continue;
    const outputAnswer = choice(returns[0], `${terminal.path}:${terminal.line}`);
    const outputOptions = seededOrder(
      [outputAnswer, ...otherReturns.map((expression) => choice(expression, "another function in this repository"))],
      `${chain.id}-output`,
    );
    exercises.push({
      id: `predict-${chain.id}-output`,
      chainId: chain.id,
      kind: "output",
      prompt: `The chain ends in \`${terminal.symbol}\` (${terminal.path}:${terminal.line}). What value does it produce?`,
      context: chain.summary,
      anchor: { path: terminal.path, line: terminal.line, symbol: terminal.symbol },
      options: outputOptions.map(({ id, label, detail }) => ({ id, label, detail })),
      answerId: outputAnswer.id,
      explanation: `\`${terminal.symbol}\` returns \`${returns[0]}\` at ${terminal.path}:${terminal.line}. Reading the terminal return is how you confirm what the whole chain produces.`,
    });
  }

  return exercises;
}

/** Renderer-safe projection: the correct answer never leaves the main process. */
export function publicExercise(exercise) {
  const { answerId, explanation, ...rest } = exercise;
  void answerId;
  void explanation;
  return rest;
}

/** Grade one prediction. Feedback always carries the source anchor that proves it. */
export function gradeCallChainAnswer(exercise, choiceId) {
  const correct = Boolean(choiceId) && choiceId === exercise.answerId;
  return {
    exerciseId: exercise.id,
    kind: exercise.kind,
    correct,
    choiceId: choiceId ?? null,
    answerId: exercise.answerId,
    answerLabel: exercise.options.find((option) => option.id === exercise.answerId)?.label ?? "",
    explanation: exercise.explanation,
    anchor: exercise.anchor,
  };
}

/** Lesson content block describing one chain, rendered by the lesson canvas. */
export function callChainBlock(chain, blockId) {
  return {
    id: blockId ?? `${chain.id}-block`,
    type: "callchain",
    title: "Cross-file call chain",
    caption: `${chain.steps.length} hops across ${chain.files.length} file${chain.files.length > 1 ? "s" : ""}; ${chain.crossFileHops} cross-file.`,
    steps: chain.steps.map((step) => ({
      symbol: step.symbol,
      detail: step.path,
      anchor: { path: step.path, line: step.line, symbol: step.symbol },
    })),
  };
}
