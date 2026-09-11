import type { Architecture, ArchitectureModule, DataFlow, DiagnosisReport, CallChain, CallChainStep, ContextPack, LocalizationExercise, RaceStageResult, RaceTask, ContextSection, KnowledgeGraphEdge, KnowledgeGraphNode, KnowledgeGraphSummary, LearnerState, LinkClassification, PredictionExercise, TraceBridge } from "./types";
import { nanoCourse, nanoLearnerState, nanoRepository, nanoSkillGraph, nanoSourceByPath } from "./nano-demo";
// The demo runs the *same* retrieval and evaluation code as the desktop app, so
// both behave identically with and without a main process. They are imported
// dynamically so they stay out of the application entry chunk.
import type { SearchIndex } from "../electron/search.mjs";

export const demoRepository = nanoRepository;
export const demoCourse = nanoCourse;
export const demoSkillGraph = nanoSkillGraph;
export const demoLearnerState = nanoLearnerState;

let savedLearning: LearnerState = structuredClone(nanoLearnerState);
let demoSearchIndex: SearchIndex | null = null;
let demoProbes: Record<string, Parameters<typeof import("../electron/misconception.mjs").gradeProbe>[0]> = {};

const demoGraphNodes: KnowledgeGraphNode[] = [
  { id: `repository:${nanoRepository.id}`, kind: "repository", key: nanoRepository.id, label: nanoRepository.name },
  ...nanoRepository.files.map((file) => ({ id: `file:${file.path}`, kind: "file" as const, key: file.path, label: file.name, language: file.language })),
  ...nanoRepository.symbols.map((symbol) => ({ id: `symbol:${symbol.path}#${symbol.name}@${symbol.line}`, kind: "symbol" as const, key: `${symbol.path}#${symbol.name}`, label: symbol.name, symbolKind: symbol.kind, path: symbol.path, line: symbol.line })),
];

const demoGraphEdges: KnowledgeGraphEdge[] = [
  ...nanoRepository.files.map((file) => ({ from: `repository:${nanoRepository.id}`, to: `file:${file.path}`, kind: "contains" as const })),
  ...nanoRepository.symbols.map((symbol) => ({ from: `file:${symbol.path}`, to: `symbol:${symbol.path}#${symbol.name}@${symbol.line}`, kind: "defines" as const })),
  ...(nanoRepository.imports ?? []).map((item) => ({ from: `file:${item.path}`, to: item.targetPath ? `file:${item.targetPath}` : `external:${item.specifier}`, kind: "imports" as const, specifier: item.specifier, line: item.line, resolved: Boolean(item.targetPath) })),
  ...(nanoRepository.callEdges ?? []).map((edge) => ({ from: `symbol:${edge.path}#${edge.caller}`, to: edge.resolved ? `symbol:${edge.targetPath}#${edge.callee}@${edge.targetLine}` : `unresolved:${edge.callee}`, kind: "calls" as const, callee: edge.callee, line: edge.line, resolved: Boolean(edge.resolved) })),
];

const demoKnowledgeGraph: KnowledgeGraphSummary = {
  format: "kg-v1",
  repositoryId: nanoRepository.id,
  version: nanoRepository.versionId,
  previousVersion: null,
  generatedAt: new Date().toISOString(),
  stats: {
    nodeCount: demoGraphNodes.length,
    edgeCount: demoGraphEdges.length,
    fileCount: nanoRepository.files.length,
    reusedPartitions: 0,
    rebuiltPartitions: nanoRepository.files.length,
    invalidatedByDependency: 0,
    removedPartitions: 0,
    danglingEdges: 0,
    resolvedCallEdges: (nanoRepository.callEdges ?? []).filter((edge) => edge.resolved).length,
    resolvedImportEdges: (nanoRepository.imports ?? []).filter((item) => item.resolved).length,
    byKind: { repository: 1, file: nanoRepository.files.length, symbol: nanoRepository.symbols.length },
  },
};

// The browser demo mirrors the main-process call-chain builder so the chain
// panel behaves identically without a desktop bridge.
function buildDemoCallChains(): CallChain[] {
  const edges = (nanoRepository.callEdges ?? []).filter((edge) => edge.resolved && edge.caller && edge.targetPath);
  const outgoing = new Map<string, typeof edges>();
  for (const edge of edges) {
    const key = `${edge.path}#${edge.caller}`;
    outgoing.set(key, [...(outgoing.get(key) ?? []), edge]);
  }
  const called = new Set(edges.map((edge) => `${edge.targetPath}#${edge.callee}`));
  const lineOf = (path: string, name: string) => nanoRepository.symbols.find((symbol) => symbol.path === path && symbol.name === name)?.line ?? 1;
  const chains: CallChain[] = [];
  for (const root of [...outgoing.keys()].filter((key) => !called.has(key))) {
    const [rootPath, rootName] = [root.slice(0, root.lastIndexOf("#")), root.slice(root.lastIndexOf("#") + 1)];
    const stack: CallChainStep[][] = [[{ symbol: rootName, path: rootPath, line: lineOf(rootPath, rootName), kind: "function", callLine: null }]];
    while (stack.length) {
      const steps = stack.pop()!;
      const last = steps[steps.length - 1];
      const next = steps.length >= 5
        ? []
        : (outgoing.get(`${last.path}#${last.symbol}`) ?? []).filter((edge) => !steps.some((step) => step.path === edge.targetPath && step.symbol === edge.callee));
      if (!next.length) {
        const crossFileHops = steps.reduce((count, step, index) => count + (index > 0 && step.path !== steps[index - 1].path ? 1 : 0), 0);
        if (steps.length >= 2 && crossFileHops >= 1) {
          chains.push({
            id: `chain-${steps.map((step) => step.symbol).join("-")}`,
            steps,
            crossFileHops,
            files: [...new Set(steps.map((step) => step.path))],
            summary: steps.map((step) => `${step.symbol}()`).join(" → "),
          });
        }
        continue;
      }
      for (const edge of next) {
        stack.push([
          ...steps.slice(0, -1),
          { ...last, callLine: edge.line },
          { symbol: edge.callee, path: edge.targetPath!, line: edge.targetLine ?? 1, kind: "function", callLine: null },
        ]);
      }
    }
  }
  return chains.sort((left, right) => right.crossFileHops - left.crossFileHops || right.steps.length - left.steps.length || left.id.localeCompare(right.id)).slice(0, 8);
}

const demoAnswers = new Map<string, { answerId: string; explanation: string; label: string }>();

function buildDemoExercises(chains: CallChain[]): PredictionExercise[] {
  demoAnswers.clear();
  return chains.flatMap((chain) => {
    const hop = chain.steps.findIndex((step, index) => index > 0 && step.path !== chain.steps[index - 1].path);
    const from = chain.steps[Math.max(0, hop - 1)];
    const to = chain.steps[Math.max(0, hop - 1) + 1];
    if (!from || !to) return [];
    const distractors = nanoRepository.symbols
      .filter((symbol) => symbol.name !== to.symbol && !chain.steps.some((step) => step.symbol === symbol.name))
      .filter((symbol) => symbol.path === from.path || symbol.path.split("/")[0] === to.path.split("/")[0])
      .slice(0, 3);
    if (distractors.length < 2) return [];
    const answerId = `choice-${to.symbol}`;
    const options = [
      { id: answerId, label: `${to.symbol}()`, detail: to.path },
      ...distractors.map((symbol) => ({ id: `choice-${symbol.name}`, label: `${symbol.name}()`, detail: symbol.path })),
    ].sort((left, right) => left.id.localeCompare(right.id));
    const id = `predict-${chain.id}-next`;
    demoAnswers.set(id, {
      answerId,
      label: `${to.symbol}()`,
      explanation: `\`${from.symbol}\` calls \`${to.symbol}\` at ${from.path}:${from.callLine ?? from.line}; \`${to.symbol}\` is defined at ${to.path}:${to.line}, so the chain crosses a file boundary here.`,
    });
    return [{
      id,
      chainId: chain.id,
      kind: "next-call" as const,
      prompt: `Execution is inside \`${from.symbol}\` (${from.path}${from.callLine ? `:${from.callLine}` : ""}). Which function does it call next?`,
      context: chain.steps.slice(0, Math.max(0, hop - 1) + 1).map((step) => `${step.symbol}()`).join(" → "),
      anchor: { path: from.path, line: from.callLine ?? from.line, symbol: from.symbol },
      options,
    }];
  });
}

// Localization mirror (item 27): the gold set stays out of the exercise payload.
type DemoLocalization = LocalizationExercise & { goldFiles: string[]; hintTexts: Record<string, string>; definition: { path: string; line: number; symbol: string } };

function buildDemoLocalization(): DemoLocalization {
  const edges = (nanoRepository.callEdges ?? []).filter((edge) => edge.resolved && edge.targetPath);
  const byTarget = new Map<string, Set<string>>();
  for (const edge of edges) {
    const key = `${edge.targetPath}#${edge.callee}`;
    byTarget.set(key, new Set([...(byTarget.get(key) ?? []), edge.path]));
  }
  const importance = new Map(nanoRepository.files.map((file) => [file.path, file.importance ?? 0]));
  const candidate = [...byTarget.entries()]
    .map(([key, callers]) => {
      const targetPath = key.slice(0, key.lastIndexOf("#"));
      return { targetPath, symbol: key.slice(key.lastIndexOf("#") + 1), callers: [...callers].filter((caller) => caller !== targetPath) };
    })
    .filter((entry) => entry.callers.length >= 1)
    .sort((left, right) => right.callers.length - left.callers.length
      || (importance.get(right.targetPath) ?? 0) - (importance.get(left.targetPath) ?? 0)
      || left.targetPath.localeCompare(right.targetPath))[0];
  const definition = nanoRepository.symbols.find((symbol) => symbol.name === candidate.symbol && symbol.path === candidate.targetPath);
  const goldFiles = [candidate.targetPath, ...candidate.callers].slice(0, 4);
  const language = nanoRepository.files.find((file) => file.path === candidate.targetPath)?.language ?? "plaintext";
  return {
    id: `locate-demo-${candidate.symbol}`,
    version: 1,
    symbol: candidate.symbol,
    prompt: `A caller reports that \`${candidate.symbol}()\` returns the wrong result. Without reading the whole repository, find every file you would need to open to diagnose it: the file that defines \`${candidate.symbol}\` and the files that call it.`,
    goldCount: goldFiles.length,
    repositoryFiles: nanoRepository.files.length,
    hints: [{ id: "language", cost: 0.05 }, { id: "directory", cost: 0.1 }, { id: "filename", cost: 0.2 }],
    goldFiles,
    hintTexts: {
      language: `The definition is written in ${language}, and ${goldFiles.length} files are relevant in total.`,
      directory: `Start under \`${candidate.targetPath.split("/")[0]}/\`.`,
      filename: `The definition lives in a file named \`${candidate.targetPath.split("/").at(-1)}\`.`,
    },
    definition: { path: candidate.targetPath, line: definition?.line ?? 1, symbol: candidate.symbol },
  };
}

// RACE grading mirror (item 28): the same three stages, weights, and length
// factor as the main process, driven by the demo repository's own source.
const demoStageWeights = { understanding: 0.3, localization: 0.35, plan: 0.35 };

function demoRaceCriteria(exercise: DemoLocalization) {
  const definitionFile = exercise.definition.path.split("/").at(-1)!;
  const callerFiles = exercise.goldFiles.filter((filePath) => filePath !== exercise.definition.path);
  const callerNames = callerFiles.map((filePath) => filePath.split("/").at(-1)!.toLowerCase());
  const source = nanoSourceByPath[exercise.definition.path] ?? "";
  const signature = source.split("\n").find((line) => line.includes(`def ${exercise.symbol}(`)) ?? "";
  const parameters = signature.slice(signature.indexOf("(") + 1, signature.lastIndexOf(")"))
    .split(",").map((part) => part.trim().split(/[:=\s]/)[0]).filter((name) => /^[A-Za-z_]\w*$/.test(name) && name !== "self");
  const has = (text: string, needles: string[]) => needles.some((needle) => text.toLowerCase().includes(needle.toLowerCase()));
  return {
    understanding: [
      { id: "names-symbol", description: `Names the failing function \`${exercise.symbol}\`.`, weight: 0.3, evidence: `${exercise.definition.path}:${exercise.definition.line}`, test: (text: string) => has(text, [exercise.symbol]) },
      { id: "names-module", description: "Identifies the module or file that owns the behavior.", weight: 0.2, evidence: exercise.definition.path, test: (text: string) => has(text, [definitionFile, exercise.definition.path]) },
      { id: "names-input", description: parameters.length ? `Refers to an actual input (${parameters.join(", ")}).` : "Describes the inputs the function receives.", weight: 0.2, evidence: exercise.definition.path, test: (text: string) => (parameters.length ? has(text, parameters) : /input|argument|parameter/i.test(text)) },
      { id: "names-caller", description: "Connects the defect to a caller that depends on it.", weight: 0.15, evidence: callerFiles[0] ?? exercise.definition.path, test: (text: string) => has(text, callerNames) },
      { id: "expected-vs-actual", description: "Contrasts the expected behavior with the observed behavior.", weight: 0.15, evidence: "issue report", test: (text: string) => /\b(expected|should|instead|actually|but|rather than|incorrect|wrong)\b/i.test(text) },
    ],
    plan: [
      { id: "target-file", description: `Changes the file that defines \`${exercise.symbol}\`.`, weight: 0.3, evidence: exercise.definition.path, test: (text: string) => has(text, [definitionFile, exercise.definition.path]) },
      { id: "validation", description: "States how the change will be validated.", weight: 0.2, evidence: "repository tests", test: (text: string) => /\b(test|tests|pytest|unittest|assert|regression|verify|reproduce)\b/i.test(text) },
      { id: "check-callers", description: "Checks the callers that would be affected.", weight: 0.2, evidence: callerFiles[0] ?? exercise.definition.path, test: (text: string) => has(text, callerNames) || /\bcaller|call site|dependent|downstream\b/i.test(text) },
      { id: "ordered-steps", description: "Breaks the work into at least three ordered steps.", weight: 0.15, evidence: "plan structure", test: (text: string) => text.split("\n").filter((line) => /^\s*(\d+[.)]|[-*•])\s+\S/.test(line)).length >= 3 || (text.match(/\b(first|then|next|after that|finally)\b/gi) ?? []).length >= 3 },
      { id: "bounded-scope", description: "Stays inside the affected modules instead of proposing a rewrite.", weight: 0.15, evidence: exercise.definition.path.split("/")[0], test: (text: string) => !/\b(rewrite|refactor everything|redesign the whole|rearchitect)\b/i.test(text) },
    ],
  };
}

function demoGradeText(criteria: ReturnType<typeof demoRaceCriteria>["plan"], text: string): RaceStageResult {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const lengthFactor = Math.min(1, wordCount / 25);
  const results = criteria.map((item) => ({ id: item.id, description: item.description, weight: item.weight, met: wordCount > 0 && item.test(text), evidence: item.evidence }));
  const rawScore = results.filter((result) => result.met).reduce((sum, result) => sum + result.weight, 0);
  return {
    score: Math.max(0, Math.min(1, rawScore * lengthFactor)),
    rawScore,
    lengthFactor,
    wordCount,
    criteria: results,
    met: results.filter((result) => result.met).map((result) => result.id),
    missed: results.filter((result) => !result.met).map((result) => result.id),
  };
}

function demoRaceTask(): RaceTask & { exercise: DemoLocalization } {
  const exercise = buildDemoLocalization();
  const criteria = demoRaceCriteria(exercise);
  const callerCount = exercise.goldFiles.length - 1;
  return {
    id: `race-demo-${exercise.symbol}`,
    version: 1,
    symbol: exercise.symbol,
    issue: `Issue: calls to \`${exercise.symbol}()\` return an unexpected result for some inputs. ${callerCount} caller file${callerCount === 1 ? "" : "s"} depend${callerCount === 1 ? "s" : ""} on it. Before writing any code, (1) restate what is going wrong in this repository's own terms, (2) name the files involved, and (3) describe a bounded plan to fix and validate it.`,
    localizationExerciseId: exercise.id,
    weights: demoStageWeights,
    rubric: {
      understanding: criteria.understanding.map(({ id, description, weight }) => ({ id, description, weight })),
      plan: criteria.plan.map(({ id, description, weight }) => ({ id, description, weight })),
    },
    exercise,
  };
}

// Architecture mirror (item 30): module aggregation and layering over the demo
// repository, using the same rules as the main process.
function demoModuleFor(filePath: string, depth = 2) {
  const parts = filePath.split("/");
  return parts.length === 1 ? "<root>" : parts.slice(0, Math.min(depth, parts.length - 1)).join("/");
}

function buildDemoArchitecture(depth = 2): Architecture {
  const modules = new Map<string, ArchitectureModule>();
  for (const file of nanoRepository.files) {
    const id = demoModuleFor(file.path, depth);
    const entry = modules.get(id) ?? { id, files: 0, bytes: 0, languages: {}, symbols: 0, importance: 0, fanIn: 0, fanOut: 0, external: [], layer: 0, cycleId: null };
    entry.files += 1;
    entry.bytes += file.size;
    entry.languages[file.language] = (entry.languages[file.language] ?? 0) + 1;
    entry.importance = Math.max(entry.importance, file.importance ?? 0);
    modules.set(id, entry);
  }
  for (const symbol of nanoRepository.symbols) {
    const entry = modules.get(demoModuleFor(symbol.path, depth));
    if (entry) entry.symbols += 1;
  }
  const edgeMap = new Map<string, { from: string; to: string; weight: number; examples: Array<{ path: string; line: number; specifier: string; targetPath: string }> }>();
  for (const item of nanoRepository.imports ?? []) {
    const from = demoModuleFor(item.path, depth);
    if (!item.targetPath) {
      const entry = modules.get(from);
      if (entry && !entry.external.includes(item.specifier.split(/[./]/)[0])) entry.external.push(item.specifier.split(/[./]/)[0]);
      continue;
    }
    const to = demoModuleFor(item.targetPath, depth);
    if (from === to || !modules.has(from) || !modules.has(to)) continue;
    const key = `${from}->${to}`;
    const edge = edgeMap.get(key) ?? { from, to, weight: 0, examples: [] };
    edge.weight += 1;
    if (edge.examples.length < 3) edge.examples.push({ path: item.path, line: item.line, specifier: item.specifier, targetPath: item.targetPath! });
    edgeMap.set(key, edge);
  }
  const edges = [...edgeMap.values()];
  for (const entry of modules.values()) {
    entry.fanOut = edges.filter((edge) => edge.from === entry.id).length;
    entry.fanIn = edges.filter((edge) => edge.to === entry.id).length;
  }
  // Same rules as the main process: condense import cycles first, then layer by
  // longest path over the acyclic condensation. Reachability is enough here
  // because the demo repository has only a handful of modules.
  const ids = [...modules.keys()];
  const reaches = new Map<string, Set<string>>(ids.map((id) => [id, new Set(edges.filter((edge) => edge.from === id).map((edge) => edge.to))]));
  for (const middle of ids) {
    for (const from of ids) {
      if (!reaches.get(from)!.has(middle)) continue;
      for (const to of reaches.get(middle)!) reaches.get(from)!.add(to);
    }
  }
  const componentOf = new Map<string, string>();
  for (const id of ids) {
    if (componentOf.has(id)) continue;
    const members = ids.filter((other) => other === id || (reaches.get(id)!.has(other) && reaches.get(other)!.has(id)));
    const key = members.slice().sort().join("|");
    for (const member of members) componentOf.set(member, key);
  }
  const componentKeys = [...new Set(componentOf.values())];
  const componentLayer = new Map<string, number>(componentKeys.map((key) => [key, 0]));
  for (let pass = 0; pass < componentKeys.length; pass += 1) {
    for (const edge of edges) {
      const from = componentOf.get(edge.from)!;
      const to = componentOf.get(edge.to)!;
      if (from === to) continue;
      componentLayer.set(to, Math.max(componentLayer.get(to) ?? 0, (componentLayer.get(from) ?? 0) + 1));
    }
  }
  const layerOf = new Map<string, number>(ids.map((id) => [id, componentLayer.get(componentOf.get(id)!) ?? 0]));
  const cycles = componentKeys
    .filter((key) => key.includes("|"))
    .map((key, position) => ({ id: `cycle-${position}`, modules: key.split("|"), size: key.split("|").length }));
  const cycleIdOf = new Map<string, string>();
  for (const cycle of cycles) for (const member of cycle.modules) cycleIdOf.set(member, cycle.id);
  const moduleList = [...modules.values()]
    .map((entry) => ({ ...entry, layer: layerOf.get(entry.id) ?? 0, cycleId: cycleIdOf.get(entry.id) ?? null }))
    .sort((left, right) => left.layer - right.layer || right.importance - left.importance || left.id.localeCompare(right.id));
  const layers: Array<{ layer: number; modules: string[] }> = [];
  for (const entry of moduleList) {
    layers[entry.layer] = layers[entry.layer] ?? { layer: entry.layer, modules: [] };
    layers[entry.layer].modules.push(entry.id);
  }
  const violations = edges
    .map((edge) => {
      const from = layerOf.get(edge.from) ?? 0;
      const to = layerOf.get(edge.to) ?? 0;
      if (componentOf.get(edge.from) === componentOf.get(edge.to)) {
        return { ...edge, kind: "cycle" as const, detail: `${edge.from} and ${edge.to} import each other, directly or transitively.` };
      }
      if (to < from) return { ...edge, kind: "upward" as const, detail: `${edge.from} (layer ${from}) imports ${edge.to} (layer ${to}), against the dependency direction.` };
      if (to - from > 1) return { ...edge, kind: "skip" as const, detail: `${edge.from} reaches past layer ${from + 1} straight into ${edge.to} (layer ${to}).` };
      return null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((left, right) => right.weight - left.weight);
  return {
    version: 1,
    moduleDepth: depth,
    modules: moduleList,
    edges: edges.sort((left, right) => right.weight - left.weight),
    layers: layers.filter(Boolean),
    cycles,
    violations,
    stats: {
      moduleCount: moduleList.length,
      edgeCount: edges.length,
      layerCount: layers.filter(Boolean).length,
      cycleCount: cycles.length,
      violationCount: violations.length,
      acyclic: cycles.length === 0,
    },
  };
}

function demoPack(request: Parameters<TraceBridge["askAgent"]>[0]): ContextPack {
  const context = request.context;
  const modeBudget = { lean: 2400, balanced: 5200, deep: 10000 }[context.mode];
  const sections: ContextSection[] = [
    { id: "lesson", kind: "lesson" as const, title: context.lesson.title, reason: "Active learning objective", content: context.lesson.objective, estimatedTokens: Math.ceil(context.lesson.objective.length / 4), priority: 95, cached: true, untrusted: true, injectionFindings: [] },
  ];
  if (context.openFile && context.scope.currentFile) {
    const source = nanoSourceByPath[context.openFile.path] ?? "";
    sections.push({ id: "source", kind: "source" as const, title: context.openFile.path, source: `${context.openFile.path}:${context.openFile.line}`, reason: "Current source file", content: source, estimatedTokens: Math.ceil(source.length / 4), priority: 90, cached: true });
  }
  if (context.memory.length) {
    const content = context.memory.slice(-5).map((item) => `- ${item.text}`).join("\n");
    sections.push({ id: "memory", kind: "memory" as const, title: "Learning memory", reason: "Keeps established concepts without replaying chat history", content, estimatedTokens: Math.ceil(content.length / 4), priority: 80, cached: true });
  }
  const estimatedTokens = sections.reduce((sum, item) => sum + item.estimatedTokens, 140);
  return { id: `demo-pack-${Date.now()}`, mode: context.mode, budget: modeBudget, estimatedTokens, savedTokens: context.mode === "lean" ? 3400 : 1800, sections, omitted: context.scope.dependencies ? [] : [{ title: "Dependency expansion", reason: "Disabled by learner", estimatedTokens: 1800 }], intent: /flow|call|trace/i.test(context.question) ? "trace" : "explain", injectionFindings: [], secretFindings: [], redactedSections: 0, secretSummary: { total: 0, critical: 0, high: 0, byType: {} }, cacheHit: true };
}

// The browser demo mirrors the desktop policy so behaviour is identical in tests.
const browserAllowedOrigins = ["github.com", "gitlab.com", "arxiv.org", "developer.mozilla.org", "docs.python.org", "pytorch.org"];

function classifyLinkInBrowser(candidate: string): LinkClassification {
  const raw = String(candidate ?? "").trim();
  if (!raw) return { decision: "block", reason: "empty-url", url: null, host: null };
  if (/^(javascript|data|vbscript|file|blob|about):/i.test(raw)) {
    return { decision: "block", reason: `blocked-scheme:${raw.split(":")[0].toLowerCase()}`, url: null, host: null };
  }
  let url: URL;
  try { url = new URL(raw); } catch { return { decision: "block", reason: "unparsable", url: null, host: null }; }
  if (url.protocol === "http:") return { decision: "block", reason: "insecure-scheme", url: null, host: url.hostname };
  if (url.protocol !== "https:") return { decision: "block", reason: `blocked-scheme:${url.protocol.replace(":", "")}`, url: null, host: url.hostname };
  const host = url.hostname.toLowerCase();
  const allowed = browserAllowedOrigins.some((origin) => host === origin || host.endsWith(`.${origin}`));
  return { decision: allowed ? "allow" : "confirm", reason: allowed ? "allowlisted-origin" : "unlisted-origin", url: url.toString(), host };
}

export const browserBridge: TraceBridge = {
  async chooseRepository() { return null; },
  async cancelRepositoryOpen() { return false; },
  async indexLimits() {
    return { maxFiles: 4_000, maxFileBytes: 2_000_000, maxTotalBytes: 900_000_000, maxAnalyzedFiles: 1_200, maxSymbols: 2_500, maxReferences: 20_000, maxCallEdges: 20_000, maxImports: 20_000, analysisBatchSize: 48 };
  },
  onIndexProgress() { return () => undefined; },
  async openRepository() { return { repository: nanoRepository, course: nanoCourse, skillGraph: nanoSkillGraph, learnerState: savedLearning, knowledgeGraph: demoKnowledgeGraph }; },
  async graphSummary() { return demoKnowledgeGraph; },
  async graphNeighborhood(request) {
    const nodes = demoGraphNodes.filter((node) => node.id === request.nodeId || demoGraphEdges.some((edge) => (edge.from === request.nodeId && edge.to === node.id) || (edge.to === request.nodeId && edge.from === node.id)));
    const edges = demoGraphEdges.filter((edge) => edge.from === request.nodeId || edge.to === request.nodeId);
    return { nodes, edges };
  },
  async readFile(_rootPath, filePath) { return nanoSourceByPath[filePath] ?? `# Preview unavailable for ${filePath}`; },
  async classifyLink(url) { return classifyLinkInBrowser(url); },
  async openLink(url) {
    const classification = classifyLinkInBrowser(url);
    if (classification.decision === "block") return { ...classification, opened: false };
    if (classification.decision === "confirm" && !window.confirm(`Open ${classification.host} in your browser?\n\n${classification.url}`)) {
      return { ...classification, opened: false, confirmed: false };
    }
    window.open(classification.url ?? "", "_blank", "noopener,noreferrer");
    return { ...classification, opened: true, confirmed: true };
  },
  async lastLinkDecision() { return null; },
  async detectAgents() { return { codex: { available: true, version: "demo" }, claude: { available: true, version: "demo" } }; },
  async detectLanguageServers() {
    return { pyright: { id: "pyright", command: "pyright-langserver", available: false, binary: null, languages: ["python"] } };
  },
  async resolveSymbol(request) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    const imports = (nanoRepository.imports ?? []).filter((item) => item.path === request.path);
    const definitions = nanoRepository.symbols
      .filter((symbol) => symbol.path === request.path && (symbol.line === request.line || symbol.name === request.symbol))
      .map((symbol) => ({ path: symbol.path, line: symbol.line, column: 1 }));
    return {
      path: request.path,
      line: request.line,
      column: request.column ?? 1,
      language: nanoRepository.files.find((file) => file.path === request.path)?.language ?? "plaintext",
      imports,
      definitions,
      resolvedBy: "static-index",
      languageServer: { available: false, server: null, reason: "No language server is installed for the browser demo." },
    };
  },
  async callChains(request) {
    const chains = buildDemoCallChains().slice(0, request.limit ?? 8);
    return { version: 1, chains, exercises: buildDemoExercises(chains) };
  },
  async gradePrediction(request) {
    const exercise = buildDemoExercises(buildDemoCallChains()).find((item) => item.id === request.exerciseId);
    const answer = demoAnswers.get(request.exerciseId);
    if (!exercise || !answer) throw new Error("That prediction exercise is not active for this repository.");
    return {
      exerciseId: exercise.id,
      kind: exercise.kind,
      correct: request.choiceId === answer.answerId,
      choiceId: request.choiceId,
      answerId: answer.answerId,
      answerLabel: answer.label,
      explanation: answer.explanation,
      anchor: exercise.anchor,
    };
  },
  async localizationExercise() {
    const { goldFiles, hintTexts, definition, ...exercise } = buildDemoLocalization();
    void goldFiles; void hintTexts; void definition;
    return exercise;
  },
  async localizationHint(request) {
    const exercise = buildDemoLocalization();
    const hint = exercise.hints.find((candidate) => !(request.used ?? []).includes(candidate.id));
    return hint ? { id: hint.id, cost: hint.cost, text: exercise.hintTexts[hint.id] } : null;
  },
  async scoreLocalization(request) {
    const exercise = buildDemoLocalization();
    const gold = new Set(exercise.goldFiles);
    const sizes = new Map(nanoRepository.files.map((file) => [file.path, file.size]));
    const selected = [...new Set(request.selected)];
    const inspected = [...new Set(request.inspected)];
    const hintsUsed = [...new Set(request.hintsUsed ?? [])];
    const hits = selected.filter((filePath) => gold.has(filePath));
    const coverage = gold.size ? Math.min(1, hits.length / gold.size) : 0;
    const precision = selected.length ? Math.min(1, hits.length / selected.length) : 0;
    const f1 = coverage + precision > 0 ? (2 * coverage * precision) / (coverage + precision) : 0;
    const inspectedBytes = inspected.reduce((sum, filePath) => sum + (sizes.get(filePath) ?? 0), 0);
    const relevantBytes = inspected.filter((filePath) => gold.has(filePath)).reduce((sum, filePath) => sum + (sizes.get(filePath) ?? 0), 0);
    const fileEfficiency = inspected.length ? Math.min(1, gold.size / Math.max(inspected.length, gold.size)) : 0;
    const byteEfficiency = inspectedBytes > 0 ? relevantBytes / inspectedBytes : 0;
    const hintPenalty = hintsUsed.reduce((sum, id) => sum + (exercise.hints.find((hint) => hint.id === id)?.cost ?? 0), 0);
    const score = Math.max(0, Math.min(1, (0.5 * f1 + 0.3 * fileEfficiency + 0.2 * byteEfficiency) * (1 - hintPenalty)));
    const firstHit = request.inspected.findIndex((filePath) => gold.has(filePath));
    return {
      exerciseId: exercise.id,
      coverage, precision, f1, fileEfficiency, byteEfficiency, score,
      passed: coverage >= 0.75 && precision >= 0.75,
      grade: score >= 0.8 ? "excellent" : score >= 0.6 ? "solid" : score >= 0.35 ? "developing" : "scattered",
      inspectedCount: inspected.length,
      inspectedBytes,
      relevantBytes,
      optimalCount: gold.size,
      wastedInspections: inspected.filter((filePath) => !gold.has(filePath)).length,
      firstHitRank: firstHit >= 0 ? firstHit + 1 : null,
      hintsUsed,
      hintPenalty,
      hits,
      missed: exercise.goldFiles.filter((filePath) => !selected.includes(filePath)),
      falsePositives: selected.filter((filePath) => !gold.has(filePath)),
      goldFiles: exercise.goldFiles,
      definition: exercise.definition,
    };
  },
  async raceTask() {
    const { exercise, ...task } = demoRaceTask();
    void exercise;
    return task;
  },
  async gradeRace(request) {
    const task = demoRaceTask();
    const criteria = demoRaceCriteria(task.exercise);
    const understanding = demoGradeText(criteria.understanding, request.understanding);
    const plan = demoGradeText(criteria.plan, request.plan);
    const localization = await browserBridge.scoreLocalization({
      repository: request.repository,
      exerciseId: task.exercise.id,
      inspected: request.inspected ?? [],
      selected: request.files,
      hintsUsed: request.hintsUsed,
    });
    const stageScores = { understanding: understanding.score, localization: localization.f1, plan: plan.score };
    const overall = Object.entries(demoStageWeights).reduce((sum, [stage, weight]) => sum + weight * stageScores[stage as keyof typeof stageScores], 0);
    const band = (score: number): "expert" | "competent" | "emerging" | "novice" => (score >= 0.85 ? "expert" : score >= 0.65 ? "competent" : score >= 0.4 ? "emerging" : "novice");
    const weakest = (Object.entries(stageScores).sort((left, right) => left[1] - right[1])[0][0]) as keyof typeof stageScores;
    return {
      taskId: task.id,
      version: 1,
      stages: { understanding, localization, plan },
      stageScores,
      stageBands: Object.fromEntries(Object.entries(stageScores).map(([stage, score]) => [stage, band(score)])),
      overall,
      band: band(overall),
      weakestStage: weakest,
      nextStep: {
        understanding: "Re-read the definition and restate the defect using the real parameter and caller names.",
        localization: "Follow the call edges out of the definition before answering; name every file that would have to change.",
        plan: "Write an ordered plan that names the file to change, the callers to check, and the test that proves it.",
      }[weakest],
    };
  },
  async traceRuntimes() {
    // The browser demo cannot start an interpreter; the desktop app can.
    return { python: { id: "python", command: null, available: false, version: null } };
  },
  async runTrace(request) {
    return {
      trace: {
        supported: true,
        language: request.language,
        status: "unavailable" as const,
        reason: "Execution tracing runs a real interpreter, so it is only available in the Trace desktop app.",
        events: [],
      },
      summary: null,
      suggestions: [{ path: "nanovllm/engine/llm_engine.py", module: "nanovllm.engine.llm_engine", symbol: "step", snippet: "import nanovllm.engine.llm_engine" }],
    };
  },
  async architecture(request) {
    return buildDemoArchitecture(request.moduleDepth ?? 2);
  },
  async symbolFlow(request) {
    const edges = (nanoRepository.callEdges ?? []).filter((edge) => edge.resolved && edge.targetPath);
    const definition = nanoRepository.symbols.find((symbol) => symbol.path === request.path && symbol.name === request.symbol);
    const source = nanoSourceByPath[request.path] ?? "";
    const lines = source.split("\n");
    const headerIndex = lines.findIndex((line) => line.includes(`def ${request.symbol}(`));
    const callers = edges
      .filter((edge) => edge.targetPath === request.path && edge.callee === request.symbol && edge.caller)
      .map((edge) => ({ path: edge.path, symbol: edge.caller!, line: edge.line, crossFile: edge.path !== request.path }));
    const callees = edges
      .filter((edge) => edge.path === request.path && edge.caller === request.symbol)
      .map((edge) => ({ path: edge.targetPath!, symbol: edge.callee, line: edge.targetLine ?? 1, callLine: edge.line, crossFile: edge.targetPath !== request.path }));
    // Lexical parameter-to-return flow over the demo source.
    const parameters = headerIndex >= 0
      ? lines[headerIndex].slice(lines[headerIndex].indexOf("(") + 1, lines[headerIndex].lastIndexOf(")"))
        .split(",").map((part) => part.trim().split(/[:=\s]/)[0]).filter((name) => /^[A-Za-z_]\w*$/.test(name) && name !== "self")
      : [];
    const tainted = new Map(parameters.map((name) => [name, [name]]));
    const steps: DataFlow["steps"] = [];
    const returns: DataFlow["returns"] = [];
    if (headerIndex >= 0) {
      const indent = lines[headerIndex].length - lines[headerIndex].trimStart().length;
      for (let cursor = headerIndex + 1; cursor < lines.length; cursor += 1) {
        const raw = lines[cursor];
        if (raw.trim() && raw.length - raw.trimStart().length <= indent) break;
        const text = raw.trim();
        const returnMatch = text.match(/^return\s+(.+?)\s*;?$/);
        const assignMatch = text.match(/^([A-Za-z_]\w*)\s*=\s*(.+?)\s*;?$/);
        const expression = returnMatch?.[1] ?? assignMatch?.[2];
        if (!expression) continue;
        const identifiers = [...new Set(expression.match(/[A-Za-z_]\w*/g) ?? [])];
        const dependsOn = identifiers.filter((name) => tainted.has(name));
        const origins = [...new Set(dependsOn.flatMap((name) => tainted.get(name) ?? []))];
        if (returnMatch) { returns.push({ line: cursor + 1, expression, dependsOn, parameters: origins }); continue; }
        if (dependsOn.length) tainted.set(assignMatch![1], origins);
        steps.push({ line: cursor + 1, target: assignMatch![1], expression, dependsOn, parameters: origins, calls: identifiers.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(expression)) });
      }
    }
    const reaching = new Set(returns.flatMap((item) => item.parameters));
    return {
      target: { path: request.path, symbol: request.symbol, line: definition?.line ?? 1 },
      definition: { path: request.path, line: definition?.line ?? 1, symbol: request.symbol },
      callers,
      callees,
      fanIn: new Set(callers.map((item) => `${item.path}#${item.symbol}`)).size,
      fanOut: new Set(callees.map((item) => `${item.path}#${item.symbol}`)).size,
      flow: {
        path: request.path,
        symbol: request.symbol,
        line: headerIndex + 1,
        parameters: parameters.map((name) => ({ name, reachesReturn: reaching.has(name) })),
        steps,
        returns,
        unusedParameters: parameters.filter((name) => !reaching.has(name) && !steps.some((step) => step.parameters.includes(name))),
      },
    };
  },
  async history() {
    // The browser demo has no git repository behind it, so it reports the same
    // unavailable result the desktop app produces outside a git work tree.
    return { summary: { version: 1, available: false, reason: "The featured demo runs from a bundled snapshot, so it has no git history to read.", commitCount: 0 }, lessons: [] };
  },
  async importEvidence() {
    // The bundled demo has no git history and no checked-in ADRs, so the only
    // evidence it can offer is its documentation and the linked source it names.
    const readme = nanoSourceByPath["README.md"] ?? "";
    const items = [{
      id: "doc-readme",
      kind: "doc" as const,
      reference: "README.md",
      title: readme.match(/^#\s+(.+)$/m)?.[1] ?? "README",
      summary: "0 file references, 0 symbol references",
      source: "README.md",
      body: readme.split("\n").filter((line) => line.trim() && !line.startsWith("#")).slice(0, 4).join(" "),
      anchors: [{ path: "README.md", line: 1, symbol: null }],
      paths: [],
      confidence: 0.5,
    }];
    return {
      version: 1,
      items,
      stats: { total: items.length, byKind: { doc: items.length }, linked: items.length, unlinked: 0, coverage: 1 },
      sources: { offline: ["documentation"], unavailable: ["git history (the featured demo runs from a bundled snapshot)"] },
      bySkill: {},
    };
  },
  async search(request) {
    const retrieval = await import("../electron/search.mjs");
    demoSearchIndex = demoSearchIndex ?? await retrieval.buildSearchIndex(nanoRepository, { read: (filePath) => nanoSourceByPath[filePath] ?? "" });
    return { ...retrieval.search(demoSearchIndex, request.query, { limit: request.limit ?? 10 }), indexStats: demoSearchIndex.stats };
  },
  async evaluate(request) {
    const [retrieval, evaluation] = await Promise.all([import("../electron/search.mjs"), import("../electron/evaluation.mjs")]);
    demoSearchIndex = demoSearchIndex ?? await retrieval.buildSearchIndex(nanoRepository, { read: (filePath) => nanoSourceByPath[filePath] ?? "" });
    return evaluation.runEvaluation({
      index: demoSearchIndex,
      repository: nanoRepository,
      course: request.course ?? nanoCourse,
      skillGraph: request.skillGraph ?? nanoSkillGraph,
      answers: request.answers ?? [],
      options: { retrieval: { sampleSize: request.sampleSize ?? 10 } },
    });
  },
  async diagnose(request) {
    const model = await import("../electron/misconception.mjs");
    const diagnosis = model.diagnoseLearner(request.learnerState, request.skillGraph, nanoRepository, {
      findings: request.text
        ? Object.fromEntries(request.skillGraph.nodes.map((node) => [node.id, model.detectMisconceptions(request.text!, { source: "answer" })]))
        : {},
    });
    demoProbes = diagnosis.probes;
    return { ...diagnosis, probes: undefined } as unknown as DiagnosisReport;
  },
  async answerProbe(request) {
    const model = await import("../electron/misconception.mjs");
    const probe = demoProbes[request.probeId];
    if (!probe) throw new Error("That probe is not active for this repository.");
    return model.gradeProbe(probe, request.choiceId);
  },
  async buildQuiz() {
    // The browser has no interpreter and no sandbox; saying so is more useful
    // than pretending to run the learner's code.
    return {
      available: false,
      version: 1,
      reason: "Executable quizzes run learner-written code in a resource-limited local sandbox, which needs the desktop app.",
    };
  },
  async gradeQuiz(request) {
    return {
      version: 1,
      quizId: request.quizId,
      status: "unavailable" as const,
      passed: false,
      reason: "Executable quizzes need the desktop app's sandbox.",
      passedCases: 0,
      totalCases: 0,
      cases: [],
    };
  },
  async reviewPlan(request) {
    // The demo runs the same scheduler as the desktop app, so it cannot drift.
    const scheduler = await import("../electron/spaced-repetition.mjs");
    return scheduler.reviewPlan(request.learnerState, request.skillGraph, { now: request.now, dailyLimit: request.dailyLimit });
  },
  async recordReview(request) {
    const scheduler = await import("../electron/spaced-repetition.mjs");
    const result = scheduler.applyReview(request.learnerState, request.skillGraph, {
      skillId: request.skillId,
      grade: request.grade,
      now: request.now,
    });
    savedLearning = result.learnerState;
    return result;
  },
  async askAgent(request) {
    await new Promise((resolve) => setTimeout(resolve, 550));
    const pack = demoPack(request);
    const anchor = request.context.lesson.anchors[0];
    if (/where .*defined|definition of/i.test(request.context.question)) {
      const match = nanoRepository.symbols.find((item) => new RegExp(`\\b${item.name}\\b`, "i").test(request.context.question));
      if (match) return { text: `${match.name} is defined at ${match.path}:${match.line}. This answer came from the local symbol index, so it used no agent credits.`, pack, answeredBy: "local-index", responseCacheHit: false };
    }
    return {
      text: `The key idea in **${request.context.lesson.title}** is to keep control-plane decisions separate from GPU execution. Start at ${anchor?.path ?? "the active module"}:${anchor?.line ?? 1}, then follow the state that crosses into the next component.\n\nFor your question—“${request.context.question}”—look for what enters the active function, which object owns the state change, and where the result is consumed next.`,
      pack,
      answeredBy: "demo",
      responseCacheHit: false,
    };
  },
  async enhanceCourse(request) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    return { course: { ...request.course, generatedBy: request.provider, generatedAt: new Date().toISOString() }, skillGraph: { ...nanoSkillGraph, generatedBy: request.provider } };
  },
  async loadLearning() { return savedLearning; },
  async saveLearning(state) { savedLearning = structuredClone(state); return true; },
  async createPractice(request) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { id: "demo-practice", repositoryId: request.repository.id, repositoryName: nanoRepository.name, worktreePath: "/tmp/trace-practice/nano-vllm-a1b2c3d4", baseCommit: nanoRepository.head, lessonId: request.lesson.id, lessonTitle: request.lesson.title, createdAt: new Date().toISOString() };
  },
  async inspectPractice(sessionId) { return { sessionId, clean: true, status: "", diffStat: "", diffCheckPassed: true, diffCheckOutput: "", checkedAt: new Date().toISOString() }; },
  async openPractice() { return true; },
  async removePractice() { return { removed: true, requiresConfirmation: false }; },
};
