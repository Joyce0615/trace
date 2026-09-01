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
  endLine?: number;
  container?: string | null;
}

export interface CodeReference {
  name: string;
  path: string;
  line: number;
  kind: string;
}

export interface CallEdge {
  path: string;
  line: number;
  caller: string | null;
  callee: string;
  targetPath?: string | null;
  targetLine?: number | null;
  resolved?: boolean;
}

/** Minimal repository identity sent across IPC instead of the full index. */
export interface RepositoryRef {
  id: string;
  rootPath: string;
}

export interface ImportEdge {
  path: string;
  line: number;
  specifier: string;
  statement?: string;
  targetPath?: string | null;
  resolved?: boolean;
  resolvedBy?: string | null;
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
  references?: CodeReference[];
  callEdges?: CallEdge[];
  imports?: ImportEdge[];
  entryFiles: string[];
  stats: {
    fileCount: number;
    symbolCount: number;
    referenceCount?: number;
    callEdgeCount?: number;
    resolvedCallEdgeCount?: number;
    importCount?: number;
    resolvedImportCount?: number;
    indexer?: string;
    indexerCounts?: Record<string, number>;
    languages: Record<string, number>;
    totalBytes?: number;
    limits?: IndexLimits;
    truncated?: IndexTruncation[];
    complete?: boolean;
    submodules?: { declared: number; urls: string[]; checkedOut: boolean; note: string };
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
  | { id: string; type: "comparison"; title: string; columns: Array<{ title: string; items: string[] }> }
  | { id: string; type: "callchain"; title: string; caption: string; steps: Array<{ symbol: string; detail: string; anchor: CodeAnchor }> };

export interface CallChainStep {
  symbol: string;
  path: string;
  line: number;
  kind: string;
  callLine: number | null;
}

export interface CallChain {
  id: string;
  steps: CallChainStep[];
  crossFileHops: number;
  files: string[];
  summary: string;
}

/** Exercise as the renderer sees it: options only, never the answer. */
export interface PredictionExercise {
  id: string;
  chainId: string;
  kind: "next-call" | "output";
  prompt: string;
  context: string;
  anchor: CodeAnchor;
  options: Array<{ id: string; label: string; detail: string }>;
}

export interface PredictionGrade {
  exerciseId: string;
  kind: "next-call" | "output";
  correct: boolean;
  choiceId: string | null;
  answerId: string;
  answerLabel: string;
  explanation: string;
  anchor: CodeAnchor;
}

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
  untrusted?: boolean;
  injectionFindings?: InjectionFinding[];
  redacted?: boolean;
  secretFindings?: SecretFinding[];
}

export interface SecretFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  line: number;
  preview: string;
  length: number;
  section?: string;
  source?: string | null;
}

export interface InjectionFinding {
  id: string;
  severity: "high" | "medium";
  excerpt: string;
  line: number;
  section?: string;
  source?: string | null;
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
  injectionFindings?: InjectionFinding[];
  secretFindings?: SecretFinding[];
  redactedSections?: number;
  secretSummary?: { total: number; critical: number; high: number; byType: Record<string, number> };
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

export interface KnowledgeGraphNode {
  id: string;
  kind: "repository" | "directory" | "file" | "symbol" | "external" | "unresolved";
  key: string;
  label: string;
  language?: string;
  symbolKind?: string;
  path?: string;
  line?: number;
  container?: string | null;
  importance?: number;
  size?: number;
}

export interface KnowledgeGraphEdge {
  from: string;
  to: string;
  kind: "contains" | "defines" | "imports" | "calls";
  specifier?: string;
  callee?: string;
  line?: number;
  resolved?: boolean;
}

export interface KnowledgeGraphSummary {
  format: string;
  repositoryId: string;
  version?: string;
  previousVersion: string | null;
  generatedAt: string;
  stats: {
    nodeCount: number;
    edgeCount: number;
    fileCount: number;
    reusedPartitions: number;
    rebuiltPartitions: number;
    invalidatedByDependency: number;
    removedPartitions: number;
    danglingEdges: number;
    resolvedCallEdges: number;
    resolvedImportEdges: number;
    byKind: Record<string, number>;
  };
}

export interface IndexProgress {
  requestId?: string;
  phase: "prepare" | "discover" | "read" | "git" | "analyze" | "link" | "finalize" | "cancelled";
  completed: number;
  total: number;
  ratio: number;
  message: string;
  at?: number;
}

export interface IndexLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxAnalyzedFiles: number;
  maxSymbols: number;
  maxReferences: number;
  maxCallEdges: number;
  maxImports: number;
  analysisBatchSize: number;
}

export interface IndexTruncation {
  limit: string;
  value: number;
  discovered?: number;
  skipped?: number;
  indexedBytes?: number;
}

export interface LinkClassification {
  decision: "allow" | "confirm" | "block";
  reason: string;
  url: string | null;
  host: string | null;
  opened?: boolean;
  confirmed?: boolean;
  at?: string;
}

export interface LanguageServerRecord {
  id: string;
  command: string;
  available: boolean;
  binary: string | null;
  languages: string[];
}

export interface SymbolResolution {
  path: string;
  line: number;
  column: number;
  language: string;
  imports: ImportEdge[];
  definitions: Array<{ path: string; line: number; column: number }>;
  resolvedBy: string;
  languageServer: {
    available: boolean;
    server: string | null;
    reason?: string;
    definitions?: Array<{ path: string; line: number; column: number }>;
    overloads?: Array<{ path: string; line: number; column: number }>;
    typeDefinitions?: Array<{ path: string; line: number; column: number }>;
    implementations?: Array<{ path: string; line: number; column: number }>;
    dynamicDispatch?: boolean;
    type?: string | null;
  };
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
  cancelRepositoryOpen(requestId: string): Promise<boolean>;
  indexLimits(): Promise<IndexLimits>;
  onIndexProgress(callback: (progress: IndexProgress) => void): () => void;
  openRepository(request: { source: string; profile?: LearnerProfile; requestId?: string; limits?: Partial<IndexLimits> }): Promise<{ repository: Repository; course: Course; skillGraph: SkillGraph; learnerState: LearnerState; knowledgeGraph?: KnowledgeGraphSummary }>;
  graphSummary(request: { repository: RepositoryRef }): Promise<KnowledgeGraphSummary>;
  graphNeighborhood(request: { repository: RepositoryRef; nodeId: string; depth?: number; edgeKinds?: string[] }): Promise<{ nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[] }>;
  readFile(rootPath: string, filePath: string): Promise<string>;
  classifyLink(url: string): Promise<LinkClassification>;
  openLink(url: string): Promise<LinkClassification>;
  lastLinkDecision(): Promise<LinkClassification | null>;
  detectAgents(): Promise<AgentState>;
  detectLanguageServers(): Promise<Record<string, LanguageServerRecord>>;
  resolveSymbol(request: { repository: RepositoryRef; path: string; line: number; column?: number; symbol?: string }): Promise<SymbolResolution>;
  callChains(request: { repository: RepositoryRef; limit?: number }): Promise<{ version: number; chains: CallChain[]; exercises: PredictionExercise[] }>;
  gradePrediction(request: { repository: RepositoryRef; exerciseId: string; choiceId: string }): Promise<PredictionGrade>;
  askAgent(request: {
    provider: "codex" | "claude";
    rootPath: string;
    context: {
      lesson: Lesson;
      question: string;
      repository: RepositoryRef;
      skill?: SkillNode;
      mode: ContextMode;
      scope: ContextScope;
      openFile?: { path: string; line: number; selection?: { text: string; startLine: number; endLine: number } };
      memory: LearningMemory[];
    };
  }): Promise<AgentAnswer>;
  enhanceCourse(request: {
    provider: "codex" | "claude";
    repository: RepositoryRef;
    course: Course;
  }): Promise<{ course: Course; skillGraph: SkillGraph }>;
  loadLearning(request: { repository: RepositoryRef; skillGraph: SkillGraph }): Promise<LearnerState>;
  saveLearning(state: LearnerState): Promise<boolean>;
  createPractice(request: { repository: RepositoryRef; lesson: Lesson }): Promise<PracticeSession>;
  inspectPractice(sessionId: string): Promise<PracticeReport>;
  openPractice(sessionId: string): Promise<boolean>;
  removePractice(request: { sessionId: string; discardChanges: boolean }): Promise<{ removed: boolean; requiresConfirmation: boolean; report?: PracticeReport }>;
}

export interface TraceWorkspaceSnapshot {
  repository: Repository;
  course: Course | null;
  skillGraph: SkillGraph | null;
  learnerState: LearnerState | null;
  knowledgeGraph: KnowledgeGraphSummary | null;
}

declare global {
  interface Window {
    trace?: TraceBridge;
    /** Read-only workspace snapshot used by smoke tests and support diagnostics. */
    traceWorkspace?: TraceWorkspaceSnapshot;
  }
}
