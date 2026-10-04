import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askAgent, detectAgents, generateCourseWithAgent } from "./agents.mjs";
import { generateStarterCourse, normalizeAgentCourse } from "./course.mjs";
import { loadCourse, saveCourse } from "./course-store.mjs";
import { DEFAULT_INDEX_LIMITS, IndexCancelledError, analyzeContent, inspectRepository, languageFor, readRepositoryFile } from "./repository.mjs";
import { createPracticeSession, getPracticeSessionPath, inspectPracticeSession, reconcilePracticeSessions, releaseOrphanedWorktree, removePracticeSession } from "./practice.mjs";
import { inspectDurable, sweepInterruptedWrites } from "./durable-store.mjs";
import { DEEP_LINK_SCHEME, deepLinkFromArgv, parseDeepLink } from "./deep-link.mjs";
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
import { detectRenames, historyLessons, historySummary, listFilesAtCommit, readCommits, readFileAtCommit } from "./git-history.mjs";
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
import { detectLicense, importCourse, packageCourse, verifyPackage } from "./course-package.mjs";
import { applyMigration, buildSymbolSnapshot, courseAnchorSites, planMigration, revertMigration } from "./course-migration.mjs";
import { buildArchive, importArchive, verifyArchive } from "./offline-archive.mjs";
import { loadNotes, saveNotes } from "./notes-store.mjs";
import { applyNoteEdit } from "./notes.mjs";
import { anchorPayload, loadOrCreateKeyPair, loadTrustedKeys, publicIdentity, responsePayload, setKeyTrust, signPackage, signPayload, verifyPackageSignature, verifyPayload } from "./signing.mjs";
import { forgetEverything, loadExperimentState, recordObservation, setConsent } from "./experiment-store.mjs";
import { buildSbom, publicSupplyChainReport, scanDependencies } from "./supply-chain.mjs";
import { BUDGETS, budgetIds, evaluateAll } from "./performance.mjs";
import { loadPlugins, publicPluginReport } from "./plugins.mjs";
import { exportTelemetry, summarize as summarizeTelemetry } from "./telemetry.mjs";
import { forgetTelemetry, loadTelemetry, record as recordTelemetry, setTelemetryConsent, telemetryFileExists } from "./telemetry-store.mjs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const openedRepositories = new Map();

/**
 * Everything keyed by repository id (item 52).
 *
 * Listing them in one place is the point: a per-repository cache that nobody
 * remembers to clear is how one repository's exercises, hints, and search index
 * end up answering questions about another. `forgetRepository` walks this list,
 * so adding a cache without adding it here is a visible omission rather than an
 * invisible leak.
 */
const REPOSITORY_CACHES = [];

function repositoryCache(name) {
  const store = new Map();
  REPOSITORY_CACHES.push({ name, store });
  return store;
}

/**
 * Drop everything cached for a repository.
 *
 * Called when the last window holding it goes away, and when a repository is
 * re-indexed at a new version, because a call chain or a search index built
 * against the old tree is wrong rather than stale.
 */
function forgetRepository(repositoryId, { keepIndex = false } = {}) {
  const dropped = [];
  for (const { name, store } of REPOSITORY_CACHES) {
    let removed = 0;
    for (const key of [...store.keys()]) {
      // Composite keys start with the repository id; plain ones are the id.
      if (key === repositoryId || String(key).startsWith(`${repositoryId}|`)) {
        store.delete(key);
        removed += 1;
      }
    }
    if (removed) dropped.push(`${name}:${removed}`);
  }
  if (!keepIndex) {
    openedRepositories.delete(repositoryId);
    knowledgeGraphs.delete(repositoryId);
  }
  return dropped;
}

const knowledgeGraphs = new Map();
const indexingRequests = new Map();
// Not a repository cache: the bill of materials describes the application, not
// anything a learner opened, so it must survive switching repositories.
const supplyChainReports = new Map();

/**
 * Plugins are read once per launch (item 58).
 *
 * Re-reading them would mean a directory that changes under a running
 * application changes what it trusts, which is a race worth not having: a
 * plugin verified at launch and swapped afterwards would keep its granted
 * capabilities. Restarting is the way to install one.
 */
let pluginsPromise = null;
function loadedPlugins() {
  if (!pluginsPromise) {
    pluginsPromise = (async () => {
      // The same trust list item 45 built for course packages. A key the
      // learner trusted for one kind of signed artifact is a key they trusted;
      // maintaining a second list would mean two places to get it wrong.
      const trustedKeyIds = await loadTrustedKeys(signingDirectory());
      return loadPlugins(path.join(app.getPath("userData"), "plugins"), {
        trustedKeyIds,
        // Granted explicitly. A capability a plugin asked for and did not get
        // is reported as `withheld` rather than quietly ignored.
        grant: ["read-file", "list-files", "symbols", "log"],
      });
    })().catch(() => ({ directory: null, plugins: [], refused: [], available: false }));
  }
  return pluginsPromise;
}
const callChainSets = repositoryCache("callChainSets");
const localizationExercises = repositoryCache("localizationExercises");
const raceTasks = repositoryCache("raceTasks");
const searchIndexes = repositoryCache("searchIndexes");
const learnerProbes = repositoryCache("learnerProbes");
const executableQuizzes = repositoryCache("executableQuizzes");
const explanationTasks = repositoryCache("explanationTasks");
const activitySets = repositoryCache("activitySets");
const scaffolds = repositoryCache("scaffolds");

/** One key per active hint ladder, so a rung can only be served for a live task. */
function scaffoldKey(repositoryId, kind, taskId) {
  return `${repositoryId}|${kind}|${taskId}`;
}

// How many hint rungs the learner has taken per task, so a graded attempt can
// record what it cost. The main process owns this: a renderer that could report
// its own hint usage could also report none.
const hintsTaken = repositoryCache("hintsTaken");

// Files the learner has opened, which is what makes an activity "near" transfer.
const inspectedPaths = repositoryCache("inspectedPaths");

/**
 * Bounds on a migration. Reconstructing a previous version means reading blobs
 * out of git one at a time, so an unbounded course could turn one click into
 * thousands of subprocess calls.
 */
const MIGRATION_LIMITS = { anchoredFiles: 60, candidateFiles: 120, maxFileBytes: 400_000 };

function activityLogDirectory() {
  return path.join(app.getPath("userData"), "activity-log");
}

function experimentDirectory() {
  return path.join(app.getPath("userData"), "experiments");
}

function signingDirectory() {
  return path.join(app.getPath("userData"), "signing");
}

function telemetryDirectory() {
  return path.join(app.getPath("userData"), "telemetry");
}

/**
 * Note one thing the application did (item 60).
 *
 * Fire and forget, and it must be: a counter is never worth failing a real
 * operation for, never worth delaying one, and never worth an unhandled
 * rejection. `record` refuses on its own when consent is absent, so callers do
 * not check — a call site that had to remember to check is a call site that
 * eventually will not.
 */
function noteTelemetry(event, dimensions = {}, measures = {}) {
  void recordTelemetry(telemetryDirectory(), event, { dimensions, measures }).catch(() => {});
}

function sizeBandFor(files) {
  if (files <= 50) return "tiny";
  if (files <= 500) return "small";
  if (files <= 3_000) return "medium";
  return "large";
}

function practiceDirectory() {
  return path.join(app.getPath("userData"), "practice");
}

/**
 * What the last shutdown left behind (item 51). Computed once at launch and
 * handed to the renderer on request, because a recovery the learner is not told
 * about is indistinguishable from data loss.
 */
let recoveryReport = null;

function notesDirectory() {
  return path.join(app.getPath("userData"), "notes");
}

function learningDirectory() {
  return path.join(app.getPath("userData"), "learning");
}

/**
 * An archive is only useful offline if it carries the source its anchors point
 * at, and reading source is the expensive half of an export, so it is bounded
 * the same way indexing is.
 */
const ARCHIVE_LIMITS = { maxFiles: 200, maxFileBytes: 400_000 };

/** The machine's signing key, created on first use and cached for the session. */
let signingKeyPromise = null;
function signingKey() {
  signingKeyPromise ??= loadOrCreateKeyPair(signingDirectory());
  return signingKeyPromise;
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

/**
 * Windows, and what each one is looking at (item 52).
 *
 * Two windows on the same repository share one index — re-indexing FlashInfer
 * per window would cost eight seconds and a hundred megabytes for nothing — so
 * the caches are keyed by repository rather than by window, and a repository is
 * only forgotten when the *last* window holding it goes away. Getting that
 * backwards either leaks memory forever or pulls the index out from under a
 * window that is still using it.
 */
const windowRepositories = new Map();

function claimRepository(webContents, repositoryId) {
  windowRepositories.set(webContents.id, repositoryId);
}

function releaseWindow(webContentsId) {
  const repositoryId = windowRepositories.get(webContentsId);
  windowRepositories.delete(webContentsId);
  if (!repositoryId) return null;
  const stillOpen = [...windowRepositories.values()].includes(repositoryId);
  if (stillOpen) return null;
  return { repositoryId, dropped: forgetRepository(repositoryId) };
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

  window.webContents.on("destroyed", () => {
    // The renderer is gone; whatever it was holding may now be released.
    releaseWindow(window.webContents.id);
  });

  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) window.loadURL(developmentUrl);
  else window.loadFile(path.join(currentDirectory, "..", "dist", "index.html"));
  return window;
}

/**
 * Route a `trace://` link to a window.
 *
 * The link is parsed against the repositories that are actually open and then
 * *sent to the renderer as an intent* — the main process never navigates on its
 * own. A link that cannot be honoured is reported to the focused window so the
 * learner sees why, rather than watching nothing happen.
 */
function routeDeepLink(url, sender = null) {
  const result = parseDeepLink(url, { openRepositories: [...openedRepositories.values()].map((repository) => ({ id: repository.id, rootPath: repository.rootPath })) });
  lastDeepLink = { url, at: new Date().toISOString(), ...result };
  // A link the renderer asked us to open belongs to *that* renderer; only a
  // link handed over by the operating system has to guess at a window.
  const target = (sender && BrowserWindow.fromWebContents(sender))
    ?? BrowserWindow.getFocusedWindow()
    ?? BrowserWindow.getAllWindows()[0]
    ?? null;
  if (target && !target.webContents.isDestroyed()) {
    target.webContents.send("deep-link:navigate", lastDeepLink);
    if (target.isMinimized()) target.restore();
    target.focus();
  }
  return lastDeepLink;
}

let lastDeepLink = null;

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
        // Item 58: indexer plugins get the files the built-in indexers could
        // not read at all, and nothing else.
        plugins: (await loadedPlugins()).plugins,
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
    // Re-indexing at a new version invalidates everything derived from the old
    // one: a call chain or a search index built against the previous tree is
    // wrong, not merely stale.
    const previous = openedRepositories.get(repository.id);
    if (previous && previous.versionId !== repository.versionId) forgetRepository(repository.id, { keepIndex: true });
    openedRepositories.set(repository.id, repository);
    const switchedFrom = windowRepositories.get(event.sender.id) ?? null;
    if (switchedFrom && switchedFrom !== repository.id) {
      // This window moved to a different repository; the one it left goes only
      // if no other window still has it.
      windowRepositories.delete(event.sender.id);
      if (![...windowRepositories.values()].includes(switchedFrom)) forgetRepository(switchedFrom);
    }
    claimRepository(event.sender, repository.id);
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
    // Item 60: how long it took and how well it worked. Not which repository —
    // there is no dimension a name or a path could occupy.
    noteTelemetry("repository.opened", {
      indexer: repository.stats.indexer,
      degraded: repository.stats.memory.degraded ? "yes" : "no",
      size: sizeBandFor(repository.stats.fileCount),
    }, { durationMs: repository.stats.timing.totalMs, files: repository.stats.fileCount });
    for (const contribution of repository.stats.plugins?.contributions ?? []) {
      noteTelemetry("plugin.ran", { kind: "indexer", outcome: "ok" }, { durationMs: contribution.durationMs });
    }
    for (const problem of repository.stats.plugins?.problems ?? []) {
      noteTelemetry("plugin.ran", { kind: "indexer", outcome: problem.reason === "timeout" ? "timeout" : "error" }, {});
    }
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
    const started = Date.now();
    const found = search(index, request.query, { limit: request.limit ?? 10 });
    // Item 60: that a search happened and how fast it was. Never the query —
    // there is no dimension it could go in.
    noteTelemetry("search.performed", {
      strategy: "fused",
      hadResults: found.results.length ? "yes" : "no",
    }, { latencyMs: Date.now() - started, results: found.results.length });
    return { ...found, indexStats: index.stats };
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

  "course:package": async (_event, request) => {
    const repository = openedRepository(request.repository);
    if (!Array.isArray(request.course?.modules)) throw new Error("Invalid course package request.");
    // The license is read from the repository's own LICENSE file, and only the
    // files the course actually anchors into are read for possible excerpts.
    const licenseSources = {};
    for (const file of repository.files.filter((candidate) => /^(?:LICEN[CS]E|COPYING)(?:\.\w+)?$/i.test(candidate.name)).slice(0, 4)) {
      try {
        licenseSources[file.path] = await readRepositoryFile(repository.rootPath, file.path);
      } catch {
        // An unreadable LICENSE simply leaves the license unknown.
      }
    }
    const license = detectLicense(licenseSources);
    const sources = { ...licenseSources };
    if (request.embedSource && license.permissive) {
      const anchored = new Set(request.course.modules.flatMap((module) => (module.lessons ?? []).flatMap((lesson) => (lesson.anchors ?? []).map((anchor) => anchor.path))));
      for (const filePath of [...anchored].slice(0, 200)) {
        try {
          sources[filePath] = await readRepositoryFile(repository.rootPath, filePath);
        } catch {
          // A file that cannot be read is simply not embedded.
        }
      }
    }
    const packaged = packageCourse(repository, request.course, {
      skillGraph: request.skillGraph,
      sources,
      license,
      embedSource: Boolean(request.embedSource),
    });
    // Item 45: the package is sealed over its provenance, license policy,
    // anchors, and content, and the anchors are sealed again on their own so a
    // lesson's ground truth can be checked without trusting the rest of the file.
    const keyPair = await signingKey();
    const signed = signPackage(packaged, keyPair);
    return { ...signed, anchorSignature: signPayload("source-anchors", anchorPayload(packaged.integrity.anchors), keyPair) };
  },

  "course:import": async (_event, request) => {
    const repository = openedRepository(request.repository);
    const trustedKeyIds = await loadTrustedKeys(signingDirectory());
    const signature = verifyPackageSignature(request.package, { trustedKeyIds });
    const anchorSignature = verifyPayload("source-anchors", anchorPayload(request.package?.integrity?.anchors), request.package?.anchorSignature, { trustedKeyIds });
    // A package whose seal is broken is refused outright: unlike drift, this is
    // not a difference of version, it is evidence the file was altered.
    if (signature.trust === "invalid" || anchorSignature.trust === "invalid") {
      return {
        imported: false,
        course: null,
        skillGraph: null,
        reason: `The package signature did not verify (${signature.trust === "invalid" ? signature.reason : anchorSignature.reason}).`,
        verification: { ...verifyPackage(request.package, repository), signature, anchorSignature },
      };
    }
    const result = importCourse(request.package, repository, { force: Boolean(request.force) });
    return { ...result, verification: { ...(result.verification ?? verifyPackage(request.package, repository)), signature, anchorSignature } };
  },

  "course:verify-signature": async (_event, request) => {
    openedRepository(request.repository);
    const trustedKeyIds = await loadTrustedKeys(signingDirectory());
    return {
      signature: verifyPackageSignature(request.package, { trustedKeyIds }),
      anchorSignature: verifyPayload("source-anchors", anchorPayload(request.package?.integrity?.anchors), request.package?.anchorSignature, { trustedKeyIds }),
      trustedKeyIds,
    };
  },

  "course:migrate": async (_event, request) => {
    const repository = openedRepository(request.repository);
    if (!Array.isArray(request.course?.modules)) throw new Error("Invalid course migration request.");
    const course = request.course;
    const sites = courseAnchorSites(course);
    if (!sites.length) return { available: false, reason: "This course has no source anchors to migrate.", plan: null, course: null };

    const fromCommit = request.fromCommit ?? course.sourceCommit ?? null;
    if (!fromCommit || fromCommit === "unversioned") {
      return { available: false, reason: "This course does not record the commit it was written against, so there is nothing to migrate from.", plan: null, course: null };
    }
    const oldTree = await listFilesAtCommit(repository.rootPath, fromCommit);
    if (!oldTree.ok) {
      return { available: false, reason: `Commit ${String(fromCommit).slice(0, 12)} is not in this repository's history.`, plan: null, course: null };
    }

    const anchoredPaths = [...new Set(sites.map((site) => site.anchor.path))].slice(0, MIGRATION_LIMITS.anchoredFiles);
    const currentPaths = new Set(repository.files.map((file) => file.path));
    const rename = await detectRenames(repository.rootPath, fromCommit, repository.head ?? "HEAD");
    const renamedTo = new Map(rename.renames.map((entry) => [entry.from, entry.to]));

    // Candidate destinations: the anchored paths themselves, anything git says
    // an anchored path was renamed into, and same-basename files elsewhere —
    // enough to catch a definition that changed file without reading the tree.
    // Order matters as much as membership: the candidate list is truncated, and
    // an early basename sweep over a name like `__init__.py` once filled it with
    // 120 unrelated files and pushed real anchored files past the cut, which
    // reported live definitions as deleted. Anchored paths go in first.
    const candidates = new Set();
    for (const anchored of anchoredPaths) {
      if (currentPaths.has(anchored)) candidates.add(anchored);
      const moved = renamedTo.get(anchored);
      if (moved && currentPaths.has(moved)) candidates.add(moved);
    }
    // Siblings next. The commonest real relocation is a definition extracted
    // into a new module beside the one it came from — `CommBackend` left
    // `flashinfer/comm/mnnvl.py` for `flashinfer/comm/abstractions.py` — and
    // without the directory the matcher can only call that a disappearance.
    const anchoredDirectories = new Set(anchoredPaths.map((anchored) => anchored.split("/").slice(0, -1).join("/")));
    for (const file of repository.files) {
      if (candidates.size >= MIGRATION_LIMITS.candidateFiles) break;
      if (anchoredDirectories.has(file.directory)) candidates.add(file.path);
    }
    const anchoredBasenames = new Set(anchoredPaths.map((anchored) => anchored.split("/").at(-1)));
    for (const file of repository.files) {
      if (candidates.size >= MIGRATION_LIMITS.candidateFiles) break;
      if (anchoredBasenames.has(file.name)) candidates.add(file.path);
    }

    const snapshotFor = async (paths, read) => {
      const sources = {};
      const symbols = [];
      for (const filePath of [...paths].slice(0, MIGRATION_LIMITS.candidateFiles)) {
        const content = await read(filePath);
        if (typeof content !== "string" || content.length > MIGRATION_LIMITS.maxFileBytes) continue;
        sources[filePath] = content;
        // The same tree-sitter-then-regex path the live index uses, so the two
        // never disagree about which definitions a file contains.
        const analysis = await analyzeContent(filePath, languageFor(filePath), content);
        symbols.push(...analysis.symbols);
      }
      return { sources, symbols };
    };

    const oldFiles = new Set(oldTree.files);
    const before = await snapshotFor(anchoredPaths.filter((filePath) => oldFiles.has(filePath)), async (filePath) => {
      const read = await readFileAtCommit(repository.rootPath, fromCommit, filePath, { maxBytes: MIGRATION_LIMITS.maxFileBytes });
      return read.ok ? read.content : null;
    });
    const after = await snapshotFor(candidates, async (filePath) => {
      try {
        return await readRepositoryFile(repository.rootPath, filePath);
      } catch {
        return null;
      }
    });

    const beforeSnapshot = buildSymbolSnapshot(before.symbols, before.sources, {
      label: "packaged", commit: fromCommit, files: oldTree.files.filter((filePath) => filePath.length < 400),
    });
    const afterSnapshot = buildSymbolSnapshot(after.symbols, after.sources, {
      label: "current", commit: repository.head ?? null, sourceVersion: repository.versionId ?? null, files: [...currentPaths],
    });
    const plan = planMigration(course, beforeSnapshot, afterSnapshot);
    const gitEvidence = rename.renames.filter((entry) => anchoredPaths.includes(entry.from)).slice(0, 20);

    if (!request.apply) return { available: true, plan, course: null, gitRenames: gitEvidence, filesCompared: Object.keys(before.sources).length };
    const accept = Array.isArray(request.acceptIds) ? request.acceptIds : request.accept === "none" ? [] : request.accept ?? "auto";
    const applied = applyMigration(course, plan, { accept, retireMissing: request.retireMissing ?? true });
    return { available: true, plan, ...applied, gitRenames: gitEvidence, filesCompared: Object.keys(before.sources).length };
  },

  "course:revert-migration": async (_event, request) => {
    openedRepository(request.repository);
    if (!Array.isArray(request.course?.modules)) throw new Error("Invalid revert request.");
    return revertMigration(request.course, request.migrationId ?? null);
  },

  "notes:list": async (_event, request) => {
    const repository = openedRepository(request.repository);
    return { notes: await loadNotes(notesDirectory(), repository.id) };
  },

  "notes:save": async (_event, request) => {
    const repository = openedRepository(request.repository);
    const notes = await loadNotes(notesDirectory(), repository.id);
    const edit = applyNoteEdit(notes, {
      id: request.id,
      lessonId: request.lessonId ?? null,
      anchor: request.anchor ?? null,
      text: request.text,
    });
    const saved = await saveNotes(notesDirectory(), repository.id, edit.notes);
    return { notes: saved, removed: edit.removed, note: saved.find((note) => note.id === request.id) ?? null };
  },

  "archive:export": async (_event, request) => {
    const repository = openedRepository(request.repository);
    if (!Array.isArray(request.course?.modules)) throw new Error("Invalid archive request.");
    // Only the files the course actually anchors into are read, so exporting a
    // course never turns into reading the repository.
    const sources = {};
    if (request.includeExcerpts !== false) {
      const anchored = [...new Set(courseAnchorSites(request.course).map((site) => site.anchor.path))].slice(0, ARCHIVE_LIMITS.maxFiles);
      for (const filePath of anchored) {
        const file = repository.files.find((candidate) => candidate.path === filePath);
        if (!file || file.size > ARCHIVE_LIMITS.maxFileBytes) continue;
        try {
          sources[filePath] = await readRepositoryFile(repository.rootPath, filePath);
        } catch {
          // An unreadable file is reported as a missing excerpt, not hidden.
        }
      }
    }
    const learnerState = request.learnerState ?? await loadLearnerState(learningDirectory(), repository.id);
    const archive = buildArchive({
      repository,
      course: request.course,
      skillGraph: request.skillGraph ?? null,
      learnerState,
      notes: await loadNotes(notesDirectory(), repository.id),
      sources,
    });
    // Item 45's seal, over the archive as a whole: a learner carrying their own
    // progress between machines should be able to tell whether it arrived intact.
    const keyPair = await signingKey();
    return { ...archive, signature: signPayload("offline-archive", archive, keyPair) };
  },

  "archive:import": async (_event, request) => {
    const repository = openedRepository(request.repository);
    const archive = request.archive;
    // Verification reads only the files the archive claims excerpts from.
    const sources = {};
    for (const excerpt of (archive?.content?.excerpts ?? []).slice(0, ARCHIVE_LIMITS.maxFiles)) {
      if (sources[excerpt.path] !== undefined) continue;
      try {
        sources[excerpt.path] = await readRepositoryFile(repository.rootPath, excerpt.path);
      } catch {
        sources[excerpt.path] = null;
      }
    }
    const trustedKeyIds = await loadTrustedKeys(signingDirectory());
    const { signature, ...payload } = archive ?? {};
    const seal = verifyPayload("offline-archive", payload, signature ?? null, { trustedKeyIds });
    if (!request.apply) return { imported: false, preview: true, verification: verifyArchive(archive, { sources }), seal };

    const learnerState = request.learnerState ?? await loadLearnerState(learningDirectory(), repository.id);
    const result = importArchive(archive, {
      sources,
      mode: request.mode ?? "merge",
      learnerState,
      notes: await loadNotes(notesDirectory(), repository.id),
      force: Boolean(request.force),
    });
    if (!result.imported) return { ...result, seal };
    // Persisted only after the merge succeeded, so a refused archive cannot
    // leave the learner half-migrated.
    if (result.learnerState) await saveLearnerState(learningDirectory(), { ...result.learnerState, repositoryId: repository.id });
    const notes = await saveNotes(notesDirectory(), repository.id, result.notes);
    return { ...result, notes, seal };
  },

  "signing:identity": async (_event, request) => {
    openedRepository(request.repository);
    // Only the public half ever crosses the IPC boundary.
    return { ...publicIdentity(await signingKey()), trustedKeyIds: await loadTrustedKeys(signingDirectory()) };
  },

  "signing:trust": async (_event, request) => {
    openedRepository(request.repository);
    return { trustedKeyIds: await setKeyTrust(signingDirectory(), request.keyId, request.trusted) };
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
    noteTelemetry("exercise.graded", {
      kind: "quiz",
      outcome: grade.passed ? "pass" : (grade.score ?? 0) > 0 ? "partial" : "fail",
      hinted: hints.count > 0 ? "yes" : "no",
    }, {});
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
    const keyPair = await signingKey();
    const cached = await loadCachedResponse(cacheDirectory, cacheKey, {
      // A tampered cache entry is discarded, not served.
      verify: (entry) => verifyPayload("agent-response", responsePayload(entry), entry?.signature),
    });
    if (cached?.text) return { ...cached, pack, responseCacheHit: true };
    if (request.rootPath !== repository.rootPath) throw new Error("Agent root does not match the open repository.");
    const text = await askAgent(request.provider, repository.rootPath, { ...trustedContext, contextPack: pack });
    const response = { text, pack, answeredBy: request.provider, responseCacheHit: false };
    const stored = await saveCachedResponse(cacheDirectory, cacheKey, response, {
      sign: (entry) => signPayload("agent-response", responsePayload(entry), keyPair),
    });
    return { ...response, signature: stored.signature };
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
    practiceDirectory(),
  ),

  "practice:inspect": (_event, sessionId) => inspectPracticeSession(sessionId),

  "practice:open": async (_event, sessionId) => {
    const error = await shell.openPath(getPracticeSessionPath(sessionId));
    if (error) throw new Error(error);
    return true;
  },

  "practice:remove": (_event, request) => removePracticeSession(request.sessionId, Boolean(request.discardChanges)),

  /**
   * What this build is made of (item 56).
   *
   * Two sources, in this order, and the answer says which one it used. A
   * packaged application does not ship `package-lock.json`, so rebuilding the
   * bill of materials from the lockfile is impossible there — but the release
   * puts `sbom.cdx.json` *inside* the artifact precisely so the shipped copy
   * can be read. Falling back to "unknown" rather than to an empty list is the
   * point: an application that reported no dependencies would be describing a
   * fact about its own packaging as a fact about its dependencies.
   */
  "supply-chain:report": async (_event, request) => {
    const scope = request?.scope ?? "all";
    const cached = supplyChainReports.get(scope);
    if (cached) return cached;
    const projectRoot = path.resolve(currentDirectory, "..");
    let bom = null;
    let source = null;
    try {
      bom = JSON.parse(await readFile(path.join(projectRoot, "sbom.cdx.json"), "utf8"));
      source = "shipped";
    } catch {
      try {
        bom = await buildSbom({ projectRoot });
        source = "lockfile";
      } catch (cause) {
        return { available: false, source: null, reason: cause?.message ?? "No bill of materials is available in this installation." };
      }
    }
    const report = { available: true, source, ...publicSupplyChainReport(bom, scanDependencies(bom, { scope })) };
    supplyChainReports.set(scope, report);
    return report;
  },

  /**
   * What the last index cost, judged against the declared budgets (item 57).
   *
   * The measurements are taken where they happen: indexing time and peak
   * resident memory in the main process, render timings in the renderer, which
   * is the only place that can see a paint. Nothing here is a *new*
   * measurement — the point of a budget is to judge the numbers the real work
   * already produced, not to run a benchmark that resembles the real work.
   */
  "perf:report": async (_event, request) => {
    const repository = request?.repository ? openedRepository(request.repository) : null;
    const measurements = {};
    const sizes = {};
    if (repository?.stats?.timing) {
      const files = repository.stats.fileCount || 1;
      measurements["index.totalMs"] = repository.stats.timing.totalMs;
      measurements["index.peakRssBytes"] = repository.stats.memory.peakRss;
      measurements["index.peakHeapBytes"] = repository.stats.memory.peakHeap;
      sizes["index.totalMs"] = { size: files };
      sizes["index.peakRssBytes"] = { size: files };
      sizes["index.peakHeapBytes"] = { size: files };
    }
    for (const [id, samples] of Object.entries(request?.render ?? {})) {
      if (!BUDGETS[id]) continue;
      // A budget with a `percentile` flag wants the distribution; the rest want
      // the worst observation, because one slow switch is the complaint.
      measurements[id] = BUDGETS[id].percentile ? { samples } : Math.max(...samples, 0);
    }
    const report = evaluateAll(measurements, sizes);
    // Item 60: a budget crossing its line is worth counting, and the budget id
    // is a declared value rather than free text.
    for (const result of report.results) {
      if (result.verdict === "warn" || result.verdict === "fail") noteTelemetry("budget.exceeded", { budget: result.id, verdict: result.verdict }, {});
    }
    return {
      ...report,
      budgets: Object.fromEntries(budgetIds().map((id) => [id, { label: BUDGETS[id].label, unit: BUDGETS[id].unit, limit: BUDGETS[id].limit, warnAt: BUDGETS[id].warnAt, per: BUDGETS[id].per ?? null, floor: BUDGETS[id].floor ?? null, why: BUDGETS[id].why }])),
      index: repository
        ? {
          files: repository.stats.fileCount,
          analyzed: repository.stats.timing.analyzedFiles,
          phases: repository.stats.timing.phases,
          memoryActions: repository.stats.memory.actions,
          degraded: repository.stats.memory.degraded,
        }
        : null,
    };
  },

  /**
   * Which extensions are installed, and which were refused (item 58).
   *
   * Refusals are part of the answer. A plugin somebody installed and that is
   * silently not running is the worst of the three possible outcomes: worse
   * than running, and worse than being told plainly that it will not.
   */
  "plugins:list": async () => publicPluginReport(await loadedPlugins()),

  /*
   * Item 60: opt-in local telemetry.
   *
   * Reading the state is always allowed — a learner who has not consented is
   * entitled to see the empty result and the full schema, which is how they
   * decide. Recording is refused without consent and says so, rather than
   * succeeding quietly and discarding.
   */
  "telemetry:state": async () => ({
    ...summarizeTelemetry(await loadTelemetry(telemetryDirectory())),
    onDisk: await telemetryFileExists(telemetryDirectory()),
  }),

  "telemetry:consent": async (_event, request) => {
    const next = await setTelemetryConsent(telemetryDirectory(), request.granted);
    return { ...summarizeTelemetry(next), onDisk: await telemetryFileExists(telemetryDirectory()) };
  },

  "telemetry:record": async (_event, request) => recordTelemetry(telemetryDirectory(), request.event, {
    dimensions: request.dimensions ?? {},
    measures: request.measures ?? {},
  }),

  "telemetry:forget": async (_event, request) => {
    const result = await forgetTelemetry(telemetryDirectory(), { event: request?.event ?? null });
    return { ...result, state: summarizeTelemetry(await loadTelemetry(telemetryDirectory())), onDisk: await telemetryFileExists(telemetryDirectory()) };
  },

  "telemetry:export": async () => exportTelemetry(await loadTelemetry(telemetryDirectory())),

  "window:new": async (_event) => {
    const created = createWindow();
    return { windowId: created.webContents.id, windows: BrowserWindow.getAllWindows().length };
  },

  "window:state": async (_event) => ({
    windows: BrowserWindow.getAllWindows().length,
    // What each window is looking at, and which repositories are therefore
    // still worth keeping indexed.
    byWindow: [...windowRepositories.entries()].map(([windowId, repositoryId]) => ({ windowId, repositoryId })),
    indexed: [...openedRepositories.keys()],
    caches: REPOSITORY_CACHES.map(({ name, store }) => ({ name, entries: store.size })),
  }),

  "deep-link:open": async (event, request) => routeDeepLink(request.url, event.sender),

  "deep-link:last": async () => lastDeepLink,

  "recovery:report": async (_event, request) => {
    const repository = request?.repository ? openedRepository(request.repository) : null;
    const learning = repository ? await inspectDurable(path.join(learningDirectory(), `${createHash("sha256").update(repository.id).digest("hex").slice(0, 24)}.json`)) : null;
    return { ...(recoveryReport ?? { ready: false }), learning };
  },

  "practice:release": async (_event, request) => {
    const repository = openedRepository(request.repository);
    // Only bookkeeping is released; the directory's contents are left alone,
    // because an orphaned worktree may hold the only copy of somebody's work.
    return releaseOrphanedWorktree(repository.rootPath, request.worktreePath);
  },
};

// Item 40: the outbound guard. Every response is audited for structural and
// value-level answer leakage before the renderer can see it, and a leak throws
// rather than being logged, because a silently compromised exercise is worse
// than a broken one.
export const registeredIpcChannels = registerValidatedHandlers(ipcMain, ipcHandlers, {
  onResponse: (channel, result) => guardResponse(channel, result),
});

/*
 * One instance owns the protocol. A second launch — which is what a `trace://`
 * click produces on Windows and Linux — hands its link to the first and exits,
 * rather than starting a second copy of the app with its own index of the same
 * repository.
 */
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const link = deepLinkFromArgv(argv);
    if (link) routeDeepLink(link);
    else {
      const existing = BrowserWindow.getAllWindows()[0];
      if (existing) { if (existing.isMinimized()) existing.restore(); existing.focus(); }
    }
  });
}

// macOS delivers the link as an event instead of an argument.
app.on("open-url", (event, url) => {
  event.preventDefault();
  routeDeepLink(url);
});

app.whenReady().then(async () => {
  // Before anything opens: clear temporary files left by an interrupted write,
  // and work out which practice worktrees the last run left behind.
  const [sweptLearning, sweptNotes, sweptPractice, practice] = await Promise.all([
    sweepInterruptedWrites(learningDirectory()),
    sweepInterruptedWrites(notesDirectory()),
    sweepInterruptedWrites(practiceDirectory()),
    reconcilePracticeSessions(practiceDirectory()),
  ]);
  recoveryReport = {
    ready: true,
    at: new Date().toISOString(),
    interruptedWrites: [...sweptLearning.swept, ...sweptNotes.swept, ...sweptPractice.swept],
    practice,
    // A clean launch says so, so "no notice" never has to be interpreted.
    clean: practice.orphaned.length === 0 && practice.stale.length === 0 && !practice.recovered
      && sweptLearning.swept.length === 0 && sweptNotes.swept.length === 0 && sweptPractice.swept.length === 0,
  };
  // Registering the scheme is what makes `trace://` links reach this app at all.
  // It is skipped under the test harness, which must not change the machine.
  if (!process.env.TRACE_NO_PROTOCOL_REGISTRATION) {
    if (process.defaultApp && process.argv.length >= 2) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
    else app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }
  createWindow();
  const startupLink = deepLinkFromArgv(process.argv);
  if (startupLink) routeDeepLink(startupLink);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => { void shutdownLanguageServers(); });
