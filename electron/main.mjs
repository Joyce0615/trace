import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askAgent, detectAgents, generateCourseWithAgent } from "./agents.mjs";
import { generateStarterCourse, normalizeAgentCourse } from "./course.mjs";
import { loadCourse, saveCourse } from "./course-store.mjs";
import { inspectRepository, readRepositoryFile } from "./repository.mjs";
import { createPracticeSession, getPracticeSessionPath, inspectPracticeSession, removePracticeSession } from "./practice.mjs";
import { answerFromLocalIndex, buildContextPack, loadCachedResponse, responseCacheKey, saveCachedResponse } from "./context-engine.mjs";
import { loadLearnerState, saveLearnerState } from "./learning-store.mjs";
import { buildSkillGraph, reconcileLearnerState } from "./skill-graph.mjs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const openedRepositories = new Map();

function openedRepository(candidate) {
  const repository = candidate?.id ? openedRepositories.get(candidate.id) : null;
  if (!repository || repository.rootPath !== candidate.rootPath) throw new Error("Repository is not open in this workspace.");
  return repository;
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

ipcMain.handle("repository:choose", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose a codebase to learn",
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("repository:open", async (_event, source) => {
  const request = typeof source === "string" ? { source } : source;
  if (!request || typeof request.source !== "string") throw new Error("Repository source must be a path or Git URL.");
  const repositoriesDirectory = path.join(app.getPath("userData"), "repositories");
  const courseDirectory = path.join(app.getPath("userData"), "courses");
  const repository = await inspectRepository(request.source, repositoriesDirectory);
  openedRepositories.set(repository.id, repository);
  const course = await loadCourse(courseDirectory, repository, request.profile)
    ?? generateStarterCourse(repository, request.profile);
  const skillGraph = buildSkillGraph(repository, course);
  const savedState = await loadLearnerState(path.join(app.getPath("userData"), "learning"), repository.id);
  const learnerState = reconcileLearnerState(repository, skillGraph, savedState);
  return { repository, course, skillGraph, learnerState };
});

ipcMain.handle("repository:read-file", async (_event, request) => {
  if (!request || typeof request.rootPath !== "string" || typeof request.filePath !== "string") {
    throw new Error("Invalid file request.");
  }
  if (![...openedRepositories.values()].some((repository) => repository.rootPath === request.rootPath)) throw new Error("Repository is not open in this workspace.");
  return readRepositoryFile(request.rootPath, request.filePath);
});

ipcMain.handle("agents:detect", () => detectAgents());

ipcMain.handle("agents:ask", async (_event, request) => {
  if (!request || !["codex", "claude"].includes(request.provider)) throw new Error("Choose Codex or Claude first.");
  if (typeof request.rootPath !== "string" || !request.context?.lesson || !request.context?.repository || typeof request.context.question !== "string") {
    throw new Error("Invalid tutor request.");
  }
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
});

ipcMain.handle("course:enhance", async (_event, request) => {
  if (!request || !["codex", "claude"].includes(request.provider)) throw new Error("Choose an available agent first.");
  if (!request.repository?.rootPath || !request.course?.modules) throw new Error("Invalid curriculum request.");
  const repository = openedRepository(request.repository);
  const draft = await generateCourseWithAgent(
    request.provider,
    repository.rootPath,
    repository,
    request.course,
  );
  const course = normalizeAgentCourse(repository, request.course, draft, request.provider);
  await saveCourse(path.join(app.getPath("userData"), "courses"), repository, course);
  return { course, skillGraph: buildSkillGraph(repository, course) };
});

ipcMain.handle("learning:load", async (_event, request) => {
  if (!request?.repository?.id || !request?.skillGraph?.nodes) throw new Error("Invalid learning-state request.");
  const repository = openedRepository(request.repository);
  const saved = await loadLearnerState(path.join(app.getPath("userData"), "learning"), repository.id);
  return reconcileLearnerState(repository, request.skillGraph, saved);
});

ipcMain.handle("learning:save", (_event, state) => {
  if (!openedRepositories.has(state?.repositoryId)) throw new Error("Repository is not open in this workspace.");
  return saveLearnerState(path.join(app.getPath("userData"), "learning"), state);
});

ipcMain.handle("practice:create", async (_event, request) => {
  if (!request?.repository?.rootPath || !request?.lesson?.id) throw new Error("Invalid practice request.");
  return createPracticeSession(openedRepository(request.repository), request.lesson, path.join(app.getPath("userData"), "practice"));
});

ipcMain.handle("practice:inspect", (_event, sessionId) => inspectPracticeSession(sessionId));

ipcMain.handle("practice:open", async (_event, sessionId) => {
  const error = await shell.openPath(getPracticeSessionPath(sessionId));
  if (error) throw new Error(error);
  return true;
});

ipcMain.handle("practice:remove", (_event, request) => removePracticeSession(request?.sessionId, Boolean(request?.discardChanges)));

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
