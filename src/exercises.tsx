import { useEffect, useMemo, useState } from "react";
import { Icon, bridge, readableError, repositoryRef } from "./shell";
import type { Course, Lesson, PredictionExercise, Repository, SkillGraph } from "./types";
import type { ArchitectureState, ChainState, EvaluationState, EvidenceState, HistoryState, LocalizationState, ReviewState, TraceState } from "./exercise-state";

/**
 * Exercise, visualization, and quality panels (items 26-34).
 *
 * These are loaded lazily: a learner who never opens Chains, Locate, or Review
 * never downloads them, which keeps the application entry chunk inside the
 * budget enforced by the bundle test.
 *
 * All exercise state is owned by `App` and passed in, so switching workspace
 * tabs or jumping into the editor never discards work in progress.
 */


/**
 * Cross-file call chains plus prediction exercises (item 26). The correct answer
 * lives in the main process, so a learner cannot read it out of the DOM.
 */
export function CallChainPanel({ repository, state, onState, onAnchor }: { repository: Repository; state: ChainState; onState: (update: Partial<ChainState>) => void; onAnchor: (path: string, line: number) => void }) {
  const { chains, exercises, activeChain, choice, grades, status } = state;

  useEffect(() => {
    if (status !== "idle") return;
    let active = true;
    onState({ status: "loading" });
    void bridge.callChains({ repository: repositoryRef(repository), limit: 8 })
      .then((result) => {
        if (!active) return;
        onState({
          chains: result.chains,
          exercises: result.exercises,
          activeChain: result.chains[0]?.id ?? null,
          status: result.chains.length ? "ready" : "empty",
        });
      })
      .catch(() => { if (active) onState({ status: "error" }); });
    return () => { active = false; };
  }, [onState, repository, status]);

  const chain = chains.find((candidate) => candidate.id === activeChain) ?? chains[0];
  const chainExercises = exercises.filter((exercise) => exercise.chainId === chain?.id);
  const submit = async (exercise: PredictionExercise) => {
    const selected = choice[exercise.id];
    if (!selected) return;
    const grade = await bridge.gradePrediction({ repository: repositoryRef(repository), exerciseId: exercise.id, choiceId: selected });
    onState({ grades: { ...grades, [exercise.id]: grade } });
  };

  if (status !== "ready" || !chain) {
    return <div className="call-chain-panel empty" data-status={status}>
      <Icon name="branch" size={22} />
      <h3>Cross-file call chains</h3>
      <p>{status === "error" ? "Call chains are unavailable for this repository." : status === "empty" ? "No resolved chain crosses a file boundary in this index yet." : "Deriving resolved call chains from the index…"}</p>
    </div>;
  }

  return <div className="call-chain-panel" data-status="ready" data-chains={chains.length}>
    <header><span>CROSS-FILE REASONING</span><h2>Predict the call chain</h2><p>Every option is a real symbol from this repository. Predict before you read the source.</p></header>
    <div className="chain-picker">
      {chains.map((candidate) => <button key={candidate.id} className={candidate.id === chain.id ? "active" : ""} onClick={() => onState({ activeChain: candidate.id })}>
        <strong>{candidate.summary}</strong><small>{candidate.crossFileHops} cross-file hop{candidate.crossFileHops === 1 ? "" : "s"} · {candidate.files.length} files</small>
      </button>)}
    </div>
    <ol className="chain-steps" data-summary={chain.summary}>
      {chain.steps.map((step, index) => <li key={`${step.path}-${step.symbol}-${index}`}>
        <button onClick={() => onAnchor(step.path, step.line)}>
          <span>{String(index + 1).padStart(2, "0")}</span>
          <strong>{step.symbol}()</strong>
          <small>{step.path}:{step.line}</small>
          {step.callLine && <em>calls next at :{step.callLine}</em>}
        </button>
      </li>)}
    </ol>
    {chainExercises.map((exercise) => {
      const grade = grades[exercise.id];
      return <section className="chain-exercise" key={exercise.id} data-kind={exercise.kind} data-graded={grade ? String(grade.correct) : "pending"}>
        <div className="chain-exercise-head"><span>{exercise.kind === "next-call" ? "CALL PREDICTION" : "OUTPUT PREDICTION"}</span><small>{exercise.context}</small></div>
        <h3>{exercise.prompt}</h3>
        <div className="chain-options">
          {exercise.options.map((option) => <label key={option.id} className={choice[exercise.id] === option.id ? "selected" : ""}>
            <input type="radio" name={exercise.id} checked={choice[exercise.id] === option.id} onChange={() => onState({ choice: { ...choice, [exercise.id]: option.id } })} />
            <strong>{option.label}</strong><small>{option.detail}</small>
          </label>)}
        </div>
        <div className="chain-actions">
          <button className="primary" disabled={!choice[exercise.id]} onClick={() => void submit(exercise)}>Check prediction</button>
          {grade && <button className="ghost" onClick={() => onAnchor(grade.anchor.path, grade.anchor.line)}>Open {grade.anchor.path.split("/").at(-1)}:{grade.anchor.line}</button>}
        </div>
        {grade && <div className={`chain-feedback ${grade.correct ? "correct" : "incorrect"}`}>
          <strong>{grade.correct ? "Correct" : `Not quite — the answer is ${grade.answerLabel}`}</strong>
          <p>{grade.explanation}</p>
        </div>}
      </section>;
    })}
  </div>;
}

/**
 * Dynamic execution trace (item 29). A static chain says what *could* run; this
 * runs a learner-authored snippet under a real interpreter and maps every
 * recorded event back to a repository-relative `path:line`.
 */
export function ExecutionTracePanel({ repository, state, onState, onAnchor }: { repository: Repository; state: TraceState; onState: (update: Partial<TraceState>) => void; onAnchor: (path: string, line: number) => void }) {
  const { runtimes, snippet, result, busy, error } = state;

  useEffect(() => {
    if (runtimes) return;
    let active = true;
    void bridge.traceRuntimes()
      .then((detected) => { if (active) onState({ runtimes: detected }); })
      .catch(() => { if (active) onState({ runtimes: {} }); });
    return () => { active = false; };
  }, [onState, runtimes]);

  const python = runtimes?.python;
  const run = async () => {
    onState({ busy: true, error: null });
    try {
      onState({ result: await bridge.runTrace({ repository: repositoryRef(repository), language: "python", snippet }), busy: false });
    } catch (cause) {
      onState({ error: readableError(cause), busy: false });
    }
  };

  const summary = result?.summary ?? null;
  const trace = result?.trace ?? null;
  return <section className="execution-trace" data-runtime={python?.available ? "available" : "unavailable"} data-status={trace?.status ?? "idle"}>
    <div className="trace-head">
      <span>DYNAMIC EXECUTION TRACE</span>
      <small>{python?.available ? `${python.command} · ${python.version}` : "No Python runtime detected on this machine."}</small>
    </div>
    <p className="trace-note">Trace runs this snippet in the repository root and records only the frames that belong to this repository. It never runs anything you did not type.</p>
    {result?.suggestions?.length ? <div className="trace-suggestions">
      {result.suggestions.map((suggestion) => <button key={suggestion.path} onClick={() => onState({ snippet: suggestion.snippet })}>{suggestion.module}</button>)}
    </div> : null}
    <textarea className="trace-snippet" value={snippet} onChange={(event) => onState({ snippet: event.target.value })} placeholder={"from package.module import entry\nprint(entry(1))"} />
    <div className="trace-actions">
      <button className="primary" disabled={busy || !snippet.trim()} onClick={() => void run()}>{busy ? "Running…" : "Run and trace"}</button>
      {trace?.durationMs !== undefined && <small>{trace.durationMs} ms · exit {trace.exitCode}</small>}
    </div>
    {error && <div className="error-banner">{error}</div>}
    {trace && trace.status !== "ok" && <div className="trace-problem" data-status={trace.status}>
      <strong>{trace.status === "unavailable" ? "Runtime unavailable" : trace.status === "timeout" ? "Run timed out" : trace.status === "error" ? "The snippet raised" : "Run failed"}</strong>
      <pre>{trace.reason ?? trace.error ?? trace.stderr ?? ""}</pre>
    </div>}
    {trace?.stdout ? <pre className="trace-stdout">{trace.stdout}</pre> : null}
    {summary && <div className="trace-summary">
      <div className="score-metrics">
        <div><em data-trace-metric="calls">{summary.callCount}</em><small>calls recorded</small></div>
        <div><em data-trace-metric="files">{summary.files.length}</em><small>files entered</small></div>
        <div><em data-trace-metric="confirmed">{summary.confirmedStaticEdges}</em><small>static edges confirmed</small></div>
        <div><em data-trace-metric="dynamic">{summary.dynamicOnlyEdges}</em><small>dynamic-only edges</small></div>
      </div>
      <ol className="trace-transitions">
        {summary.transitions.slice(0, 10).map((transition) => <li key={`${transition.from.path}-${transition.from.name}-${transition.to.path}-${transition.to.name}`} data-static={String(transition.inStaticGraph)}>
          <button onClick={() => onAnchor(transition.to.path, transition.to.line)}>
            <strong>{transition.from.name}() → {transition.to.name}()</strong>
            <small>{transition.to.path}:{transition.to.line}</small>
            <em>{transition.inStaticGraph ? "in static graph" : "dynamic only"}</em>
          </button>
        </li>)}
      </ol>
      {summary.returnValues.length > 0 && <div className="trace-returns">
        <strong>Observed return values</strong>
        {summary.returnValues.slice(-5).map((entry, index) => <code key={`${entry.path}-${entry.line}-${index}`}>{entry.function} → {entry.value}</code>)}
      </div>}
    </div>}
  </section>;
}

/**
 * Architecture view (item 30): module boundaries, layers, import cycles, and the
 * callers/callees/data flow of the symbol the learner is reading.
 */
export function ArchitecturePanel({ repository, currentFile, symbol, state, onState, onAnchor }: {
  repository: Repository;
  currentFile: string | null;
  symbol: { path: string; name: string; line: number } | null;
  state: ArchitectureState;
  onState: (update: Partial<ArchitectureState>) => void;
  onAnchor: (path: string, line: number) => void;
}) {
  const { architecture, flow, status, activeModule } = state;

  useEffect(() => {
    if (status !== "idle") return;
    let active = true;
    onState({ status: "loading" });
    void bridge.architecture({ repository: repositoryRef(repository), moduleDepth: 2 })
      .then((result) => { if (active) onState({ architecture: result, status: "ready" }); })
      .catch(() => { if (active) onState({ status: "error" }); });
    return () => { active = false; };
  }, [onState, repository, status]);

  useEffect(() => {
    if (!symbol) return;
    let active = true;
    void bridge.symbolFlow({ repository: repositoryRef(repository), path: symbol.path, symbol: symbol.name, line: symbol.line })
      .then((result) => { if (active) onState({ flow: result }); })
      .catch(() => { if (active) onState({ flow: null }); });
    return () => { active = false; };
  }, [onState, repository, symbol]);

  if (status !== "ready" || !architecture) {
    return <section className="architecture-panel empty" data-status={status}>
      <Icon name="layers" size={22} />
      <p>{status === "error" ? "The architecture view is unavailable for this repository." : "Aggregating module boundaries…"}</p>
    </section>;
  }

  const modulesById = new Map(architecture.modules.map((entry) => [entry.id, entry]));
  return <section className="architecture-panel" data-status="ready" data-layers={architecture.stats.layerCount} data-cycles={architecture.stats.cycleCount}>
    <div className="architecture-head">
      <span>ARCHITECTURE</span>
      <strong>{architecture.stats.moduleCount} modules · {architecture.stats.layerCount} layers · {architecture.stats.edgeCount} module imports</strong>
      <small data-acyclic={String(architecture.stats.acyclic)}>{architecture.stats.acyclic ? "No import cycles" : `${architecture.stats.cycleCount} import cycle${architecture.stats.cycleCount === 1 ? "" : "s"}`}</small>
    </div>
    <div className="layer-grid">
      {architecture.layers.map((layer) => <div className="layer-column" key={layer.layer} data-layer={layer.layer}>
        <header>Layer {layer.layer}<em>{layer.modules.length}</em></header>
        {layer.modules.slice(0, 8).map((id) => {
          const entry = modulesById.get(id);
          return <button
            key={id}
            className={`module-card ${activeModule === id ? "active" : ""} ${entry?.cycleId ? "cyclic" : ""}`}
            data-module={id}
            onClick={() => onState({ activeModule: activeModule === id ? null : id })}
          >
            <strong>{id}</strong>
            <small>{entry?.files ?? 0} files · in {entry?.fanIn ?? 0} / out {entry?.fanOut ?? 0}</small>
            {entry?.external.length ? <em>{entry.external.slice(0, 3).join(", ")}</em> : null}
          </button>;
        })}
      </div>)}
    </div>
    {activeModule && <div className="module-detail" data-module={activeModule}>
      <strong>{activeModule}</strong>
      <div className="module-edges">
        {architecture.edges.filter((edge) => edge.from === activeModule).slice(0, 6).map((edge) => <button key={`out-${edge.to}`} onClick={() => onAnchor(edge.examples[0].path, edge.examples[0].line)}>→ {edge.to} <small>{edge.weight}</small></button>)}
        {architecture.edges.filter((edge) => edge.to === activeModule).slice(0, 6).map((edge) => <button key={`in-${edge.from}`} onClick={() => onAnchor(edge.examples[0].path, edge.examples[0].line)}>← {edge.from} <small>{edge.weight}</small></button>)}
      </div>
    </div>}
    {architecture.violations.length > 0 && <div className="boundary-violations" data-count={architecture.violations.length}>
      <strong>Boundary findings</strong>
      {architecture.violations.slice(0, 5).map((violation) => <button key={`${violation.from}-${violation.to}`} data-kind={violation.kind} onClick={() => onAnchor(violation.examples[0].path, violation.examples[0].line)}>
        <em>{violation.kind}</em>{violation.detail}
      </button>)}
    </div>}
    {flow && <div className="symbol-flow" data-symbol={flow.target.symbol}>
      <div className="flow-head"><strong>{flow.target.symbol}()</strong><small>{flow.definition.path}:{flow.definition.line}</small><em>in {flow.fanIn} / out {flow.fanOut}</em></div>
      <div className="flow-columns">
        <div className="flow-column" data-column="callers">
          <header>Callers</header>
          {flow.callers.length === 0 && <p>No resolved caller in this index.</p>}
          {flow.callers.slice(0, 6).map((caller) => <button key={`${caller.path}-${caller.line}`} onClick={() => onAnchor(caller.path, caller.line)}>{caller.symbol}()<small>{caller.path}:{caller.line}</small></button>)}
        </div>
        <div className="flow-column" data-column="callees">
          <header>Callees</header>
          {flow.callees.length === 0 && <p>This function calls nothing that resolves inside the repository.</p>}
          {flow.callees.slice(0, 6).map((callee) => <button key={`${callee.path}-${callee.symbol}`} onClick={() => onAnchor(callee.path, callee.line)}>{callee.symbol}()<small>{callee.path}:{callee.line}</small></button>)}
        </div>
        <div className="flow-column" data-column="dataflow">
          <header>Data flow</header>
          {flow.flow?.parameters.length ? flow.flow.parameters.map((parameter) => <span key={parameter.name} className={parameter.reachesReturn ? "reaches" : "stops"} data-parameter={parameter.name}>{parameter.name}<small>{parameter.reachesReturn ? "reaches return" : "does not reach return"}</small></span>) : <p>No parameters to follow.</p>}
          {flow.flow?.steps.slice(0, 4).map((step) => <button key={step.line} onClick={() => onAnchor(flow.definition.path, step.line)}><code>{step.target} ← {step.expression.slice(0, 46)}</code><small>:{step.line}</small></button>)}
        </div>
      </div>
    </div>}
    {!flow && currentFile && <p className="architecture-hint">Open a file with an indexed symbol to see its callers, callees, and data flow.</p>}
  </section>;
}

/**
 * Repository history (item 31): ownership, evolution, regressions, and the
 * commits that explain a design decision — all read from real `git log` output.
 */
export function HistoryPanel({ repository, state, onState, onAnchor, onLesson }: {
  repository: Repository;
  state: HistoryState;
  onState: (update: Partial<HistoryState>) => void;
  onAnchor: (path: string, line: number) => void;
  onLesson: (lesson: Lesson) => void;
}) {
  const { summary, lessons, status, view } = state;

  useEffect(() => {
    if (status !== "idle") return;
    let active = true;
    onState({ status: "loading" });
    void bridge.history({ repository: repositoryRef(repository), commits: 400 })
      .then((result) => { if (active) onState({ summary: result.summary, lessons: result.lessons, status: "ready" }); })
      .catch(() => { if (active) onState({ status: "error" }); });
    return () => { active = false; };
  }, [onState, repository, status]);

  if (status !== "ready" || !summary) {
    return <section className="history-panel empty" data-status={status}>
      <Icon name="git" size={22} />
      <p>{status === "error" ? "Repository history is unavailable." : "Reading git history…"}</p>
    </section>;
  }
  if (!summary.available) {
    return <section className="history-panel empty" data-status="unavailable">
      <Icon name="git" size={22} />
      <p data-reason="no-history">{summary.reason}</p>
    </section>;
  }

  const views: Array<HistoryState["view"]> = ["ownership", "evolution", "regressions", "decisions"];
  return <section className="history-panel" data-status="ready" data-commits={summary.commitCount} data-view={view}>
    <div className="history-head">
      <span>REPOSITORY HISTORY</span>
      <strong>{summary.commitCount.toLocaleString()} commits · {summary.authorCount} authors · bus factor {summary.repositoryBusFactor}</strong>
      <small>{summary.since?.slice(0, 10)} → {summary.until?.slice(0, 10)}{summary.truncated ? " (most recent)" : ""}</small>
    </div>
    <div className="history-tabs">
      {views.map((candidate) => <button key={candidate} className={view === candidate ? "active" : ""} onClick={() => onState({ view: candidate })}>{candidate}</button>)}
    </div>
    {view === "ownership" && <div className="history-list" data-list="ownership">
      {summary.ownership?.files.slice(0, 6).map((entry) => <div key={entry.key} className="ownership-row" data-file={entry.key}>
        <button onClick={() => onAnchor(entry.key, 1)}><code>{entry.key}</code></button>
        <div className="ownership-bar" title={`${entry.authorCount} authors`}>
          {entry.authors.slice(0, 3).map((author) => <span key={author.name} style={{ width: `${Math.max(6, author.share * 100)}%` }} title={`${author.name} · ${Math.round(author.share * 100)}%`} />)}
        </div>
        <small data-bus-factor={entry.busFactor}>{entry.authors[0]?.name} {Math.round(entry.topAuthorShare * 100)}% · bus {entry.busFactor}</small>
      </div>)}
    </div>}
    {view === "evolution" && <div className="history-list" data-list="evolution">
      <div className="churn-chart">
        {summary.evolution?.buckets.slice(-18).map((bucket) => <span key={bucket.month} title={`${bucket.month}: ${bucket.commits} commits`} style={{ height: `${Math.max(4, (bucket.commits / Math.max(...(summary.evolution?.buckets ?? []).map((item) => item.commits))) * 46)}px` }} />)}
      </div>
      {summary.evolution?.hotFiles.slice(0, 6).map((entry) => <button key={entry.path} className="hot-file" onClick={() => onAnchor(entry.path, 1)}>
        <code>{entry.path}</code><small>{entry.commits} commits · {entry.lines} lines · {entry.lastChange.slice(0, 10)}</small>
      </button>)}
    </div>}
    {view === "regressions" && <div className="history-list" data-list="regressions">
      <p className="history-note" data-fix-ratio={summary.regressions?.fixRatio}>{summary.regressions?.fixCommits} fix commits ({Math.round((summary.regressions?.fixRatio ?? 0) * 100)}% of history) and {summary.regressions?.revertCommits} reverts.</p>
      {summary.regressions?.hotspots.slice(0, 6).map((entry) => <button key={entry.path} className="hotspot" data-fixes={entry.fixes} onClick={() => onAnchor(entry.path, 1)}>
        <code>{entry.path}</code><small>{entry.fixes} fixes · last {entry.lastFix.slice(0, 10)}</small>
        <em>{entry.examples[0]?.subject}</em>
      </button>)}
    </div>}
    {view === "decisions" && <div className="history-list" data-list="decisions">
      {summary.decisions?.slice(0, 5).map((decision) => <div key={decision.hash} className="decision" data-reason={decision.reason}>
        <strong>{decision.subject}</strong>
        <small>{decision.hash} · {decision.author} · {decision.date.slice(0, 10)}</small>
        {decision.excerpt && <p>{decision.excerpt}</p>}
        <div className="decision-files">{decision.files.slice(0, 4).map((filePath) => <button key={filePath} onClick={() => onAnchor(filePath, 1)}>{filePath.split("/").at(-1)}</button>)}</div>
      </div>)}
    </div>}
    {lessons.length > 0 && <div className="history-lessons">
      <strong>History lessons</strong>
      {lessons.map((lesson) => <button key={lesson.id} data-lesson={lesson.id} onClick={() => onLesson(lesson)}>{lesson.title}<small>{lesson.duration} min</small></button>)}
    </div>}
  </section>;
}

/**
 * Imported evidence (item 32): the pull requests, issues, ADRs, docs, and tests
 * that already explain this repository, linked to the files they describe.
 */
export function EvidencePanel({ repository, skillGraph, currentFile, state, onState, onAnchor }: {
  repository: Repository;
  skillGraph: SkillGraph | null;
  currentFile: string | null;
  state: EvidenceState;
  onState: (update: Partial<EvidenceState>) => void;
  onAnchor: (path: string, line: number) => void;
}) {
  const { evidence, status, kind, onlyCurrentFile } = state;

  useEffect(() => {
    if (status !== "idle") return;
    let active = true;
    onState({ status: "loading" });
    void bridge.importEvidence({ repository: repositoryRef(repository), commits: 300, skillGraph: skillGraph ?? undefined })
      .then((result) => { if (active) onState({ evidence: result, status: "ready" }); })
      .catch(() => { if (active) onState({ status: "error" }); });
    return () => { active = false; };
  }, [onState, repository, skillGraph, status]);

  if (status !== "ready" || !evidence) {
    return <section className="evidence-panel empty" data-status={status}>
      <Icon name="book" size={22} />
      <p>{status === "error" ? "Evidence import is unavailable for this repository." : "Importing documentation, decisions, and tests…"}</p>
    </section>;
  }

  const kinds = ["all", "pull-request", "issue", "adr", "doc", "test"] as const;
  const visible = evidence.items
    .filter((item) => kind === "all" || item.kind === kind)
    .filter((item) => !onlyCurrentFile || !currentFile || item.anchors.some((anchor) => anchor.path === currentFile) || item.paths.includes(currentFile))
    .slice(0, 12);

  return <section className="evidence-panel" data-status="ready" data-total={evidence.stats.total} data-linked={evidence.stats.linked}>
    <div className="evidence-head">
      <span>IMPORTED EVIDENCE</span>
      <strong>{evidence.stats.total} items · {Math.round(evidence.stats.coverage * 100)}% linked to source</strong>
      <small>{Object.entries(evidence.stats.byKind).map(([name, count]) => `${name} ${count}`).join(" · ") || "nothing imported"}</small>
    </div>
    {evidence.sources.unavailable.length > 0 && <p className="evidence-unavailable">Not available offline: {evidence.sources.unavailable.join(", ")}.</p>}
    <div className="evidence-tabs">
      {kinds.map((candidate) => <button key={candidate} className={kind === candidate ? "active" : ""} data-kind={candidate} onClick={() => onState({ kind: candidate })}>{candidate}</button>)}
      <label className="evidence-filter"><input type="checkbox" checked={onlyCurrentFile} onChange={() => onState({ onlyCurrentFile: !onlyCurrentFile })} />this file only</label>
    </div>
    <div className="evidence-list">
      {visible.length === 0 && <p className="evidence-empty">No imported evidence matches this filter.</p>}
      {visible.map((item) => <div className="evidence-item" key={item.id} data-kind={item.kind} data-confidence={item.confidence}>
        <div className="evidence-item-head"><em>{item.kind}</em><strong>{item.title}</strong><small>{item.reference}</small></div>
        <p>{item.summary}</p>
        <div className="evidence-anchors">
          {item.anchors.slice(0, 4).map((anchor) => <button key={`${anchor.path}-${anchor.line}`} onClick={() => onAnchor(anchor.path, anchor.line)}>{anchor.path.split("/").at(-1)}:{anchor.line}</button>)}
          {(item.symbols ?? []).slice(0, 3).map((symbol) => <button key={`${symbol.path}-${symbol.name}`} className="symbol" onClick={() => onAnchor(symbol.path, symbol.line)}>{symbol.name}()</button>)}
        </div>
      </div>)}
    </div>
  </section>;
}

/**
 * Quality scorecards (item 34). Retrieval, tutor answers, and lessons are shown
 * side by side and never averaged: they fail for different reasons.
 */
export function EvaluationPanel({ repository, course, skillGraph, state, onState, onAnchor }: {
  repository: Repository;
  course: Course | null;
  skillGraph: SkillGraph | null;
  state: EvaluationState;
  onState: (update: Partial<EvaluationState>) => void;
  onAnchor: (path: string, line: number) => void;
}) {
  const { report, status } = state;
  const run = async () => {
    onState({ status: "loading" });
    try {
      onState({
        report: await bridge.evaluate({
          repository: repositoryRef(repository),
          course: course ?? undefined,
          skillGraph: skillGraph ?? undefined,
          sampleSize: 12,
        }),
        status: "ready",
      });
    } catch {
      onState({ status: "error" });
    }
  };

  return <section className="evaluation-panel" data-status={status}>
    <div className="evaluation-head">
      <span>QUALITY SCORECARDS</span>
      <button className="ghost" disabled={status === "loading"} onClick={() => void run()}>{status === "loading" ? "Evaluating…" : report ? "Re-run evaluation" : "Run evaluation"}</button>
    </div>
    {status === "error" && <p className="evaluation-note">Evaluation is unavailable for this repository.</p>}
    {!report && status !== "loading" && <p className="evaluation-note">Retrieval, tutor answers, and lessons are measured separately, never averaged into one number.</p>}
    {report && <div className="scorecards">
      {report.retrieval && <div className="scorecard" data-card="retrieval">
        <header>Retrieval<small>{report.retrieval.cases} gold cases</small></header>
        <div className="scorecard-metrics">
          <div><em data-metric="recall1">{Math.round(report.retrieval.recallAt1 * 100)}%</em><small>recall@1</small></div>
          <div><em data-metric="recall5">{Math.round(report.retrieval.recallAt5 * 100)}%</em><small>recall@5</small></div>
          <div><em data-metric="mrr">{report.retrieval.mrr.toFixed(2)}</em><small>MRR</small></div>
          <div><em data-metric="ndcg">{report.retrieval.ndcgAt5.toFixed(2)}</em><small>nDCG@5</small></div>
        </div>
        <small className="scorecard-note">{report.retrieval.medianLatencyMs} ms median · {report.retrieval.falsePositiveQueries} nonsense queries returned results</small>
        {report.retrieval.missed.length > 0 && <div className="scorecard-misses">{report.retrieval.missed.slice(0, 3).map((miss) => <button key={miss.query} onClick={() => onAnchor(miss.goldPath, 1)}>{miss.query}</button>)}</div>}
      </div>}
      {report.lessons && <div className="scorecard" data-card="lessons" data-verdict={report.lessons.verdict}>
        <header>Lessons<small>{report.lessons.lessons} lessons · {report.lessons.anchors} anchors</small></header>
        <div className="scorecard-metrics">
          <div><em data-metric="anchors">{Math.round(report.lessons.anchorValidity * 100)}%</em><small>anchors valid</small></div>
          <div><em data-metric="symbols">{Math.round(report.lessons.symbolAccuracy * 100)}%</em><small>symbols exact</small></div>
          <div><em data-metric="quiz">{Math.round(report.lessons.quizCoverage * 100)}%</em><small>quiz coverage</small></div>
          <div><em data-metric="entry">{Math.round(report.lessons.entryPointCoverage * 100)}%</em><small>entry points</small></div>
        </div>
        <small className="scorecard-note">{report.lessons.difficultyInversions} difficulty inversions · verdict {report.lessons.verdict}</small>
        {report.lessons.danglingAnchors.length > 0 && <div className="scorecard-misses">{report.lessons.danglingAnchors.slice(0, 3).map((anchor) => <button key={`${anchor.lessonId}-${anchor.path}`}>{anchor.path}</button>)}</div>}
      </div>}
      <div className="scorecard" data-card="tutor">
        <header>Tutor answers<small>{report.tutor ? `${report.tutor.answers} graded` : "no answers yet"}</small></header>
        {report.tutor ? <>
          <div className="scorecard-metrics">
            <div><em data-metric="grounding">{Math.round(report.tutor.grounding * 100)}%</em><small>citations valid</small></div>
            <div><em data-metric="precision">{Math.round(report.tutor.symbolPrecision * 100)}%</em><small>symbols real</small></div>
            <div><em data-metric="faithful">{Math.round(report.tutor.faithfulness * 100)}%</em><small>context used</small></div>
            <div><em data-metric="unverifiable">{report.tutor.unverifiable}</em><small>unverifiable</small></div>
          </div>
        </> : <p className="evaluation-note">Ask the tutor a question, then re-run to grade its grounding.</p>}
      </div>
    </div>}
  </section>;
}

/**
 * Localization exercise (item 27). The gold file set never reaches the renderer
 * before submission, and the score separates coverage from navigation efficiency
 * so a learner who opens every file cannot pass by brute force.
 */
export function LocalizationPanel({ repository, trail, state, onState, onOpen }: { repository: Repository; trail: string[]; state: LocalizationState; onState: (update: Partial<LocalizationState>) => void; onOpen: (path: string) => void }) {
  const { exercise, trailStart, selected, hints, score, error } = state;
  const [query, setQuery] = useState("");

  const inspected = useMemo(() => [...new Set(trail.slice(trailStart))], [trail, trailStart]);
  const start = async () => {
    try {
      const next = await bridge.localizationExercise({ repository: repositoryRef(repository) });
      onState({ exercise: next, trailStart: trail.length, selected: [], hints: [], score: null, error: null });
    } catch (cause) {
      onState({ error: readableError(cause) });
    }
  };
  const revealHint = async () => {
    if (!exercise) return;
    const hint = await bridge.localizationHint({ repository: repositoryRef(repository), exerciseId: exercise.id, used: hints.map((item) => item.id) });
    if (hint) onState({ hints: [...hints, hint] });
  };
  const submit = async () => {
    if (!exercise) return;
    onState({ score: await bridge.scoreLocalization({
      repository: repositoryRef(repository),
      exerciseId: exercise.id,
      inspected,
      selected,
      hintsUsed: hints.map((item) => item.id),
    }) });
  };
  const toggle = (filePath: string) => onState({ selected: selected.includes(filePath) ? selected.filter((item) => item !== filePath) : [...selected, filePath] });
  const searchResults = query.trim()
    ? repository.files.filter((file) => file.path.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8)
    : [];

  if (!exercise) {
    return <div className="localization-panel empty">
      <Icon name="search" size={22} />
      <h3>Localization drill</h3>
      <p>Practice finding the right files fast. Trace measures how much of the repository you had to read, not only whether you found the answer.</p>
      <button className="primary" onClick={() => void start()}>Start localization exercise</button>
      {error && <div className="error-banner">{error}</div>}
    </div>;
  }

  return <div className="localization-panel" data-exercise={exercise.id} data-gold={exercise.goldCount}>
    <header><span>LOCALIZATION DRILL</span><h2>Find the responsible files</h2><p className="localization-prompt">{exercise.prompt}</p>
      <small>{exercise.goldCount} relevant file{exercise.goldCount > 1 ? "s" : ""} among {exercise.repositoryFiles.toLocaleString()} indexed.</small></header>
    <div className="localization-trail">
      <strong>Files you have opened <em data-inspected={inspected.length}>{inspected.length}</em></strong>
      {inspected.length === 0 && <p>Open files from the explorer or search below; every file you read counts toward your efficiency score.</p>}
      {inspected.map((filePath) => <label key={filePath} className={selected.includes(filePath) ? "selected" : ""}>
        <input type="checkbox" checked={selected.includes(filePath)} onChange={() => toggle(filePath)} />
        <code>{filePath}</code>
      </label>)}
    </div>
    <label className="localization-search"><Icon name="search" size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search for a file to open or select" /></label>
    {searchResults.length > 0 && <div className="localization-results">
      {searchResults.map((file) => <div key={file.path}>
        <code>{file.path}</code>
        <button onClick={() => onOpen(file.path)}>Open</button>
        <button onClick={() => toggle(file.path)}>{selected.includes(file.path) ? "Unselect" : "Select"}</button>
      </div>)}
    </div>}
    <div className="localization-actions">
      <button className="ghost" disabled={hints.length >= exercise.hints.length} onClick={() => void revealHint()}>Reveal a hint ({hints.length}/{exercise.hints.length})</button>
      <button className="primary" disabled={!selected.length} onClick={() => void submit()}>Submit {selected.length} file{selected.length === 1 ? "" : "s"}</button>
    </div>
    {hints.map((hint) => <div className="localization-hint" key={hint.id}><Icon name="spark" size={12} /><span>{hint.text}</span><em>-{Math.round(hint.cost * 100)}%</em></div>)}
    {score && <div className="localization-score" data-grade={score.grade} data-passed={String(score.passed)}>
      <div className="score-headline"><strong>{Math.round(score.score * 100)}%</strong><span>{score.grade}</span></div>
      <div className="score-metrics">
        <div><em data-metric="coverage">{Math.round(score.coverage * 100)}%</em><small>coverage</small></div>
        <div><em data-metric="precision">{Math.round(score.precision * 100)}%</em><small>precision</small></div>
        <div><em data-metric="file-efficiency">{Math.round(score.fileEfficiency * 100)}%</em><small>file efficiency</small></div>
        <div><em data-metric="byte-efficiency">{Math.round(score.byteEfficiency * 100)}%</em><small>context efficiency</small></div>
      </div>
      <p>You read {score.inspectedCount} file{score.inspectedCount === 1 ? "" : "s"} ({(score.inspectedBytes / 1024).toFixed(1)} kB) for an optimal set of {score.optimalCount}; {score.wastedInspections} were irrelevant{score.firstHitRank ? `, and your first relevant file was #${score.firstHitRank}` : ""}.</p>
      {score.missed.length > 0 && <div className="score-missed"><strong>Missed</strong>{score.missed.map((filePath) => <button key={filePath} onClick={() => onOpen(filePath)}>{filePath}</button>)}</div>}
      {score.falsePositives.length > 0 && <div className="score-extra"><strong>Not relevant</strong>{score.falsePositives.map((filePath) => <code key={filePath}>{filePath}</code>)}</div>}
      <button className="ghost" onClick={() => void start()}>Try another drill</button>
    </div>}
  </div>;
}

/**
 * RACE-style review (item 28): understanding, localization, and plan are graded
 * as three separate stages so a learner sees exactly which one is weak.
 */
export function ReviewPanel({ repository, trail, state, onState, onOpen }: { repository: Repository; trail: string[]; state: ReviewState; onState: (update: Partial<ReviewState>) => void; onOpen: (path: string) => void }) {
  const { task, understanding, plan, files, report, error } = state;
  const start = async () => {
    try {
      const next = await bridge.raceTask({ repository: repositoryRef(repository) });
      onState({ task: next, report: null, error: null });
    } catch (cause) {
      onState({ error: readableError(cause) });
    }
  };
  const submit = async () => {
    if (!task) return;
    onState({ report: await bridge.gradeRace({
      repository: repositoryRef(repository),
      taskId: task.id,
      understanding,
      plan,
      files,
      inspected: [...new Set(trail)],
    }) });
  };
  const toggleFile = (filePath: string) => onState({ files: files.includes(filePath) ? files.filter((item) => item !== filePath) : [...files, filePath] });

  if (!task) {
    return <div className="review-panel empty">
      <Icon name="target" size={22} />
      <h3>Graded review</h3>
      <p>Restate the issue, localize it, and plan the fix. Each stage is graded on its own rubric, built from this repository&rsquo;s source.</p>
      <button className="primary" onClick={() => void start()}>Start graded review</button>
      {error && <div className="error-banner">{error}</div>}
    </div>;
  }

  const stageOrder: Array<"understanding" | "localization" | "plan"> = ["understanding", "localization", "plan"];
  return <div className="review-panel" data-task={task.id}>
    <header><span>GRADED REVIEW &middot; RACE</span><h2>Three stages, three rubrics</h2><p className="review-issue">{task.issue}</p></header>
    <section className="review-stage" data-stage="understanding">
      <h3>1 &middot; Understanding <em>{Math.round((task.weights.understanding ?? 0) * 100)}%</em></h3>
      <textarea value={understanding} onChange={(event) => onState({ understanding: event.target.value })} placeholder="Restate the defect using the repository's own names: the function, its file, its inputs, and who depends on it…" />
      <ul className="review-rubric">{task.rubric.understanding.map((item) => <li key={item.id} data-criterion={item.id} data-met={report ? String(report.stages.understanding.met.includes(item.id)) : "pending"}>{item.description}</li>)}</ul>
    </section>
    <section className="review-stage" data-stage="localization">
      <h3>2 &middot; Localization <em>{Math.round((task.weights.localization ?? 0) * 100)}%</em></h3>
      <p className="review-hint">Select every file that must be read or changed. Files you have opened appear first.</p>
      <div className="review-files">
        {[...new Set([...trail, ...files])].map((filePath) => <label key={filePath} className={files.includes(filePath) ? "selected" : ""}>
          <input type="checkbox" checked={files.includes(filePath)} onChange={() => toggleFile(filePath)} />
          <code>{filePath}</code>
        </label>)}
        {trail.length === 0 && <p className="review-hint">Open files from the explorer to add them here.</p>}
      </div>
    </section>
    <section className="review-stage" data-stage="plan">
      <h3>3 &middot; Plan <em>{Math.round((task.weights.plan ?? 0) * 100)}%</em></h3>
      <textarea value={plan} onChange={(event) => onState({ plan: event.target.value })} placeholder={"1. Change …\n2. Check the callers …\n3. Validate with …"} />
      <ul className="review-rubric">{task.rubric.plan.map((item) => <li key={item.id} data-criterion={item.id} data-met={report ? String(report.stages.plan.met.includes(item.id)) : "pending"}>{item.description}</li>)}</ul>
    </section>
    <div className="review-actions">
      <button className="primary" disabled={!understanding.trim() && !plan.trim() && !files.length} onClick={() => void submit()}>Grade my review</button>
      <button className="ghost" onClick={() => void start()}>Reset</button>
    </div>
    {report && <div className="review-report" data-band={report.band} data-weakest={report.weakestStage}>
      <div className="score-headline"><strong>{Math.round(report.overall * 100)}%</strong><span>{report.band}</span></div>
      <div className="score-metrics">
        {stageOrder.map((stage) => <div key={stage}>
          <em data-stage-score={stage}>{Math.round(report.stageScores[stage] * 100)}%</em>
          <small>{stage} &middot; {report.stageBands[stage]}</small>
        </div>)}
      </div>
      <p className="review-next"><strong>Weakest stage: {report.weakestStage}.</strong> {report.nextStep}</p>
      {report.stages.localization.missed.length > 0 && <div className="score-missed"><strong>Files you missed</strong>{report.stages.localization.missed.map((filePath) => <button key={filePath} onClick={() => onOpen(filePath)}>{filePath}</button>)}</div>}
    </div>}
  </div>;
}
