import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { generateStarterCourse, normalizeAgentCourse } from "../electron/course.mjs";
import { loadCourse, saveCourse } from "../electron/course-store.mjs";
import { createPracticeSession, inspectPracticeSession, removePracticeSession } from "../electron/practice.mjs";
import { fileImportance, inspectRepository, languageFor, readRepositoryFile } from "../electron/repository.mjs";
import { answerFromLocalIndex, buildContextPack } from "../electron/context-engine.mjs";
import { buildSkillGraph, createLearnerState, reconcileLearnerState } from "../electron/skill-graph.mjs";
import { loadLearnerState, saveLearnerState } from "../electron/learning-store.mjs";

const execFileAsync = promisify(execFile);

test("languageFor recognizes common source formats", () => {
  assert.equal(languageFor("src/App.tsx"), "typescript");
  assert.equal(languageFor("service/main.py"), "python");
  assert.equal(languageFor("Dockerfile"), "dockerfile");
  assert.equal(languageFor("include/kernel.cuh"), "cuda");
  assert.ok(fileImportance("src/core.ts") > fileImportance("benchmarks/bench_core.py"));
  assert.ok(fileImportance("README.md") > fileImportance(".private/README.md"));
});

test("repository inspection and starter curriculum stay linked to real files", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "trace-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  await mkdir(path.join(temporaryRoot, "src"));
  await mkdir(path.join(temporaryRoot, "tests"));
  await writeFile(path.join(temporaryRoot, "README.md"), "# Fixture\nA tiny service.");
  await writeFile(path.join(temporaryRoot, "package.json"), '{"name":"fixture"}');
  await writeFile(path.join(temporaryRoot, "src", "index.ts"), "export function startServer() { return true; }\n");
  await writeFile(path.join(temporaryRoot, "tests", "index.test.ts"), "export function verifiesStartup() {}\n");

  const repository = await inspectRepository(temporaryRoot, path.join(temporaryRoot, "clones"));
  const course = generateStarterCourse(repository);

  assert.equal(repository.stats.fileCount, 4);
  assert.ok(repository.symbols.some((symbol) => symbol.name === "startServer"));
  assert.ok(course.modules.length >= 2);
  for (const lesson of course.modules.flatMap((module) => module.lessons)) {
    for (const anchor of lesson.anchors) {
      assert.ok(repository.files.some((file) => file.path === anchor.path), `missing anchor ${anchor.path}`);
    }
  }
});

test("file reader blocks traversal and symlinks outside the repository", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "trace-security-"));
  const repositoryRoot = path.join(temporaryRoot, "repo");
  const outsideFile = path.join(temporaryRoot, "secret.txt");
  await mkdir(repositoryRoot);
  await writeFile(path.join(repositoryRoot, "safe.txt"), "safe");
  await writeFile(outsideFile, "secret");
  await symlink(outsideFile, path.join(repositoryRoot, "escape.txt"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  assert.equal(await readRepositoryFile(repositoryRoot, "safe.txt"), "safe");
  await assert.rejects(() => readRepositoryFile(repositoryRoot, "../secret.txt"), /outside the repository/);
  await assert.rejects(() => readRepositoryFile(repositoryRoot, "escape.txt"), /Symlink target is outside/);
});

test("agent curricula are normalized and cannot anchor to unknown files", () => {
  const repository = {
    id: "repo",
    head: "abc",
    files: [{ path: "src/index.ts" }],
  };
  const starter = {
    title: "Starter",
    subtitle: "Starter subtitle",
    modules: [{ lessons: [{
      id: "fallback",
      title: "Fallback",
      objective: "Fallback objective",
      summary: "Fallback summary",
      duration: 10,
      difficulty: "foundation",
      kind: "lesson",
      anchors: [{ path: "src/index.ts", line: 3, symbol: "start" }],
      quiz: { question: "Why?", hint: "Trace it." },
    }] }],
  };
  const draft = {
    title: "Agent course",
    subtitle: "Deep path",
    modules: [{ id: "flow", title: "Flow", summary: "Trace flow", lessons: [{
      id: "entry",
      title: "Entry",
      objective: "Find input",
      summary: "Read entry",
      duration: 12,
      difficulty: "intermediate",
      kind: "lesson",
      anchor: { path: "../../secret.txt", line: 1, symbol: null },
      quiz: { question: "Input?", hint: "Read signature" },
    }] }],
  };

  const normalized = normalizeAgentCourse(repository, starter, draft, "codex");
  assert.equal(normalized.generatedBy, "codex");
  assert.equal(normalized.modules[0].lessons[0].anchors[0].path, "src/index.ts");
});

test("generated courses are cached by repository version and learner profile", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trace-course-cache-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repository = { id: "repo-cache", versionId: "v1" };
  const course = {
    id: "course-cache",
    repositoryId: repository.id,
    sourceVersion: repository.versionId,
    profile: { goal: "architecture", level: "adaptive" },
    modules: [],
  };
  await saveCourse(directory, repository, course);
  assert.equal((await loadCourse(directory, repository, course.profile))?.id, course.id);
  assert.equal(await loadCourse(directory, { ...repository, versionId: "v2" }, course.profile), null);
  assert.equal(await loadCourse(directory, repository, { goal: "contribute", level: "adaptive" }), null);
});

test("practice runner isolates edits and requires confirmation before discarding them", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "trace-practice-test-"));
  const repositoryRoot = path.join(temporaryRoot, "repo");
  const practiceRoot = path.join(temporaryRoot, "practice");
  await mkdir(repositoryRoot);
  await execFileAsync("git", ["init", repositoryRoot]);
  await execFileAsync("git", ["-C", repositoryRoot, "config", "user.email", "trace@example.com"]);
  await execFileAsync("git", ["-C", repositoryRoot, "config", "user.name", "Trace Test"]);
  await writeFile(path.join(repositoryRoot, "README.md"), "initial\n");
  await execFileAsync("git", ["-C", repositoryRoot, "add", "README.md"]);
  await execFileAsync("git", ["-C", repositoryRoot, "commit", "-m", "initial"]);
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const session = await createPracticeSession(
    { id: "practice-repo", name: "practice-repo", rootPath: repositoryRoot },
    { id: "lesson", title: "Safe change" },
    practiceRoot,
  );
  assert.equal((await inspectPracticeSession(session.id)).clean, true);
  await writeFile(path.join(session.worktreePath, "README.md"), "changed\n");
  const report = await inspectPracticeSession(session.id);
  assert.equal(report.clean, false);
  assert.equal(report.diffCheckPassed, true);
  const guarded = await removePracticeSession(session.id, false);
  assert.equal(guarded.requiresConfirmation, true);
  assert.equal((await removePracticeSession(session.id, true)).removed, true);
  await assert.rejects(() => access(session.worktreePath));
});

test("context packs stay inside budget, explain inclusion, and cache source excerpts", async (context) => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "trace-context-"));
  context.after(() => rm(rootPath, { recursive: true, force: true }));
  await mkdir(path.join(rootPath, "src"));
  await writeFile(path.join(rootPath, "src", "engine.py"), Array.from({ length: 220 }, (_, index) => `${index === 59 ? "def step():" : "# line"} ${index + 1}`).join("\n"));
  const repository = {
    id: "context-repo", rootPath, versionId: "v1", name: "fixture", entryFiles: ["src/engine.py"],
    files: [{ path: "src/engine.py" }], symbols: [{ name: "step", kind: "function", path: "src/engine.py", line: 60 }],
    stats: { fileCount: 1, symbolCount: 1, languages: { python: 1 } },
  };
  const request = {
    mode: "lean", question: "Trace the data flow through step", scope: { selection: false, currentFile: true, lesson: true, dependencies: true },
    lesson: { id: "step", title: "Engine step", objective: "Trace one step", summary: "Schedule and run", anchors: [{ path: "src/engine.py", line: 60, symbol: "step" }] },
    openFile: { path: "src/engine.py", line: 60 }, memory: [],
  };
  const first = await buildContextPack(repository, request);
  const second = await buildContextPack(repository, request);
  assert.ok(first.estimatedTokens <= first.budget);
  assert.ok(first.sections.some((section) => section.source === "src/engine.py:60"));
  assert.ok(first.sections.every((section) => section.reason.length > 0));
  assert.equal(second.cacheHit, true);
  assert.match(answerFromLocalIndex(repository, "Where is step defined?"), /src\/engine\.py:60/);
});

test("skill graphs persist mastery and only mark skills stale when their source changes", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trace-learning-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repository = { id: "skills-repo", versionId: "v1", files: [{ path: "README.md", blobId: "blob-v1" }] };
  const lesson = (id, title) => ({ id, title, objective: title, duration: 10, difficulty: "foundation", anchors: [{ path: "README.md", line: 1, symbol: null }] });
  const course = { generatedBy: "test", modules: [{ title: "Map", lessons: [lesson("map", "Map")], number: "01" }, { title: "Flow", lessons: [lesson("flow", "Flow")], number: "02" }] };
  const graph = buildSkillGraph(repository, course);
  const state = createLearnerState(repository, graph);
  state.mastery[graph.nodes[0].id].mastery = 0.9;
  state.mastery[graph.nodes[0].id].status = "mastered";
  await saveLearnerState(directory, state);
  const saved = await loadLearnerState(directory, repository.id);
  assert.equal(saved.mastery[graph.nodes[0].id].mastery, 0.9);
  const unrelatedRepository = { ...repository, versionId: "v1-unrelated" };
  const unrelatedGraph = buildSkillGraph(unrelatedRepository, course);
  const preserved = reconcileLearnerState(unrelatedRepository, unrelatedGraph, saved);
  assert.equal(preserved.mastery[graph.nodes[0].id].status, "mastered");
  const changedRepository = { ...repository, versionId: "v2", files: [{ path: "README.md", blobId: "blob-v2" }] };
  const changedGraph = buildSkillGraph(changedRepository, course);
  const reconciled = reconcileLearnerState(changedRepository, changedGraph, saved);
  assert.equal(reconciled.mastery[graph.nodes[0].id].status, "stale");
});
