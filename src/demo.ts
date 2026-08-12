import type { ContextPack, ContextSection, LearnerState, TraceBridge } from "./types";
import { nanoCourse, nanoLearnerState, nanoRepository, nanoSkillGraph, nanoSourceByPath } from "./nano-demo";

export const demoRepository = nanoRepository;
export const demoCourse = nanoCourse;
export const demoSkillGraph = nanoSkillGraph;
export const demoLearnerState = nanoLearnerState;

let savedLearning: LearnerState = structuredClone(nanoLearnerState);

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
  async openRepository() { return { repository: nanoRepository, course: nanoCourse, skillGraph: nanoSkillGraph, learnerState: savedLearning }; },
  async readFile(_rootPath, filePath) { return nanoSourceByPath[filePath] ?? `# Preview unavailable for ${filePath}`; },
  async detectAgents() { return { codex: { available: true, version: "demo" }, claude: { available: true, version: "demo" } }; },
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
