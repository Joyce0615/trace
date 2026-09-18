import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askAgent, detectAgents, generateCourseWithAgent } from "./agents.mjs";
import { generateStarterCourse, normalizeAgentCourse } from "./course.mjs";
import { loadCourse, saveCourse } from "./course-store.mjs";
import { DEFAULT_INDEX_LIMITS, IndexCancelledError, inspectRepository, readRepositoryFile } from "./repository.mjs";
import { createPracticeSession, getPracticeSessionPath, inspectPracticeSession, removePracticeSession } from "./practice.mjs";
import { answerFromLocalIndex, buildContextPack, loadCachedResponse, responseCacheKey, saveCachedResponse } from "./context-engine.mjs";
import { loadLearnerState, saveLearnerState } from "./learning-store.mjs";
import { buildSkillGraph, reconcileLearnerState } from "./skill-graph.mjs";
import { detectLanguageServers, resolveImportsStatically, resolveSymbol, shutdownLanguageServers } from "./language-server.mjs";
import { buildKnowledgeGraph, loadKnowledgeGraph, neighborhood, saveKnowledgeGraph } from "./knowledge-graph.mjs";
import { registerValidatedHandlers } from "./ipc-schema.mjs";
import { classifyExternalLink, confirmationPrompt, isInternalNavigation, repositoryOrigins } from "./link-policy.mjs";
import { CALL_CHAIN_VERSION, buildCallChainExercises, buildCallChains, gradeCallChainAnswer, publicExercise } from "./call-chain.mjs";
import { buildLocalizationExercise, nextHint, publicLocalizationExercise, scoreLocalization } from "./localization.mjs";
import { buildRaceTask, gradeRaceSubmission, publicRaceTask } from "./race-grader.mjs";
import { detectRuntimes, runExecutionTrace, suggestTraceSnippets, summarizeTrace } from "./execution-trace.mjs";
import { buildArchitecture, dataFlow, symbolNeighborhood } from "./architecture.mjs";
import { historyLessons, historySummary, readCommits } from "./git-history.mjs";
import { evidenceForSkills, importEvidence } from "./evidence-import.mjs";
import { buildSearchIndex, search } from "./search.mjs";
import { runEvaluation } from "./evaluation.mjs";
import { detectMisconceptions, diagnoseLearner, gradeProbe } from "./misconception.mjs";
import { applyReview, reviewPlan } from "./spaced-repetition.mjs";
import { buildExecutableQuiz, gradeSubmission, publicQuiz } from "./executable-quiz.mjs";
import { buildExplanationTask, gradeExplanation, publicExplanationTask } from "./explanation-grader.mjs";
import { buildActivitySet, gradeContrast, gradePrediction, gradeTeachBack, publicActivitySet } from "./activities.mjs";
import { applyScaffold, buildScaffold, guardResponse, nextHintRung, publicScaffold, registerAnswerSecrets } from "./answer-guard.mjs";
import { appendEvent, readEvents } from "./activity-log.mjs";
import { analyticsReport } from "./analytics.mjs";
import { EXPERIMENTS, experimentReport, settingsFor } from "./experiments.mjs";
import { goalPlan } from "./goals.mjs";
import { forgetEverything, loadExperimentState, recordObservation, setConsent } from "./experiment-store.mjs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const openedRepositories = new Map();
const knowledgeGraphs = new Map();
const indexingRequests = new Map();
const callChainSets = new Map();
const localizationExercises = new Map();
const raceTasks = new Map();
const searchIndexes = new Map();
const learnerProbes = new Map();
const executableQuizzes = new Map();
const explanationTasks = new Map();
const activitySets = new Map();
const scaffolds = new Map();

/** One key per active hint ladder, so a rung can only be served for a live task. */
function scaffoldKey(repositoryId, kind, taskId) {
  return `${repositoryId}|${kind}|${taskId}`;
}

// How many hint rungs the learner has taken per task, so a graded attempt can
// record what it cost. The main process owns this: a renderer that could report
// its own hint usage could also report none.
const hintsTaken = new Map();

// Files the learner has opened, which is what makes an activity "near" transfer.
const inspectedPaths = new Map();

function activityLogDirectory() {
  return path.join(app.getPath("userData"), "activity-log");
}

function experimentDirectory() {
  return path.join(app.getPath("userData"), "experiments");
}

/**
 * Record one experiment observation. The store refuses without consent, so a
 * caller that forgets to check the gate still cannot collect anything.
 */
async function observeExperiment(experimentId, value) {
  const state = await loadExperimentState(experimentDirectory());
  const assignment = settingsFor(experimentId, state);
  if (!assignment.enrolled) return;
  const experiment = EXPERIMENTS.find((item) => item.id === experimentId);
  await recordObservation(experimentDirectory(), { experimentId, arm: assignment.arm, metric: experiment.metric, value });
}

/**
 * Record one graded attempt for item 41's analytics.
 *
 * Awaited so the log is consistent by the time the grade is returned — appends
 * are serialized in the log itself — but `appendEvent` never throws, so
 * analytics can never fail the activity the learner just completed.
 */
function recordActivity(repository, event) {
  return appendEvent(activityLogDirectory(), repository.id, event);
}

function openedRepository(candidate) {
  const repository = candidate?.id ? openedRepositories.get(candidate.id) : null;
  if (!repository || repository.rootPath !== candidate.rootPath) throw new Error("Repository is not open in this workspace.");
  return repository;
}

// The renderer receives graph statistics eagerly and requests neighborhoods on demand,
// so a large graph never crosses the IPC boundary in one payload.
function summarizeGraph(graph) {
  return {
    format: graph.format,
    repositoryId: graph.repositoryId,
    version: graph.version,
    previousVersion: graph.previousVersion,
    generatedAt: graph.generatedAt,
    stats: graph.stats,
  };
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1580,
    height: 980,
    minWidth: 1120,
    minHeight: 720,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0b0e14",
    webPreferences: {
      preload: path.join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Nothing opens a new window; every external link goes through the policy gate.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalLink(window, url);
    return { action: "deny" };
  });

  // The renderer may only ever navigate within its own bundle or the dev server.
  window.webContents.on("will-navigate", (event, url) => {
    if (isInternalNavigation(url, process.env.VITE_DEV_SERVER_URL)) return;
    event.preventDefault();
    void openExternalLink(window, url);
  });

  window.webContents.on("will-attach-webview", (event) => event.preventDefault());

  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) window.loadURL(developmentUrl);
  else window.loadFile(path.join(currentDirectory, "..", "dist", "index.html"));
}

let lastLinkDecision = null;

/**
 * Single exit point for every outbound link. Blocked links never reach the shell,
 * and unlisted origins require an explicit confirmation showing the destination.
 */
async function openExternalLink(window, candidate) {
  const additionalOrigins = [...openedRepositories.values()].flatMap((repository) => repositoryOrigins(repository));
  const classification = classifyExternalLink(candidate, { additionalOrigins });
  lastLinkDecision = { ...classification, at: new Date().toISOString() };
  if (classification.decision === "block") return { ...classification, opened: false };
  if (classification.decision === "confirm") {
    const prompt = confirmationPrompt(classification);
    const { response } = window
      ? await dialog.showMessageBox(window, { type: "question", ...prompt })
      : await dialog.showMessageBox({ type: "question", ...prompt });
    if (response !== 1) return { ...classification, opened: false, confirmed: false };
  }
  await shell.openExternal(classification.url);
  return { ...classification, opened: true, confirmed: true };
}

/**
 * Every handler receives a payload that has already been size-, depth-, and
 * schema-validated by `registerValidatedHandlers`, so handlers assert only
 * workspace invariants (is this repository open?) rather than payload shape.
 */
const ipcHandlers = {
  "links:classify": (_event, request) => classifyExternalLink(request.url, {
    additionalOrigins: [...openedRepositories.values()].flatMap((repository) => repositoryOrigins(repository)),
  }),

  "links:open": async (event, request) => openExternalLink(BrowserWindow.fromWebContents(event.sender), request.url),

  "links:last-decision": () => lastLinkDecision,

  "repository:choose": async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose a codebase to learn",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  },

  "repository:limits": () => DEFAULT_INDEX_LIMITS,

  "repository:cancel": (_event, requestId) => {
    const controller = indexingRequests.get(requestId);
    if (!controller) return false;
    controller.abort();
    indexingRequests.delete(requestId);
    return true;
  },

  "repository:open": async (event, request) => {
    const repositoriesDirectory = path.join(app.getPath("userData"), "repositories");
    const courseDirectory = path.join(app.getPath("userData"), "courses");
    const requestId = request.requestId ?? `index-${Date.now()}`;
    const controller = new AbortController();
    indexingRequests.set(requestId, controller);
    const sender = event.sender;
    const onProgress = (progress) => {
      if (!sender.isDestroyed()) sender.send("repository:progress", { requestId, ...progress });
    };
    let repository;
    try {
      repository = await inspectRepository(request.source, repositoriesDirectory, {
        signal: controller.signal,
        onProgress,
        limits: request.limits,
      });
    } catch (cause) {
      if (cause instanceof IndexCancelledError || cause?.cancelled) {
        onProgress({ phase: "cancelled", completed: 0, total: 1, ratio: 0, message: "Indexing cancelled." });
        const error = new Error("Repository indexing was cancelled.");
        error.cancelled = true;
        throw error;
      }
      throw cause;
    } finally {
      indexingRequests.delete(requestId);
    }
    openedRepositories.set(repository.id, repository);
    const course = await loadCourse(courseDirectory, repository, request.profile)
      ?? generateStarterCourse(repository, request.profile);
    const skillGraph = buildSkillGraph(repository, course);
    const savedState = await loadLearnerState(path.join(app.getPath("userData"), "learning"), repository.id);
    const learnerState = reconcileLearnerState(repository, skillGraph, savedState);
    const graphDirectory = path.join(app.getPath("userData"), "knowledge-graphs");
    const previousGraph = await loadKnowledgeGraph(graphDirectory, repository.id);
    const knowledgeGraph = buildKnowledgeGraph(repository, { previous: previousGraph });
    knowledgeGraphs.set(repository.id, knowledgeGraph);
    await saveKnowledgeGraph(graphDirectory, knowledgeGraph);
    return { repository, course, skillGraph, learnerState, knowledgeGraph: summarizeGraph(knowledgeGraph) };
  },

  "repository:read-file": async (_event, request) => {
    const repository = [...openedRepositories.values()].find((candidate) => candidate.rootPath === request.rootPath);
    if (!repository) throw new Error("Repository is not open in this workspace.");
    // Opening a file is what makes later work in it "near" transfer (item 41).
    if (!inspectedPaths.has(repository.id)) inspectedPaths.set(repository.id, new Set());
    inspectedPaths.get(repository.id).add(request.filePath);
    return readRepositoryFile(request.rootPath, request.filePath);
  },

  "graph:summary": (_event, request) => {
    const repository = openedRepository(request.repository);
    const graph = knowledgeGraphs.get(repository.id);
    if (!graph) throw new Error("The knowledge graph is not built for this repository.");
    return summarizeGraph(graph);
  },

  "graph:neighborhood": (_event, request) => {
    const repository = openedRepository(request.repository);
    const graph = knowledgeGraphs.get(repository.id);
    if (!graph) throw new Error("The knowledge graph is not built for this repository.");
    const result = neighborhood(graph, request.nodeId, request.depth ?? 1, request.edgeKinds?.length ? request.edgeKinds : null);
    return { ...result, nodes: result.nodes.slice(0, 400), edges: result.edges.slice(0, 800) };
  },

  "agents:detect": () => detectAgents(),

  "index:language-servers": () => detectLanguageServers(),

  "index:resolve": async (_event, request) => {
    const repository = openedRepository(request.repository);
    const file = repository.files.find((candidate) => candidate.path === request.path);
    if (!file) throw new Error("That file is not part of the indexed repository.");
    const staticImports = resolveImportsStatically(
      repository,
      (repository.imports ?? []).filter((item) => item.path === request.path),
    );
    const line = request.line ?? 1;
    const column = request.column ?? 1;
    const resolution = await resolveSymbol(repository.rootPath, { path: request.path, line, column, language: file.language });
    const staticDefinitions = repository.symbols
      .filter((symbol) => symbol.name === request.symbol)
      .map((symbol) => ({ path: symbol.path, line: symbol.line, column: 1 }));
    return {
      path: request.path,
      line,
      column,
      language: file.language,
      imports: staticImports,
      languageServer: resolution,
      // The static index always answers, so resolution degrades instead of failing.
      definitions: resolution.available && resolution.definitions.length ? resolution.definitions : staticDefinitions,
      resolvedBy: resolution.available && resolution.definitions.length ? `language-server:${resolution.server}` : "static-index",
    };
  },

  "lessons:call-chains": async (_event, request) => {
    const repository = openedRepository(request.repository);
    const chains = buildCallChains(repository, { limit: request.limit ?? 8 });
    // Only the files that actually appear in a chain are read, so output
    // prediction never turns into a whole-repository read.
    const sources = {};
    for (const filePath of [...new Set(chains.flatMap((chain) => chain.files))].slice(0, 40)) {
      try {
        sources[filePath] = await readRepositoryFile(repository.rootPath, filePath);
      } catch {
        // A file that cannot be read simply yields no output-prediction exercise.
      }
    }
    const exercises = buildCallChainExercises(repository, chains, sources);
    callChainSets.set(repository.id, new Map(exercises.map((exercise) => [exercise.id, exercise])));
    return { version: CALL_CHAIN_VERSION, chains, exercises: exercises.map(publicExercise) };
  },

  "lessons:grade-prediction": async (_event, request) => {
    const repository = openedRepository(request.repository);
    const exercise = callChainSets.get(repository.id)?.get(request.exerciseId);
    if (!exercise) throw new Error("That prediction exercise is not active for this repository.");
    const grade = gradeCallChainAnswer(exercise, request.choiceId);
    await recordActivity(repository, { kind: "call-chain", taskId: exercise.id, path: grade.anchor?.path ?? null, correct: grade.correct, score: grade.correct ? 1 : 0, hints: 0, hintPenalty: 0 });
    return grade;
  },

  "exercise:localization": (_event, request) => {
    const repository = openedRepository(request.repository);
    const exercise = buildLocalizationExercise(repository, { symbol: request.symbol });
    if (!exercise) throw new Error("This repository has no resolved cross-file caller to localize.");
    const active = localizationExercises.get(repository.id) ?? new Map();
    active.set(exercise.id, exercise);
    localizationExercises.set(repository.id, active);
    return publicLocalizationExercise(exercise);
  },

  "exercise:localization-hint": (_event, request) => {
    const repository = openedRepository(request.repository);
    const exercise = localizationExercises.get(repository.id)?.get(request.exerciseId);
    if (!exercise) throw new Error("That localization exercise is not active for this repository.");
    return nextHint(exercise, request.used ?? []);
  },

  "exercise:localization-score": async (_event, request) => {
    const repository = openedRepository(request.repository);
    const exercise = localizationExercises.get(repository.id)?.get(request.exerciseId);
    if (!exercise) throw new Error("That localization exercise is not active for this repository.");
    const score = scoreLocalization(exercise, request, repository);
    await recordActivity(repository, { kind: "localization", taskId: exercise.id, path: exercise.definition.path, symbol: exercise.symbol, correct: score.passed, score: score.score, hints: (request.hintsUsed ?? []).length, hintPenalty: score.hintPenalty ?? 0 });
    return score;
  },

  "grade:race-task": async (_event, request) => {
    const repository = openedRepository(request.repository);
    const exercise = buildLocalizationExercise(repository);
    if (!exercise) throw new Error("This repository has no resolved cross-file caller to grade against.");
    const active = localizationExercises.get(repository.id) ?? new Map();
    active.set(exercise.id, exercise);
    localizationExercises.set(repository.id, active);
    // Only the definition file is read; the rubric needs the real signature.
    const sources = {};
    try {
      sources[exercise.definition.path] = await readRepositoryFile(repository.rootPath, exercise.definition.path);
    } catch {
      // Without the source the rubric falls back to structural criteria.
    }
    const task = buildRaceTask(repository, exercise, sources);
    raceTasks.set(repository.id, task);
    return publicRaceTask(task);
  },

  "grade:race": (_event, request) => {
    const repository = openedRepository(request.repository);
    const task = raceTasks.get(repository.id);
    if (!task || task.id !== request.taskId) throw new Error("That grading task is not active for this repository.");
    return gradeRaceSubmission(task, request, repository);
  },

  "trace:runtimes": async (_event) => detectRuntimes(),

  "trace:run": async (_event, request) => {
    const repository = openedRepository(request.repository);
    // Running repository code is always learner-initiated and bounded; the
    // result carries the run status even when the snippet fails.
    const trace = await runExecutionTrace(repository, request);
    return {
      trace: { ...trace, events: (trace.events ?? []).slice(0, 500) },
      summary: trace.events?.length ? summarizeTrace(trace, repository) : null,
      suggestions: suggestTraceSnippets(repository, 4),
    };
  },

  "graph:architecture": (_event, request) => {
    const repository = openedRepository(request.repository);
    const architecture = buildArchitecture(repository, { moduleDepth: request.moduleDepth });
    // Bounded payload: the renderer draws the top of the graph and asks for more.
    return {
      ...architecture,
      modules: architecture.modules.slice(0, 60),
      edges: architecture.edges.slice(0, 200),
      violations: architecture.violations.slice(0, 40),
    };
  },

  "graph:symbol-flow": async (_event, request) => {
    const repository = openedRepository(request.repository);
    const file = repository.files.find((candidate) => candidate.path === request.path);
    if (!file) throw new Error("That file is not part of the indexed repository.");
    const definition = repository.symbols.find((symbol) => symbol.path === request.path && symbol.name === request.symbol)
      ?? { path: request.path, name: request.symbol, line: request.line ?? 1 };
    const neighborhood = symbolNeighborhood(repository, { path: request.path, symbol: request.symbol, line: definition.line });
    let flow = null;
    try {
      flow = dataFlow(await readRepositoryFile(repository.rootPath, request.path), { ...definition, symbol: request.symbol }, file.language);
    } catch {
      // A file that cannot be read still yields callers and callees.
    }
    return { ...neighborhood, definition: { path: definition.path, line: definition.line, symbol: request.symbol }, flow };
  },

  "history:summary": async (_event, request) => {
    const repository = openedRepository(request.repository);
    const summary = await historySummary(repository.rootPath, { limits: { commits: request.commits ?? 400 } });
    return { summary, lessons: historyLessons(summary, repository) };
  },

  "evidence:import": async (_event, request) => {
    const repository = openedRepository(request.repository);
    // Pull requests and issues are recovered from local history; live issue APIs
    // would need network access and credentials this app deliberately avoids.
    const history = await readCommits(repository.rootPath, { limits: { commits: request.commits ?? 300 }, includeMerges: true });
    const evidence = await importEvidence(repository, { commits: history.commits });
    return {
      ...evidence,
      bySkill: request.skillGraph?.nodes ? evidenceForSkills(evidence.items, request.skillGraph) : {},
    };
  },

  "search:query": async (_event, request) => {
    const repository = openedRepository(request.repository);
    // The index is built once per repository version and reused across queries.
    const cached = searchIndexes.get(repository.id);
    const index = cached?.sourceVersion === repository.versionId
      ? cached
      : await buildSearchIndex(repository, { read: (filePath) => readRepositoryFile(repository.rootPath, filePath) });
    searchIndexes.set(repository.id, index);
    return { ...search(index, request.query, { limit: request.limit ?? 10 }), indexStats: index.stats };
  },

  "eval:run": async (_event, request) => {
    const repository = openedRepository(request.repository);
    const cached = searchIndexes.get(repository.id);
    const index = cached?.sourceVersion === repository.versionId
      ? cached
      : await buildSearchIndex(repository, { read: (filePath) => readRepositoryFile(repository.rootPath, filePath) });
    searchIndexes.set(repository.id, index);
    return runEvaluation({
      index,
      repository,
      course: request.course ?? null,
      skillGraph: request.skillGraph ?? null,
      answers: request.answers ?? [],
      options: { retrieval: { sampleSize: request.sampleSize ?? 20 } },
    });
  },

  "learning:diagnose": (_event, request) => {
    const repository = openedRepository(request.repository);
    if (!Array.isArray(request.skillGraph?.nodes)) throw new Error("Invalid diagnosis request.");
    const diagnosis = diagnoseLearner(request.learnerState ?? {}, request.skillGraph, repository, {
      // Free text the learner just wrote is diagnosed against every skill.
      findings: request.text
        ? Object.fromEntries(request.skillGraph.nodes.map((node) => [node.id, detectMisconceptions(request.text, { source: "answer" })]))
        : {},
    });
    learnerProbes.set(repository.id, diagnosis.probes);
    return { ...diagnosis, probes: undefined };
  },

  "learning:probe": async (_event, request) => {
    const repository = openedRepository(request.repository);
    const probe = learnerProbes.get(repository.id)?.[request.probeId];
    if (!probe) throw new Error("That probe is not active for this repository.");
    const grade = gradeProbe(probe, request.choiceId);
    await recordActivity(repository, { kind: "probe", taskId: probe.id, path: probe.anchor?.path ?? null, skillId: probe.skillId, correct: grade.correct, score: grade.correct ? 1 : 0, hints: 0, hintPenalty: 0 });
    return grade;
  },

  "activity:build": async (_event, request) => {
    const repository = openedRepository(request.repository);
    // Only the files the three activities actually anchor into are read.
    const wanted = new Set();
    for (const symbol of repository.symbols ?? []) wanted.add(symbol.path);
    const sources = {};
    for (const filePath of [...wanted].slice(0, 300)) {
      try {
        sources[filePath] = await readRepositoryFile(repository.rootPath, filePath);
      } catch {
        // A file that cannot be read yields no excerpt, not a failed activity.
      }
    }
    const set = buildActivitySet(repository, sources, { symbol: request.symbol });
    activitySets.set(repository.id, set);
    // The reveal sentences are answers by construction; the numeric answers and
    // the contrast's `path:line` are covered structurally instead, because they
    // also occur as ordinary repository facts.
    registerAnswerSecrets(set.predictions.map((item) => item.reveal).filter(Boolean));
    for (const prediction of set.predictions) {
      scaffolds.set(scaffoldKey(repository.id, "prediction", prediction.id), buildScaffold("prediction", {
        answer: prediction.answer,
        anchorPath: prediction.anchor.path,
      }));
    }
    if (set.contrast.available) {
      scaffolds.set(scaffoldKey(repository.id, "contrast", set.contrast.id), buildScaffold("contrast", {
        difference: set.contrast.differences[0]?.detail ?? null,
        answer: set.contrast.answerId,
      }));
    }
    return publicActivitySet(set);
  },

  "activity:grade": async (_event, request) => {
    const repository = openedRepository(request.repository);
    const set = activitySets.get(repository.id);
    if (!set) throw new Error("No activities are active for this repository.");
    if (request.kind === "teach-back") {
      if (set.teachBack?.id !== request.id) throw new Error("That teach-back task is not active for this repository.");
      const grade = gradeTeachBack(set.teachBack, request.answer ?? "", repository);
      await recordActivity(repository, { kind: "teach-back", taskId: set.teachBack.id, path: set.teachBack.anchor.path, symbol: set.teachBack.symbol, correct: grade.passed, score: grade.score, hints: 0, hintPenalty: 0 });
      return grade;
    }
    if (request.kind === "prediction") {
      const prediction = set.predictions.find((item) => item.id === request.id);
      if (!prediction) throw new Error("That prediction is not active for this repository.");
      const outcome = gradePrediction(prediction, request.answer ?? "", request.confidence);
      await observeExperiment("tutor-context-depth", outcome.credit);
      const hints = hintsTaken.get(`${repository.id}|${prediction.id}`) ?? { count: 0, penalty: 0 };
      await recordActivity(repository, { kind: "prediction", taskId: prediction.id, path: prediction.anchor.path, correct: outcome.correct, score: outcome.credit, hints: hints.count, hintPenalty: hints.penalty, confidence: outcome.confidence });
      return outcome;
    }
    if (set.contrast?.id !== request.id) throw new Error("That contrast is not active for this repository.");
    const grade = gradeContrast(set.contrast, request.choiceId);
    const hints = hintsTaken.get(`${repository.id}|${set.contrast.id}`) ?? { count: 0, penalty: 0 };
    await recordActivity(repository, { kind: "contrast", taskId: set.contrast.id, path: grade.anchor.path, symbol: set.contrast.symbol, correct: grade.correct, score: grade.correct ? 1 : 0, hints: hints.count, hintPenalty: hints.penalty });
    return grade;
  },

  "explain:task": async (_event, request) => {
    const repository = openedRepository(request.repository);
    // The trace runs now, but the learner explains first: the recorded behavior
    // is the answer key and is only revealed by grading.
    const trace = await runExecutionTrace(repository, request);
    if (!trace.events?.length) {
      return { available: false, version: 1, reason: trace.reason ?? trace.error ?? `The run produced no trace (${trace.status}).`, traceStatus: trace.status };
    }
    const task = buildExplanationTask(repository, summarizeTrace(trace, repository));
    if (!task.available) return publicExplanationTask(task);
    explanationTasks.set(repository.id, task);
    // Only the observed result is registered as a value: the function names are
    // ordinary index data that other channels legitimately return.
    registerAnswerSecrets([task.observed.returnValue?.value].filter(Boolean));
    scaffolds.set(scaffoldKey(repository.id, "explanation", task.id), buildScaffold("explanation", {
      functionCount: task.observed.functions.length,
      maxDepth: task.observed.maxDepth,
      entryPath: task.entry.path,
      answer: task.observed.returnValue?.value ?? null,
    }));
    return publicExplanationTask(task);
  },

  "explain:grade": async (_event, request) => {
    const repository = openedRepository(request.repository);
    const task = explanationTasks.get(repository.id);
    if (!task || task.id !== request.taskId) throw new Error("That explanation task is not active for this repository.");
    const grade = gradeExplanation(task, request.explanation, repository);
    const hints = hintsTaken.get(`${repository.id}|${task.id}`) ?? { count: 0, penalty: 0 };
    await recordActivity(repository, { kind: "explanation", taskId: task.id, path: task.entry.path, symbol: task.entry.name, correct: grade.score >= 0.65, score: grade.score, hints: hints.count, hintPenalty: hints.penalty });
    return grade;
  },

  "goals:plan": async (_event, request) => {
    const repository = openedRepository(request.repository);
    // Only indexed files are scanned, largest-importance first, so ranking a
    // goal never turns into a whole-repository read.
    const sources = {};
    const candidates = [...repository.files]
      .filter((file) => file.size < 200_000)
      .sort((left, right) => (right.importance ?? 0) - (left.importance ?? 0))
      .slice(0, 250);
    for (const file of candidates) {
      try {
        sources[file.path] = await readRepositoryFile(repository.rootPath, file.path);
      } catch {
        // An unreadable file simply contributes no signal.
      }
    }
    return goalPlan(repository, request.goal, { sources, course: request.course, limit: request.limit });
  },

  "experiment:state": async (_event, request) => {
    openedRepository(request.repository);
    return experimentReport(await loadExperimentState(experimentDirectory()));
  },

  "experiment:consent": async (_event, request) => {
    openedRepository(request.repository);
    // Revoking deletes the observations, not just the permission to collect more.
    return experimentReport(await setConsent(experimentDirectory(), request.granted));
  },

  "experiment:forget": async (_event, request) => {
    openedRepository(request.repository);
    const removed = await forgetEverything(experimentDirectory());
    return { ...removed, state: experimentReport(await loadExperimentState(experimentDirectory())) };
  },

  "analytics:report": async (_event, request) => {
    const repository = openedRepository(request.repository);
    return analyticsReport({
      events: await readEvents(activityLogDirectory(), repository.id),
      learnerState: request.learnerState ?? null,
      skillGraph: request.skillGraph ?? null,
      now: request.now,
      // Files the learner has actually opened count as studied ground.
      studiedPaths: [...(inspectedPaths.get(repository.id) ?? [])],
    });
  },

  "hint:next": (_event, request) => {
    const repository = openedRepository(request.repository);
    // Localization keeps its own item-27 ladder; everything else uses the
    // shared one, and either way only the *next* rung is ever served.
    const scaffold = request.kind === "localization"
      ? buildScaffold("localization", { hints: localizationExercises.get(repository.id)?.get(request.taskId)?.hints ?? [] })
      : scaffolds.get(scaffoldKey(repository.id, request.kind, request.taskId));
    if (!scaffold?.available) throw new Error("No hint ladder is active for that task.");
    const rung = nextHintRung(scaffold, request.used ?? []);
    const revealed = [...(request.used ?? []), rung?.id].filter(Boolean);
    const penalty = applyScaffold(1, scaffold, revealed).penalty;
    hintsTaken.set(`${repository.id}|${request.taskId}`, { count: revealed.length, penalty });
    return { ...publicScaffold(scaffold), rung, used: (request.used ?? []).length, penalty };
  },

  "quiz:build": async (_event, request) => {
    const repository = openedRepository(request.repository);
    // Only Python files that could hold a self-contained function are read, so
    // building a quiz never turns into a whole-repository read.
    const sources = {};
    const indexedFunctionFiles = new Set(
      (repository.symbols ?? []).filter((symbol) => symbol.kind === "function").map((symbol) => symbol.path),
    );
    // Only Python files that the index actually analyzed, most important first,
    // so a quiz anchor is always openable and building never reads the whole tree.
    const candidates = repository.files
      .filter((file) => file.path.endsWith(".py") && file.size < 120_000 && indexedFunctionFiles.has(file.path))
      .sort((left, right) => (right.importance ?? 0) - (left.importance ?? 0))
      .slice(0, 200);
    for (const file of candidates) {
      try {
        sources[file.path] = await readRepositoryFile(repository.rootPath, file.path);
      } catch {
        // A file that cannot be read simply yields no quiz candidate.
      }
    }
    const quiz = await buildExecutableQuiz(repository, { sources, symbol: request.symbol });
    if (!quiz.available) return publicQuiz(quiz);
    executableQuizzes.set(repository.id, quiz);
    // Item 40: the oracle is registered so the egress guard can prove it never
    // comes back out, and the hint ladder is built from the same facts.
    registerAnswerSecrets(quiz.cases.slice(1).map((item) => item.expected));
    scaffolds.set(scaffoldKey(repository.id, "executable-quiz", quiz.id), buildScaffold("executable-quiz", {
      parameters: (quiz.header.match(/\(([^)]*)\)/)?.[1] ?? "").split(",").filter((piece) => piece.trim()).length,
      hiddenCases: quiz.cases.length - 1,
      sampleInput: JSON.stringify(quiz.cases[1]?.arguments ?? []),
      answer: quiz.cases[1]?.expected ?? null,
    }));
    return publicQuiz(quiz);
  },

  "quiz:grade": async (_event, request) => {
    const repository = openedRepository(request.repository);
    const quiz = executableQuizzes.get(repository.id);
    if (!quiz || quiz.id !== request.quizId) throw new Error("That quiz is not active for this repository.");
    const grade = await gradeSubmission(quiz, request.submission);
    const hints = hintsTaken.get(`${repository.id}|${quiz.id}`) ?? { count: 0, penalty: 0 };
    await recordActivity(repository, { kind: "executable-quiz", taskId: quiz.id, path: quiz.path, symbol: quiz.entry, correct: grade.passed, score: grade.score ?? 0, hints: hints.count, hintPenalty: hints.penalty });
    return grade;
  },

  "learning:schedule": async (_event, request) => {
    openedRepository(request.repository);
    if (!Array.isArray(request.skillGraph?.nodes)) throw new Error("Invalid review-schedule request.");
    // Item 42: an explicit request always wins; otherwise the assigned arm sets
    // the daily limit, and without consent that is the control arm's value.
    const assigned = settingsFor("review-daily-limit", await loadExperimentState(experimentDirectory()));
    return reviewPlan(request.learnerState ?? {}, request.skillGraph, {
      now: request.now,
      dailyLimit: request.dailyLimit ?? assigned.dailyLimit,
    });
  },

  "learning:review": async (_event, request) => {
    const repository = openedRepository(request.repository);
    if (!Array.isArray(request.skillGraph?.nodes)) throw new Error("Invalid review request.");
    // The scheduler is the authority on the next interval, so the updated state
    // is persisted here rather than trusting the renderer to save it back.
    const result = applyReview(request.learnerState ?? { repositoryId: repository.id, mastery: {} }, request.skillGraph, {
      skillId: request.skillId,
      grade: request.grade,
      now: request.now,
    });
    const learnerState = { ...result.learnerState, repositoryId: repository.id };
    await saveLearnerState(path.join(app.getPath("userData"), "learning"), learnerState);
    await recordActivity(repository, {
      kind: "review",
      taskId: request.skillId,
      skillId: request.skillId,
      correct: result.review.recalled,
      score: result.review.strength,
      // The delay and the interval it was recalled against are what turn a set
      // of reviews into a measured retention curve.
      elapsedDays: result.review.elapsedDays,
      stability: result.review.previous.stability,
      hints: 0,
      hintPenalty: 0,
    });
    await observeExperiment("review-daily-limit", result.review.recalled ? 1 : 0);
    return { ...result, learnerState };
  },

  "agents:ask": async (_event, request) => {
    const repository = openedRepository(request.context.repository);
    const trustedContext = { ...request.context, repository };
    const pack = await buildContextPack(repository, trustedContext);
    const local = answerFromLocalIndex(repository, request.context.question);
    if (local) return { text: local, pack, answeredBy: "local-index", responseCacheHit: false };
    const cacheDirectory = path.join(app.getPath("userData"), "agent-responses");
    const cacheKey = responseCacheKey(repository, request.provider, trustedContext, pack);
    const cached = await loadCachedResponse(cacheDirectory, cacheKey);
    if (cached?.text) return { ...cached, pack, responseCacheHit: true };
    if (request.rootPath !== repository.rootPath) throw new Error("Agent root does not match the open repository.");
    const text = await askAgent(request.provider, repository.rootPath, { ...trustedContext, contextPack: pack });
    const response = { text, pack, answeredBy: request.provider, responseCacheHit: false };
    await saveCachedResponse(cacheDirectory, cacheKey, response);
    return response;
  },

  "course:enhance": async (_event, request) => {
    if (!Array.isArray(request.course?.modules)) throw new Error("Invalid curriculum request.");
    const repository = openedRepository(request.repository);
    const draft = await generateCourseWithAgent(request.provider, repository.rootPath, repository, request.course);
    const course = normalizeAgentCourse(repository, request.course, draft, request.provider);
    await saveCourse(path.join(app.getPath("userData"), "courses"), repository, course);
    return { course, skillGraph: buildSkillGraph(repository, course) };
  },

  "learning:load": async (_event, request) => {
    if (!Array.isArray(request.skillGraph?.nodes)) throw new Error("Invalid learning-state request.");
    const repository = openedRepository(request.repository);
    const saved = await loadLearnerState(path.join(app.getPath("userData"), "learning"), repository.id);
    return reconcileLearnerState(repository, request.skillGraph, saved);
  },

  "learning:save": (_event, state) => {
    if (!openedRepositories.has(state.repositoryId)) throw new Error("Repository is not open in this workspace.");
    return saveLearnerState(path.join(app.getPath("userData"), "learning"), state);
  },

  "practice:create": async (_event, request) => createPracticeSession(
    openedRepository(request.repository),
    request.lesson,
    path.join(app.getPath("userData"), "practice"),
  ),

  "practice:inspect": (_event, sessionId) => inspectPracticeSession(sessionId),

  "practice:open": async (_event, sessionId) => {
    const error = await shell.openPath(getPracticeSessionPath(sessionId));
    if (error) throw new Error(error);
    return true;
  },

  "practice:remove": (_event, request) => removePracticeSession(request.sessionId, Boolean(request.discardChanges)),
};

// Item 40: the outbound guard. Every response is audited for structural and
// value-level answer leakage before the renderer can see it, and a leak throws
// rather than being logged, because a silently compromised exercise is worse
// than a broken one.
export const registeredIpcChannels = registerValidatedHandlers(ipcMain, ipcHandlers, {
  onResponse: (channel, result) => guardResponse(channel, result),
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => { void shutdownLanguageServers(); });
