import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { generateStarterCourse, normalizeAgentCourse } from "../electron/course.mjs";
import { loadCourse, saveCourse } from "../electron/course-store.mjs";
import { createPracticeSession, inspectPracticeSession, removePracticeSession } from "../electron/practice.mjs";
import { analysisCacheStats, analyzeFile, fileImportance, inspectRepository, languageFor, readRepositoryFile, resetAnalysisCache } from "../electron/repository.mjs";
import { buildKnowledgeGraph, loadKnowledgeGraph, neighborhood, saveKnowledgeGraph } from "../electron/knowledge-graph.mjs";
import { analyzeSource, treeSitterSupports } from "../electron/tree-sitter-index.mjs";
import { detectLanguageServers, resolveImportsStatically, resolveSymbol, serverForLanguage, shutdownLanguageServers } from "../electron/language-server.mjs";
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

test("tree-sitter indexing yields definitions, references, and call edges", async (context) => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "trace-treesitter-"));
  context.after(() => rm(rootPath, { recursive: true, force: true }));
  await mkdir(path.join(rootPath, "engine"));
  await writeFile(
    path.join(rootPath, "engine", "runner.py"),
    [
      "class Runner:",
      "    def start(self, request):",
      "        prepared = normalize(request)",
      "        return self.execute(prepared)",
      "",
      "    def execute(self, payload):",
      "        return payload",
      "",
      "def normalize(request):",
      "    return request",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(rootPath, "engine", "index.ts"),
    [
      "export interface Job { id: string }",
      "export class Queue {",
      "  push(job: Job) { return schedule(job); }",
      "}",
      "export function schedule(job: Job) { return job.id; }",
      "",
    ].join("\n"),
  );

  assert.equal(treeSitterSupports("python", "engine/runner.py"), true);
  assert.equal(treeSitterSupports("markdown", "README.md"), false);

  const pythonAnalysis = await analyzeSource(
    "engine/runner.py",
    "python",
    "class A:\n    def run(self, value):\n        return helper(value)\n\ndef helper(value):\n    return value\n",
  );
  assert.equal(pythonAnalysis.indexer, "tree-sitter");
  assert.deepEqual(
    pythonAnalysis.definitions.map((definition) => `${definition.kind}:${definition.name}:${definition.line}`),
    ["class:A:1", "function:run:2", "function:helper:5"],
  );
  assert.ok(pythonAnalysis.definitions.every((definition) => definition.endLine >= definition.line));
  assert.equal(pythonAnalysis.definitions.find((definition) => definition.name === "run").container, "A");
  assert.deepEqual(
    pythonAnalysis.callEdges.map((edge) => `${edge.caller}->${edge.callee}@${edge.line}`),
    ["run->helper@3"],
  );
  assert.equal(pythonAnalysis.resolvedCallEdges, 1);
  assert.deepEqual(pythonAnalysis.references.map((reference) => reference.name), ["helper"]);

  const typescriptAnalysis = await analyzeFile(rootPath, {
    path: "engine/index.ts",
    language: "typescript",
    size: 200,
  });
  assert.equal(typescriptAnalysis.indexer, "tree-sitter");
  assert.ok(typescriptAnalysis.symbols.some((symbol) => symbol.kind === "interface" && symbol.name === "Job"));
  assert.ok(typescriptAnalysis.symbols.some((symbol) => symbol.kind === "class" && symbol.name === "Queue"));
  assert.ok(typescriptAnalysis.symbols.some((symbol) => symbol.kind === "method" && symbol.name === "push"));
  assert.ok(typescriptAnalysis.callEdges.some((edge) => edge.caller === "push" && edge.callee === "schedule"));

  const repository = await inspectRepository(rootPath, path.join(rootPath, "clones"));
  assert.equal(repository.stats.indexer, "tree-sitter");
  assert.ok(repository.stats.referenceCount > 0);
  assert.ok(repository.stats.resolvedCallEdgeCount >= 2);
  const resolvedPythonEdge = repository.callEdges.find((edge) => edge.callee === "normalize" && edge.resolved);
  assert.equal(resolvedPythonEdge.caller, "start");
  assert.equal(resolvedPythonEdge.targetPath, "engine/runner.py");
  assert.equal(resolvedPythonEdge.targetLine, 9);

  // Languages without a grammar still index through the deterministic regex path.
  const fallback = await analyzeFile(rootPath, { path: "engine/legacy.txt", language: "plaintext", size: 10 });
  assert.equal(fallback.indexer, "none");
});

test("import resolution degrades from language servers to the static index", async (context) => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "trace-lsp-"));
  context.after(async () => {
    await shutdownLanguageServers();
    await rm(rootPath, { recursive: true, force: true });
  });
  await mkdir(path.join(rootPath, "pkg", "engine"), { recursive: true });
  await writeFile(path.join(rootPath, "pkg", "__init__.py"), "");
  await writeFile(path.join(rootPath, "pkg", "engine", "__init__.py"), "");
  await writeFile(path.join(rootPath, "pkg", "engine", "core.py"), "def run():\n    return 1\n");
  await writeFile(
    path.join(rootPath, "pkg", "engine", "app.py"),
    "import os\nfrom pkg.engine.core import run\nfrom .core import run as run_again\n\ndef main():\n    return run()\n",
  );
  await writeFile(path.join(rootPath, "web", "index.ts"), "").catch(() => undefined);
  await mkdir(path.join(rootPath, "web"), { recursive: true });
  await writeFile(path.join(rootPath, "web", "util.ts"), "export const identity = (value: string) => value;\n");
  await writeFile(path.join(rootPath, "web", "index.ts"), "import { identity } from './util';\nexport const go = () => identity('x');\n");

  const repository = await inspectRepository(rootPath, path.join(rootPath, "clones"));
  const appImports = repository.imports.filter((item) => item.path === "pkg/engine/app.py");
  assert.ok(appImports.some((item) => item.specifier === "pkg.engine.core" && item.targetPath === "pkg/engine/core.py"));
  assert.ok(appImports.some((item) => item.specifier === ".core" && item.targetPath === "pkg/engine/core.py"));
  // A third-party module is reported but honestly marked unresolved.
  assert.equal(appImports.find((item) => item.specifier === "os").resolved, false);
  const webImports = repository.imports.filter((item) => item.path === "web/index.ts");
  assert.equal(webImports[0].targetPath, "web/util.ts");
  assert.ok(repository.stats.resolvedImportCount >= 3);
  assert.ok(repository.stats.importCount > repository.stats.resolvedImportCount);

  // Re-resolution is pure and repeatable.
  assert.deepEqual(resolveImportsStatically(repository, appImports).map((item) => item.targetPath), appImports.map((item) => item.targetPath));

  const servers = await detectLanguageServers();
  assert.ok(Object.keys(servers).length >= 6);
  assert.ok(Object.values(servers).every((record) => typeof record.available === "boolean"));

  // A language with no installed server must degrade instead of throwing.
  const missing = await resolveSymbol(rootPath, { path: "pkg/engine/app.py", line: 6, column: 12, language: "cobol" }, { detected: servers });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /No language server is installed/);
  assert.equal(serverForLanguage("cobol", servers), null);
});

test("language server client resolves definitions and types when a server is installed", async (context) => {
  const servers = await detectLanguageServers();
  const server = serverForLanguage("c", servers) ?? serverForLanguage("typescript", servers) ?? serverForLanguage("python", servers);
  if (!server) {
    // Recorded blocker: no language server binary is available on this machine.
    context.skip("No supported language server binary is installed.");
    return;
  }
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "trace-lsp-live-"));
  context.after(async () => {
    await shutdownLanguageServers();
    await rm(rootPath, { recursive: true, force: true });
  });
  const language = server.languages[0];
  const fixtures = {
    c: { file: "main.c", source: "int helper(int value) { return value + 1; }\n\nint main(void) {\n  return helper(41);\n}\n", line: 4, column: 10 },
    typescript: { file: "main.ts", source: "export function helper(value: number) { return value + 1; }\nexport const go = () => helper(41);\n", line: 2, column: 26 },
    python: { file: "main.py", source: "def helper(value):\n    return value + 1\n\n\ndef go():\n    return helper(41)\n", line: 6, column: 12 },
  };
  const fixture = fixtures[language];
  await writeFile(path.join(rootPath, fixture.file), fixture.source);

  const resolved = await resolveSymbol(
    rootPath,
    { path: fixture.file, line: fixture.line, column: fixture.column, language },
    { detected: servers, timeoutMs: 45_000 },
  );
  assert.equal(resolved.available, true, `resolution failed: ${resolved.reason}`);
  assert.equal(resolved.server, server.id);
  assert.ok(resolved.definitions.length >= 1, JSON.stringify(resolved));
  assert.equal(resolved.definitions[0].path, fixture.file);
  assert.equal(resolved.definitions[0].line, 1);
  assert.ok(Array.isArray(resolved.overloads));
  assert.ok(Array.isArray(resolved.implementations));
  assert.equal(typeof resolved.dynamicDispatch, "boolean");
  assert.match(resolved.type ?? "", /helper/);
});

test("the knowledge graph is versioned and rebuilds incrementally", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "trace-graph-"));
  const rootPath = path.join(workspace, "repo");
  const graphDirectory = path.join(workspace, "graphs");
  await mkdir(rootPath, { recursive: true });
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(path.join(rootPath, "app"), { recursive: true });
  await writeFile(path.join(rootPath, "app", "__init__.py"), "");
  await writeFile(path.join(rootPath, "app", "core.py"), "def helper(value):\n    return value\n");
  await writeFile(path.join(rootPath, "app", "runner.py"), "from app.core import helper\n\n\ndef run(value):\n    return helper(value)\n");
  await writeFile(path.join(rootPath, "app", "stable.py"), "def untouched():\n    return 7\n");
  await execFileAsync("git", ["init", rootPath]);
  await execFileAsync("git", ["-C", rootPath, "config", "user.email", "trace@example.com"]);
  await execFileAsync("git", ["-C", rootPath, "config", "user.name", "Trace Test"]);
  await execFileAsync("git", ["-C", rootPath, "add", "."]);
  await execFileAsync("git", ["-C", rootPath, "commit", "-m", "initial"]);

  resetAnalysisCache();
  const first = await inspectRepository(rootPath, path.join(workspace, "clones"));
  const firstGraph = buildKnowledgeGraph(first);
  assert.equal(firstGraph.format, "kg-v1");
  assert.equal(firstGraph.version, first.versionId);
  assert.equal(firstGraph.previousVersion, null);
  assert.equal(firstGraph.stats.reusedPartitions, 0);
  assert.equal(firstGraph.stats.rebuiltPartitions, first.files.length);
  assert.ok(firstGraph.nodes.some((node) => node.id === "file:app/runner.py"));
  assert.ok(firstGraph.nodes.some((node) => node.kind === "symbol" && node.label === "helper"));
  assert.ok(firstGraph.edges.some((edge) => edge.kind === "imports" && edge.from === "file:app/runner.py" && edge.to === "file:app/core.py" && edge.resolved));
  assert.ok(firstGraph.edges.some((edge) => edge.kind === "calls" && edge.callee === "helper" && edge.resolved));
  assert.equal(firstGraph.stats.danglingEdges, 0);

  await saveKnowledgeGraph(graphDirectory, firstGraph);
  const reloaded = await loadKnowledgeGraph(graphDirectory, first.id);
  assert.equal(reloaded.version, firstGraph.version);
  assert.equal(await loadKnowledgeGraph(graphDirectory, "some-other-repository"), null);

  // Rebuilding with no source change reuses every partition and re-parses nothing.
  const hitsBefore = analysisCacheStats().hits;
  const unchanged = await inspectRepository(rootPath, path.join(workspace, "clones"));
  assert.ok(analysisCacheStats().hits > hitsBefore, "expected the per-blob analysis cache to serve unchanged files");
  const unchangedGraph = buildKnowledgeGraph(unchanged, { previous: reloaded });
  assert.equal(unchangedGraph.version, firstGraph.version);
  assert.equal(unchangedGraph.stats.rebuiltPartitions, 0);
  assert.equal(unchangedGraph.stats.reusedPartitions, unchanged.files.length);

  // Changing one file invalidates that file and its dependents only.
  await writeFile(path.join(rootPath, "app", "core.py"), "def helper(value):\n    return value + 1\n\n\ndef extra():\n    return 2\n");
  const changed = await inspectRepository(rootPath, path.join(workspace, "clones"));
  assert.notEqual(changed.versionId, first.versionId);
  const changedGraph = buildKnowledgeGraph(changed, { previous: unchangedGraph });
  assert.equal(changedGraph.previousVersion, firstGraph.version);
  assert.equal(changedGraph.version, changed.versionId);
  assert.ok(changedGraph.stats.rebuiltPartitions >= 2, JSON.stringify(changedGraph.stats));
  assert.ok(changedGraph.stats.rebuiltPartitions < changed.files.length, "unrelated files must be reused");
  assert.equal(changedGraph.stats.invalidatedByDependency >= 1, true);
  assert.equal(changedGraph.partitions.find((partition) => partition.path === "app/stable.py").digest,
    firstGraph.partitions.find((partition) => partition.path === "app/stable.py").digest);
  assert.notEqual(changedGraph.partitions.find((partition) => partition.path === "app/core.py").digest,
    firstGraph.partitions.find((partition) => partition.path === "app/core.py").digest);
  assert.ok(changedGraph.nodes.some((node) => node.kind === "symbol" && node.label === "extra"));

  // Deleting a file removes its partition and leaves no stale resolved edge behind.
  await rm(path.join(rootPath, "app", "stable.py"));
  const afterDelete = await inspectRepository(rootPath, path.join(workspace, "clones"));
  const deletedGraph = buildKnowledgeGraph(afterDelete, { previous: changedGraph });
  assert.equal(deletedGraph.stats.removedPartitions, 1);
  assert.equal(deletedGraph.nodes.some((node) => node.id === "file:app/stable.py"), false);
  assert.equal(deletedGraph.edges.some((edge) => edge.to === "file:app/stable.py"), false);

  const around = neighborhood(changedGraph, "file:app/runner.py", 1);
  assert.ok(around.nodes.some((node) => node.id === "file:app/core.py"));
  assert.ok(around.edges.every((edge) => edge.from === "file:app/runner.py" || edge.to === "file:app/runner.py"));
  const callsOnly = neighborhood(changedGraph, "file:app/runner.py", 1, ["imports"]);
  assert.ok(callsOnly.edges.every((edge) => edge.kind === "imports"));
});

test("the production entry bundle excludes Monaco and stays inside its budget", async (context) => {
  const distDirectory = path.resolve("dist");
  let entryHtml;
  try {
    entryHtml = await readFile(path.join(distDirectory, "index.html"), "utf8");
  } catch {
    context.skip("Run `npm run build` before this test to check the bundle budget.");
    return;
  }
  const assetDirectory = path.join(distDirectory, "assets");
  const assets = await readdir(assetDirectory);

  // Everything the browser downloads before any interaction.
  const eagerScripts = [...entryHtml.matchAll(/<script[^>]+src="\.\/assets\/([^"]+)"/g)].map((match) => match[1]);
  const modulePreloads = [...entryHtml.matchAll(/rel="modulepreload"[^>]+href="\.\/assets\/([^"]+)"/g)].map((match) => match[1]);
  const eager = [...new Set([...eagerScripts, ...modulePreloads])];
  assert.equal(eagerScripts.length, 1, `expected a single entry script, got ${eagerScripts.join(", ")}`);

  let eagerBytes = 0;
  for (const asset of eager) {
    const source = await readFile(path.join(assetDirectory, asset), "utf8");
    eagerBytes += Buffer.byteLength(source);
    assert.equal(/monaco-editor\/esm\/vs\/editor\/editor\.main/.test(source), false, `${asset} statically bundles the Monaco editor core`);
    assert.equal(/createMonacoBaseAPI|StandaloneEditor/.test(source), false, `${asset} statically bundles Monaco internals`);
  }
  assert.ok(eagerBytes < 320_000, `eager bundle grew to ${eagerBytes} bytes across ${eager.join(", ")}`);

  // Monaco still ships, but only as separately fetchable chunks.
  const monacoCore = assets.filter((asset) => /^editor\.api-.*\.js$/.test(asset));
  assert.equal(monacoCore.length, 1, `expected one lazy Monaco core chunk, got ${monacoCore.join(", ")}`);
  assert.equal(eager.includes(monacoCore[0]), false, "the Monaco core must not be preloaded by the entry");
  const monacoBytes = Buffer.byteLength(await readFile(path.join(assetDirectory, monacoCore[0]), "utf8"));
  assert.ok(monacoBytes > 1_000_000, "sanity check: the lazy chunk really is the Monaco core");

  // Language grammars are individually fetchable rather than bundled together.
  for (const language of ["python", "typescript", "cpp", "rust", "go"]) {
    assert.ok(assets.some((asset) => asset.startsWith(`${language}-`) && asset.endsWith(".js")), `missing lazy chunk for ${language}`);
  }
  const workerChunk = assets.find((asset) => asset.startsWith("editor.worker-"));
  assert.ok(workerChunk, "the editor worker must be emitted as its own chunk");
  assert.equal(eager.includes(workerChunk), false, "the editor worker must not be preloaded by the entry");
});
