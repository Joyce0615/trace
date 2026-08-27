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

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const openedRepositories = new Map();
const knowledgeGraphs = new Map();
const indexingRequests = new Map();

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

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) window.loadURL(developmentUrl);
  else window.loadFile(path.join(currentDirectory, "..", "dist", "index.html"));
}

/**
 * Every handler receives a payload that has already been size-, depth-, and
 * schema-validated by `registerValidatedHandlers`, so handlers assert only
 * workspace invariants (is this repository open?) rather than payload shape.
 */
const ipcHandlers = {
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
    if (![...openedRepositories.values()].some((repository) => repository.rootPath === request.rootPath)) {
      throw new Error("Repository is not open in this workspace.");
    }
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

export const registeredIpcChannels = registerValidatedHandlers(ipcMain, ipcHandlers);

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
