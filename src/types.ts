export type LessonDifficulty = "foundation" | "intermediate" | "advanced";
export type LessonKind = "lesson" | "quiz" | "practice" | "project";
export type ContextMode = "lean" | "balanced" | "deep";
export type SkillStatus = "locked" | "available" | "recommended" | "active" | "mastered" | "stale";

export interface LearnerProfile {
  goal: "architecture" | "critical_path" | "contribute" | "review";
  level: "foundation" | "adaptive" | "advanced";
}

export interface RepoFile {
  path: string;
  name: string;
  directory: string;
  language: string;
  size: number;
  blobId?: string;
  importance?: number;
}

export interface CodeSymbol {
  name: string;
  kind: string;
  path: string;
  line: number;
}

export interface Repository {
  id: string;
  name: string;
  rootPath: string;
  source: "local" | "remote" | "demo";
  remoteUrl: string | null;
  head: string;
  versionId?: string;
  branch: string;
  isDirty: boolean;
  files: RepoFile[];
  symbols: CodeSymbol[];
  entryFiles: string[];
  stats: {
    fileCount: number;
    symbolCount: number;
    languages: Record<string, number>;
  };
  indexedAt: string;
}

export interface CodeAnchor {
  path: string;
  line: number;
  symbol: string | null;
}

export interface DiagramNode {
  id: string;
  label: string;
  detail?: string;
  anchor?: CodeAnchor;
}

export type LessonContentBlock =
  | { id: string; type: "narrative"; eyebrow?: string; title: string; body: string }
  | { id: string; type: "callout"; tone: "insight" | "warning" | "question"; title: string; body: string }
  | { id: string; type: "diagram"; title: string; caption: string; nodes: DiagramNode[]; edges: Array<{ from: string; to: string; label?: string }> }
  | { id: string; type: "timeline"; title: string; steps: Array<{ label: string; detail: string; anchor?: CodeAnchor }> }
  | { id: string; type: "comparison"; title: string; columns: Array<{ title: string; items: string[] }> };

export interface Lesson {
  id: string;
  title: string;
  objective: string;
  summary: string;
  duration: number;
  difficulty: LessonDifficulty;
  kind: LessonKind;
  status: string;
  anchors: CodeAnchor[];
  quiz: {
    question: string;
    hint: string;
  };
  content?: LessonContentBlock[];
}

export interface CourseModule {
  id: string;
  number: string;
  title: string;
  summary: string;
  lessons: Lesson[];
}

export interface Course {
  id: string;
  repositoryId: string;
  sourceCommit: string;
  sourceVersion?: string;
  title: string;
  subtitle: string;
  level: string;
  generatedBy: string;
  generatedAt: string;
  profile?: LearnerProfile;
  modules: CourseModule[];
}

export interface DiagnosticQuestion {
  id: string;
  skillId: string;
  prompt: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

export interface SkillNode {
  id: string;
  title: string;
  summary: string;
  lessonId: string;
  prerequisites: string[];
  anchors: CodeAnchor[];
  depth: "foundation" | "working" | "deep";
  branch: string;
  importance: number;
  estimatedMinutes: number;
  sourceFingerprint?: string;
}

export interface SkillGraph {
  id: string;
  repositoryId: string;
  sourceVersion?: string;
  generatedBy: string;
  nodes: SkillNode[];
  diagnostic: DiagnosticQuestion[];
}

export interface LearningEvidence {
  id: string;
  skillId: string;
  kind: "diagnostic" | "lesson" | "quiz" | "practice" | "self-report" | "note";
  strength: number;
  detail: string;
  createdAt: string;
}

export interface SkillMastery {
  skillId: string;
  mastery: number;
  confidence: number;
  status: SkillStatus;
  evidence: LearningEvidence[];
  sourceFingerprint?: string;
}

export interface LearningMemory {
  id: string;
  text: string;
  skillId?: string;
  source: "side-chat" | "lesson" | "learner";
  createdAt: string;
}

export interface LearnerState {
  repositoryId: string;
  sourceVersion?: string;
  diagnosticCompleted: boolean;
  mastery: Record<string, SkillMastery>;
  memory: LearningMemory[];
  updatedAt: string;
}

export interface ContextSection {
  id: string;
  kind: "instruction" | "memory" | "repository" | "lesson" | "selection" | "source" | "related";
  title: string;
  source?: string;
  reason: string;
  content: string;
  estimatedTokens: number;
  priority: number;
  cached: boolean;
}

export interface ContextPack {
  id: string;
  mode: ContextMode;
  budget: number;
  estimatedTokens: number;
  savedTokens: number;
  sections: ContextSection[];
  omitted: Array<{ title: string; reason: string; estimatedTokens: number }>;
  intent: "lookup" | "explain" | "trace" | "design" | "practice";
  cacheHit: boolean;
}

export interface ContextScope {
  selection: boolean;
  currentFile: boolean;
  lesson: boolean;
  dependencies: boolean;
}

export interface AgentAnswer {
  text: string;
  pack: ContextPack;
  answeredBy: "codex" | "claude" | "local-index" | "demo";
  responseCacheHit: boolean;
}

export interface AgentState {
  codex: { available: boolean; version: string | null };
  claude: { available: boolean; version: string | null };
}

export interface PracticeSession {
  id: string;
  repositoryId: string;
  repositoryName: string;
  worktreePath: string;
  baseCommit: string;
  lessonId: string;
  lessonTitle: string;
  createdAt: string;
}

export interface PracticeReport {
  sessionId: string;
  clean: boolean;
  status: string;
  diffStat: string;
  diffCheckPassed: boolean;
  diffCheckOutput: string;
  checkedAt: string;
}

export interface TraceBridge {
  chooseRepository(): Promise<string | null>;
  openRepository(request: string | { source: string; profile?: LearnerProfile }): Promise<{ repository: Repository; course: Course; skillGraph: SkillGraph; learnerState: LearnerState }>;
  readFile(rootPath: string, filePath: string): Promise<string>;
  detectAgents(): Promise<AgentState>;
  askAgent(request: {
    provider: "codex" | "claude";
    rootPath: string;
    context: {
      lesson: Lesson;
      question: string;
      repository: Repository;
      skill?: SkillNode;
      mode: ContextMode;
      scope: ContextScope;
      openFile?: { path: string; line: number; selection?: { text: string; startLine: number; endLine: number } };
      memory: LearningMemory[];
    };
  }): Promise<AgentAnswer>;
  enhanceCourse(request: {
    provider: "codex" | "claude";
    repository: Repository;
    course: Course;
  }): Promise<{ course: Course; skillGraph: SkillGraph }>;
  loadLearning(request: { repository: Repository; skillGraph: SkillGraph }): Promise<LearnerState>;
  saveLearning(state: LearnerState): Promise<boolean>;
  createPractice(request: { repository: Repository; lesson: Lesson }): Promise<PracticeSession>;
  inspectPractice(sessionId: string): Promise<PracticeReport>;
  openPractice(sessionId: string): Promise<boolean>;
  removePractice(request: { sessionId: string; discardChanges: boolean }): Promise<{ removed: boolean; requiresConfirmation: boolean; report?: PracticeReport }>;
}

declare global {
  interface Window {
    trace?: TraceBridge;
  }
}
