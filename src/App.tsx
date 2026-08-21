import Editor, { type OnMount } from "@monaco-editor/react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { browserBridge, demoCourse, demoLearnerState, demoRepository, demoSkillGraph } from "./demo";
import { addEvidence, completeDiagnostic, personalizeSkillGraph, skillForLesson } from "./learning";
import type { AgentState, ContextMode, ContextPack, ContextScope, Course, LearnerProfile, LearnerState, LearningMemory, Lesson, LessonContentBlock, PracticeReport, PracticeSession, Repository, RepoFile, SkillGraph, SkillNode } from "./types";

type TutorMode = "learn" | "ask" | "quiz" | "practice";
type WorkspaceMode = "lesson" | "diagram" | "code" | "notes";
type FontScale = "compact" | "comfortable" | "large";
type CodeSelection = { text: string; startLine: number; endLine: number };
type Message = { id: string; role: "agent" | "user"; text: string; pack?: ContextPack; answeredBy?: string; saved?: boolean };

const missingDesktopBridge = new Proxy({}, {
  get() {
    return async () => { throw new Error("Desktop bridge failed to load. Restart Trace or reinstall the app."); };
  },
}) as unknown as typeof browserBridge;
const bridge = window.trace ?? (navigator.userAgent.includes("Electron") ? missingDesktopBridge : browserBridge);

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    arrow: <><path d="m9 18 6-6-6-6" /><path d="M15 12H3" /></>,
    book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" /></>,
    branch: <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M8 6h5a5 5 0 0 1 5 5v-3" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    code: <><path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14" /></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></>,
    folder: <><path d="M3 7h5l2 2h11v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2" /></>,
    git: <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="19" r="2" /><path d="M6 7v10a2 2 0 0 0 2 2h8M18 17V9a2 2 0 0 0-2-2H8" /></>,
    layers: <><path d="m12 2 9 5-9 5-9-5Z" /><path d="m3 12 9 5 9-5M3 17l9 5 9-5" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
    spark: <path d="m12 3-1.6 4.4L6 9l4.4 1.6L12 15l1.6-4.4L18 9l-4.4-1.6ZM5 15l-.8 2.2L2 18l2.2.8L5 21l.8-2.2L8 18l-2.2-.8Z" />,
    target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><path d="M12 3v3M21 12h-3M12 21v-3M3 12h3" /></>,
    terminal: <><path d="m4 17 6-5-6-5M12 19h8" /><rect width="20" height="18" x="2" y="3" rx="2" /></>,
    time: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function Logo() {
  return <div className="logo-mark" aria-label="Trace"><span /><span /><span /></div>;
}

const fontBoosts: Record<FontScale, number> = { compact: 0, comfortable: 2, large: 4 };

function FontSizeControl({ value, onChange }: { value: FontScale; onChange: (value: FontScale) => void }) {
  return <div className="font-size-control" role="group" aria-label="Text size">
    <button aria-label="Compact text" aria-pressed={value === "compact"} className={value === "compact" ? "active" : ""} onClick={() => onChange("compact")}>A−</button>
    <button aria-label="Comfortable text" aria-pressed={value === "comfortable"} className={value === "comfortable" ? "active" : ""} onClick={() => onChange("comfortable")}>A</button>
    <button aria-label="Large text" aria-pressed={value === "large"} className={value === "large" ? "active" : ""} onClick={() => onChange("large")}>A+</button>
  </div>;
}

function difficultyLabel(value: Lesson["difficulty"]) {
  return value === "foundation" ? "Foundation" : value === "intermediate" ? "Intermediate" : "Advanced";
}

function flattenLessons(course: Course) {
  return course.modules.flatMap((module) => module.lessons);
}

function languageLabel(language: string) {
  const labels: Record<string, string> = { typescript: "TS", javascript: "JS", python: "PY", rust: "RS", go: "GO", markdown: "MD", json: "{}" };
  return labels[language] ?? language.slice(0, 2).toUpperCase();
}

function editorLanguage(language?: string) {
  if (["cuda", "c", "cpp"].includes(language ?? "")) return "cpp";
  if (language === "rst") return "restructuredtext";
  return language ?? "plaintext";
}

function StartScreen({ onOpen, onDemo, busy, error, fontScale, onFontScale }: { onOpen: (source?: string, profile?: LearnerProfile) => void; onDemo: (profile: LearnerProfile) => void; busy: boolean; error: string | null; fontScale: FontScale; onFontScale: (value: FontScale) => void }) {
  const [source, setSource] = useState("");
  const [profile, setProfile] = useState<LearnerProfile>({ goal: "architecture", level: "adaptive" });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (source.trim()) onOpen(source.trim(), profile);
  };

  return (
    <div className="welcome-shell">
      <div className="welcome-glow" />
      <header className="welcome-header"><Logo /><span>TRACE</span><em>CODEBASE LEARNING STUDIO</em><span className="welcome-header-spacer" /><FontSizeControl value={fontScale} onChange={onFontScale} /></header>
      <main className="welcome-card">
        <div className="eyebrow"><Icon name="spark" size={14} /> Learn the system, not just the syntax</div>
        <h1>Turn any unfamiliar codebase<br /><span>into a guided learning path.</span></h1>
        <p>Trace maps real files, symbols, and execution paths. A local agent guides you through reading, questions, and practice until you can make your first confident change.</p>
        <form className="repo-entry" onSubmit={submit}>
          <Icon name="git" size={18} />
          <input value={source} onChange={(event) => setSource(event.target.value)} placeholder="Paste a local path or Git URL" aria-label="Repository path or URL" />
          <button type="submit" disabled={!source.trim() || busy}>{busy ? "Indexing…" : "Start learning"}<Icon name="arrow" /></button>
        </form>
        <div className="profile-controls">
          <label><span>Learning goal</span><select value={profile.goal} onChange={(event) => setProfile((value) => ({ ...value, goal: event.target.value as LearnerProfile["goal"] }))}><option value="architecture">Architecture overview</option><option value="critical_path">Critical call paths</option><option value="contribute">Prepare to contribute</option><option value="review">Code review</option></select></label>
          <label><span>Course level</span><select value={profile.level} onChange={(event) => setProfile((value) => ({ ...value, level: event.target.value as LearnerProfile["level"] }))}><option value="foundation">Foundation</option><option value="adaptive">Adaptive</option><option value="advanced">Advanced</option></select></label>
        </div>
        <div className="welcome-actions">
          <button className="text-button" onClick={() => onOpen(undefined, profile)} disabled={busy}><Icon name="folder" />Choose local repository</button>
          <span />
          <button className="text-button featured-demo" onClick={() => onDemo(profile)} disabled={busy}><Icon name="spark" />Explore nano-vllm <em>FEATURED</em></button>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="feature-row">
          <div><Icon name="layers" /><strong>Adaptive skill trees</strong><small>Learn only what moves you forward</small></div>
          <div><Icon name="code" /><strong>Illustrated source lessons</strong><small>Every diagram links back to code</small></div>
          <div><Icon name="terminal" /><strong>Credit-aware agents</strong><small>Transparent, budgeted context packs</small></div>
        </div>
      </main>
      <footer className="welcome-footer">Your code stays local · Agent actions are read-only by default</footer>
    </div>
  );
}

function DiagnosticOverlay({ graph, onComplete, onSkip }: { graph: SkillGraph; onComplete: (answers: Record<string, number>) => void; onSkip: () => void }) {
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const complete = graph.diagnostic.every((question) => answers[question.id] !== undefined);
  return <div className="diagnostic-backdrop">
    <section className="diagnostic-card" role="dialog" aria-label="Adaptive skill assessment">
      <div className="diagnostic-kicker"><Icon name="target" size={14} /> ADAPTIVE START</div>
      <h2>Let’s map what you already know.</h2>
      <p>Four quick checks shape your skill tree. They do not consume agent credits, and you can revisit any branch later.</p>
      <div className="diagnostic-progress"><span style={{ width: `${Object.keys(answers).length / Math.max(1, graph.diagnostic.length) * 100}%` }} /></div>
      <div className="diagnostic-questions">
        {graph.diagnostic.map((question, questionIndex) => <fieldset key={question.id}>
          <legend><span>{questionIndex + 1}</span>{question.prompt}</legend>
          {question.options.map((option, optionIndex) => <label key={option}><input type="radio" name={question.id} checked={answers[question.id] === optionIndex} onChange={() => setAnswers((value) => ({ ...value, [question.id]: optionIndex }))} /><span>{option}</span></label>)}
        </fieldset>)}
      </div>
      <div className="diagnostic-actions"><button onClick={onSkip}>Skip for now</button><button className="primary" disabled={!complete} onClick={() => onComplete(answers)}>Build my skill tree<Icon name="arrow" size={14} /></button></div>
    </section>
  </div>;
}

function skillLevel(node: SkillNode, nodes: SkillNode[], memo = new Map<string, number>()): number {
  if (memo.has(node.id)) return memo.get(node.id)!;
  const parents = node.prerequisites.map((id) => nodes.find((candidate) => candidate.id === id)).filter(Boolean) as SkillNode[];
  const level = parents.length ? 1 + Math.max(...parents.map((parent) => skillLevel(parent, nodes, memo))) : 0;
  memo.set(node.id, level);
  return level;
}

function SkillTree({ graph, state, activeSkill, onSelect, onFamiliar, onChallenge }: { graph: SkillGraph; state: LearnerState; activeSkill?: SkillNode; onSelect: (node: SkillNode) => void; onFamiliar: (node: SkillNode) => void; onChallenge: (node: SkillNode) => void }) {
  return <div className="skill-tree" aria-label="Repository skill tree">
    <div className="skill-legend"><span><i className="mastered" />Mastered</span><span><i className="recommended" />Recommended</span><span><i className="locked" />Locked</span></div>
    {graph.nodes.map((node) => {
      const mastery = state.mastery[node.id];
      const status = mastery?.status ?? "locked";
      const level = skillLevel(node, graph.nodes);
      return <div className="skill-row" key={node.id} style={{ "--skill-level": level } as React.CSSProperties}>
        <span className="skill-rail" />
        <button className={`skill-node ${status} ${activeSkill?.id === node.id ? "active" : ""}`} onClick={() => onSelect(node)} title={node.summary}>
          <span className="skill-orb">{status === "mastered" ? <Icon name="check" size={12} /> : status === "locked" ? "·" : Math.round((mastery?.mastery ?? 0) * 100)}</span>
          <span><strong>{node.title}</strong><small>{node.branch} · {node.estimatedMinutes} min</small></span>
          {status === "recommended" && <em>NEXT</em>}
        </button>
        {activeSkill?.id === node.id && status !== "mastered" && <div className="skill-shortcuts"><button onClick={() => onFamiliar(node)}>Mark familiar</button><button onClick={() => onChallenge(node)}>Take 60s challenge</button></div>}
      </div>;
    })}
  </div>;
}

function CourseSidebar({ course, skillGraph, learnerState, activeSkill, selectedLesson, completed, onSelect, onSelectSkill, onFamiliar, onChallenge, onToggleComplete, onEnhance, enhancing, enhanceElapsed, provider, canEnhance }: {
  course: Course;
  skillGraph: SkillGraph;
  learnerState: LearnerState;
  activeSkill?: SkillNode;
  selectedLesson: Lesson;
  completed: Set<string>;
  onSelect: (lesson: Lesson) => void;
  onSelectSkill: (node: SkillNode) => void;
  onFamiliar: (node: SkillNode) => void;
  onChallenge: (node: SkillNode) => void;
  onToggleComplete: (lesson: Lesson) => void;
  onEnhance: () => void;
  enhancing: boolean;
  enhanceElapsed: number;
  provider: "codex" | "claude";
  canEnhance: boolean;
}) {
  const [view, setView] = useState<"tree" | "outline">("tree");
  const lessons = flattenLessons(course);
  const mastered = skillGraph.nodes.filter((node) => learnerState.mastery[node.id]?.status === "mastered").length;
  const percent = Math.round((mastered / Math.max(1, skillGraph.nodes.length)) * 100);

  return (
    <aside className="course-sidebar panel-border">
      <div className="course-heading">
        <div className="course-kicker">ADAPTIVE PATH <span>{course.generatedBy === "local-indexer" ? "LOCAL DRAFT" : `${course.generatedBy.toUpperCase()} CURATED`}</span></div>
        <h2>{course.title}</h2>
        <p>{course.subtitle}</p>
      </div>
      <div className="progress-card">
        <div className="progress-ring" style={{ "--progress": `${percent * 3.6}deg` } as React.CSSProperties}><span>{percent}%</span></div>
        <div><strong>{mastered} / {skillGraph.nodes.length} skills lit</strong><small>{percent ? "Your next branch is ready" : "Start with the highlighted node"}</small></div>
      </div>
      <div className="sidebar-view-switch"><button className={view === "tree" ? "active" : ""} onClick={() => setView("tree")}>Skill Map</button><button className={view === "outline" ? "active" : ""} onClick={() => setView("outline")}>Outline</button></div>
      {view === "tree" ? <div className="module-list skill-list"><SkillTree graph={skillGraph} state={learnerState} activeSkill={activeSkill} onSelect={onSelectSkill} onFamiliar={onFamiliar} onChallenge={onChallenge} /></div> : <div className="module-list">
        {course.modules.map((module) => (
          <section className="course-module" key={module.id}>
            <div className="module-title"><span>{module.number}</span><div><strong>{module.title}</strong><small>{module.lessons.length} lessons</small></div></div>
            <div className="lesson-list">
              {module.lessons.map((lesson) => {
                const isSelected = selectedLesson.id === lesson.id;
                const isComplete = completed.has(lesson.id);
                return (
                  <button key={lesson.id} className={`lesson-item ${isSelected ? "selected" : ""}`} onClick={() => onSelect(lesson)}>
                    <span className={`lesson-state ${isComplete ? "complete" : ""}`} onClick={(event) => { event.stopPropagation(); onToggleComplete(lesson); }}>
                      {isComplete ? <Icon name="check" size={13} /> : <span />}
                    </span>
                    <span className="lesson-copy"><strong>{lesson.title}</strong><small><Icon name="time" size={12} />{lesson.duration} min <i>·</i> {difficultyLabel(lesson.difficulty)}</small></span>
                    {lesson.kind !== "lesson" && <span className={`kind-badge ${lesson.kind}`}>{lesson.kind}</span>}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>}
      {enhancing && <div className="generation-status"><span><i />{enhanceElapsed < 20 ? "Reading repository map" : enhanceElapsed < 90 ? "Tracing critical paths" : enhanceElapsed < 210 ? "Designing lessons and practice" : "Validating source anchors"}</span><strong>{Math.floor(enhanceElapsed / 60)}:{String(enhanceElapsed % 60).padStart(2, "0")}</strong></div>}
      <button className="course-settings" onClick={onEnhance} disabled={!canEnhance || enhancing}>
        <Icon name="spark" />
        {enhancing ? `${provider === "codex" ? "Codex" : "Claude"} is compiling…` : course.generatedBy === "local-indexer" ? `Compile skill tree with ${provider === "codex" ? "Codex" : "Claude"}` : `Recompile with ${provider === "codex" ? "Codex" : "Claude"}`}
        {!enhancing && <Icon name="chevron" size={14} />}
      </button>
    </aside>
  );
}

function FileExplorer({ repository, lesson, currentFile, query, onQuery, onOpen }: {
  repository: Repository;
  lesson: Lesson;
  currentFile: RepoFile | null;
  query: string;
  onQuery: (value: string) => void;
  onOpen: (file: RepoFile, line?: number) => void;
}) {
  const focusPaths = useMemo(
    () => [...new Set([...lesson.anchors.map((anchor) => anchor.path), ...repository.entryFiles])],
    [lesson.anchors, repository.entryFiles],
  );
  const visibleFiles = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const focusOrder = new Map(focusPaths.map((filePath, index) => [filePath, index]));
    return [...repository.files]
      .filter((file) => !normalized || file.path.toLowerCase().includes(normalized))
      .sort((left, right) => {
        const leftFocus = focusOrder.get(left.path);
        const rightFocus = focusOrder.get(right.path);
        if (leftFocus !== undefined || rightFocus !== undefined) {
          if (leftFocus === undefined) return 1;
          if (rightFocus === undefined) return -1;
          return leftFocus - rightFocus;
        }
        return (right.importance ?? 0) - (left.importance ?? 0) || left.path.localeCompare(right.path);
      })
      .slice(0, 180);
  }, [focusPaths, query, repository.files]);
  const activeSymbols = repository.symbols.filter((symbol) => symbol.path === currentFile?.path);

  return (
    <aside className="file-explorer">
      <div className="explorer-header"><span>EXPLORER</span><small>{repository.files.length}</small></div>
      <label className="explorer-search"><Icon name="search" size={13} /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Find file" /></label>
      <div className="explorer-scroll">
        <div className="tree-root"><Icon name="folder" size={14} /><strong>{repository.name}</strong></div>
        {visibleFiles.map((file) => (
          <button className={`file-row ${currentFile?.path === file.path ? "active" : ""}`} key={file.path} onClick={() => onOpen(file)} title={file.path}>
            <span className={`language-dot lang-${file.language}`}>{languageLabel(file.language)}</span>
            <span className="file-path">
              {file.directory && <i>{file.directory}/</i>}
              <strong>{file.name}</strong>
            </span>
          </button>
        ))}
        {visibleFiles.length === 180 && <div className="more-files">Refine search to see more files</div>}
        {activeSymbols.length > 0 && (
          <div className="symbol-section">
            <div className="symbol-heading">SYMBOLS <small>{activeSymbols.length}</small></div>
            {activeSymbols.map((symbol) => (
              <button key={`${symbol.name}-${symbol.line}`} onClick={() => currentFile && onOpen(currentFile, symbol.line)}><span>{symbol.kind === "class" ? "C" : symbol.kind === "interface" ? "I" : "ƒ"}</span>{symbol.name}<small>:{symbol.line}</small></button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function LessonCanvas({ lesson, diagramOnly, onAnchor }: { lesson: Lesson; diagramOnly?: boolean; onAnchor: (path: string, line: number) => void }) {
  const blocks = (lesson.content ?? []).filter((block) => !diagramOnly || ["diagram", "timeline", "comparison"].includes(block.type));
  if (!blocks.length) return <div className="lesson-canvas empty"><Icon name="book" size={26} /><h3>Source-first lesson</h3><p>This lesson is grounded in the active code anchor. Open Code to begin, then use Ask for questions.</p></div>;
  const jump = (path?: string, line = 1) => { if (path) onAnchor(path, line); };
  return <div className="lesson-canvas">
    <header><span>{diagramOnly ? "VISUAL MODEL" : "ILLUSTRATED LESSON"}</span><h2>{lesson.title}</h2><p>{lesson.summary}</p></header>
    {blocks.map((block: LessonContentBlock) => {
      if (block.type === "narrative") return <article className="content-narrative" key={block.id}>{block.eyebrow && <span>{block.eyebrow}</span>}<h3>{block.title}</h3><p>{block.body}</p></article>;
      if (block.type === "callout") return <aside className={`content-callout ${block.tone}`} key={block.id}><Icon name={block.tone === "question" ? "target" : "spark"} size={16} /><div><strong>{block.title}</strong><p>{block.body}</p></div></aside>;
      if (block.type === "diagram") return <article className="content-diagram" key={block.id}><div className="content-heading"><div><span>SOURCE-LINKED DIAGRAM</span><h3>{block.title}</h3></div><p>{block.caption}</p></div><div className="diagram-flow">{block.nodes.map((node, index) => <div className="diagram-step" key={node.id}>{index > 0 && <span className="diagram-arrow">→</span>}<button onClick={() => jump(node.anchor?.path, node.anchor?.line)} disabled={!node.anchor}><strong>{node.label}</strong><small>{node.detail}</small>{node.anchor && <em>{node.anchor.path.split("/").at(-1)}:{node.anchor.line}</em>}</button></div>)}</div><div className="diagram-edges">{block.edges.map((edge) => <span key={`${edge.from}-${edge.to}`}>{edge.from} → {edge.to}{edge.label ? ` · ${edge.label}` : ""}</span>)}</div></article>;
      if (block.type === "timeline") return <article className="content-timeline" key={block.id}><h3>{block.title}</h3><div>{block.steps.map((step, index) => <button key={`${step.label}-${index}`} onClick={() => jump(step.anchor?.path, step.anchor?.line)} disabled={!step.anchor}><span>{String(index + 1).padStart(2, "0")}</span><strong>{step.label}</strong><small>{step.detail}</small></button>)}</div></article>;
      return <article className="content-comparison" key={block.id}><h3>{block.title}</h3><div>{block.columns.map((column) => <section key={column.title}><strong>{column.title}</strong>{column.items.map((item) => <p key={item}><Icon name="check" size={12} />{item}</p>)}</section>)}</div></article>;
    })}
  </div>;
}

function CodeWorkspace({ repository, lesson, currentFile, content, line, workspaceMode, fontBoost, onOpen, onSelection, onWorkspaceMode }: {
  repository: Repository;
  lesson: Lesson;
  currentFile: RepoFile | null;
  content: string;
  line: number;
  workspaceMode: WorkspaceMode;
  fontBoost: number;
  onOpen: (file: RepoFile, line?: number) => void;
  onSelection: (selection: CodeSelection | null) => void;
  onWorkspaceMode: (mode: WorkspaceMode) => void;
}) {
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState(() => localStorage.getItem(`trace:notes:${repository.id}:${lesson.id}`) ?? "");
  const [monacoReady, setMonacoReady] = useState(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  useEffect(() => {
    let active = true;
    void import("./monaco").then(() => { if (active) setMonacoReady(true); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    setNotes(localStorage.getItem(`trace:notes:${repository.id}:${lesson.id}`) ?? "");
    onSelection(null);
  }, [lesson.id, lesson.content?.length, onSelection, repository.id]);
  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monaco.editor.defineTheme("trace-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "667085", fontStyle: "italic" },
        { token: "keyword", foreground: "C8B6FF" },
        { token: "string", foreground: "A7E3A1" },
        { token: "type.identifier", foreground: "8FD8FF" },
      ],
      colors: {
        "editor.background": "#0d1119",
        "editor.foreground": "#cbd3df",
        "editorLineNumber.foreground": "#3f4857",
        "editorLineNumber.activeForeground": "#aab4c4",
        "editor.lineHighlightBackground": "#141a25",
        "editor.selectionBackground": "#4f46e533",
        "editorCursor.foreground": "#9ee66f",
        "editorIndentGuide.background1": "#1d2430",
      },
    });
    monaco.editor.setTheme("trace-dark");
    editor.revealLineInCenter(Math.max(1, line));
    editor.setPosition({ lineNumber: Math.max(1, line), column: 1 });
    editor.onDidChangeCursorSelection((event) => {
      const model = editor.getModel();
      const text = model?.getValueInRange(event.selection) ?? "";
      onSelection(text.trim() ? { text: text.slice(0, 8_000), startLine: event.selection.startLineNumber, endLine: event.selection.endLineNumber } : null);
    });
  };

  useEffect(() => {
    if (!editorRef.current) return;
    editorRef.current.revealLineInCenter(Math.max(1, line));
    editorRef.current.setPosition({ lineNumber: Math.max(1, line), column: 1 });
  }, [line, currentFile?.path]);

  return (
    <main className="code-workspace panel-border">
      <FileExplorer repository={repository} lesson={lesson} currentFile={currentFile} query={query} onQuery={setQuery} onOpen={(file, targetLine) => { onWorkspaceMode("code"); onOpen(file, targetLine); }} />
      <section className="editor-column">
        <div className="lesson-context">
          <div><span>NOW LEARNING</span><strong>{lesson.title}</strong></div>
          <p>{lesson.objective}</p>
          <div className="context-anchor"><span className="pulse" />{lesson.anchors[0]?.symbol ?? currentFile?.name ?? "Repository map"}</div>
        </div>
        <div className="content-tabs">
          <button className={workspaceMode === "lesson" ? "active" : ""} onClick={() => onWorkspaceMode("lesson")}><Icon name="book" size={12} />Lesson</button>
          <button className={workspaceMode === "diagram" ? "active" : ""} onClick={() => onWorkspaceMode("diagram")}><Icon name="layers" size={12} />Diagram</button>
          <button className={workspaceMode === "code" ? "active" : ""} onClick={() => onWorkspaceMode("code")}><Icon name="code" size={12} />Code</button>
          <button className={workspaceMode === "notes" ? "active" : ""} onClick={() => onWorkspaceMode("notes")}><Icon name="file" size={12} />Notes</button>
          <span />
          {workspaceMode === "code" && <div className="editor-actions"><span>Ln {line}</span><span>{currentFile?.language ?? "text"}</span></div>}
        </div>
        {workspaceMode === "code" && <><div className="editor-tabs">{currentFile ? <div className="editor-tab active"><Icon name="file" size={13} />{currentFile.name}<span>×</span></div> : <div className="editor-tab active">No file selected</div>}</div><div className="breadcrumb"><Icon name="code" size={13} />{currentFile?.path.split("/").map((part, index, parts) => <span key={`${part}-${index}`}>{part}{index < parts.length - 1 && <Icon name="chevron" size={11} />}</span>)}</div></>}
        {workspaceMode === "lesson" && <LessonCanvas lesson={lesson} onAnchor={(path, targetLine) => { const file = repository.files.find((item) => item.path === path); if (file) { onWorkspaceMode("code"); onOpen(file, targetLine); } }} />}
        {workspaceMode === "diagram" && <LessonCanvas lesson={lesson} diagramOnly onAnchor={(path, targetLine) => { const file = repository.files.find((item) => item.path === path); if (file) { onWorkspaceMode("code"); onOpen(file, targetLine); } }} />}
        {workspaceMode === "notes" && <div className="lesson-notes"><span>PRIVATE LEARNING NOTES</span><h3>{lesson.title}</h3><textarea value={notes} onChange={(event) => { setNotes(event.target.value); localStorage.setItem(`trace:notes:${repository.id}:${lesson.id}`, event.target.value); }} placeholder="Capture an insight, question, or source reference…" /><small>Stored locally for this repository and lesson.</small></div>}
        <div className={`editor-wrap ${workspaceMode === "code" ? "" : "hidden"}`}>
          {monacoReady ? <Editor
            path={currentFile?.path ?? "empty.txt"}
            language={editorLanguage(currentFile?.language)}
            value={content}
            onMount={onMount}
            loading={<div className="editor-loading">Loading source…</div>}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontFamily: '"SFMono-Regular", "Cascadia Code", Menlo, monospace',
              fontSize: 13 + fontBoost,
              lineHeight: 22 + fontBoost * 1.5,
              padding: { top: 18, bottom: 18 },
              renderLineHighlight: "all",
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              automaticLayout: true,
              overviewRulerBorder: false,
              folding: true,
              glyphMargin: false,
              lineNumbersMinChars: 3,
            }}
          /> : <div className="editor-loading">Loading local editor…</div>}
        </div>
      </section>
    </main>
  );
}

function ContextPackCard({ pack }: { pack: ContextPack }) {
  const [open, setOpen] = useState(false);
  return <div className="context-pack-card">
    <button onClick={() => setOpen((value) => !value)}><span><Icon name="layers" size={13} /><strong>{pack.estimatedTokens.toLocaleString()}</strong> est. tokens</span><em>{pack.savedTokens.toLocaleString()} saved</em><Icon name="chevron" size={12} /></button>
    {open && <div className="context-pack-detail"><div><span>{pack.mode.toUpperCase()} PACK</span><strong>{pack.sections.length} included · {pack.omitted.length} omitted</strong></div>{pack.sections.map((section) => <article key={section.id}><span>{section.kind}</span><strong>{section.title}</strong><small>{section.reason}</small><em>{section.estimatedTokens} tok{section.cached ? " · cached" : ""}</em></article>)}</div>}
  </div>;
}

const learningSteps = ["Read", "Trace", "Explain", "Quiz", "Practice", "Complete"];
const learningInstructions = [
  "Read the illustrated lesson once for the mental model. Ignore implementation details on the first pass.",
  "Open the highlighted source and follow inputs → state changes → outputs. You do not need to read every line.",
  "Explain the flow in your own words. Use Quick Ask for any concept or line that is still unclear.",
  "Answer the checkpoint without looking back, then use the source-grounded feedback to close gaps.",
  "Make one small change in an isolated workspace and inspect the diff before finishing.",
  "Mark the lesson complete when you can explain the path and predict the impact of a change.",
  "This node is complete. Continue with the newly unlocked recommended skill.",
];

function LearningGuide({ stage, nextSkill, onStage, onWorkspaceMode, onMode, onDone, onNextSkill }: {
  stage: number;
  nextSkill?: SkillNode;
  onStage: (stage: number) => void;
  onWorkspaceMode: (mode: WorkspaceMode) => void;
  onMode: (mode: TutorMode) => void;
  onDone: () => void;
  onNextSkill: (skill: SkillNode) => void;
}) {
  const action = () => {
    if (stage === 0) { onWorkspaceMode("code"); onStage(1); }
    else if (stage === 1) { onStage(2); }
    else if (stage === 2) onMode("ask");
    else if (stage === 3) onMode("quiz");
    else if (stage === 4) onMode("practice");
    else if (stage === 5) onDone();
    else if (nextSkill) onNextSkill(nextSkill);
  };
  const actionLabel = ["Continue to source", "I found the flow", "Open Quick Ask", "Take checkpoint", "Start practice", "Mark lesson complete", nextSkill ? `Next: ${nextSkill.title}` : "Course complete"][Math.min(stage, 6)];
  return <details className="learning-guide" open>
    <summary><span><Icon name="target" size={13} />YOUR NEXT MOVE</span><em>{stage >= 6 ? "Ready for the next skill" : `Step ${stage + 1} of 6`}</em></summary>
    <div className="learning-sequence">
      {learningSteps.map((step, index) => <span key={step} className={index < stage || stage >= 6 ? "done" : index === stage ? "current" : ""}>{index < stage || stage >= 6 ? <Icon name="check" size={10} /> : index + 1}<small>{step}</small></span>)}
    </div>
    <p>{learningInstructions[Math.min(stage, 6)]}</p>
    <div className="learning-guide-actions">
      {stage === 4 && <button className="guide-skip" onClick={() => onStage(5)}>Skip for now</button>}
      <button className="guide-primary" disabled={stage >= 6 && !nextSkill} onClick={action}>{actionLabel}<Icon name="arrow" size={12} /></button>
    </div>
  </details>;
}

function TutorPanel({ repository, lesson, skill, nextSkill, learnerState, provider, agents, mode, messages, askMessages, busy, currentFile, selection, guideStage, onGuideStage, onWorkspaceMode, onNextSkill, onProvider, onMode, onAsk, onSaveMemory, onQuizEvidence, onDone, complete, practiceSession, practiceReport, practiceBusy, onCreatePractice, onInspectPractice, onOpenPractice, onRemovePractice }: {
  repository: Repository;
  lesson: Lesson;
  skill?: SkillNode;
  nextSkill?: SkillNode;
  learnerState: LearnerState;
  provider: "codex" | "claude";
  agents: AgentState;
  mode: TutorMode;
  messages: Message[];
  askMessages: Message[];
  busy: boolean;
  currentFile: RepoFile | null;
  selection: CodeSelection | null;
  guideStage: number;
  onGuideStage: (stage: number) => void;
  onWorkspaceMode: (mode: WorkspaceMode) => void;
  onNextSkill: (skill: SkillNode) => void;
  onProvider: (provider: "codex" | "claude") => void;
  onMode: (mode: TutorMode) => void;
  onAsk: (question: string, channel: "learn" | "ask", options?: { mode: ContextMode; scope: ContextScope }) => void;
  onSaveMemory: (message: Message) => void;
  onQuizEvidence: () => void;
  onDone: () => void;
  complete: boolean;
  practiceSession?: PracticeSession | null;
  practiceReport?: PracticeReport | null;
  practiceBusy?: boolean;
  onCreatePractice?: () => void;
  onInspectPractice?: () => void;
  onOpenPractice?: () => void;
  onRemovePractice?: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [showHint, setShowHint] = useState(false);
  const [contextMode, setContextMode] = useState<ContextMode>("lean");
  const [scope, setScope] = useState<ContextScope>({ selection: true, currentFile: true, lesson: true, dependencies: false });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeMessages = mode === "ask" ? askMessages : messages;
  const lastPack = [...activeMessages].reverse().find((message) => message.pack)?.pack;
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [activeMessages, busy]);
  useEffect(() => {
    setShowHint(false);
  }, [lesson.id]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!question.trim() || busy) return;
    onAsk(question.trim(), mode === "ask" ? "ask" : "learn", mode === "ask" ? { mode: contextMode, scope } : undefined);
    setQuestion("");
  };

  return (
    <aside className="tutor-panel">
      <div className="tutor-header">
        <div className="tutor-title"><span className="agent-orb"><Icon name="spark" size={15} /></span><div><strong>Learning Agent</strong><small><i className={agents[provider].available ? "online" : "offline"} />{agents[provider].available ? "Ready · read-only" : "CLI unavailable"}</small></div></div>
        <div className="provider-switch">
          <button className={provider === "codex" ? "active" : ""} onClick={() => onProvider("codex")}>Codex</button>
          <button className={provider === "claude" ? "active" : ""} onClick={() => onProvider("claude")}>Claude</button>
        </div>
      </div>
      <div className="tutor-modes">
        <button className={mode === "learn" ? "active" : ""} onClick={() => onMode("learn")}>Learn</button>
        <button className={mode === "ask" ? "active" : ""} onClick={() => onMode("ask")}>Ask</button>
        <button className={mode === "quiz" ? "active" : ""} onClick={() => onMode("quiz")}>Quiz</button>
        <button className={mode === "practice" ? "active" : ""} onClick={() => onMode("practice")}>Practice</button>
      </div>
      <div className="tutor-scroll" ref={scrollRef}>
        {mode === "learn" && <>
          <LearningGuide stage={guideStage} nextSkill={nextSkill} onStage={onGuideStage} onWorkspaceMode={onWorkspaceMode} onMode={onMode} onDone={onDone} onNextSkill={onNextSkill} />
          <div className="lesson-brief"><span>LESSON OBJECTIVE</span><p>{lesson.objective}</p><div><Icon name="target" size={14} />Focus: {lesson.anchors[0]?.symbol ?? lesson.anchors[0]?.path ?? repository.name}</div></div>
          <div className="messages">
            {messages.map((message) => <div key={message.id} className={`message ${message.role}`}><span>{message.role === "agent" ? <Icon name="spark" size={12} /> : "YOU"}</span><p>{message.text}</p></div>)}
            {busy && <div className="message agent"><span><Icon name="spark" size={12} /></span><div className="typing"><i /><i /><i /></div></div>}
          </div>
          <div className="suggestions">
            <button onClick={() => onAsk("Guide me through the complete data flow of this code.", "learn")}>Trace the data flow</button>
            <button onClick={() => onAsk("What is the most important trade-off in this design?", "learn")}>Explain the trade-offs</button>
          </div>
        </>}
        {mode === "ask" && <div className="side-chat">
          <div className="side-chat-intro"><span>QUICK ASK · SEPARATE FROM YOUR LESSON</span><h3>Ask without losing your place.</h3><p>Use the smallest context that can answer the question. Your course conversation stays clean.</p></div>
          <div className="context-controls">
            <label><span>Context budget</span><select value={contextMode} onChange={(event) => setContextMode(event.target.value as ContextMode)}><option value="lean">Lean · ~2.4k</option><option value="balanced">Balanced · ~5.2k</option><option value="deep">Deep · ~10k</option></select></label>
            <div className="context-chips">
              <button className={scope.selection && selection ? "active" : ""} disabled={!selection} onClick={() => setScope((value) => ({ ...value, selection: !value.selection }))}>Selection{selection ? ` · ${selection.endLine - selection.startLine + 1}L` : ""}</button>
              <button className={scope.currentFile ? "active" : ""} onClick={() => setScope((value) => ({ ...value, currentFile: !value.currentFile }))}>Current file</button>
              <button className={scope.lesson ? "active" : ""} onClick={() => setScope((value) => ({ ...value, lesson: !value.lesson }))}>Lesson</button>
              <button className={scope.dependencies ? "active" : ""} onClick={() => setScope((value) => ({ ...value, dependencies: !value.dependencies }))}>Dependencies</button>
            </div>
          </div>
          <div className="messages ask-messages">
            {askMessages.length === 0 && <div className="ask-empty"><Icon name="code" size={20} /><p>Try “Where is Scheduler defined?” for a zero-credit local lookup.</p></div>}
            {askMessages.map((message) => <div key={message.id} className={`message ${message.role}`}><span>{message.role === "agent" ? <Icon name="spark" size={12} /> : "YOU"}</span><p>{message.text}</p>{message.role === "agent" && <div className="message-meta"><em>{message.answeredBy === "local-index" ? "0 agent credits · local index" : message.answeredBy ?? provider}</em><span><button onClick={() => { setContextMode("deep"); setQuestion(`Go one level deeper on this answer: ${message.text.slice(0, 120)}`); }}>Go deeper</button><button onClick={() => onMode("quiz")}>Open quiz</button><button disabled={message.saved} onClick={() => onSaveMemory(message)}>{message.saved ? "Saved" : "Save to memory"}</button></span></div>}</div>)}
            {busy && <div className="message agent"><span><Icon name="spark" size={12} /></span><div className="typing"><i /><i /><i /></div></div>}
          </div>
          {lastPack && <ContextPackCard pack={lastPack} />}
          {learnerState.memory.length > 0 && <div className="memory-count"><Icon name="book" size={12} />{learnerState.memory.length} saved learning memories</div>}
        </div>}
        {mode === "quiz" && <div className="activity-card">
          <div className="activity-label"><span>CHECKPOINT</span><em>Knowledge check</em></div>
          <h3>{lesson.quiz.question}</h3>
          <textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Answer in your own words. The agent will ground feedback in the source…" />
          {showHint && <div className="hint"><Icon name="spark" size={13} />{lesson.quiz.hint}</div>}
          <div className="activity-actions"><button className="ghost" onClick={() => setShowHint((value) => !value)}>{showHint ? "Hide hint" : "Show hint"}</button><button className="primary" disabled={!question.trim() || busy} onClick={() => { onQuizEvidence(); onAsk(`Evaluate my quiz answer and point out anything I missed: ${question}`, "learn"); onMode("learn"); setQuestion(""); }}>Submit answer</button></div>
        </div>}
        {mode === "practice" && <div className="activity-card practice-card">
          <div className="activity-label"><span>{lesson.kind === "project" ? "PROJECT" : "GUIDED PRACTICE"}</span><em>{lesson.duration} min</em></div>
          <h3>{lesson.kind === "project" ? lesson.title : "Prove your understanding"}</h3>
          <p>{lesson.kind === "project" ? lesson.objective : "Describe a safe, small change and a validation plan before working in an isolated Git worktree."}</p>
          <div className="practice-steps"><div><span>1</span>Define expected behavior</div><div><span>2</span>Find the smallest change surface</div><div><span>3</span>Run the relevant tests</div></div>
          {practiceSession ? <div className="practice-session">
            <div className="practice-session-title"><span className="pulse" /><strong>Isolated workspace ready</strong><em>detached</em></div>
            <code>{practiceSession.worktreePath}</code>
            {practiceReport && <div className={`practice-report ${practiceReport.diffCheckPassed ? "passed" : "failed"}`}><Icon name={practiceReport.diffCheckPassed ? "check" : "code"} size={13} />{practiceReport.clean ? "No changes yet" : practiceReport.diffCheckPassed ? "Diff check passed" : "Diff has formatting issues"}</div>}
            <div className="practice-session-actions"><button onClick={onOpenPractice}>Open in Finder</button><button onClick={onInspectPractice} disabled={practiceBusy}>Inspect changes</button><button className="danger" onClick={onRemovePractice}>End session</button></div>
          </div> : <button className="worktree-button" disabled={practiceBusy} onClick={onCreatePractice}><Icon name="branch" size={14} />{practiceBusy ? "Creating worktree…" : "Create isolated practice workspace"}</button>}
          <button className="primary wide" onClick={() => { onAsk("Give me a step-by-step practice task based on the current lesson. Tell me only the first step, and do not modify any files.", "learn"); onMode("learn"); }}>Start guided practice<Icon name="arrow" /></button>
        </div>}
      </div>
      {(mode === "learn" || mode === "ask") && <form className="tutor-input" onSubmit={submit}>
        <textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={mode === "ask" ? "Ask a quick code or concept question…" : currentFile ? `Ask about ${currentFile.name}…` : "Ask about this lesson…"} rows={2} />
        <div><span><Icon name="code" size={12} />{mode === "ask" ? `${contextMode} context` : `${currentFile?.name ?? repository.name} in context`}</span><button disabled={!question.trim() || busy}><Icon name="send" size={15} /></button></div>
      </form>}
      <button className={`mark-complete ${complete ? "complete" : ""}`} onClick={onDone}>{complete ? <><Icon name="check" />Lesson completed</> : "Mark lesson complete"}</button>
    </aside>
  );
}

export default function App() {
  const [fontScale, setFontScale] = useState<FontScale>(() => {
    const saved = localStorage.getItem("trace:text-size");
    return saved === "compact" || saved === "large" ? saved : "comfortable";
  });
  const [repository, setRepository] = useState<Repository | null>(null);
  const [course, setCourse] = useState<Course | null>(null);
  const [skillGraph, setSkillGraph] = useState<SkillGraph | null>(null);
  const [learnerState, setLearnerState] = useState<LearnerState | null>(null);
  const [selectedLesson, setSelectedLesson] = useState<Lesson | null>(null);
  const [currentFile, setCurrentFile] = useState<RepoFile | null>(null);
  const [content, setContent] = useState("");
  const [line, setLine] = useState(1);
  const [selection, setSelection] = useState<CodeSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [courseBusy, setCourseBusy] = useState(false);
  const [courseElapsed, setCourseElapsed] = useState(0);
  const [practiceSession, setPracticeSession] = useState<PracticeSession | null>(null);
  const [practiceReport, setPracticeReport] = useState<PracticeReport | null>(null);
  const [practiceBusy, setPracticeBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentState>({ codex: { available: false, version: null }, claude: { available: false, version: null } });
  const [provider, setProvider] = useState<"codex" | "claude">("codex");
  const [mode, setMode] = useState<TutorMode>("learn");
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<Message[]>([]);
  const [askMessages, setAskMessages] = useState<Message[]>([]);
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("lesson");
  const [guideProgress, setGuideProgress] = useState<Record<string, number>>({});

  useEffect(() => { bridge.detectAgents().then(setAgents).catch(() => undefined); }, []);
  useEffect(() => {
    document.documentElement.style.setProperty("--font-boost", `${fontBoosts[fontScale]}px`);
    localStorage.setItem("trace:text-size", fontScale);
  }, [fontScale]);
  useEffect(() => {
    if (!courseBusy) return;
    const startedAt = Date.now();
    setCourseElapsed(0);
    const timer = window.setInterval(() => setCourseElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [courseBusy]);
  useEffect(() => {
    if (!learnerState) return;
    const timer = window.setTimeout(() => { void bridge.saveLearning(learnerState).catch(() => undefined); }, 250);
    return () => window.clearTimeout(timer);
  }, [learnerState]);

  const loadSource = useCallback(async (repo: Repository, file: RepoFile, targetLine = 1) => {
    setCurrentFile(file);
    setLine(targetLine);
    setContent("Loading source…");
    try {
      setContent(await bridge.readFile(repo.rootPath, file.path));
    } catch (cause) {
      setContent(`Unable to preview ${file.path}\n\n${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }, []);

  const activateWorkspace = useCallback(async (repo: Repository, nextCourse: Course, nextGraph: SkillGraph, nextState: LearnerState) => {
    const recommended = nextGraph.nodes.find((node) => nextState.mastery[node.id]?.status === "recommended");
    const firstLesson = flattenLessons(nextCourse).find((lesson) => lesson.id === recommended?.lessonId) ?? flattenLessons(nextCourse)[0];
    setRepository(repo);
    setCourse(nextCourse);
    setSkillGraph(nextGraph);
    setLearnerState(nextState);
    setSelectedLesson(firstLesson);
    setWorkspaceMode(firstLesson.content?.length ? "lesson" : "code");
    setMode("learn");
    setDiagnosticOpen(!nextState.diagnosticCompleted);
    setAskMessages([]);
    const saved = localStorage.getItem(`trace:progress:${repo.id}`);
    setCompleted(new Set(saved ? JSON.parse(saved) : []));
    setMessages([{ id: "welcome", role: "agent", text: `Let's begin with “${firstLesson.title}.” ${firstLesson.summary}\n\nI've placed the most relevant source anchor in the editor. Skim it first, then tell me what you notice about its entry point, inputs, and outputs.` }]);
    const anchor = firstLesson.anchors[0];
    const file = repo.files.find((candidate) => candidate.path === anchor?.path) ?? repo.files[0];
    if (file) await loadSource(repo, file, anchor?.line ?? 1);
  }, [loadSource]);

  const openRepository = async (source?: string, profile?: LearnerProfile) => {
    setError(null);
    try {
      let resolved = source;
      if (!resolved) resolved = (await bridge.chooseRepository()) ?? undefined;
      if (!resolved) return;
      setBusy(true);
      const workspace = await bridge.openRepository({ source: resolved, profile: profile ?? course?.profile });
      await activateWorkspace(workspace.repository, workspace.course, workspace.skillGraph, workspace.learnerState);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const selectLesson = async (lesson: Lesson) => {
    if (!repository) return;
    setSelectedLesson(lesson);
    setWorkspaceMode(lesson.content?.length ? "lesson" : "code");
    setMode("learn");
    setMessages([{ id: `guide-${lesson.id}`, role: "agent", text: `Lesson objective: ${lesson.objective}\n\nStart with the source I've highlighted. Do not try to understand every line yet—first identify the inputs, state changes, and outputs.` }]);
    const anchor = lesson.anchors[0];
    const file = repository.files.find((candidate) => candidate.path === anchor?.path);
    if (file) await loadSource(repository, file, anchor.line);
  };

  const toggleComplete = (lesson: Lesson) => {
    if (!repository || !skillGraph || !learnerState) return;
    const wasComplete = completed.has(lesson.id);
    setCompleted((previous) => {
      const next = new Set(previous);
      if (next.has(lesson.id)) next.delete(lesson.id); else next.add(lesson.id);
      localStorage.setItem(`trace:progress:${repository.id}`, JSON.stringify([...next]));
      return next;
    });
    setGuideProgress((previous) => ({ ...previous, [lesson.id]: wasComplete ? 5 : 6 }));
    const skill = skillForLesson(skillGraph, lesson.id);
    if (skill && !wasComplete) setLearnerState(addEvidence(learnerState, skillGraph, skill.id, { kind: "lesson", strength: 0.85, detail: `Completed lesson: ${lesson.title}` }));
  };

  const ask = async (question: string, channel: "learn" | "ask" = "learn", options?: { mode: ContextMode; scope: ContextScope }) => {
    if (!repository || !selectedLesson || !skillGraph || !learnerState) return;
    const userMessage = { id: `user-${Date.now()}`, role: "user" as const, text: question };
    const setChannelMessages = channel === "ask" ? setAskMessages : setMessages;
    setChannelMessages((previous) => [...previous, userMessage]);
    setGuideProgress((previous) => ({ ...previous, [selectedLesson.id]: Math.max(previous[selectedLesson.id] ?? 0, 3) }));
    setAgentBusy(true);
    try {
      const skill = skillForLesson(skillGraph, selectedLesson.id);
      const response = await bridge.askAgent({
        provider,
        rootPath: repository.rootPath,
        context: {
          lesson: selectedLesson,
          question,
          repository,
          skill,
          mode: options?.mode ?? "balanced",
          scope: options?.scope ?? { selection: false, currentFile: true, lesson: true, dependencies: true },
          openFile: currentFile ? { path: currentFile.path, line, selection: selection ?? undefined } : undefined,
          memory: learnerState.memory,
        },
      });
      setChannelMessages((previous) => [...previous, { id: `agent-${Date.now()}`, role: "agent", text: response.text, pack: response.pack, answeredBy: response.answeredBy }]);
    } catch (cause) {
      setChannelMessages((previous) => [...previous, { id: `error-${Date.now()}`, role: "agent", text: `The agent could not answer: ${cause instanceof Error ? cause.message : String(cause)}` }]);
    } finally {
      setAgentBusy(false);
    }
  };

  const enhanceCourse = async () => {
    if (!repository || !course || !agents[provider].available || courseBusy) return;
    setCourseBusy(true);
    setError(null);
    try {
      const enhanced = await bridge.enhanceCourse({ provider, repository, course });
      const nextState = await bridge.loadLearning({ repository, skillGraph: enhanced.skillGraph });
      await activateWorkspace(repository, enhanced.course, enhanced.skillGraph, nextState);
      setMessages([{ id: `enhanced-${Date.now()}`, role: "agent", text: `${provider === "codex" ? "Codex" : "Claude"} redesigned the course from the repository source. We are starting from the new first lesson, and every lesson has a validated source anchor.` }]);
    } catch (cause) {
      setMessages((previous) => [...previous, { id: `course-error-${Date.now()}`, role: "agent", text: `Course generation failed, so the local course was preserved: ${cause instanceof Error ? cause.message : String(cause)}` }]);
    } finally {
      setCourseBusy(false);
    }
  };

  const createPractice = async () => {
    if (!repository || !selectedLesson || practiceBusy) return;
    setPracticeBusy(true);
    try {
      const session = await bridge.createPractice({ repository, lesson: selectedLesson });
      setPracticeSession(session);
      setPracticeReport(null);
    } catch (cause) {
      setMessages((previous) => [...previous, { id: `practice-error-${Date.now()}`, role: "agent", text: `Could not create the isolated practice workspace: ${cause instanceof Error ? cause.message : String(cause)}` }]);
      setMode("learn");
    } finally {
      setPracticeBusy(false);
    }
  };

  const inspectPractice = async () => {
    if (!practiceSession || practiceBusy) return;
    setPracticeBusy(true);
    try {
      const report = await bridge.inspectPractice(practiceSession.id);
      setPracticeReport(report);
      if (!report.clean && report.diffCheckPassed && skillGraph && learnerState && selectedLesson) {
        const skill = skillForLesson(skillGraph, selectedLesson.id);
        if (skill) setLearnerState(addEvidence(learnerState, skillGraph, skill.id, { kind: "practice", strength: 0.82, detail: `Validated practice diff for ${selectedLesson.title}` }));
        setGuideProgress((previous) => ({ ...previous, [selectedLesson.id]: Math.max(previous[selectedLesson.id] ?? 0, 5) }));
      }
    } finally {
      setPracticeBusy(false);
    }
  };

  const removePractice = async () => {
    if (!practiceSession || practiceBusy) return;
    setPracticeBusy(true);
    try {
      let result = await bridge.removePractice({ sessionId: practiceSession.id, discardChanges: false });
      if (result.requiresConfirmation && window.confirm("This worktree has uncommitted changes. Permanently discard them and end the practice session?")) {
        result = await bridge.removePractice({ sessionId: practiceSession.id, discardChanges: true });
      }
      if (result.removed) {
        setPracticeSession(null);
        setPracticeReport(null);
      } else if (result.report) {
        setPracticeReport(result.report);
      }
    } finally {
      setPracticeBusy(false);
    }
  };

  if (!repository || !course || !selectedLesson || !skillGraph || !learnerState) {
    return <StartScreen onOpen={openRepository} onDemo={(profile) => activateWorkspace(demoRepository, { ...demoCourse, profile, level: profile.level }, personalizeSkillGraph(demoSkillGraph, profile.goal), { ...structuredClone(demoLearnerState), diagnosticCompleted: false })} busy={busy} error={error} fontScale={fontScale} onFontScale={setFontScale} />;
  }

  const openFile = (file: RepoFile, targetLine = 1) => loadSource(repository, file, targetLine);
  const commit = repository.head === "unversioned" ? "unversioned" : repository.head.slice(0, 7);
  const activeSkill = skillForLesson(skillGraph, selectedLesson.id);
  const activeEvidence = activeSkill ? learnerState.mastery[activeSkill.id]?.evidence ?? [] : [];
  const evidenceStage = activeEvidence.some((item) => item.kind === "practice") ? 5 : activeEvidence.some((item) => item.kind === "quiz") ? 4 : 0;
  const guideStage = completed.has(selectedLesson.id) ? 6 : Math.max(guideProgress[selectedLesson.id] ?? 0, evidenceStage);
  const nextSkill = skillGraph.nodes.find((node) => node.id !== activeSkill?.id && learnerState.mastery[node.id]?.status === "recommended")
    ?? skillGraph.nodes.find((node) => node.id !== activeSkill?.id && learnerState.mastery[node.id]?.status === "available");
  const updateGuideStage = (stage: number) => setGuideProgress((previous) => ({ ...previous, [selectedLesson.id]: Math.max(previous[selectedLesson.id] ?? 0, stage) }));
  const changeWorkspaceMode = (nextMode: WorkspaceMode) => {
    setWorkspaceMode(nextMode);
    if (nextMode === "code") updateGuideStage(1);
  };
  const updateEvidence = (kind: "quiz" | "self-report", strength: number, detail: string) => {
    if (activeSkill) setLearnerState(addEvidence(learnerState, skillGraph, activeSkill.id, { kind, strength, detail }));
    if (kind === "quiz") updateGuideStage(4);
  };
  const selectSkill = (node: SkillNode) => {
    const lesson = flattenLessons(course).find((item) => item.id === node.lessonId);
    if (lesson) void selectLesson(lesson);
  };
  const saveMemory = (message: Message) => {
    if (!message.text || message.saved) return;
    const memory: LearningMemory = { id: `memory-${Date.now()}`, text: message.text.slice(0, 500), skillId: activeSkill?.id, source: "side-chat", createdAt: new Date().toISOString() };
    setLearnerState((value) => {
      if (!value) return value;
      const withMemory = { ...value, memory: [...value.memory, memory].slice(-50), updatedAt: new Date().toISOString() };
      return activeSkill ? addEvidence(withMemory, skillGraph, activeSkill.id, { kind: "note", strength: 0.1, detail: "Saved a side-chat insight to learning memory" }) : withMemory;
    });
    setAskMessages((items) => items.map((item) => item.id === message.id ? { ...item, saved: true } : item));
  };
  const finishDiagnostic = (answers?: Record<string, number>) => {
    const next = answers ? completeDiagnostic(learnerState, skillGraph, answers) : { ...learnerState, diagnosticCompleted: true, updatedAt: new Date().toISOString() };
    setLearnerState(next);
    setDiagnosticOpen(false);
    const recommended = skillGraph.nodes.find((node) => next.mastery[node.id]?.status === "recommended");
    if (recommended) selectSkill(recommended);
  };

  return (
    <div className="app-shell">
      <header className="app-bar">
        <div className="brand"><Logo /><span>TRACE</span></div>
        <button className="repo-switcher" onClick={() => openRepository()}><span className="repo-icon"><Icon name="code" size={15} /></span><strong>{repository.name}</strong><Icon name="chevron" size={13} /></button>
        <div className="repo-meta"><span><Icon name="branch" size={13} />{repository.branch}</span><span>{commit}</span>{repository.isDirty && <span className="dirty">modified</span>}<span className="index-badge" data-indexer={repository.stats.indexer ?? "regex"} title={`${repository.stats.symbolCount} definitions · ${repository.stats.referenceCount ?? 0} references · ${repository.stats.resolvedCallEdgeCount ?? 0}/${repository.stats.callEdgeCount ?? 0} resolved call edges`}>{repository.stats.fileCount} files · {repository.stats.indexer === "tree-sitter" ? "tree-sitter" : "regex"} index</span></div>
        <div className="app-bar-spacer" />
        <FontSizeControl value={fontScale} onChange={setFontScale} />
        <span className="privacy"><i />LOCAL · CONTEXT BUDGETED</span>
        <button className="avatar">BJ</button>
      </header>
      <div className="workspace-grid">
        <CourseSidebar course={course} skillGraph={skillGraph} learnerState={learnerState} activeSkill={activeSkill} selectedLesson={selectedLesson} completed={completed} onSelect={selectLesson} onSelectSkill={selectSkill} onFamiliar={(node) => setLearnerState(addEvidence(learnerState, skillGraph, node.id, { kind: "self-report", strength: 0.62, detail: `Marked familiar: ${node.title}` }))} onChallenge={(node) => { const lesson = flattenLessons(course).find((item) => item.id === node.lessonId); if (lesson) void selectLesson(lesson).then(() => setMode("quiz")); }} onToggleComplete={toggleComplete} onEnhance={enhanceCourse} enhancing={courseBusy} enhanceElapsed={courseElapsed} provider={provider} canEnhance={agents[provider].available} />
        <CodeWorkspace repository={repository} lesson={selectedLesson} currentFile={currentFile} content={content} line={line} workspaceMode={workspaceMode} fontBoost={fontBoosts[fontScale]} onOpen={openFile} onSelection={setSelection} onWorkspaceMode={changeWorkspaceMode} />
        <TutorPanel repository={repository} lesson={selectedLesson} skill={activeSkill} nextSkill={nextSkill} learnerState={learnerState} provider={provider} agents={agents} mode={mode} messages={messages} askMessages={askMessages} busy={agentBusy} currentFile={currentFile} selection={selection} guideStage={guideStage} onGuideStage={updateGuideStage} onWorkspaceMode={changeWorkspaceMode} onNextSkill={selectSkill} onProvider={setProvider} onMode={setMode} onAsk={ask} onSaveMemory={saveMemory} onQuizEvidence={() => updateEvidence("quiz", 0.55, `Submitted quiz answer for ${selectedLesson.title}`)} onDone={() => toggleComplete(selectedLesson)} complete={completed.has(selectedLesson.id)} practiceSession={practiceSession} practiceReport={practiceReport} practiceBusy={practiceBusy} onCreatePractice={createPractice} onInspectPractice={inspectPractice} onOpenPractice={() => { if (practiceSession) void bridge.openPractice(practiceSession.id); }} onRemovePractice={removePractice} />
      </div>
      {diagnosticOpen && <DiagnosticOverlay graph={skillGraph} onComplete={finishDiagnostic} onSkip={() => finishDiagnostic()} />}
    </div>
  );
}
