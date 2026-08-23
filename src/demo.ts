import type { ContextPack, ContextSection, KnowledgeGraphEdge, KnowledgeGraphNode, KnowledgeGraphSummary, LearnerState, TraceBridge } from "./types";
import { nanoCourse, nanoLearnerState, nanoRepository, nanoSkillGraph, nanoSourceByPath } from "./nano-demo";

export const demoRepository = nanoRepository;
export const demoCourse = nanoCourse;
export const demoSkillGraph = nanoSkillGraph;
export const demoLearnerState = nanoLearnerState;

let savedLearning: LearnerState = structuredClone(nanoLearnerState);

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

function demoPack(request: Parameters<TraceBridge["askAgent"]>[0]): ContextPack {
  const context = request.context;
  const modeBudget = { lean: 2400, balanced: 5200, deep: 10000 }[context.mode];
  const sections: ContextSection[] = [
    { id: "lesson", kind: "lesson" as const, title: context.lesson.title, reason: "Active learning objective", content: context.lesson.objective, estimatedTokens: Math.ceil(context.lesson.objective.length / 4), priority: 95, cached: true },
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
  return { id: `demo-pack-${Date.now()}`, mode: context.mode, budget: modeBudget, estimatedTokens, savedTokens: context.mode === "lean" ? 3400 : 1800, sections, omitted: context.scope.dependencies ? [] : [{ title: "Dependency expansion", reason: "Disabled by learner", estimatedTokens: 1800 }], intent: /flow|call|trace/i.test(context.question) ? "trace" : "explain", cacheHit: true };
}

export const browserBridge: TraceBridge = {
  async chooseRepository() { return null; },
  async openRepository() { return { repository: nanoRepository, course: nanoCourse, skillGraph: nanoSkillGraph, learnerState: savedLearning, knowledgeGraph: demoKnowledgeGraph }; },
  async graphSummary() { return demoKnowledgeGraph; },
  async graphNeighborhood(request) {
    const nodes = demoGraphNodes.filter((node) => node.id === request.nodeId || demoGraphEdges.some((edge) => (edge.from === request.nodeId && edge.to === node.id) || (edge.to === request.nodeId && edge.from === node.id)));
    const edges = demoGraphEdges.filter((edge) => edge.from === request.nodeId || edge.to === request.nodeId);
    return { nodes, edges };
  },
  async readFile(_rootPath, filePath) { return nanoSourceByPath[filePath] ?? `# Preview unavailable for ${filePath}`; },
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
    return { id: "demo-practice", repositoryId: request.repository.id, repositoryName: request.repository.name, worktreePath: "/tmp/trace-practice/nano-vllm-a1b2c3d4", baseCommit: request.repository.head, lessonId: request.lesson.id, lessonTitle: request.lesson.title, createdAt: new Date().toISOString() };
  },
  async inspectPractice(sessionId) { return { sessionId, clean: true, status: "", diffStat: "", diffCheckPassed: true, diffCheckOutput: "", checkedAt: new Date().toISOString() }; },
  async openPractice() { return true; },
  async removePractice() { return { removed: true, requiresConfirmation: false }; },
};
