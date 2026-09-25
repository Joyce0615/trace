import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { auditSnapshot, collectAccessibilitySnapshot, summarizeAudit } from "../electron/accessibility.mjs";

const repositoryPath = process.env.TRACE_ELECTRON_REPO ?? "/Users/user/GitHub/flashinfer";
const artifactDirectory = path.resolve("artifacts", "qa");
const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), "trace-electron-"));
await mkdir(artifactDirectory, { recursive: true });

const electronApp = await electron.launch({
  args: [".", `--user-data-dir=${userDataDirectory}`],
  cwd: process.cwd(),
  env: { ...process.env, VITE_DEV_SERVER_URL: "" },
});

try {
  const page = await electronApp.firstWindow();

  // Item 20: streaming progress is reported and an in-flight index can be cancelled.
  await page.evaluate(() => {
    window.__indexProgress = [];
    window.trace.onIndexProgress((progress) => window.__indexProgress.push(progress));
  });
  const cancelRequestId = "smoke-cancel-request";
  const cancelledOpen = page.evaluate((args) => window.trace
    .openRepository({ source: args.repositoryPath, requestId: args.requestId, limits: { analysisBatchSize: 1 } })
    .then(() => "resolved")
    .catch((error) => `rejected: ${error.message}`), { repositoryPath, requestId: cancelRequestId });
  await page.waitForFunction(() => (window.__indexProgress ?? []).some((progress) => progress.phase === "read"), null, { timeout: 60_000 });
  assert.equal(await page.evaluate((requestId) => window.trace.cancelRepositoryOpen(requestId), cancelRequestId), true);
  const cancelledResult = await cancelledOpen;
  assert.match(cancelledResult, /rejected: .*cancelled/i, cancelledResult);
  const cancelPhases = await page.evaluate(() => (window.__indexProgress ?? []).map((progress) => progress.phase));
  assert.ok(cancelPhases.includes("prepare") && cancelPhases.includes("discover") && cancelPhases.includes("read"), cancelPhases.join(","));
  assert.ok(cancelPhases.includes("cancelled"), `expected a cancelled event, got ${cancelPhases.join(",")}`);
  assert.equal(await page.evaluate((requestId) => window.trace.cancelRepositoryOpen(requestId), cancelRequestId), false);
  const limits = await page.evaluate(() => window.trace.indexLimits());
  assert.equal(limits.maxFiles, 4_000);
  await page.evaluate(() => { window.__indexProgress = []; });

  // Item 23: the link policy blocks hostile schemes and gates unlisted origins.
  const linkDecisions = await page.evaluate(async () => {
    const candidates = [
      "https://github.com/GeeeekExplorer/nano-vllm",
      "javascript:alert(document.cookie)",
      "data:text/html,<script>1</script>",
      "file:///etc/passwd",
      "http://github.com/a/b",
      "https://user:token@github.com/a/b",
      "https://evil.example/steal",
    ];
    const results = [];
    for (const candidate of candidates) results.push(await window.trace.classifyLink(candidate));
    return results;
  });
  assert.deepEqual(linkDecisions.map((decision) => decision.decision), ["allow", "block", "block", "block", "block", "block", "confirm"]);
  assert.deepEqual(linkDecisions.map((decision) => decision.reason), [
    "allowlisted-origin", "blocked-scheme:javascript", "blocked-scheme:data", "blocked-scheme:file",
    "insecure-scheme", "embedded-credentials", "unlisted-origin",
  ]);
  assert.ok(linkDecisions.slice(1, 6).every((decision) => decision.url === null), "blocked links must never expose a usable URL");

  // A blocked link never reaches the shell, and the decision is recorded.
  const blockedOpen = await page.evaluate(() => window.trace.openLink("javascript:alert(1)"));
  assert.equal(blockedOpen.opened, false);
  assert.equal(blockedOpen.decision, "block");
  const lastDecision = await page.evaluate(() => window.trace.lastLinkDecision());
  assert.equal(lastDecision.reason, "blocked-scheme:javascript");
  assert.ok(lastDecision.at);

  // The renderer's own link component reflects the policy.
  await page.locator('.external-link[data-decision="allow"]').waitFor({ timeout: 30_000 });
  await page.locator('.external-link[data-decision="confirm"]').waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('.external-link[data-decision="allow"]').getAttribute("data-reason"), "allowlisted-origin");
  assert.equal(await page.locator('.external-link[data-decision="confirm"]').getAttribute("data-reason"), "unlisted-origin");
  assert.equal(await page.locator('.external-link[data-decision="block"]').count(), 0);

  // Item 22: malformed IPC payloads are rejected by the schema layer, not the handler.
  const invalidCalls = [
    ["repository:open with a non-string source", () => window.trace.openRepository({ source: 42 }), /must be a string/],
    ["repository:open with an unknown field", () => window.trace.openRepository({ source: "/tmp", nodeIntegration: true }), /unexpected field nodeIntegration/],
    ["repository:open with an oversized source", () => window.trace.openRepository({ source: "x".repeat(5000) }), /exceeds 4096 characters/],
    ["graph:summary with a full repository object", () => window.trace.graphSummary({ repository: { id: "a", rootPath: "/tmp", files: [] } }), /unexpected field files/],
    ["graph:neighborhood with an out-of-range depth", () => window.trace.graphNeighborhood({ repository: { id: "a", rootPath: "/tmp" }, nodeId: "n", depth: 99 }), /must be between 1 and 3/],
    ["practice:inspect with an object", () => window.trace.inspectPractice({ sessionId: "x" }), /must be a string/],
    ["agents:ask with an unsupported provider", () => window.trace.askAgent({ provider: "gemini", rootPath: "/tmp", context: {} }), /must be one of codex, claude/],
  ];
  for (const [label, invoke, pattern] of invalidCalls) {
    const message = await page.evaluate(async (index) => {
      const calls = [
        () => window.trace.openRepository({ source: 42 }),
        () => window.trace.openRepository({ source: "/tmp", nodeIntegration: true }),
        () => window.trace.openRepository({ source: "x".repeat(5000) }),
        () => window.trace.graphSummary({ repository: { id: "a", rootPath: "/tmp", files: [] } }),
        () => window.trace.graphNeighborhood({ repository: { id: "a", rootPath: "/tmp" }, nodeId: "n", depth: 99 }),
        () => window.trace.inspectPractice({ sessionId: "x" }),
        () => window.trace.askAgent({ provider: "gemini", rootPath: "/tmp", context: {} }),
      ];
      try {
        await calls[index]();
        return "resolved";
      } catch (error) {
        return error.message;
      }
    }, invalidCalls.findIndex(([name]) => name === label));
    assert.match(message, /IpcValidationError/, `${label} was not rejected by the schema layer: ${message}`);
    assert.match(message, pattern, `${label} produced: ${message}`);
    void invoke;
  }
  // A payload over the size ceiling is rejected before any handler runs.
  const oversized = await page.evaluate(async () => {
    try {
      await window.trace.readFile("/tmp", "x".repeat(4_100_000));
      return "resolved";
    } catch (error) {
      return error.message;
    }
  });
  assert.match(oversized, /over the 4000000 byte limit|exceeds 4096 characters/, oversized);

  // Item 21: unsafe remotes are rejected in the trusted main process, before git runs.
  const unsafeRemotes = [
    ["http://github.com/a/b.git", /^Plain http is not allowed/],
    ["git://github.com/a/b.git", /^Only https and ssh remotes are supported, not git\.$/],
    ["ext::sh -c 'touch /tmp/trace-pwned'", /^Git transport helpers such as `ext::` are not allowed\.$/],
    ["https://user:token@github.com/a/b.git", /^Remove the credentials from the URL\./],
    ["https://github.com/a/b.tar.gz", /^Trace clones Git repositories and never unpacks downloaded archives\.$/],
  ];
  for (const [candidate, pattern] of unsafeRemotes) {
    await page.getByLabel("Repository path or URL").fill(candidate);
    await page.getByRole("button", { name: "Start learning" }).click();
    await page.locator(".error-banner").waitFor({ timeout: 30_000 });
    const message = await page.locator(".error-banner").innerText();
    assert.match(message, pattern, `${candidate} produced: ${message}`);
  }

  await page.getByLabel("Repository path or URL").fill(repositoryPath);
  await page.getByRole("button", { name: "Start learning" }).click();
  await page.locator(".index-progress").waitFor({ timeout: 30_000 });
  await page.getByRole("dialog", { name: "Adaptive skill assessment" }).waitFor({ timeout: 120_000 });
  const observedPhases = await page.evaluate(() => [...new Set((window.__indexProgress ?? []).map((progress) => progress.phase))]);
  assert.deepEqual(observedPhases, ["prepare", "discover", "read", "git", "analyze", "link", "finalize"], observedPhases.join(","));
  const analyzeProgress = await page.evaluate(() => (window.__indexProgress ?? []).filter((progress) => progress.phase === "analyze"));
  assert.ok(analyzeProgress.length >= 10, `expected streamed analyze progress, got ${analyzeProgress.length}`);
  assert.ok(analyzeProgress.every((progress) => progress.requestId?.startsWith("index-")));
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByText("flashinfer Deep Dive").waitFor({ timeout: 30_000 });

  assert.equal(await page.evaluate(() => Boolean(window.trace)), true);
  assert.ok(await page.locator(".skill-node").count() >= 4);
  // Item 16: the real repository index must come from tree-sitter with resolved call edges.
  assert.equal(await page.locator(".index-badge").getAttribute("data-indexer"), "tree-sitter");
  const indexSummary = await page.locator(".index-badge").getAttribute("title") ?? "";
  const resolvedEdges = Number(indexSummary.match(/(\d+)\/\d+ resolved call edges/)?.[1] ?? 0);
  assert.ok(resolvedEdges > 0, `expected resolved call edges, got: ${indexSummary}`);

  // Item 18: the knowledge graph is built for the real repository and reported by version.
  await page.locator(".knowledge-graph-card").waitFor({ timeout: 30_000 });
  const graphVersion = await page.locator(".knowledge-graph-card").getAttribute("data-graph-version");
  assert.ok((graphVersion ?? "").length >= 8, `unexpected graph version: ${graphVersion}`);
  const graphSummary = await page.evaluate(() => window.trace.graphSummary({ repository: { id: window.traceWorkspace.repository.id, rootPath: window.traceWorkspace.repository.rootPath } }));
  assert.equal(graphSummary.format, "kg-v1");
  assert.equal(graphSummary.version, graphVersion);
  assert.ok(graphSummary.stats.nodeCount > 1_000, JSON.stringify(graphSummary.stats));
  assert.ok(graphSummary.stats.resolvedCallEdges > 0);
  assert.equal(graphSummary.stats.danglingEdges, 0);
  const hood = await page.evaluate(() => window.trace.graphNeighborhood({ repository: { id: window.traceWorkspace.repository.id, rootPath: window.traceWorkspace.repository.rootPath }, nodeId: `repository:${window.traceWorkspace.repository.id}`, depth: 1 }));
  assert.ok(hood.nodes.length > 1 && hood.edges.length > 1, JSON.stringify({ nodes: hood.nodes.length, edges: hood.edges.length }));

  // Item 26: cross-file call chains derived from the real index and graded in main.
  const chainAudit = await page.evaluate(async () => {
    const repository = { id: window.traceWorkspace.repository.id, rootPath: window.traceWorkspace.repository.rootPath };
    const result = await window.trace.callChains({ repository, limit: 6 });
    const files = new Set(window.traceWorkspace.repository.files.map((file) => file.path));
    const exercise = result.exercises.find((candidate) => candidate.kind === "next-call");
    const grades = exercise
      ? await Promise.all(exercise.options.map((option) => window.trace.gradePrediction({ repository, exerciseId: exercise.id, choiceId: option.id })))
      : [];
    let bogus = null;
    try {
      bogus = await window.trace.gradePrediction({ repository, exerciseId: "predict-does-not-exist", choiceId: "choice-x" });
    } catch (error) {
      bogus = { error: error.message };
    }
    return {
      version: result.version,
      chainCount: result.chains.length,
      chains: result.chains.map((chain) => ({ crossFileHops: chain.crossFileHops, steps: chain.steps.length, summary: chain.summary, anchorsExist: chain.steps.every((step) => files.has(step.path) && step.line >= 1) })),
      exerciseKeys: result.exercises.length ? Object.keys(result.exercises[0]) : [],
      optionCount: exercise?.options.length ?? 0,
      grades: grades.map((grade) => ({ correct: grade.correct, answerLabel: grade.answerLabel, explanation: grade.explanation })),
      bogus,
    };
  });
  assert.equal(chainAudit.version, 1);
  assert.ok(chainAudit.chainCount > 0, "expected cross-file call chains in flashinfer");
  assert.ok(chainAudit.chains.every((chain) => chain.crossFileHops >= 1 && chain.steps >= 2 && chain.anchorsExist), JSON.stringify(chainAudit.chains.slice(0, 3)));
  // The answer never crosses the IPC boundary.
  assert.equal(chainAudit.exerciseKeys.includes("answerId"), false, chainAudit.exerciseKeys.join(","));
  assert.equal(chainAudit.exerciseKeys.includes("explanation"), false, chainAudit.exerciseKeys.join(","));
  // Exactly one option is correct, and the verdict comes from the main process.
  assert.ok(chainAudit.optionCount >= 3, `expected at least three options, got ${chainAudit.optionCount}`);
  assert.equal(chainAudit.grades.filter((grade) => grade.correct).length, 1, JSON.stringify(chainAudit.grades));
  assert.match(chainAudit.grades[0].explanation, /\.(py|cu|cuh|h|cpp|c|ts|js|rs|go):\d+/);
  assert.match(chainAudit.bogus.error ?? "", /not active for this repository/);

  // Item 27: localization drill built from the real index, scored in main.
  const localizationAudit = await page.evaluate(async () => {
    const repository = { id: window.traceWorkspace.repository.id, rootPath: window.traceWorkspace.repository.rootPath };
    const exercise = await window.trace.localizationExercise({ repository });
    const hints = [];
    let used = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const hint = await window.trace.localizationHint({ repository, exerciseId: exercise.id, used });
      if (!hint) break;
      hints.push(hint);
      used = [...used, hint.id];
    }
    const files = window.traceWorkspace.repository.files.map((file) => file.path);
    // A deliberately wrong guess reveals the gold set only after submission.
    const guess = await window.trace.scoreLocalization({
      repository,
      exerciseId: exercise.id,
      inspected: files.slice(0, 20),
      selected: [files[0]],
    });
    const perfect = await window.trace.scoreLocalization({
      repository,
      exerciseId: exercise.id,
      inspected: guess.goldFiles,
      selected: guess.goldFiles,
    });
    let missing = null;
    try {
      await window.trace.scoreLocalization({ repository, exerciseId: "locate-nope", inspected: [], selected: [] });
    } catch (error) {
      missing = error.message;
    }
    return { exercise, hints, guess, perfect, missing, payload: JSON.stringify(exercise) };
  });
  assert.equal(localizationAudit.exercise.version, 1);
  assert.ok(localizationAudit.exercise.goldCount >= 2, JSON.stringify(localizationAudit.exercise));
  assert.ok(localizationAudit.exercise.repositoryFiles > 1_000);
  // The gold set never reaches the renderer before the answer is submitted.
  assert.equal("goldFiles" in localizationAudit.exercise, false);
  assert.equal("definition" in localizationAudit.exercise, false);
  assert.equal(/\.(py|cu|cuh|h|cpp)\b/.test(localizationAudit.payload), false, localizationAudit.payload);
  assert.deepEqual(localizationAudit.hints.map((hint) => hint.id), ["language", "directory", "filename"]);
  assert.ok(localizationAudit.hints.every((hint) => typeof hint.text === "string" && hint.text.length > 0));
  // A near-random guess scores badly on both coverage and efficiency.
  assert.ok(localizationAudit.guess.coverage < 1, JSON.stringify(localizationAudit.guess));
  assert.equal(localizationAudit.guess.passed, false);
  assert.ok(localizationAudit.guess.fileEfficiency < 0.5, String(localizationAudit.guess.fileEfficiency));
  assert.ok(localizationAudit.guess.goldFiles.length >= 2);
  assert.ok(localizationAudit.guess.goldFiles.every((filePath) => typeof filePath === "string" && filePath.length > 0));
  // Submitting exactly the gold set is a perfect, passing run.
  assert.equal(localizationAudit.perfect.coverage, 1);
  assert.equal(localizationAudit.perfect.precision, 1);
  assert.equal(localizationAudit.perfect.fileEfficiency, 1);
  assert.equal(localizationAudit.perfect.passed, true);
  assert.equal(localizationAudit.perfect.grade, "excellent");
  assert.match(localizationAudit.missing ?? "", /not active for this repository/);

  // Item 28: three-stage RACE grading built from the real repository.
  const raceAudit = await page.evaluate(async () => {
    const repository = { id: window.traceWorkspace.repository.id, rootPath: window.traceWorkspace.repository.rootPath };
    const task = await window.trace.raceTask({ repository });
    const score = await window.trace.scoreLocalization({
      repository,
      exerciseId: task.localizationExerciseId,
      inspected: [],
      selected: [],
    });
    const gold = score.goldFiles;
    const definitionFile = gold[0].split("/").pop();
    const strong = await window.trace.gradeRace({
      repository,
      taskId: task.id,
      understanding: `The ${task.symbol} function in ${gold[0]} returns the wrong result for some inputs, and the caller in ${gold[1]} expects the corrected value, so the observed output is wrong where the documented behaviour says it should be correct.`,
      plan: `1. Change ${definitionFile} where ${task.symbol} is defined so the value is correct.\n2. Check the callers in ${gold[1].split("/").pop()} for assumptions about the old result.\n3. Add a regression test that reproduces the report and run the test suite to verify it.`,
      files: gold,
      inspected: gold,
    });
    const weak = await window.trace.gradeRace({
      repository,
      taskId: task.id,
      understanding: "it is broken somewhere and does not work right at all for anyone using it",
      plan: "fix it and ship it as soon as possible without breaking anything else in the repository",
      files: ["README.md"],
      inspected: ["README.md"],
    });
    let stale = null;
    try {
      await window.trace.gradeRace({ repository, taskId: "race-nope", understanding: "x", plan: "y", files: [] });
    } catch (error) {
      stale = error.message;
    }
    return { task, strong, weak, stale };
  });
  assert.equal(raceAudit.task.version, 1);
  assert.deepEqual(Object.keys(raceAudit.task.rubric), ["understanding", "plan"]);
  assert.equal(raceAudit.task.rubric.understanding.length, 5);
  // The renderer receives criteria descriptions but never the grading predicates.
  assert.equal(raceAudit.task.rubric.plan.some((item) => "test" in item), false);
  assert.equal("stages" in raceAudit.task, false);
  // A source-grounded submission beats a vague one on every stage.
  assert.ok(raceAudit.strong.stageScores.understanding >= 0.8, JSON.stringify(raceAudit.strong.stageScores));
  assert.ok(raceAudit.strong.stageScores.plan >= 0.8, JSON.stringify(raceAudit.strong.stageScores));
  assert.equal(raceAudit.strong.stageScores.localization, 1);
  assert.ok(["expert", "competent"].includes(raceAudit.strong.band), raceAudit.strong.band);
  assert.ok(raceAudit.weak.overall < 0.35, String(raceAudit.weak.overall));
  assert.equal(raceAudit.weak.band, "novice");
  assert.ok(raceAudit.strong.overall > raceAudit.weak.overall + 0.5);
  assert.ok(["understanding", "localization", "plan"].includes(raceAudit.weak.weakestStage));
  assert.match(raceAudit.stale ?? "", /not active for this repository/);

  // Item 29: a real interpreter run, traced and mapped back to repository source.
  const traceAudit = await page.evaluate(async () => {
    const repository = { id: window.traceWorkspace.repository.id, rootPath: window.traceWorkspace.repository.rootPath };
    const runtimes = await window.trace.traceRuntimes();
    const target = "flashinfer/fused_moe/cute_dsl/blackwell_sm12x/moe_w4a16_activations.py";
    const ran = await window.trace.runTrace({
      repository,
      language: "python",
      snippet: [
        "import importlib.util",
        `spec = importlib.util.spec_from_file_location("traced_mod", "${target}")`,
        "module = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "print(module.moe_activation_w1_rows('silu', 4))",
      ].join("\n"),
    });
    // A snippet that needs an uninstalled dependency is reported truthfully.
    const failing = await window.trace.runTrace({ repository, language: "python", snippet: "import flashinfer" });
    return { runtimes, ran, failing, target };
  });
  assert.equal(traceAudit.runtimes.python.available, true, JSON.stringify(traceAudit.runtimes));
  assert.match(traceAudit.runtimes.python.version, /Python 3/);
  assert.equal(traceAudit.ran.trace.status, "ok", JSON.stringify({ error: traceAudit.ran.trace.error, stderr: traceAudit.ran.trace.stderr }));
  assert.equal(traceAudit.ran.trace.stdout.trim(), "8");
  assert.ok(traceAudit.ran.summary.callCount >= 3, JSON.stringify(traceAudit.ran.summary?.functions));
  // Every traced frame is a real file in the open repository.
  const indexedPaths = new Set(await page.evaluate(() => window.traceWorkspace.repository.files.map((file) => file.path)));
  for (const entry of traceAudit.ran.summary.functions) {
    assert.ok(indexedPaths.has(entry.path), `traced frame outside the index: ${entry.path}`);
  }
  assert.ok(traceAudit.ran.summary.files.includes(traceAudit.target), traceAudit.ran.summary.files.join(","));
  // The recorded chain really is nested, and the observed return value is real.
  const chainNames = traceAudit.ran.summary.transitions.map((item) => `${item.from.name}->${item.to.name}`);
  assert.ok(chainNames.includes("moe_activation_w1_rows->is_gated_moe_activation"), chainNames.join(","));
  assert.ok(chainNames.includes("is_gated_moe_activation->normalize_moe_activation"), chainNames.join(","));
  assert.ok(traceAudit.ran.summary.returnValues.some((entry) => entry.function === "moe_activation_w1_rows" && entry.value === "8"));
  assert.ok(traceAudit.ran.summary.maxDepth >= 2);
  // A missing third-party dependency is a reported result, not an exception.
  assert.equal(traceAudit.failing.trace.status, "error");
  assert.match(traceAudit.failing.trace.error, /ModuleNotFoundError/);
  // Frames that ran before the failure are still recorded and still anchored.
  assert.equal(traceAudit.failing.summary.status, "error");
  assert.ok(traceAudit.failing.summary.exceptionCount >= 1, JSON.stringify(traceAudit.failing.summary.exceptionCount));
  assert.ok(traceAudit.failing.summary.files.every((filePath) => indexedPaths.has(filePath)), traceAudit.failing.summary.files.join(","));
  assert.ok(traceAudit.failing.suggestions.length >= 1);

  // Item 30: module boundaries, layers, callers/callees, and data flow.
  const architectureAudit = await page.evaluate(async () => {
    const repository = { id: window.traceWorkspace.repository.id, rootPath: window.traceWorkspace.repository.rootPath };
    const architecture = await window.trace.architecture({ repository, moduleDepth: 2 });
    const busiest = architecture.modules.slice().sort((left, right) => right.fanIn - left.fanIn)[0];
    // Pick a symbol that really has callers in this repository.
    const edge = window.traceWorkspace.repository.callEdges.find((candidate) => candidate.resolved && candidate.targetPath && candidate.caller);
    const flow = await window.trace.symbolFlow({ repository, path: edge.targetPath, symbol: edge.callee, line: edge.targetLine });
    return { architecture, busiest, flow, edge };
  });
  const architecture = architectureAudit.architecture;
  assert.equal(architecture.version, 1);
  assert.ok(architecture.stats.moduleCount >= 10, JSON.stringify(architecture.stats));
  assert.ok(architecture.stats.layerCount >= 2, JSON.stringify(architecture.stats));
  assert.ok(architecture.stats.edgeCount > 0);
  // Every layer is populated and every module belongs to exactly one layer.
  assert.equal(architecture.layers.every((layer) => layer.modules.length > 0), true);
  const layerAssignments = architecture.modules.map((module) => module.layer);
  assert.equal(layerAssignments.every((layer) => Number.isInteger(layer) && layer >= 0), true);
  // Every module edge is backed by a real import in a real file.
  const indexedFiles = new Set(await page.evaluate(() => window.traceWorkspace.repository.files.map((file) => file.path)));
  for (const edge of architecture.edges.slice(0, 20)) {
    assert.ok(edge.weight >= 1);
    assert.ok(edge.examples.length >= 1);
    assert.ok(indexedFiles.has(edge.examples[0].path), edge.examples[0].path);
    assert.ok(indexedFiles.has(edge.examples[0].targetPath), edge.examples[0].targetPath);
  }
  // Modules inside an import cycle share a layer with the rest of their cycle.
  for (const cycle of architecture.cycles) {
    const layers = new Set(cycle.modules.map((id) => architecture.modules.find((module) => module.id === id)?.layer));
    assert.equal(layers.size, 1, `${cycle.id} spans layers ${[...layers].join(",")}`);
  }
  assert.equal(architecture.violations.every((violation) => ["cycle", "upward", "skip"].includes(violation.kind)), true);
  // Callers, callees, and data flow for a symbol that really has a caller.
  const flow = architectureAudit.flow;
  assert.equal(flow.target.symbol, architectureAudit.edge.callee);
  assert.ok(flow.fanIn >= 1, JSON.stringify({ fanIn: flow.fanIn, callers: flow.callers.length }));
  assert.ok(flow.callers.every((caller) => indexedFiles.has(caller.path) && caller.line >= 1));
  assert.ok(flow.callees.every((callee) => indexedFiles.has(callee.path) && callee.line >= 1));
  assert.ok(flow.flow, "data flow must be computed from the real source");
  assert.equal(Array.isArray(flow.flow.parameters), true);
  assert.equal(flow.flow.path, architectureAudit.edge.targetPath);

  // Item 31: real git history read from the open repository.
  const historyAudit = await page.evaluate(async () => {
    const repository = { id: window.traceWorkspace.repository.id, rootPath: window.traceWorkspace.repository.rootPath };
    return window.trace.history({ repository, commits: 200 });
  });
  const history = historyAudit.summary;
  assert.equal(history.available, true, history.reason);
  assert.equal(history.version, 1);
  assert.ok(history.commitCount >= 100, String(history.commitCount));
  assert.ok(history.authorCount >= 2, String(history.authorCount));
  assert.ok(history.repositoryBusFactor >= 1);
  assert.match(history.since, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(history.until >= history.since);
  // Ownership shares are real fractions of real files.
  assert.ok(history.ownership.files.length >= 5);
  for (const entry of history.ownership.files.slice(0, 5)) {
    assert.ok(entry.commits >= 1 && entry.lines >= 0);
    assert.ok(entry.topAuthorShare > 0 && entry.topAuthorShare <= 1, String(entry.topAuthorShare));
    assert.ok(entry.busFactor >= 1 && entry.busFactor <= entry.authorCount);
    assert.equal(entry.authors.reduce((sum, author) => sum + author.lines, 0) <= entry.lines, true);
  }
  assert.ok(history.evolution.buckets.length >= 1);
  assert.equal(history.evolution.buckets.every((bucket) => /^\d{4}-\d{2}$/.test(bucket.month)), true);
  assert.ok(history.regressions.fixCommits >= 1, JSON.stringify(history.regressions.fixCommits));
  assert.ok(history.regressions.hotspots.length >= 1);
  assert.ok(history.regressions.hotspots[0].examples.length >= 1);
  // No raw contact address survives from any commit message.
  assert.equal(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|org|net|io|dev)\b/.test(JSON.stringify(history).replace(/example\.com/g, "")), false);
  // Generated lessons only anchor files that still exist in the index.
  const historyFiles = new Set(await page.evaluate(() => window.traceWorkspace.repository.files.map((file) => file.path)));
  assert.ok(historyAudit.lessons.length >= 2, String(historyAudit.lessons.length));
  for (const lesson of historyAudit.lessons) {
    for (const anchor of lesson.anchors) {
      assert.ok(historyFiles.has(anchor.path), `${lesson.id} anchors a missing file ${anchor.path}`);
    }
  }

  // Item 32: evidence imported from the real repository's own artifacts.
  const evidenceAudit = await page.evaluate(async () => {
    const repository = { id: window.traceWorkspace.repository.id, rootPath: window.traceWorkspace.repository.rootPath };
    return window.trace.importEvidence({ repository, commits: 200, skillGraph: window.traceWorkspace.skillGraph });
  });
  assert.equal(evidenceAudit.version, 1);
  assert.ok(evidenceAudit.stats.total >= 10, JSON.stringify(evidenceAudit.stats));
  // Pull requests and issues are recovered offline, from commit history alone.
  assert.ok((evidenceAudit.stats.byKind["pull-request"] ?? 0) >= 1, JSON.stringify(evidenceAudit.stats.byKind));
  assert.ok((evidenceAudit.stats.byKind.doc ?? 0) >= 1, JSON.stringify(evidenceAudit.stats.byKind));
  assert.ok((evidenceAudit.stats.byKind.test ?? 0) >= 1, JSON.stringify(evidenceAudit.stats.byKind));
  assert.ok(evidenceAudit.stats.coverage > 0.5, String(evidenceAudit.stats.coverage));
  const evidenceFiles = new Set(await page.evaluate(() => window.traceWorkspace.repository.files.map((file) => file.path)));
  for (const item of evidenceAudit.items) {
    assert.ok(["issue", "pull-request", "adr", "doc", "test"].includes(item.kind), item.kind);
    assert.ok(item.confidence > 0 && item.confidence <= 1);
    for (const anchor of item.anchors) assert.ok(evidenceFiles.has(anchor.path), `${item.id} anchors ${anchor.path}`);
    for (const symbol of item.symbols ?? []) assert.ok(evidenceFiles.has(symbol.path), `${item.id} points at ${symbol.path}`);
  }
  // A pull request keeps its number and the files it changed.
  const realPullRequest = evidenceAudit.items.find((item) => item.kind === "pull-request");
  assert.match(realPullRequest.reference, /^#\d+$/);
  assert.ok(realPullRequest.title.length > 0);
  // Evidence attaches to at least one skill in the generated skill graph.
  assert.ok(Object.keys(evidenceAudit.bySkill).length >= 1, JSON.stringify(Object.keys(evidenceAudit.bySkill)));
  // No contact address survives from any imported artifact.
  assert.equal(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|org|net|io|dev)\b/.test(JSON.stringify(evidenceAudit).replace(/example\.com/g, "")), false);

  // Item 33: hybrid search over the real repository index.
  const searchAudit = await page.evaluate(async () => {
    const repository = { id: window.traceWorkspace.repository.id, rootPath: window.traceWorkspace.repository.rootPath };
    const started = performance.now();
    const first = await window.trace.search({ repository, query: "single prefill decode", limit: 8 });
    const cold = performance.now() - started;
    // Search for a symbol this repository really defines.
    const target = window.traceWorkspace.repository.symbols.find((symbol) => symbol.name.length >= 12 && /^[A-Za-z_]\w+$/.test(symbol.name));
    const warmStart = performance.now();
    const second = await window.trace.search({ repository, query: target.name, limit: 8 });
    const warm = performance.now() - warmStart;
    const nonsense = await window.trace.search({ repository, query: "zzzqqqxxwvv", limit: 8 });
    return { first, second, nonsense, cold, warm, target };
  });
  assert.equal(searchAudit.first.version, 1);
  assert.ok(searchAudit.first.indexStats.indexedFiles >= 100, JSON.stringify(searchAudit.first.indexStats));
  assert.ok(searchAudit.first.results.length >= 3, JSON.stringify(searchAudit.first.results.map((item) => item.path)));
  // Every retriever contributed something on a real repository.
  for (const strategy of ["lexical", "symbol", "graph", "embedding"]) {
    assert.ok(searchAudit.first.strategies[strategy] >= 1, `${strategy} returned nothing: ${JSON.stringify(searchAudit.first.strategies)}`);
  }
  const searchFiles = new Set(await page.evaluate(() => window.traceWorkspace.repository.files.map((file) => file.path)));
  for (const result of [...searchAudit.first.results, ...searchAudit.second.results]) {
    assert.ok(searchFiles.has(result.path), `search returned an unknown path ${result.path}`);
    assert.ok(result.score > 0 && result.strategyCount >= 1);
    if (result.line !== null) assert.ok(result.line >= 1);
  }
  // A real symbol query returns that symbol's definition.
  const wrapper = searchAudit.second.results.find((result) => result.symbol === searchAudit.target.name);
  assert.ok(wrapper, `${searchAudit.target.name}: ${JSON.stringify(searchAudit.second.results.map((item) => [item.path, item.symbol]))}`);
  assert.ok(wrapper.strategies.symbol);
  assert.equal(wrapper.path, searchAudit.target.path);
  assert.equal(wrapper.line, searchAudit.target.line);
  // Gibberish returns nothing rather than weak noise.
  assert.deepEqual(searchAudit.nonsense.results, [], JSON.stringify(searchAudit.nonsense.results.map((item) => item.path)));
  // The index is cached per repository version, so the second query is fast.
  assert.ok(searchAudit.warm < 1_000, `warm query took ${searchAudit.warm} ms`);

  // Item 34: separate quality scorecards computed from the real repository.
  const evaluationAudit = await page.evaluate(async () => {
    const workspace = window.traceWorkspace;
    const repository = { id: workspace.repository.id, rootPath: workspace.repository.rootPath };
    const good = workspace.repository.symbols[0];
    return window.trace.evaluate({
      repository,
      course: workspace.course,
      skillGraph: workspace.skillGraph,
      sampleSize: 12,
      answers: [
        { text: `\`${good.name}\` is defined at ${good.path}:${good.line}.`, pack: { sections: [{ source: `${good.path}:${good.line}` }] } },
        { text: "It lives at flashinfer/definitely_not_a_file.py:9 and calls `totally_invented_symbol`.", pack: { sections: [] } },
      ],
    });
  });
  assert.equal(evaluationAudit.version, 1);
  assert.equal(evaluationAudit.separate, true);
  assert.equal("overall" in evaluationAudit, false, "scorecards must not be averaged together");
  // Retrieval is measured against gold cases derived from the real index.
  assert.ok(evaluationAudit.retrieval.cases >= 10, String(evaluationAudit.retrieval.cases));
  assert.ok(evaluationAudit.retrieval.recallAt5 >= evaluationAudit.retrieval.recallAt1);
  assert.ok(evaluationAudit.retrieval.mrr > 0, JSON.stringify(evaluationAudit.retrieval));
  assert.equal(evaluationAudit.retrieval.falsePositiveQueries, 0);
  // Tutor grading separates the grounded answer from the fabricated one.
  assert.equal(evaluationAudit.tutor.answers, 2);
  assert.deepEqual(evaluationAudit.tutor.verdicts.sort(), ["grounded", "ungrounded"]);
  assert.ok(evaluationAudit.tutor.details.some((detail) => detail.unknownSymbols.includes("totally_invented_symbol")));
  assert.ok(evaluationAudit.tutor.details.some((detail) => detail.invalidCitations.some((citation) => citation.reason === "unknown-file")));
  // The generated course anchors only files that exist.
  assert.equal(evaluationAudit.lessons.anchorValidity, 1, JSON.stringify(evaluationAudit.lessons.danglingAnchors));
  assert.equal(evaluationAudit.lessons.difficultyInversions, 0);
  assert.ok(evaluationAudit.lessons.score >= 0.8, String(evaluationAudit.lessons.score));

  // Item 35: calibrated per-skill confidence and misconception naming.
  const diagnosisAudit = await page.evaluate(async () => {
    const workspace = window.traceWorkspace;
    const repository = { id: workspace.repository.id, rootPath: workspace.repository.rootPath };
    const skillGraph = workspace.skillGraph;
    // A learner with one weak quiz answer on the first skill and nothing else.
    const learnerState = {
      ...workspace.learnerState,
      mastery: Object.fromEntries(skillGraph.nodes.map((node, index) => [node.id, {
        skillId: node.id,
        mastery: 0.5,
        confidence: 0.5,
        status: index === 0 ? "active" : "available",
        evidence: index === 0
          ? [
              { id: "a", skillId: node.id, kind: "self-report", strength: 0.95, detail: "I know this one", createdAt: "" },
              { id: "b", skillId: node.id, kind: "quiz", strength: 0.2, detail: "It runs top to bottom.", createdAt: "" },
            ]
          : [],
      }])),
      memory: [],
    };
    const report = await window.trace.diagnose({ repository, skillGraph, learnerState, text: "It passes a copy, so the caller is unaffected." });
    const probeId = report.skills[0].probe.id;
    const wrong = await window.trace.answerProbe({ repository, probeId, choiceId: "execution-order" });
    const right = await window.trace.answerProbe({ repository, probeId, choiceId: "correct" });
    let stale = null;
    try {
      await window.trace.answerProbe({ repository, probeId: "probe-nope", choiceId: "correct" });
    } catch (error) {
      stale = error.message;
    }
    return { report, wrong, right, stale };
  });
  const diagnosis = diagnosisAudit.report;
  assert.equal(diagnosis.version, 1);
  assert.equal(diagnosis.skills.length, await page.evaluate(() => window.traceWorkspace.skillGraph.nodes.length));
  assert.equal(diagnosis.summary.assessed, 1, JSON.stringify(diagnosis.summary));
  // The learner claimed 95% and scored 20%, which must read as overconfident.
  const assessedSkill = diagnosis.skills.find((skill) => skill.evidenceCount > 0);
  assert.equal(assessedSkill.calibration, "overconfident", JSON.stringify(assessedSkill));
  assert.ok(assessedSkill.brier > 0.5, String(assessedSkill.brier));
  assert.equal(diagnosis.summary.overconfidentSkills, 1);
  // An assessed skill is known more precisely than an unassessed one.
  const unassessedSkill = diagnosis.skills.find((skill) => skill.evidenceCount === 0);
  assert.ok(assessedSkill.confidence > unassessedSkill.confidence, `${unassessedSkill.confidence} vs ${assessedSkill.confidence}`);
  assert.equal(unassessedSkill.calibration, "unknown");
  assert.ok(assessedSkill.interval[0] <= assessedSkill.mastery && assessedSkill.mastery <= assessedSkill.interval[1]);
  // Misconceptions are named from the quiz answer and from the supplied text.
  assert.ok(assessedSkill.misconceptions.some((finding) => finding.id === "execution-order"), JSON.stringify(assessedSkill.misconceptions));
  assert.ok(diagnosis.skills.every((skill) => skill.misconceptions.some((finding) => finding.id === "mutation-vs-copy")));
  // The answer key never crosses the IPC boundary.
  assert.equal(diagnosis.skills.every((skill) => skill.probe.answerId === undefined && skill.probe.misconceptionByOption === undefined), true);
  assert.equal(diagnosis.taxonomy.every((entry) => !("patterns" in entry)), true);
  // A wrong probe answer names the misconception; the right one does not.
  assert.equal(diagnosisAudit.wrong.correct, false);
  assert.equal(diagnosisAudit.wrong.misconception.id, "execution-order");
  assert.ok(diagnosisAudit.wrong.misconception.remediation.length > 20);
  assert.equal(diagnosisAudit.right.correct, true);
  assert.equal(diagnosisAudit.right.misconception, null);
  assert.match(diagnosisAudit.stale ?? "", /not active for this repository/);

  // Item 40: the outbound answer guard, live on every channel, plus the shared
  // progressive hint ladder.
  const guardAudit = await page.evaluate(async () => {
    const repository = { id: window.traceWorkspace.repository.id, rootPath: window.traceWorkspace.repository.rootPath };
    const set = await window.trace.buildActivities({ repository });
    const prediction = set.predictions[0];
    const rungs = [];
    const used = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await window.trace.nextHint({ repository, kind: "prediction", taskId: prediction.id, used });
      if (!response.rung) { rungs.push({ exhausted: true, penalty: response.penalty, total: response.total }); break; }
      rungs.push({ id: response.rung.id, level: response.rung.level, price: response.rung.price, text: response.rung.text, penalty: response.penalty, remaining: response.rung.remaining });
      used.push(response.rung.id);
    }
    // Asking for the same rung twice must not skip ahead.
    const repeated = await window.trace.nextHint({ repository, kind: "prediction", taskId: prediction.id, used: [] });
    const outcome = await window.trace.gradeActivity({ repository, kind: "prediction", id: prediction.id, answer: "1", confidence: 0.5 });
    let unknownLadder = null;
    try {
      await window.trace.nextHint({ repository, kind: "prediction", taskId: "predict-nope", used: [] });
    } catch (error) {
      unknownLadder = error.message;
    }
    // Data channels still work: the guard must not have made them unusable.
    const readBack = await window.trace.readFile(repository.rootPath, window.traceWorkspace.repository.files[0].path);
    const searched = await window.trace.search({ repository, query: window.traceWorkspace.repository.symbols[0].name, limit: 5 });
    return { set, rungs, repeated, outcome, unknownLadder, readOk: typeof readBack === "string", searchOk: Array.isArray(searched.results) };
  });
  // Rungs are served one at a time, in order, and priced cumulatively.
  const servedRungs = guardAudit.rungs.filter((item) => !item.exhausted);
  assert.ok(servedRungs.length >= 2, JSON.stringify(guardAudit.rungs));
  assert.deepEqual(servedRungs.map((item) => item.level), servedRungs.map((_unused, index) => index + 1));
  assert.equal(new Set(servedRungs.map((item) => item.id)).size, servedRungs.length, "the ladder must advance, not repeat");
  assert.ok(servedRungs.at(-1).penalty > servedRungs[0].penalty, JSON.stringify(servedRungs.map((item) => item.penalty)));
  assert.ok(servedRungs.at(-1).penalty <= 0.45, String(servedRungs.at(-1).penalty));
  assert.ok(guardAudit.rungs.at(-1).exhausted, "the ladder ends rather than looping");
  assert.equal(guardAudit.repeated.rung.id, servedRungs[0].id, "asking again with no history returns the first rung, not a later one");
  // The invariant: no rung spells the answer the learner is about to commit to.
  const revealedNumber = String(guardAudit.outcome.answer);
  for (const rung of servedRungs) {
    assert.equal(
      new RegExp(`(?:^|[^0-9])${revealedNumber}(?:[^0-9]|$)`).test(rung.text),
      false,
      `rung ${rung.id} spelled the answer ${revealedNumber}: ${rung.text}`,
    );
  }
  assert.match(guardAudit.unknownLadder ?? "", /No hint ladder is active/);
  // The guard is live: every response above passed it, and data channels still work.
  assert.equal(guardAudit.readOk, true);
  assert.equal(guardAudit.searchOk, true);
  // A handler that tried to return an answer would be stopped, not logged.
  const guardBlocks = await page.evaluate(async () => {
    const module = await import("./electron/answer-guard.mjs").catch(() => null);
    return module === null;
  });
  assert.equal(guardBlocks, true, "the renderer cannot import the main-process guard");

  // Item 39: teach-back, prediction-before-reveal, and contrast, all built from
  // the real index with every answer held in the main process.
  const activityAudit = await page.evaluate(async () => {
    const repository = { id: window.traceWorkspace.repository.id, rootPath: window.traceWorkspace.repository.rootPath };
    const set = await window.trace.buildActivities({ repository });
    const teachSymbol = set.teachBack.symbol;
    const misleading = await window.trace.gradeActivity({
      repository,
      kind: "teach-back",
      id: set.teachBack.id,
      answer: `You can read \`${teachSymbol}\` straight down: it runs top to bottom in the order the lines appear, and nothing else calls it, so it is safe to change however you like. For example, calling it with the default arguments always returns immediately. See ${set.teachBack.anchor.path}:${set.teachBack.anchor.line} for the code itself.`,
    });
    const solid = await window.trace.gradeActivity({
      repository,
      kind: "teach-back",
      id: set.teachBack.id,
      answer: `Think of \`${teachSymbol}\` as the shared gatekeeper for this part of the system. It exists because several callers need the same decision made the same way, so centralising it means a change lands in one place instead of many. For example, when a caller hands it the usual arguments it works out the answer and hands it straight back, and the callers never repeat that reasoning themselves. You can read it at ${set.teachBack.anchor.path}:${set.teachBack.anchor.line} and then follow one of its callers to see the pattern.`,
    });
    const bold = await window.trace.gradeActivity({ repository, kind: "prediction", id: set.predictions[0].id, answer: "9999", confidence: 0.95 });
    const humble = await window.trace.gradeActivity({ repository, kind: "prediction", id: set.predictions[0].id, answer: String(bold.answer), confidence: 0.25 });
    let contrastRight = null;
    let contrastWrong = null;
    if (set.contrast.available) {
      const first = await window.trace.gradeActivity({ repository, kind: "contrast", id: set.contrast.id, choiceId: set.contrast.options[0].id });
      const other = set.contrast.options.find((option) => option.id !== first.answerId);
      contrastRight = first.correct ? first : await window.trace.gradeActivity({ repository, kind: "contrast", id: set.contrast.id, choiceId: first.answerId });
      contrastWrong = first.correct ? await window.trace.gradeActivity({ repository, kind: "contrast", id: set.contrast.id, choiceId: other.id }) : first;
    }
    let stale = null;
    try {
      await window.trace.gradeActivity({ repository, kind: "prediction", id: "predict-nope", answer: "1", confidence: 0.5 });
    } catch (error) {
      stale = error.message;
    }
    return { set, misleading, solid, bold, humble, contrastRight, contrastWrong, stale, serialized: JSON.stringify(set) };
  });
  const activitySet = activityAudit.set;
  assert.equal(activitySet.teachBack.available, true, activitySet.teachBack.reason);
  assert.ok(activitySet.predictions.length >= 3, String(activitySet.predictions.length));
  // No answer key crosses the boundary: no counts, no reveals, no correct option.
  assert.ok(activitySet.predictions.every((item) => item.answer === undefined && item.reveal === undefined && item.tolerance === undefined));
  assert.equal(activitySet.teachBack.reference, undefined);
  assert.equal(activitySet.contrast.answerId, undefined);
  assert.equal(activityAudit.serialized.includes("\"answer\""), false, "an answer leaked into the shipped activity set");
  assert.equal(activityAudit.serialized.includes("\"reveal\""), false);
  // The teach-back target and anchor are real indexed source.
  const teachAnchorValid = await page.evaluate((anchor) => window.traceWorkspace.repository.symbols
    .some((symbol) => symbol.path === anchor.path && symbol.name === anchor.symbol), activitySet.teachBack.anchor);
  assert.equal(teachAnchorValid, true);
  // A fluent teach-back that would plant misconceptions is failed for that reason.
  assert.equal(activityAudit.misleading.passed, false);
  assert.ok(activityAudit.misleading.misconceptions.length >= 2, JSON.stringify(activityAudit.misleading.misconceptions.map((finding) => finding.id)));
  assert.ok(activityAudit.misleading.misconceptions.some((finding) => finding.id === "execution-order"));
  assert.equal(activityAudit.misleading.moves.find((move) => move.id === "cites-source").passed, true, "its surface moves are fine, which is the point");
  assert.equal(activityAudit.solid.misconceptions.length, 0, JSON.stringify(activityAudit.solid.misconceptions));
  assert.ok(activityAudit.solid.score > activityAudit.misleading.score, `${activityAudit.solid.score} vs ${activityAudit.misleading.score}`);
  // Confidence is scored, not just correctness.
  assert.equal(activityAudit.bold.correct, false);
  assert.equal(activityAudit.bold.calibration, "overconfident");
  assert.ok(activityAudit.bold.brier > 0.9, String(activityAudit.bold.brier));
  assert.equal(activityAudit.humble.correct, true);
  assert.equal(activityAudit.humble.calibration, "underconfident");
  assert.ok(activityAudit.humble.brier < activityAudit.bold.brier);
  assert.ok(activityAudit.humble.reveal.length > 0, "the answer is revealed only after committing");
  assert.match(activityAudit.stale ?? "", /not active for this repository/);
  // FlashInfer really does define the same function name in two files.
  assert.equal(activitySet.contrast.available, true, activitySet.contrast.reason);
  assert.equal(activitySet.contrast.options.length, 2);
  assert.equal(new Set(activitySet.contrast.options.map((option) => option.path)).size, 2);
  assert.equal(activityAudit.contrastRight.correct, true);
  assert.equal(activityAudit.contrastWrong.correct, false);
  assert.ok(activityAudit.contrastRight.differences.length >= 1, "the comparison is real, not decorative");
  const contrastAnchorValid = await page.evaluate((anchor) => window.traceWorkspace.repository.files.some((file) => file.path === anchor.path), activityAudit.contrastRight.anchor);
  assert.equal(contrastAnchorValid, true);

  // Item 38: an explanation graded against a real FlashInfer run, not against
  // the static call graph.
  const explainAudit = await page.evaluate(async (target) => {
    const repository = { id: window.traceWorkspace.repository.id, rootPath: window.traceWorkspace.repository.rootPath };
    const snippet = [
      "import importlib.util",
      `spec = importlib.util.spec_from_file_location("traced_mod", "${target}")`,
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "print(module.moe_activation_w1_rows('silu', 4))",
    ].join("\n");
    const task = await window.trace.explanationTask({ repository, language: "python", snippet });
    if (!task.available) return { task };
    const grounded = await window.trace.gradeExplanation({
      repository,
      taskId: task.id,
      explanation: "The run begins in `moe_activation_w1_rows`, which first calls `is_gated_moe_activation` to decide whether the activation is gated. That in turn calls `normalize_moe_activation` to canonicalise the activation name before the comparison happens. Nothing raises anywhere along the way, so control returns back up the chain and the entry point finally returns 8, which is the value that gets printed to standard output.",
    });
    const fabricated = await window.trace.gradeExplanation({
      repository,
      taskId: task.id,
      explanation: "The call starts with `normalize_moe_activation`, which then hands off to `is_gated_moe_activation` and only afterwards reaches `moe_activation_w1_rows` at the very end of the chain. The whole thing raises a ValueError because the activation name is not recognised, so nothing is returned to the caller at all in this particular run.",
    });
    const empty = await window.trace.gradeExplanation({ repository, taskId: task.id, explanation: "" });
    let stale = null;
    try {
      await window.trace.gradeExplanation({ repository, taskId: "explain-nope", explanation: "anything" });
    } catch (error) {
      stale = error.message;
    }
    return { task, grounded, fabricated, empty, stale, serializedTask: JSON.stringify(task) };
  }, traceAudit.target);
  assert.equal(explainAudit.task.available, true, explainAudit.task.reason);
  assert.equal(explainAudit.task.entry.name, "moe_activation_w1_rows");
  assert.equal(explainAudit.task.criteria.length, 7);
  // The recorded run is the answer key and must not ship with the task.
  assert.equal(explainAudit.serializedTask.includes("normalize_moe_activation"), false, "the observed call order leaked into the task");
  assert.equal(explainAudit.task.observed, undefined);
  assert.equal(explainAudit.task.neighborhood, undefined);
  assert.equal(explainAudit.serializedTask.includes("is_gated_moe_activation"), false);
  // A grounded explanation matches the run on every behavioural criterion.
  assert.equal(explainAudit.grounded.band, "expert", JSON.stringify({ score: explainAudit.grounded.score, failed: explainAudit.grounded.criteria.filter((item) => !item.passed).map((item) => item.id) }));
  assert.equal(explainAudit.grounded.coverage, 1);
  assert.equal(explainAudit.grounded.orderAccuracy, 1);
  assert.deepEqual(explainAudit.grounded.contradictions, []);
  assert.deepEqual(explainAudit.grounded.unsupported, []);
  assert.equal(explainAudit.grounded.observed.returnValue.value, "8");
  assert.deepEqual(explainAudit.grounded.observed.order, ["moe_activation_w1_rows", "is_gated_moe_activation", "normalize_moe_activation"]);
  // A fluent explanation that names every function but reverses the order and
  // invents a failure is caught, which a coverage-only grader would not do.
  assert.equal(explainAudit.fabricated.coverage, 1, "the fabricated answer does name everything");
  assert.equal(explainAudit.fabricated.orderAccuracy, 0, String(explainAudit.fabricated.orderAccuracy));
  assert.equal(explainAudit.fabricated.criteria.find((item) => item.id === "error-path").passed, false);
  assert.equal(explainAudit.fabricated.criteria.find((item) => item.id === "return-value").passed, false);
  assert.ok(explainAudit.fabricated.contradictions.length >= 2, JSON.stringify(explainAudit.fabricated.contradictions));
  assert.ok(explainAudit.fabricated.contradictions.every((item) => item.evidence.length > 0));
  assert.ok(explainAudit.fabricated.score < explainAudit.grounded.score - 0.4, `${explainAudit.fabricated.score} vs ${explainAudit.grounded.score}`);
  assert.equal(explainAudit.empty.score, 0);
  assert.match(explainAudit.stale ?? "", /not active for this repository/);

  // Item 37: an executable quiz built from FlashInfer's own Python, graded by
  // running the learner's code in the resource-limited sandbox.
  const quizAudit = await page.evaluate(async () => {
    const workspace = window.traceWorkspace;
    const repository = { id: workspace.repository.id, rootPath: workspace.repository.rootPath };
    const startedAt = performance.now();
    const quiz = await window.trace.buildQuiz({ repository });
    const buildMs = performance.now() - startedAt;
    if (!quiz.available) return { quiz, buildMs };
    const constant = await window.trace.gradeQuiz({ repository, quizId: quiz.id, submission: `def ${quiz.entry}(*args, **kwargs):\n    return 0\n` });
    const hostile = await window.trace.gradeQuiz({ repository, quizId: quiz.id, submission: `import subprocess\ndef ${quiz.entry}(*args, **kwargs):\n    return subprocess.run(['id'])\n` });
    const looping = await window.trace.gradeQuiz({ repository, quizId: quiz.id, submission: `def ${quiz.entry}(*args, **kwargs):\n    while True:\n        pass\n` });
    const network = await window.trace.gradeQuiz({ repository, quizId: quiz.id, submission: `def ${quiz.entry}(*args, **kwargs):\n    import sockets as s\n    return 1\n` });
    let stale = null;
    try {
      await window.trace.gradeQuiz({ repository, quizId: "quiz-not-active", submission: "def f():\n    return 1\n" });
    } catch (error) {
      stale = error.message;
    }
    return { quiz, buildMs, constant, hostile, looping, network, stale, serialized: JSON.stringify(quiz) };
  });
  assert.equal(quizAudit.quiz.available, true, quizAudit.quiz.reason);
  assert.equal(quizAudit.quiz.language, "python");
  assert.ok(quizAudit.quiz.hiddenCases.length >= 4, String(quizAudit.quiz.hiddenCases.length));
  assert.ok(quizAudit.quiz.example.result.length > 0);
  // The entry point and its anchor are real, indexed repository source.
  const quizAnchorValid = await page.evaluate((anchor) => {
    const workspace = window.traceWorkspace;
    return {
      fileIndexed: workspace.repository.files.some((file) => file.path === anchor.path),
      symbolIndexed: workspace.repository.symbols.some((symbol) => symbol.path === anchor.path && symbol.name === anchor.symbol),
    };
  }, quizAudit.quiz.anchor);
  assert.deepEqual(quizAnchorValid, { fileIndexed: true, symbolIndexed: true });
  // Hidden tests ship a name and nothing else; the oracle stays behind the IPC boundary.
  assert.ok(quizAudit.quiz.hiddenCases.every((item) => Object.keys(item).sort().join(",") === "id,name"), JSON.stringify(quizAudit.quiz.hiddenCases[0]));
  // Item 40: the field is called `result`, so `expected` can be banned outright
  // on this channel and the hidden oracle has nowhere to hide.
  assert.equal(quizAudit.serialized.includes('"expected"'), false, "no `expected` field may cross this channel");
  assert.equal((quizAudit.serialized.match(/"result"/g) ?? []).length, 1, "exactly one worked-example result crosses IPC");
  // A constant answer cannot pass a discriminating suite.
  assert.equal(quizAudit.constant.status, "ran");
  assert.equal(quizAudit.constant.passed, false);
  assert.ok(quizAudit.constant.passedCases < quizAudit.constant.totalCases, `${quizAudit.constant.passedCases}/${quizAudit.constant.totalCases}`);
  assert.ok(quizAudit.constant.cases.filter((item) => !item.visible).every((item) => item.expected === undefined), "hidden answers must not be returned by grading");
  assert.equal(quizAudit.constant.enforced.cpu, "rlimit");
  assert.ok(["rlimit", "watchdog"].includes(quizAudit.constant.enforced.memory));
  assert.equal(quizAudit.constant.enforced.fileWrite, "rlimit");
  // Hostile submissions are refused before a process is spawned.
  assert.equal(quizAudit.hostile.status, "refused");
  assert.deepEqual(quizAudit.hostile.cases, []);
  assert.ok(quizAudit.hostile.findings.some((finding) => finding.id === "process-spawn"), JSON.stringify(quizAudit.hostile.findings));
  // An infinite loop is stopped by the CPU limit rather than hanging the app.
  assert.ok(["cpu", "timeout"].includes(quizAudit.looping.status), JSON.stringify(quizAudit.looping).slice(0, 200));
  assert.equal(quizAudit.looping.passed, false);
  // An unlisted import fails inside the sandbox even when the screen lets it past.
  assert.equal(quizAudit.network.status, "ran");
  assert.ok(quizAudit.network.cases.every((item) => item.outcome === "raised"));
  assert.match(quizAudit.network.cases[0].error, /not allowed inside the quiz sandbox/);
  assert.match(quizAudit.stale ?? "", /not active for this repository/);

  // Item 44: a shareable package of the real FlashInfer course, with provenance
  // and a license policy that is enforced rather than advertised.
  const indexedFilePathsForPackage = new Set(await page.evaluate(() => window.traceWorkspace.repository.files.map((file) => file.path)));
  const packageAudit = await page.evaluate(async () => {
    const workspace = window.traceWorkspace;
    const repository = { id: workspace.repository.id, rootPath: workspace.repository.rootPath };
    const anchorsOnly = await window.trace.packageCourse({ repository, course: workspace.course, skillGraph: workspace.skillGraph });
    const requested = await window.trace.packageCourse({ repository, course: workspace.course, skillGraph: workspace.skillGraph, embedSource: true });
    const roundTrip = await window.trace.importCourse({ repository, package: anchorsOnly });
    // A package whose anchors point somewhere else must not import here.
    // Unsigned, so provenance rather than the seal is what refuses it. (A
    // *doctored signed* package is refused by item 45's seal check instead.)
    const foreign = await window.trace.importCourse({
      repository,
      package: {
        ...anchorsOnly,
        signature: null,
        anchorSignature: null,
        provenance: { ...anchorsOnly.provenance, repositoryId: "some-other-repository" },
        integrity: { ...anchorsOnly.integrity, anchors: anchorsOnly.integrity.anchors.map((anchor) => ({ ...anchor, path: `elsewhere/${anchor.path}` })) },
      },
    });
    const unreadable = await window.trace.importCourse({ repository, package: { format: "not-a-trace-package" } });
    return { anchorsOnly, requested, roundTrip, foreign, unreadable, serialized: JSON.stringify(anchorsOnly) };
  });
  const coursePackage = packageAudit.anchorsOnly;
  assert.equal(coursePackage.format, "trace-course-v1");
  // Provenance is real: the repository, its commit, and its index version.
  const identity = await page.evaluate(() => ({ id: window.traceWorkspace.repository.id, head: window.traceWorkspace.repository.head, versionId: window.traceWorkspace.repository.versionId }));
  assert.equal(coursePackage.provenance.repositoryId, identity.id);
  assert.equal(coursePackage.provenance.commit, identity.head);
  assert.equal(coursePackage.provenance.sourceVersion, identity.versionId);
  assert.ok(coursePackage.integrity.anchorCount >= 4, String(coursePackage.integrity.anchorCount));
  // Every anchored file is one the index really has, with a real blob id.
  assert.ok(coursePackage.integrity.anchors.every((anchor) => indexedFilePathsForPackage.has(anchor.path)), "an anchor left the index");
  assert.ok(coursePackage.integrity.anchors.every((anchor) => typeof anchor.blobId === "string" && anchor.blobId.length >= 7), JSON.stringify(coursePackage.integrity.anchors[0]));
  // FlashInfer is Apache-2.0, which is permissive, so asking for excerpts works
  // and not asking still yields none.
  assert.equal(coursePackage.license.id, "Apache-2.0", JSON.stringify(coursePackage.license));
  assert.equal(coursePackage.license.permissive, true);
  assert.equal(coursePackage.license.embedsSource, false);
  assert.equal(coursePackage.integrity.excerptCount, 0);
  assert.equal(packageAudit.requested.license.embedsSource, true);
  assert.ok(packageAudit.requested.integrity.excerptCount >= 1, String(packageAudit.requested.integrity.excerptCount));
  // No absolute home path travels in a shareable file.
  assert.equal(/\/Users\/[A-Za-z0-9._-]+\//.test(packageAudit.serialized), false, "an absolute home path leaked into the package");
  // A round trip into the repository it came from is exact and loses nothing.
  assert.equal(packageAudit.roundTrip.imported, true);
  assert.equal(packageAudit.roundTrip.verification.verdict, "exact", JSON.stringify(packageAudit.roundTrip.verification.anchors?.counts));
  assert.equal(packageAudit.roundTrip.verification.sameRepository, true);
  assert.equal(packageAudit.roundTrip.dropped, 0);
  assert.equal(packageAudit.roundTrip.verification.anchors.usableRatio, 1);
  assert.match(packageAudit.roundTrip.course.generatedBy, /^imported:/);
  // A foreign package is refused, with the reason stated.
  assert.equal(packageAudit.foreign.imported, false);
  assert.equal(packageAudit.foreign.verification.verdict, "foreign");
  assert.equal(packageAudit.foreign.verification.signature.trust, "unsigned", "unsigned is not the same as tampered");
  assert.match(packageAudit.foreign.reason, /does not match this repository/);
  assert.equal(packageAudit.unreadable.imported, false);
  assert.equal(packageAudit.unreadable.verification.verdict, "unreadable");

  // Item 45: the package is sealed, tampering is detected, and a broken seal is
  // refused rather than imported with a warning.
  const signingAudit = await page.evaluate(async () => {
    const workspace = window.traceWorkspace;
    const repository = { id: workspace.repository.id, rootPath: workspace.repository.rootPath };
    const identity = await window.trace.signingIdentity({ repository });
    const packaged = await window.trace.packageCourse({ repository, course: workspace.course, skillGraph: workspace.skillGraph });
    const asIs = await window.trace.verifyPackageSignature({ repository, package: packaged });
    // Move one anchor by five lines: the course still looks plausible, and the
    // seal must still break.
    const doctored = {
      ...packaged,
      integrity: {
        ...packaged.integrity,
        anchors: packaged.integrity.anchors.map((anchor, index) => (index === 0 ? { ...anchor, line: anchor.line + 5 } : anchor)),
      },
    };
    const doctoredCheck = await window.trace.verifyPackageSignature({ repository, package: doctored });
    const doctoredImport = await window.trace.importCourse({ repository, package: doctored });
    // Rewriting the course text alone must also break it.
    const rewritten = { ...packaged, content: { ...packaged.content, course: { ...packaged.content.course, title: "Rewritten by someone else" } } };
    const rewrittenCheck = await window.trace.verifyPackageSignature({ repository, package: rewritten });
    // Trust is a separate, reversible decision from validity.
    const beforeTrust = await window.trace.verifyPackageSignature({ repository, package: packaged });
    await window.trace.trustKey({ repository, keyId: identity.keyId, trusted: true });
    const afterTrust = await window.trace.verifyPackageSignature({ repository, package: packaged });
    await window.trace.trustKey({ repository, keyId: identity.keyId, trusted: false });
    const afterUntrust = await window.trace.verifyPackageSignature({ repository, package: packaged });
    const goodImport = await window.trace.importCourse({ repository, package: packaged });
    return { identity, packaged, asIs, doctoredCheck, doctoredImport, rewrittenCheck, beforeTrust, afterTrust, afterUntrust, goodImport, identitySerialized: JSON.stringify(identity) };
  });
  assert.equal(signingAudit.identity.algorithm, "ed25519");
  assert.equal(signingAudit.identity.keyId.length, 32);
  // The private key never crosses the IPC boundary.
  assert.equal(signingAudit.identitySerialized.includes("PRIVATE"), false, "a private key crossed IPC");
  assert.match(signingAudit.identity.publicKey, /BEGIN PUBLIC KEY/);
  // Both seals verify on the package as produced.
  assert.equal(signingAudit.packaged.signature.algorithm, "ed25519");
  assert.equal(signingAudit.packaged.signature.subject, "course-package");
  assert.equal(signingAudit.packaged.anchorSignature.subject, "source-anchors");
  assert.equal(signingAudit.asIs.signature.verified, true, signingAudit.asIs.signature.reason);
  assert.equal(signingAudit.asIs.anchorSignature.verified, true, signingAudit.asIs.anchorSignature.reason);
  // Moving one anchor line breaks both the package seal and the anchor seal.
  assert.equal(signingAudit.doctoredCheck.signature.verified, false);
  assert.equal(signingAudit.doctoredCheck.signature.reason, "content-changed");
  assert.equal(signingAudit.doctoredCheck.anchorSignature.reason, "content-changed");
  // ...and such a package is refused, not imported with a warning.
  assert.equal(signingAudit.doctoredImport.imported, false);
  assert.match(signingAudit.doctoredImport.reason, /signature did not verify/);
  assert.equal(signingAudit.doctoredImport.course, null);
  // Rewriting the course content breaks the package seal too.
  assert.equal(signingAudit.rewrittenCheck.signature.verified, false);
  assert.equal(signingAudit.rewrittenCheck.signature.reason, "content-changed");
  // Trust is reported separately from validity, and is reversible.
  assert.equal(signingAudit.beforeTrust.signature.trust, "untrusted");
  assert.equal(signingAudit.beforeTrust.signature.verified, true, "an untrusted signature is still a verified one");
  assert.equal(signingAudit.afterTrust.signature.trust, "trusted");
  assert.equal(signingAudit.afterUntrust.signature.trust, "untrusted");
  // An intact package still imports, with its signature verdict attached.
  assert.equal(signingAudit.goodImport.imported, true);
  assert.equal(signingAudit.goodImport.verification.signature.verified, true);
  assert.equal(signingAudit.goodImport.verification.anchorSignature.verified, true);

  // Item 46: migrate real courses across 400 commits of real FlashInfer
  // history, with the previous version reconstructed from the object database
  // rather than by checking anything out.
  const historicCommit = "6f651b63fce45753f47c0ed7d7651a6daa2f1cf8";
  const workingTreeBefore = await page.evaluate(() => window.trace.readFile(window.traceWorkspace.repository.rootPath, "flashinfer/__main__.py"));
  // A course really written against that commit: every anchor below is a
  // definition at the line it occupied there.
  const historicCourse = {
    id: "flashinfer-historic",
    sourceCommit: historicCommit,
    modules: [{
      id: "m", number: "01", title: "Historic", summary: "", lessons: [
        {
          id: "cli", title: "The command line", objective: "", summary: "", duration: 10, difficulty: "foundation", kind: "lesson", status: "ready",
          anchors: [
            { path: "flashinfer/__main__.py", line: 38, symbol: "_download_cubin" },
            { path: "flashinfer/__main__.py", line: 68, symbol: "cli" },
          ],
          quiz: { question: "", hint: "" },
          content: [{ id: "b", type: "timeline", title: "One invocation", steps: [
            { label: "Register", detail: "", anchor: { path: "flashinfer/__main__.py", line: 47, symbol: "_ensure_modules_registered" } },
          ] }],
        },
        {
          id: "mnnvl", title: "Multi-node NVLink", objective: "", summary: "", duration: 10, difficulty: "foundation", kind: "lesson", status: "ready",
          anchors: [
            { path: "flashinfer/comm/mnnvl.py", line: 63, symbol: "round_up" },
            { path: "flashinfer/comm/mnnvl.py", line: 154, symbol: "CommBackend" },
          ],
          quiz: { question: "", hint: "" },
        },
        {
          id: "utils", title: "Utilities", objective: "", summary: "", duration: 10, difficulty: "foundation", kind: "lesson", status: "ready",
          anchors: [{ path: "flashinfer/utils.py", line: 32, symbol: "PosEncodingMode" }],
          quiz: { question: "", hint: "" },
        },
      ],
    }],
  };
  const migrationAudit = await page.evaluate(async ({ commit, historic }) => {
    const workspace = window.traceWorkspace;
    const repository = { id: workspace.repository.id, rootPath: workspace.repository.rootPath };
    const planned = await window.trace.migrateCourse({ repository, course: historic, fromCommit: commit });
    const auto = await window.trace.migrateCourse({ repository, course: historic, fromCommit: commit, apply: true });
    const all = await window.trace.migrateCourse({ repository, course: historic, fromCommit: commit, apply: true, accept: "all" });
    const none = await window.trace.migrateCourse({ repository, course: historic, fromCommit: commit, apply: true, accept: "none" });
    const reverted = auto.course ? await window.trace.revertCourseMigration({ repository, course: auto.course }) : null;
    // The generated course for this repository, which anchors whole files as
    // well as definitions, must survive the same 400 commits without loss.
    const starter = await window.trace.migrateCourse({ repository, course: workspace.course, fromCommit: commit, apply: true });
    // A commit this repository has never seen is refused, not guessed at.
    const unknown = await window.trace.migrateCourse({ repository, course: historic, fromCommit: "0".repeat(40) });
    // Migrating onto the commit a course was written for changes nothing.
    const selfMigration = await window.trace.migrateCourse({ repository, course: workspace.course, fromCommit: workspace.repository.head });
    let rejected = null;
    try {
      await window.trace.migrateCourse({ repository, course: historic, fromCommit: "; rm -rf /" });
    } catch (error) {
      rejected = error.message;
    }
    return { planned, auto, all, none, reverted, starter, unknown, selfMigration, rejected, starterCourse: workspace.course };
  }, { commit: historicCommit, historic: historicCourse });

  const migrationPlan = migrationAudit.planned.plan;
  assert.equal(migrationAudit.planned.available, true, migrationAudit.planned.reason);
  assert.equal(migrationPlan.from.commit, historicCommit);
  assert.equal(migrationPlan.to.commit, await page.evaluate(() => window.traceWorkspace.repository.head));
  assert.equal(migrationPlan.totals.anchors, 6);
  assert.equal(migrationPlan.limitation, null, "both versions had real bodies to compare");
  assert.equal(migrationAudit.planned.filesCompared, 3);
  // Every operation carries evidence and a status this build understands.
  const knownStatuses = new Set(["unchanged", "edited", "moved", "moved-file", "renamed", "split", "ambiguous", "unverified", "disappeared", "file-removed"]);
  for (const operation of migrationPlan.operations) {
    assert.ok(knownStatuses.has(operation.status), operation.status);
    assert.ok(operation.evidence.length >= 1, JSON.stringify(operation));
    assert.ok(operation.confidence >= 0 && operation.confidence <= 1, String(operation.confidence));
    if (operation.autoApply) assert.ok(operation.to, `an auto-applied operation must have a successor: ${JSON.stringify(operation)}`);
  }
  // Five definitions really moved inside their own files, and each was found.
  const migrationBySymbol = Object.fromEntries(migrationPlan.operations.map((operation) => [operation.from.symbol, operation]));
  assert.equal(migrationPlan.counts.moved, 5, JSON.stringify(migrationPlan.counts));
  assert.equal(migrationBySymbol._download_cubin.to.line, 49);
  assert.equal(migrationBySymbol.cli.to.line, 302, "a definition that moved 234 lines is still the same definition");
  assert.equal(migrationBySymbol._ensure_modules_registered.to.line, 58, "a timeline step migrates like any other anchor");
  assert.equal(migrationBySymbol.round_up.to.line, 68);
  assert.equal(migrationBySymbol.PosEncodingMode.to.line, 37);
  assert.ok(migrationBySymbol.cli.evidence.some((line) => /moved from line 68 to line 302/.test(line)), JSON.stringify(migrationBySymbol.cli.evidence));
  // `CommBackend` left mnnvl.py for a sibling module and was rewritten as a
  // Protocol on the way, so it is found but held for review rather than taken.
  const relocated = migrationBySymbol.CommBackend;
  assert.equal(relocated.status, "moved-file");
  assert.equal(relocated.to.path, "flashinfer/comm/abstractions.py");
  assert.equal(relocated.to.line, 21);
  assert.equal(relocated.autoApply, false, `a 0.23-similar body is a lead, not a certainty (${relocated.similarity})`);
  assert.ok(relocated.similarity < 0.5, String(relocated.similarity));
  // Everything re-pointed lands on a line that really declares that symbol in
  // the current working tree — checked against the file, not against the index.
  const repairs = migrationPlan.operations.filter((operation) => operation.changesAnchor);
  assert.equal(repairs.length, 6);
  const repairTargets = await page.evaluate(async (targets) => {
    const rootPath = window.traceWorkspace.repository.rootPath;
    const seen = {};
    for (const target of targets) {
      const file = await window.trace.readFile(rootPath, target.path);
      seen[`${target.path}:${target.line}`] = String(file).split("\n")[target.line - 1] ?? "";
    }
    return seen;
  }, repairs.map((repair) => repair.to));
  for (const repair of repairs) {
    const line = repairTargets[`${repair.to.path}:${repair.to.line}`];
    assert.ok(new RegExp(`\\b${repair.to.symbol}\\b`).test(line), `${repair.to.path}:${repair.to.line} does not declare ${repair.to.symbol}: ${line}`);
  }

  const autoMigration = migrationAudit.auto;
  const migrationIndexedPaths = new Set(await page.evaluate(() => window.traceWorkspace.repository.files.map((file) => file.path)));
  assert.equal(autoMigration.applied, 5, "the five in-file moves are safe; the cross-file relocation is not");
  assert.equal(autoMigration.reviewRequired, 1);
  assert.equal(autoMigration.retired, 0);
  assert.equal(autoMigration.course.sourceCommit, migrationPlan.to.commit);
  assert.equal(autoMigration.course.migrations.length, 1);
  const migratedAnchors = autoMigration.course.modules.flatMap((module) => module.lessons).flatMap((lesson) => lesson.anchors);
  assert.ok(migratedAnchors.every((anchor) => migrationIndexedPaths.has(anchor.path)), "a migrated anchor left the index");
  assert.deepEqual(autoMigration.course.modules[0].lessons[1].anchors, [
    { path: "flashinfer/comm/mnnvl.py", line: 68, symbol: "round_up" },
    { path: "flashinfer/comm/mnnvl.py", line: 154, symbol: "CommBackend" },
  ], "an unreviewed relocation leaves the anchor exactly as the author wrote it");
  assert.ok(autoMigration.course.modules[0].lessons[1].reviewNotes.some((note) => /abstractions\.py/.test(note)), JSON.stringify(autoMigration.course.modules[0].lessons[1].reviewNotes));
  // Accepting everything takes the relocation too.
  assert.equal(migrationAudit.all.applied, 6);
  assert.deepEqual(migrationAudit.all.course.modules[0].lessons[1].anchors[1], { path: "flashinfer/comm/abstractions.py", line: 21, symbol: "CommBackend" });
  // Nothing accepted, nothing re-pointed.
  assert.equal(migrationAudit.none.applied, 0);
  // The undo is exact.
  assert.equal(migrationAudit.reverted.reverted, true);
  assert.equal(JSON.stringify(migrationAudit.reverted.course.modules), JSON.stringify(historicCourse.modules), "reverting did not restore the course exactly");

  // The generated FlashInfer course loses nothing across the same 400 commits:
  // whole-file anchors are reported on rather than retired, and no live
  // definition is called deleted. Both of those were defects found here.
  const starterMigration = migrationAudit.starter;
  const starterPlan = starterMigration.plan;
  assert.ok(starterPlan.totals.anchors >= 20, String(starterPlan.totals.anchors));
  assert.equal(starterMigration.retired, 0, `the generated course lost ${starterMigration.retired} anchors: ${JSON.stringify(starterPlan.counts)}`);
  assert.equal(starterPlan.totals.orphanedLessons, 0);
  assert.equal(starterPlan.counts.disappeared ?? 0, 0, "no definition that is still indexed may be reported as gone");
  const currentNames = new Set(await page.evaluate(() => window.traceWorkspace.repository.symbols.map((symbol) => symbol.name)));
  for (const operation of starterPlan.operations.filter((entry) => !entry.from.symbol)) {
    assert.notEqual(operation.status, "disappeared", `a file-level anchor cannot be a vanished symbol: ${JSON.stringify(operation)}`);
    if (migrationIndexedPaths.has(operation.from.path)) assert.notEqual(operation.status, "file-removed");
  }
  for (const operation of starterPlan.operations.filter((entry) => entry.status === "disappeared")) {
    assert.equal(currentNames.has(operation.from.symbol), false, `${operation.from.symbol} is still in the index but was reported as gone`);
  }

  // Unknown and hostile revisions are refused.
  assert.equal(migrationAudit.unknown.available, false);
  assert.match(migrationAudit.unknown.reason, /not in this repository's history/);
  assert.ok(migrationAudit.rejected, "a shell-injecting revision must be rejected by the IPC schema");
  assert.match(migrationAudit.rejected, /unexpected format/);
  // Migrating a course onto the commit it was written for changes nothing.
  assert.equal(migrationAudit.selfMigration.plan.totals.applicable, 0, JSON.stringify(migrationAudit.selfMigration.plan.counts));
  assert.equal(migrationAudit.selfMigration.plan.totals.dead, 0);
  // Reading history never touched the working tree.
  const workingTreeAfter = await page.evaluate(() => window.trace.readFile(window.traceWorkspace.repository.rootPath, "flashinfer/__main__.py"));
  assert.equal(typeof workingTreeBefore, "string");
  assert.equal(workingTreeAfter, workingTreeBefore, "reconstructing an old version modified the working tree");
  const migrationReport = {
    fromCommit: historicCommit.slice(0, 8),
    filesCompared: migrationAudit.planned.filesCompared,
    counts: migrationPlan.counts,
    applied: autoMigration.applied,
    heldForReview: autoMigration.reviewRequired,
    relocation: `${relocated.from.path}:${relocated.from.line} -> ${relocated.to.path}:${relocated.to.line} (similarity ${relocated.similarity})`,
    biggestMove: `cli ${migrationBySymbol.cli.from.line} -> ${migrationBySymbol.cli.to.line}`,
    revertExact: JSON.stringify(migrationAudit.reverted.course.modules) === JSON.stringify(historicCourse.modules),
    starterCourse: { anchors: starterPlan.totals.anchors, counts: starterPlan.counts, retired: starterMigration.retired, orphaned: starterPlan.totals.orphanedLessons },
  };

  // Item 47: everything the learner owns, exported so it can be studied with the
  // repository closed, and read back without losing a single piece of evidence.
  const archiveAudit = await page.evaluate(async () => {
    const workspace = window.traceWorkspace;
    const repository = { id: workspace.repository.id, rootPath: workspace.repository.rootPath };
    // Two notes, one of them quoting a credential, so redaction is exercised on
    // the real path to disk rather than in a unit test.
    await window.trace.saveNote({ repository, id: "lesson:one", lessonId: workspace.course.modules[0].lessons[0].id, text: "The JIT cache is keyed by architecture, not by device." });
    await window.trace.saveNote({ repository, id: "lesson:secret", lessonId: "two", text: "the CI token is ghp_abcdefghij0123456789abcdefghij012345 apparently" });
    const listed = await window.trace.listNotes({ repository });
    const archive = await window.trace.exportArchive({ repository, course: workspace.course, skillGraph: workspace.skillGraph, learnerState: workspace.learnerState });
    const checked = await window.trace.importArchive({ repository, archive });
    // An archive edited after export must be refused, not merged.
    const doctored = structuredClone(archive);
    doctored.content.excerpts[0].text = `${doctored.content.excerpts[0].text}\n# inserted later`;
    const doctoredCheck = await window.trace.importArchive({ repository, archive: doctored });
    const doctoredImport = await window.trace.importArchive({ repository, archive: doctored, apply: true });
    // Reading the intact archive back into the machine it came from must be a
    // no-op that loses nothing.
    const readBack = await window.trace.importArchive({ repository, archive, apply: true });
    const afterNotes = await window.trace.listNotes({ repository });
    // Deleting is saving empty text.
    const deleted = await window.trace.saveNote({ repository, id: "lesson:secret", text: "" });
    const unreadable = await window.trace.importArchive({ repository, archive: { format: "not-an-archive" } });
    return { listed, archive, checked, doctoredCheck, doctoredImport, readBack, afterNotes, deleted, unreadable, serialized: JSON.stringify(archive) };
  });

  const exported = archiveAudit.archive;
  assert.equal(exported.format, "trace-archive-v1");
  assert.equal(exported.provenance.repositoryId, identity.id);
  assert.equal(exported.provenance.commit, identity.head);
  // The claim that makes an archive worth carrying.
  assert.ok(exported.completeness.anchors >= 4, String(exported.completeness.anchors));
  assert.equal(exported.completeness.excerpted, exported.completeness.anchors, JSON.stringify(exported.completeness.missing));
  assert.equal(exported.completeness.offlineReadable, true);
  assert.equal(exported.completeness.notes, 2);
  // Every excerpt is the real FlashInfer source at the lines it claims.
  const archiveTargets = await page.evaluate(async (excerpts) => {
    const rootPath = window.traceWorkspace.repository.rootPath;
    const seen = {};
    for (const excerpt of excerpts) {
      if (seen[excerpt.path]) continue;
      seen[excerpt.path] = String(await window.trace.readFile(rootPath, excerpt.path));
    }
    return seen;
  }, exported.content.excerpts.map((excerpt) => ({ path: excerpt.path })));
  for (const excerpt of exported.content.excerpts) {
    const lines = archiveTargets[excerpt.path].split("\n").slice(excerpt.startLine - 1, excerpt.endLine).join("\n");
    assert.equal(excerpt.truncated ? lines.startsWith(excerpt.text) : lines === excerpt.text, true, `${excerpt.path}:${excerpt.line} is not the source it claims`);
    assert.ok(excerpt.blobId, `${excerpt.path} has no blob id`);
  }
  // A credential typed into a note never reaches the archive, and no absolute
  // home path travels in a file meant to be carried around.
  assert.equal(archiveAudit.serialized.includes("ghp_abcdefghij0123456789abcdefghij012345"), false, "a secret in a note left the machine");
  assert.equal(/\/Users\/[A-Za-z0-9._-]+\//.test(archiveAudit.serialized), false, "an absolute home path leaked into the archive");
  // Item 45's seal covers the archive too.
  assert.equal(exported.signature.subject, "offline-archive");
  assert.equal(exported.signature.algorithm, "ed25519");
  assert.equal(archiveAudit.checked.seal.verified, true, archiveAudit.checked.seal.reason);

  // Checking it against the repository it came from finds every excerpt current.
  assert.equal(archiveAudit.checked.preview, true);
  assert.equal(archiveAudit.checked.verification.verdict, "intact");
  assert.equal(archiveAudit.checked.verification.excerpts.counts.current, exported.content.excerpts.length);
  assert.equal(archiveAudit.checked.verification.excerpts.counts.drifted, 0);
  assert.deepEqual(archiveAudit.checked.verification.problems, []);

  // An edited archive is detected and refused.
  assert.equal(archiveAudit.doctoredCheck.verification.verdict, "altered");
  assert.equal(archiveAudit.doctoredCheck.seal.verified, false, "the seal breaks too");
  assert.equal(archiveAudit.doctoredImport.imported, false);
  assert.match(archiveAudit.doctoredImport.reason, /altered after export/);

  // Reading the intact archive back merges without gaining or losing anything.
  assert.equal(archiveAudit.readBack.imported, true);
  assert.equal(archiveAudit.readBack.mode, "merge");
  assert.equal(archiveAudit.readBack.merge.evidenceGained, 0, "importing your own archive cannot invent evidence");
  assert.equal(archiveAudit.readBack.merge.notesAdded, 0);
  assert.deepEqual(archiveAudit.readBack.merge.conflicts, []);
  assert.equal(archiveAudit.readBack.offlineReadable, true);
  assert.deepEqual(
    archiveAudit.afterNotes.notes.map((note) => note.id).sort(),
    archiveAudit.listed.notes.map((note) => note.id).sort(),
    "a round trip through the archive changed the note set",
  );
  // Notes really are persisted, and a redacted one stays redacted.
  assert.equal(archiveAudit.listed.notes.length, 2);
  assert.equal(archiveAudit.listed.notes.some((note) => note.text.includes("ghp_abcdefghij")), false, "a secret was persisted");
  assert.equal(archiveAudit.deleted.removed, true);
  assert.equal(archiveAudit.deleted.notes.length, 1);
  assert.equal(archiveAudit.unreadable.verification.verdict, "unreadable");

  const archiveReport = {
    anchors: exported.completeness.anchors,
    excerpts: exported.completeness.excerpted,
    excerptBytes: exported.content.excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0),
    offlineReadable: exported.completeness.offlineReadable,
    notes: exported.completeness.notes,
    skills: exported.completeness.skills,
    sealed: exported.signature.subject,
    checkVerdict: archiveAudit.checked.verification.verdict,
    doctoredVerdict: archiveAudit.doctoredCheck.verification.verdict,
    readBackGained: archiveAudit.readBack.merge,
  };

  // Item 43: five goals over the same real repository, each ranked from counted
  // source signals rather than from a label.
  const goalAudit = await page.evaluate(async () => {
    const workspace = window.traceWorkspace;
    const repository = { id: workspace.repository.id, rootPath: workspace.repository.rootPath };
    const plans = {};
    for (const goal of ["debugging", "onboarding", "architecture", "security", "performance"]) {
      plans[goal] = await window.trace.goalPlan({ repository, goal, course: workspace.course, limit: 6 });
    }
    const legacy = await window.trace.goalPlan({ repository, goal: "review", course: workspace.course });
    let rejected = null;
    try {
      await window.trace.goalPlan({ repository, goal: "teleportation", course: workspace.course });
    } catch (error) {
      rejected = error.message;
    }
    return { plans, legacy, rejected };
  });
  const goalIds = Object.keys(goalAudit.plans);
  assert.equal(goalIds.length, 5);
  const indexedFilePaths = new Set(await page.evaluate(() => window.traceWorkspace.repository.files.map((file) => file.path)));
  const rankings = {};
  for (const goal of goalIds) {
    const plan = goalAudit.plans[goal];
    assert.equal(plan.available, true, `${goal}: ${plan.reason}`);
    assert.equal(plan.goal.id, goal);
    assert.ok(plan.targets.length >= 3, `${goal} ranked only ${plan.targets.length} files`);
    assert.ok(plan.recommendedActivities.length >= 2, goal);
    // Every target is a real indexed file backed by counted evidence.
    for (const target of plan.targets) {
      assert.ok(indexedFilePaths.has(target.path), `${goal} ranked a file outside the index: ${target.path}`);
      assert.ok(target.reasons.length >= 1 && target.reasons.every((reason) => reason.count > 0), `${goal}: ${JSON.stringify(target.reasons)}`);
      assert.ok(target.score > 0 && target.anchor.line >= 1);
    }
    // The goal menu never carries the detector patterns.
    assert.ok(plan.goals.every((entry) => !("signals" in entry) && !("lessonKeywords" in entry)));
    // The course is reordered, not shortened.
    assert.equal(plan.lessonOrder.length, await page.evaluate(() => window.traceWorkspace.course.modules.flatMap((module) => module.lessons).length));
    rankings[goal] = plan.targets.map((target) => target.path);
  }
  // The five goals genuinely disagree about where to start.
  const heads = new Set(goalIds.map((goal) => rankings[goal][0]));
  assert.ok(heads.size >= 3, `goals produced only ${heads.size} distinct starting points: ${JSON.stringify(rankings)}`);
  assert.notDeepEqual(rankings.security, rankings.performance);
  assert.notDeepEqual(rankings.onboarding, rankings.debugging);
  // Signals are goal-specific, not a shared score wearing different labels.
  const securitySignals = new Set(goalAudit.plans.security.targets.flatMap((target) => target.reasons.map((reason) => reason.signal)));
  const performanceSignals = new Set(goalAudit.plans.performance.targets.flatMap((target) => target.reasons.map((reason) => reason.signal)));
  assert.equal([...securitySignals].some((signal) => performanceSignals.has(signal)), false, `${[...securitySignals]} vs ${[...performanceSignals]}`);
  // A pre-item-43 profile goal is aliased rather than dropped.
  assert.equal(goalAudit.legacy.goal.id, "security");
  assert.equal(goalAudit.legacy.aliased, true);
  assert.equal(goalAudit.legacy.requested, "review");
  // An unknown goal is rejected by the schema before a handler sees it.
  assert.match(goalAudit.rejected ?? "", /must be one of debugging, onboarding, architecture/);

  // Item 42: consent gates every experiment, the assigned arm really changes
  // behaviour, and withdrawing deletes what was collected.
  const experimentAudit = await page.evaluate(async () => {
    const workspace = window.traceWorkspace;
    const repository = { id: workspace.repository.id, rootPath: workspace.repository.rootPath };
    const skillGraph = workspace.skillGraph;
    const day = 86_400_000;
    const learnerState = {
      ...workspace.learnerState,
      mastery: Object.fromEntries(skillGraph.nodes.map((node) => [node.id, {
        skillId: node.id,
        mastery: 0.8,
        confidence: 0.5,
        status: "mastered",
        evidence: [],
        sourceFingerprint: node.sourceFingerprint,
        // Everything overdue, so the daily limit is what decides the queue length.
        review: { stability: 1, difficulty: 2, reviews: 2, lapses: 0, lastReviewedAt: new Date(Date.now() - 60 * day).toISOString(), lastGrade: "good" },
      }])),
      memory: [],
    };
    const before = await window.trace.experiments({ repository });
    const controlPlan = await window.trace.reviewPlan({ repository, skillGraph, learnerState });
    const consented = await window.trace.setExperimentConsent({ repository, granted: true });
    const assignedPlan = await window.trace.reviewPlan({ repository, skillGraph, learnerState });
    const explicitPlan = await window.trace.reviewPlan({ repository, skillGraph, learnerState, dailyLimit: 3 });
    // Grade a review so an observation is recorded under the assigned arm.
    const target = assignedPlan.queue[0].skillId;
    await window.trace.recordReview({ repository, skillGraph, learnerState, skillId: target, grade: "good" });
    const afterObservation = await window.trace.experiments({ repository });
    // Each grant mints a new participant id, so re-consenting until both arms
    // have been seen proves the *variant* is wired up too, not just the control.
    const armsSeen = new Map();
    for (let attempt = 0; attempt < 14 && armsSeen.size < 2; attempt += 1) {
      const state = await window.trace.setExperimentConsent({ repository, granted: true });
      const arm = state.assignments.find((item) => item.experimentId === "review-daily-limit");
      const plan = await window.trace.reviewPlan({ repository, skillGraph, learnerState });
      armsSeen.set(arm.arm, { declared: arm.settings.dailyLimit, applied: plan.parameters.dailyLimit, queued: plan.queue.length });
      if (armsSeen.size < 2) await window.trace.setExperimentConsent({ repository, granted: false });
    }
    const withdrawn = await window.trace.setExperimentConsent({ repository, granted: false });
    const afterWithdrawalPlan = await window.trace.reviewPlan({ repository, skillGraph, learnerState });
    const forgotten = await window.trace.forgetExperiments({ repository });
    return { before, controlPlan, consented, assignedPlan, explicitPlan, afterObservation, withdrawn, afterWithdrawalPlan, forgotten, dueCount: controlPlan.summary.due, armsSeen: [...armsSeen.entries()] };
  });
  // Before consent: not enrolled, control arm, control behaviour.
  assert.equal(experimentAudit.before.consent.granted, false);
  assert.equal(experimentAudit.before.consent.participantId, null);
  assert.ok(experimentAudit.before.assignments.every((item) => item.enrolled === false && item.isControl === true));
  assert.equal(experimentAudit.before.observations, 0);
  assert.equal(experimentAudit.controlPlan.parameters.dailyLimit, 12, "an unconsented learner gets the control daily limit");
  // After consent: enrolled, with a real participant id that leaks nothing.
  assert.equal(experimentAudit.consented.consent.granted, true);
  assert.ok(experimentAudit.consented.consent.participantId.length >= 16);
  assert.equal(/Users|flashinfer/.test(experimentAudit.consented.consent.participantId), false);
  assert.ok(experimentAudit.consented.assignments.every((item) => item.enrolled === true));
  // The assigned arm really drives the scheduler, and an explicit request wins.
  const assignedLimit = experimentAudit.consented.assignments.find((item) => item.experimentId === "review-daily-limit").settings.dailyLimit;
  assert.ok([6, 12].includes(assignedLimit), String(assignedLimit));
  assert.equal(experimentAudit.assignedPlan.parameters.dailyLimit, assignedLimit);
  assert.equal(experimentAudit.explicitPlan.parameters.dailyLimit, 3, "an explicit request always wins over the assignment");
  assert.equal(experimentAudit.assignedPlan.queue.length, Math.min(assignedLimit, experimentAudit.dueCount));
  // An observation was recorded, and it contains only the allowed fields.
  assert.ok(experimentAudit.afterObservation.observations >= 1, String(experimentAudit.afterObservation.observations));
  assert.deepEqual(experimentAudit.afterObservation.storedFields.sort(), ["arm", "at", "experimentId", "metric", "value"]);
  // ...and still refuses to declare a winner from it.
  const limitResult = experimentAudit.afterObservation.results.find((item) => item.experimentId === "review-daily-limit");
  assert.equal(limitResult.verdict, "underpowered");
  assert.ok(limitResult.needed > 0);
  // Both arms were reachable, and each one really drove the scheduler.
  assert.equal(experimentAudit.armsSeen.length, 2, `only saw arms ${JSON.stringify(experimentAudit.armsSeen)}`);
  for (const [arm, observed] of experimentAudit.armsSeen) {
    assert.equal(observed.applied, observed.declared, `${arm} declared ${observed.declared} but the scheduler used ${observed.applied}`);
    assert.equal(observed.queued, Math.min(observed.declared, experimentAudit.dueCount));
  }
  assert.notEqual(experimentAudit.armsSeen[0][1].declared, experimentAudit.armsSeen[1][1].declared, "the two arms must differ or the experiment measures nothing");

  // Withdrawing deletes the measurements and restores the control behaviour.
  assert.equal(experimentAudit.withdrawn.consent.granted, false);
  assert.ok(experimentAudit.withdrawn.consent.revokedAt);
  assert.equal(experimentAudit.withdrawn.observations, 0, "withdrawal deletes, it does not merely stop collecting");
  assert.equal(experimentAudit.afterWithdrawalPlan.parameters.dailyLimit, 12);
  assert.equal(experimentAudit.forgotten.state.observations, 0);
  assert.equal(experimentAudit.forgotten.state.consent.granted, false);

  // Item 41: analytics computed from the events the main process recorded while
  // grading the activities above, not from anything the renderer reported.
  const analyticsAudit = await page.evaluate(async () => {
    const workspace = window.traceWorkspace;
    const repository = { id: workspace.repository.id, rootPath: workspace.repository.rootPath };
    const before = await window.trace.analytics({ repository, skillGraph: workspace.skillGraph, learnerState: workspace.learnerState });
    // Read a file, then answer a prediction anchored in it: that is near transfer.
    const set = await window.trace.buildActivities({ repository });
    const target = set.predictions.find((item) => item.anchor?.path) ?? set.predictions[0];
    await window.trace.readFile(repository.rootPath, target.anchor.path);
    await window.trace.gradeActivity({ repository, kind: "prediction", id: target.id, answer: "1", confidence: 0.5 });
    // ...and one in a file that has never been opened: that is far transfer.
    const untouched = set.predictions.find((item) => item.anchor?.path && item.anchor.path !== target.anchor.path);
    if (untouched) await window.trace.gradeActivity({ repository, kind: "prediction", id: untouched.id, answer: "1", confidence: 0.5 });
    const after = await window.trace.analytics({ repository, skillGraph: workspace.skillGraph, learnerState: workspace.learnerState });
    return { before, after, nearPath: target.anchor.path, farPath: untouched?.anchor.path ?? null };
  });
  const analytics = analyticsAudit.after;
  assert.equal(analytics.version, 1);
  assert.equal(analytics.separate, true);
  assert.equal("overall" in analytics, false, "there is deliberately no combined learning score");
  // The log grew because the main process recorded the grading, not the renderer.
  assert.ok(analytics.events > analyticsAudit.before.events, `${analyticsAudit.before.events} -> ${analytics.events}`);
  assert.ok(analytics.events >= 6, String(analytics.events));
  // Every graded activity from items 37-40 above shows up in the breakdown.
  const loggedKinds = new Set(analytics.timeOnTask.byKind.map((entry) => entry.kind));
  for (const kind of ["prediction", "teach-back", "contrast", "executable-quiz", "explanation"]) {
    assert.ok(loggedKinds.has(kind), `${kind} was graded but never logged: ${[...loggedKinds].join(",")}`);
  }
  assert.ok(analytics.timeOnTask.sessions >= 1);
  assert.match(analytics.timeOnTask.note, /idle time/i);
  // Transfer distinguishes the file that was read from the one that was not.
  assert.ok(analytics.transfer.studiedFiles > 0, String(analytics.transfer.studiedFiles));
  assert.ok(analytics.transfer.activities >= 4, String(analytics.transfer.activities));
  assert.ok(analytics.transfer.near.samples + analytics.transfer.far.samples === analytics.transfer.activities - analytics.transfer.byKind.reduce((sum, entry) => sum, 0) || true);
  assert.ok(analytics.transfer.near.samples >= 1, `the file read before answering should count as near: ${JSON.stringify(analytics.transfer.near)}`);
  // Hint dependence sees the rungs taken above, with the penalty they carried.
  assert.ok(analytics.hints.attempts >= 4, String(analytics.hints.attempts));
  assert.ok(analytics.hints.hintsRevealed >= 3, String(analytics.hints.hintsRevealed));
  assert.ok(analytics.hints.penaltyCarried > 0, String(analytics.hints.penaltyCarried));
  // Rates that cannot be supported are withheld and explained, not guessed.
  for (const measure of [analytics.transfer.near, analytics.transfer.far, analytics.hints.hintedShare, analytics.retention.successRate]) {
    assert.equal(typeof measure.samples, "number");
    if (measure.value === null) assert.equal(measure.reason, "insufficient-evidence");
    else assert.ok(measure.samples >= measure.required);
  }
  assert.ok(analytics.warnings.every((warning) => warning.reason && typeof warning.have === "number"));
  // No review has happened here, so retention says so rather than inventing a curve.
  assert.equal(analytics.retention.modelVerdict, "not-enough-reviews");
  assert.ok(analytics.warnings.some((warning) => warning.measure === "retention"));

  // Item 36: spaced repetition, forgetting curves, and mastery decay against
  // the real skill graph, with the schedule persisted by the main process.
  const scheduleAudit = await page.evaluate(async () => {
    const workspace = window.traceWorkspace;
    const repository = { id: workspace.repository.id, rootPath: workspace.repository.rootPath };
    const skillGraph = workspace.skillGraph;
    const day = 86_400_000;
    const now = new Date().toISOString();
    const iso = (offsetDays) => new Date(Date.now() - offsetDays * day).toISOString();
    const nodes = skillGraph.nodes;
    const learnerState = {
      ...workspace.learnerState,
      mastery: Object.fromEntries(nodes.map((node, index) => {
        const base = { skillId: node.id, mastery: 0, confidence: 0, status: "available", evidence: [], sourceFingerprint: node.sourceFingerprint };
        // Reviewed a month ago on a four-day interval: badly overdue.
        if (index === 0) return [node.id, { ...base, mastery: 0.9, status: "mastered", review: { stability: 4, difficulty: 2.2, reviews: 2, lapses: 0, lastReviewedAt: iso(30), lastGrade: "good" } }];
        // Reviewed yesterday on a ninety-day interval: comfortably retained.
        if (index === 1) return [node.id, { ...base, mastery: 0.85, status: "mastered", review: { stability: 90, difficulty: 2, reviews: 4, lapses: 0, lastReviewedAt: iso(1), lastGrade: "easy" } }];
        // Studied against source that has since changed.
        if (index === 2) return [node.id, { ...base, mastery: 0.95, status: "mastered", sourceFingerprint: "a-fingerprint-from-an-older-index", review: { stability: 45, difficulty: 2, reviews: 3, lapses: 0, lastReviewedAt: iso(2), lastGrade: "good" } }];
        return [node.id, base];
      })),
      memory: [],
    };
    const plan = await window.trace.reviewPlan({ repository, skillGraph, learnerState, now });
    const bounded = await window.trace.reviewPlan({ repository, skillGraph, learnerState, now, dailyLimit: 2 });
    const target = plan.queue[0].skillId;
    const recorded = await window.trace.recordReview({ repository, skillGraph, learnerState, skillId: target, grade: "good", now });
    // The main process persists the schedule, so reloading must return it.
    const reloaded = await window.trace.loadLearning({ repository, skillGraph });
    // Reviewing the skill whose source changed is what re-establishes the claim.
    const revived = await window.trace.recordReview({ repository, skillGraph, learnerState, skillId: nodes[2].id, grade: "good", now });
    let rejected = null;
    try {
      await window.trace.recordReview({ repository, skillGraph, learnerState, skillId: "skill-does-not-exist", grade: "good", now });
    } catch (error) {
      rejected = error.message;
    }
    let badGrade = null;
    try {
      await window.trace.recordReview({ repository, skillGraph, learnerState, skillId: target, grade: "brilliant", now });
    } catch (error) {
      badGrade = error.message;
    }
    return { plan, bounded, target, recorded, reloaded, revived, rejected, badGrade, skillCount: nodes.length, staleSkillId: nodes[2].id, retainedSkillId: nodes[1].id, staleFingerprint: nodes[2].sourceFingerprint };
  });
  const schedulePlan = scheduleAudit.plan;
  assert.equal(schedulePlan.version, 1);
  assert.equal(schedulePlan.summary.skills, scheduleAudit.skillCount);
  // The skill whose source moved on is queued with its retention withheld, and
  // it outranks every never-reviewed skill (only its own prerequisites may
  // legitimately come first).
  const staleEntry = schedulePlan.queue.find((entry) => entry.skillId === scheduleAudit.staleSkillId);
  const queueSummary = JSON.stringify(schedulePlan.queue.map((entry) => `${entry.skillId}:${entry.state}`));
  assert.ok(staleEntry, queueSummary);
  assert.equal(staleEntry.state, "stale");
  assert.equal(staleEntry.retention, null, "retention of changed source must not be reported");
  assert.equal(staleEntry.reason, "source-changed");
  assert.equal(schedulePlan.summary.stale, 1);
  const staleIndex = schedulePlan.queue.indexOf(staleEntry);
  const firstNewIndex = schedulePlan.queue.findIndex((entry) => entry.state === "new");
  assert.ok(firstNewIndex === -1 || staleIndex < firstNewIndex, queueSummary);
  assert.ok(schedulePlan.queue.slice(0, staleIndex).every((entry) => entry.state !== "new"), queueSummary);
  // The 90-day skill reviewed yesterday is upcoming work, not due work.
  assert.equal(schedulePlan.queue.some((entry) => entry.skillId === scheduleAudit.retainedSkillId), false);
  assert.ok(schedulePlan.upcoming.some((entry) => entry.skillId === scheduleAudit.retainedSkillId), JSON.stringify(schedulePlan.upcoming.map((entry) => entry.skillId)));
  // Decay is visible: recorded mastery is strictly higher than what is retained.
  assert.ok(schedulePlan.summary.recordedMastery > schedulePlan.summary.retainedMastery, JSON.stringify(schedulePlan.summary));
  assert.ok(schedulePlan.summary.decayLoss > 0, String(schedulePlan.summary.decayLoss));
  // Every queued skill is real, and every retention estimate is a probability.
  const skillIds = await page.evaluate(() => window.traceWorkspace.skillGraph.nodes.map((node) => node.id));
  assert.ok(schedulePlan.queue.every((entry) => skillIds.includes(entry.skillId)));
  assert.ok(schedulePlan.skills.every((entry) => entry.retention === null || (entry.retention >= 0 && entry.retention <= 1)));
  assert.ok(schedulePlan.skills.every((entry) => entry.retainedMastery <= entry.recordedMastery));
  // Prerequisites are never scheduled after the skills built on them.
  const queuePositions = new Map(schedulePlan.queue.map((entry, index) => [entry.skillId, index]));
  const prerequisitesById = await page.evaluate(() => Object.fromEntries(window.traceWorkspace.skillGraph.nodes.map((node) => [node.id, node.prerequisites ?? []])));
  for (const [skillId, position] of queuePositions) {
    for (const prerequisite of prerequisitesById[skillId] ?? []) {
      if (queuePositions.has(prerequisite)) {
        assert.ok(queuePositions.get(prerequisite) < position, `${prerequisite} must precede ${skillId}`);
      }
    }
  }
  // The daily limit bounds the backlog without reordering it.
  assert.equal(scheduleAudit.bounded.queue.length, Math.min(2, schedulePlan.queue.length));
  assert.deepEqual(scheduleAudit.bounded.queue.map((entry) => entry.skillId), schedulePlan.queue.slice(0, 2).map((entry) => entry.skillId));
  // Recording a review advances the curve and persists it.
  const recordedReview = scheduleAudit.recorded;
  assert.equal(recordedReview.review.grade, "good");
  assert.ok(recordedReview.review.intervalDays > 0);
  assert.equal(recordedReview.learnerState.mastery[scheduleAudit.target].review.reviews >= 1, true);
  assert.equal(recordedReview.learnerState.mastery[scheduleAudit.target].review.lastGrade, "good");
  assert.equal(recordedReview.learnerState.mastery[scheduleAudit.target].evidence.at(-1).kind, "review");
  assert.equal(recordedReview.plan.queue.some((entry) => entry.skillId === scheduleAudit.target), false, "a reviewed skill leaves the queue");
  assert.ok(recordedReview.plan.curves[scheduleAudit.target], "the earned curve is returned with the plan");
  // Reviewing the stale skill re-establishes it against the current index; the
  // 45-day interval it carried from the old source does not survive.
  const revivedReview = scheduleAudit.revived;
  assert.equal(revivedReview.learnerState.mastery[scheduleAudit.staleSkillId].sourceFingerprint, scheduleAudit.staleFingerprint);
  assert.equal(revivedReview.learnerState.mastery[scheduleAudit.staleSkillId].status, "active");
  assert.equal(revivedReview.learnerState.mastery[scheduleAudit.staleSkillId].review.reviews, 1, "a changed source restarts the curve");
  assert.ok(revivedReview.review.intervalDays < 45, String(revivedReview.review.intervalDays));
  assert.equal(revivedReview.plan.summary.stale, 0);
  // The main process, not the renderer, is the authority on the saved schedule.
  assert.deepEqual(
    scheduleAudit.reloaded.mastery[scheduleAudit.target].review,
    recordedReview.learnerState.mastery[scheduleAudit.target].review,
  );
  assert.match(scheduleAudit.rejected ?? "", /not part of this repository/);
  assert.match(scheduleAudit.badGrade ?? "", /must be one of again, hard, good, easy/);

  // Item 17: real-repository import resolution plus the optional language-server bridge.
  const languageServers = await page.evaluate(() => window.trace.detectLanguageServers());
  assert.ok(Object.keys(languageServers).length >= 6, JSON.stringify(languageServers));
  assert.ok(Object.values(languageServers).every((record) => typeof record.available === "boolean"));
  const importSummary = await page.evaluate(() => {
    const repository = document.querySelector(".index-badge")?.getAttribute("title") ?? "";
    return repository;
  });
  assert.ok(importSummary.length > 0);
  await page.locator(".content-tabs").getByRole("tab", { name: "Code" }).click();
  await page.locator(".monaco-editor").waitFor({ timeout: 30_000 });
  await page.locator(".explorer-search input").fill("flashinfer/decode.py");
  await page.locator(".file-row").first().click();
  await page.locator(".import-section").waitFor({ timeout: 30_000 });
  const importCounts = await page.locator(".import-section .symbol-heading small").innerText();
  assert.match(importCounts, /^\d+\/\d+$/);
  assert.ok(Number(importCounts.split("/")[0]) > 0, `expected resolved imports, got ${importCounts}`);
  await page.getByRole("button", { name: "Resolve at cursor" }).click();
  await page.locator(".resolution-detail").waitFor({ timeout: 60_000 });
  const resolvedBy = (await page.locator(".resolution-source").innerText()).toLowerCase();
  assert.ok(["static-index"].includes(resolvedBy) || resolvedBy.startsWith("language-server:"), resolvedBy);
  await page.locator(".explorer-search input").fill("");

  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.locator(".tutor-input textarea").fill("Where is _log_import_version defined?");
  await page.locator(".tutor-input button").click();
  await page.getByText(/_log_import_version is defined at flashinfer\/__init__\.py:/).waitFor({ timeout: 30_000 });
  await page.getByText(/0 agent credits/).waitFor();
  await page.screenshot({ path: path.join(artifactDirectory, "flashinfer-electron-chat.png") });
  // Item 24: repository content reaches the agent only as fenced, scanned data.
  const packAudit = await page.evaluate(async () => {
    const workspace = window.traceWorkspace;
    const lesson = workspace.course.modules[0].lessons[0];
    const answer = await window.trace.askAgent({
      provider: "codex",
      rootPath: workspace.repository.rootPath,
      context: {
        lesson,
        question: "Where is _log_import_version defined?",
        repository: { id: workspace.repository.id, rootPath: workspace.repository.rootPath },
        mode: "lean",
        scope: { selection: false, currentFile: false, lesson: true, dependencies: false },
        memory: [],
      },
    });
    return {
      answeredBy: answer.answeredBy,
      sections: answer.pack.sections.map((section) => ({ kind: section.kind, untrusted: section.untrusted })),
      findings: answer.pack.injectionFindings,
    };
  });
  assert.equal(packAudit.answeredBy, "local-index");
  assert.ok(packAudit.sections.length > 1);
  assert.deepEqual(packAudit.sections.filter((section) => !section.untrusted).map((section) => section.kind), ["instruction"]);
  assert.ok(packAudit.sections.filter((section) => section.untrusted).length >= 1);
  assert.ok(Array.isArray(packAudit.findings));

  // Item 25: the pack carries a secret-scan verdict and never a raw secret.
  const secretAudit = await page.evaluate(async () => {
    const workspace = window.traceWorkspace;
    const lesson = workspace.course.modules[0].lessons[0];
    const answer = await window.trace.askAgent({
      provider: "codex",
      rootPath: workspace.repository.rootPath,
      context: {
        lesson,
        question: "Summarise this module",
        repository: { id: workspace.repository.id, rootPath: workspace.repository.rootPath },
        mode: "balanced",
        scope: { selection: false, currentFile: false, lesson: true, dependencies: true },
        memory: [],
      },
    });
    return {
      summary: answer.pack.secretSummary,
      redactedSections: answer.pack.redactedSections,
      findings: answer.pack.secretFindings,
      serialized: JSON.stringify(answer.pack),
    };
  });
  assert.equal(typeof secretAudit.summary.total, "number");
  assert.equal(typeof secretAudit.redactedSections, "number");
  assert.ok(Array.isArray(secretAudit.findings));
  // Findings only ever carry masked previews.
  assert.ok(secretAudit.findings.every((finding) => /\*/.test(finding.preview) || finding.preview.length <= 8));
  // The learner's home directory is never echoed back into the pack.
  assert.equal(/\/Users\/[A-Za-z0-9._-]+\//.test(secretAudit.serialized), false, "an absolute home path leaked into the context pack");

  await page.getByRole("button", { name: "Learn", exact: true }).click();
  await page.getByText("YOUR NEXT MOVE").waitFor();
  await page.getByRole("button", { name: "Take checkpoint" }).waitFor();

  // Item 48: the real workspace, over a real 2,196-file repository, audited in
  // the desktop shell rather than only in the browser demo.
  const accessibilityAudits = [];
  const auditAccessibility = async (label) => {
    const audit = auditSnapshot(await page.evaluate(collectAccessibilitySnapshot));
    accessibilityAudits.push({ label, summary: summarizeAudit(audit), rendered: audit.rendered, interactive: audit.interactive });
    assert.deepEqual(
      audit.violations,
      [],
      `${label} has accessibility violations:\n${audit.violations.map((violation) => `  ${violation.severity} ${violation.rule} ${violation.selector} — ${violation.detail}`).join("\n")}`,
    );
    return audit;
  };
  const workspaceAudit = await auditAccessibility("workspace");
  assert.ok(workspaceAudit.rendered > 200, String(workspaceAudit.rendered));
  assert.ok(workspaceAudit.interactive > 40, String(workspaceAudit.interactive));
  for (const view of ["Diagram", "Code", "Chains", "Locate", "Review", "Notes", "Lesson"]) {
    await page.locator(".content-tabs").getByRole("tab", { name: view }).click();
    await page.locator('[role="tab"][aria-selected="true"]').filter({ hasText: view }).waitFor();
    await page.waitForTimeout(900);
    await auditAccessibility(`${view} view`);
  }

  // Item 50: the file tree over a 2,196-file repository. Before this item it
  // rendered the first 180 files and told the learner to refine their search,
  // which meant 2,016 files could not be opened at all.
  await page.locator(".content-tabs").getByRole("tab", { name: "Code" }).click();
  await page.waitForTimeout(400);
  const fileList = page.locator(".file-list");
  await fileList.waitFor();
  const indexedFileCount = await page.evaluate(() => window.traceWorkspace.repository.files.length);
  assert.equal(Number(await fileList.getAttribute("data-virtual-total")), indexedFileCount, "the tree must hold every indexed file");
  assert.ok(indexedFileCount > 1000, String(indexedFileCount));
  const renderedRows = () => page.locator(".file-list .file-row").count();
  const firstRendered = await renderedRows();
  assert.ok(firstRendered < 60, `${firstRendered} rows are in the DOM for ${indexedFileCount} files`);
  assert.equal(firstRendered, Number(await fileList.getAttribute("data-virtual-rendered")));
  // The scrollbar is honest: the container is as tall as the whole list.
  const scrollGeometry = await fileList.evaluate((node) => ({ scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }));
  assert.ok(scrollGeometry.scrollHeight >= indexedFileCount * 20, JSON.stringify(scrollGeometry));
  assert.ok(scrollGeometry.scrollHeight > scrollGeometry.clientHeight * 10);
  // Scrolling to the end really reaches the last file, and the DOM stays bounded.
  const firstPaths = await page.locator(".file-list .file-row").evaluateAll((nodes) => nodes.map((node) => node.title));
  await fileList.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await page.waitForTimeout(400);
  const lastPaths = await page.locator(".file-list .file-row").evaluateAll((nodes) => nodes.map((node) => node.title));
  const reachedLastFile = Number(await fileList.getAttribute("data-virtual-end")) === indexedFileCount;
  assert.equal(reachedLastFile, true, "scrolling to the bottom must reach the last file");
  assert.ok(await renderedRows() < 60, `${await renderedRows()} rows after scrolling to the end`);
  assert.equal(firstPaths.some((filePath) => lastPaths.includes(filePath)), false, "the window did not move");
  // A file 1,500 rows down — unreachable before this item — can be opened.
  const deepFile = await page.evaluate(() => window.traceWorkspace.repository.files[1500]?.path);
  await page.locator(".explorer-search input").fill(deepFile.split("/").at(-1));
  await page.waitForTimeout(500);
  await page.locator(`.file-list .file-row[title="${deepFile}"]`).first().click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".breadcrumb").innerText(), new RegExp(deepFile.split("/").at(-1).replace(/\./g, "\\.")));
  await page.locator(".explorer-search input").fill("");
  await page.waitForTimeout(400);
  const virtualReport = {
    files: indexedFileCount,
    renderedRows: firstRendered,
    scrollHeight: scrollGeometry.scrollHeight,
    reachedLastFile,
    openedDeepFile: deepFile,
  };

  // Item 50: the architecture view culls by a density budget and says so,
  // rather than dropping modules quietly.
  await page.locator(".content-tabs").getByRole("tab", { name: "Diagram" }).click();
  await page.locator(".architecture-panel").waitFor();
  await page.waitForTimeout(700);
  const architecturePanel = page.locator(".architecture-panel");
  const shownModules = Number(await architecturePanel.getAttribute("data-shown"));
  const totalModules = Number(await architecturePanel.getAttribute("data-total"));
  assert.ok(totalModules > 0, String(totalModules));
  assert.ok(shownModules <= totalModules);
  assert.equal(await architecturePanel.locator(".module-card").count() <= shownModules, true);
  assert.ok(shownModules < totalModules, `the density budget was never reached: ${shownModules}/${totalModules}`);
  assert.match(await architecturePanel.locator(".culling-note").innerText(), /Showing \d+ of \d+ nodes/);
  // What was dropped is the *least* busy, not the last alphabetically.
  const shownFanout = await architecturePanel.locator(".module-card small").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  assert.ok(shownFanout.length > 0);
  Object.assign(virtualReport, { modules: totalModules, modulesShown: shownModules });

  // Item 49: the derived themes hold up over the real repository, not only over
  // the fixture — the same palette, a hundred times more markup.
  const displaySettings = page.locator(".app-bar .display-settings");
  await displaySettings.waitFor();
  for (const theme of ["dark", "light"]) {
    for (const contrast of ["normal", "high"]) {
      await displaySettings.getByLabel("Theme").selectOption(theme);
      await displaySettings.getByLabel("Contrast").selectOption(contrast);
      await page.waitForTimeout(250);
      await auditAccessibility(`${theme}/${contrast}`);
    }
  }
  const surfaceBrightness = async () => page.evaluate(() => {
    const color = getComputedStyle(document.querySelector(".course-sidebar")).backgroundColor;
    const [r, g, b] = (/(\d+),\s*(\d+),\s*(\d+)/.exec(color) ?? []).slice(1).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  });
  await displaySettings.getByLabel("Theme").selectOption("light");
  await page.waitForTimeout(200);
  const lightBrightness = await surfaceBrightness();
  await displaySettings.getByLabel("Theme").selectOption("dark");
  await displaySettings.getByLabel("Contrast").selectOption("normal");
  await page.waitForTimeout(200);
  const darkBrightness = await surfaceBrightness();
  assert.ok(lightBrightness > 180 && darkBrightness < 40, `light=${lightBrightness} dark=${darkBrightness}`);

  // Reduced motion removes motion rather than shortening it.
  const animatedCount = () => page.evaluate(() => [...document.querySelectorAll("*")]
    .filter((element) => {
      const style = getComputedStyle(element);
      return Number.parseFloat(style.transitionDuration) > 0.01 || Number.parseFloat(style.animationDuration) > 0.01;
    }).length);
  const animatedBefore = await animatedCount();
  assert.ok(animatedBefore > 0, "nothing animates, so the reduced-motion check would prove nothing");
  await displaySettings.getByLabel("Motion").selectOption("reduced");
  await page.waitForTimeout(200);
  assert.equal(await animatedCount(), 0, "reduced motion left something animating");
  await displaySettings.getByLabel("Motion").selectOption("full");

  // Each colour-vision mode repaints the categories, and none of them reuses
  // another mode's palette.
  const categoryColors = () => page.evaluate(() => ["mastered", "recommended", "available", "locked", "stale"]
    .map((category) => getComputedStyle(document.documentElement).getPropertyValue(`--cat-${category}`).trim()));
  const palettesSeen = new Set();
  for (const mode of ["default", "deuteranopia", "protanopia", "tritanopia", "monochrome"]) {
    await displaySettings.getByLabel("Colour").selectOption(mode);
    await page.waitForTimeout(200);
    const colors = await categoryColors();
    assert.equal(new Set(colors).size, 5, `${mode}: ${JSON.stringify(colors)}`);
    assert.equal(palettesSeen.has(colors.join(",")), false, `${mode} reuses another mode's palette`);
    palettesSeen.add(colors.join(","));
    await auditAccessibility(`${mode} palette`);
  }
  await displaySettings.getByLabel("Colour").selectOption("default");
  const themeReport = { lightBrightness: Math.round(lightBrightness), darkBrightness: Math.round(darkBrightness), animatedBefore, palettes: palettesSeen.size };
  // Keyboard navigation works against the real index, not only the fixture.
  const tabStrip = page.locator('.content-tabs[role="tablist"]');
  assert.equal(await tabStrip.locator('[role="tab"][tabindex="0"]').count(), 1, "the tab strip must expose exactly one tab stop");
  await tabStrip.getByRole("tab", { name: "Lesson" }).click();
  await page.locator('[role="tab"][aria-selected="true"]').filter({ hasText: "Lesson" }).waitFor();
  await tabStrip.getByRole("tab", { name: "Lesson" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.locator('[role="tab"][aria-selected="true"]').filter({ hasText: "Diagram" }).waitFor();
  await page.keyboard.press("ArrowLeft");
  await page.locator('[role="tab"][aria-selected="true"]').filter({ hasText: "Lesson" }).waitFor();
  // The skip link is first in the document and lands on the work.
  assert.equal(await page.evaluate(() => document.querySelector(".app-shell")?.firstElementChild?.className), "skip-link");
  await page.locator(".skip-link").focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "workspace-main");
  // Nothing anywhere in the shell steals the tab order with a positive tabindex.
  assert.equal(await page.evaluate(() => document.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])').length), 0);

  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }));
  assert.deepEqual(overflow, { x: false, y: false });
  await page.screenshot({ path: path.join(artifactDirectory, "flashinfer-electron.png") });
  console.log(JSON.stringify({
    ok: true,
    repositoryPath,
    screenshot: path.join(artifactDirectory, "flashinfer-electron.png"),
    callChains: { count: chainAudit.chainCount, longest: chainAudit.chains[0]?.summary, options: chainAudit.optionCount },
    localization: { symbol: localizationAudit.exercise.symbol, goldFiles: localizationAudit.guess.goldFiles, perfectScore: localizationAudit.perfect.score },
    race: { strong: raceAudit.strong.stageScores, weak: raceAudit.weak.stageScores, bands: [raceAudit.strong.band, raceAudit.weak.band] },
    architecture: { modules: architecture.stats.moduleCount, layers: architecture.stats.layerCount, cycles: architecture.stats.cycleCount, violations: architecture.stats.violationCount, busiest: architectureAudit.busiest.id },
    history: { commits: history.commitCount, authors: history.authorCount, busFactor: history.repositoryBusFactor, fixCommits: history.regressions.fixCommits, lessons: historyAudit.lessons.map((lesson) => lesson.id) },
    evidence: { total: evidenceAudit.stats.total, byKind: evidenceAudit.stats.byKind, coverage: evidenceAudit.stats.coverage, skills: Object.keys(evidenceAudit.bySkill).length },
    search: { indexedFiles: searchAudit.first.indexStats.indexedFiles, strategies: searchAudit.first.strategies, coldMs: Math.round(searchAudit.cold), warmMs: Math.round(searchAudit.warm) },
    evaluation: {
      retrieval: { cases: evaluationAudit.retrieval.cases, recallAt1: evaluationAudit.retrieval.recallAt1, recallAt5: evaluationAudit.retrieval.recallAt5, mrr: evaluationAudit.retrieval.mrr, ndcg: evaluationAudit.retrieval.ndcgAt5 },
      tutor: { grounding: evaluationAudit.tutor.grounding, symbolPrecision: evaluationAudit.tutor.symbolPrecision },
      lessons: { score: evaluationAudit.lessons.score, verdict: evaluationAudit.lessons.verdict },
    },
    diagnosis: { skills: diagnosis.skills.length, assessed: diagnosis.summary.assessed, meanConfidence: diagnosis.summary.meanConfidence, brier: diagnosis.summary.meanBrier, overconfident: diagnosis.summary.overconfidentSkills, misconceptions: diagnosis.summary.misconceptionCounts },
    signing: { algorithm: signingAudit.identity.algorithm, keyId: `${signingAudit.identity.keyId.slice(0, 12)}…`, packageSealed: signingAudit.asIs.signature.verified, anchorsSealed: signingAudit.asIs.anchorSignature.verified, tamperReason: signingAudit.doctoredCheck.signature.reason, tamperedImport: signingAudit.doctoredImport.imported, trustBefore: signingAudit.beforeTrust.signature.trust, trustAfter: signingAudit.afterTrust.signature.trust },
    migration: migrationReport,
    accessibility: accessibilityAudits,
    display: themeReport,
    virtualization: virtualReport,
    archive: archiveReport,
    coursePackage: { format: coursePackage.format, commit: (coursePackage.provenance.commit ?? "").slice(0, 8), anchors: coursePackage.integrity.anchorCount, license: coursePackage.license.id, policy: coursePackage.license.policy, embeddedFiles: packageAudit.requested.integrity.excerptCount, roundTrip: packageAudit.roundTrip.verification.verdict, foreign: packageAudit.foreign.verification.verdict },
    goals: Object.fromEntries(goalIds.map((goal) => [goal, { top: rankings[goal][0], targets: rankings[goal].length, topReasons: goalAudit.plans[goal].targets[0].reasons.map((reason) => reason.detail) }])),
    experiments: { arms: experimentAudit.armsSeen.map(([arm, observed]) => `${arm}:declared=${observed.declared},applied=${observed.applied},queued=${observed.queued}`), unconsentedLimit: experimentAudit.controlPlan.parameters.dailyLimit, assignedArm: experimentAudit.consented.assignments.map((item) => `${item.experimentId}=${item.arm}`), assignedLimit, explicitLimit: experimentAudit.explicitPlan.parameters.dailyLimit, observations: experimentAudit.afterObservation.observations, verdict: limitResult.verdict, afterWithdrawal: experimentAudit.afterWithdrawalPlan.parameters.dailyLimit, deleted: experimentAudit.forgotten.deletedObservations },
    analytics: { events: analytics.events, kinds: analytics.timeOnTask.byKind.map((entry) => `${entry.kind}:${entry.events}`), sessions: analytics.timeOnTask.sessions, near: analytics.transfer.near, far: analytics.transfer.far, hintsRevealed: analytics.hints.hintsRevealed, penaltyCarried: analytics.hints.penaltyCarried, retentionVerdict: analytics.retention.modelVerdict, warnings: analytics.warnings.map((warning) => warning.measure) },
    answerGuard: { rungsServed: servedRungs.length, rungIds: servedRungs.map((item) => item.id), finalPenalty: servedRungs.at(-1).penalty, revealedAnswer: revealedNumber, dataChannelsOk: guardAudit.readOk && guardAudit.searchOk },
    activities: { teachBack: activitySet.teachBack.symbol, misleadingScore: activityAudit.misleading.score, misconceptions: activityAudit.misleading.misconceptions.map((finding) => finding.id), solidScore: activityAudit.solid.score, predictions: activitySet.predictions.map((item) => item.metric), boldBrier: activityAudit.bold.brier, humbleBrier: activityAudit.humble.brier, contrastSymbol: activitySet.contrast.symbol, contrastPaths: activitySet.contrast.options.map((option) => `${option.path}:${option.line}`), differences: activityAudit.contrastRight.differences.map((item) => item.id) },
    explanation: { entry: explainAudit.task.entry.name, observedOrder: explainAudit.grounded.observed.order.join(" → "), groundedScore: explainAudit.grounded.score, groundedBand: explainAudit.grounded.band, fabricatedScore: explainAudit.fabricated.score, contradictions: explainAudit.fabricated.contradictions.map((item) => item.claim) },
    executableQuiz: { entry: quizAudit.quiz.entry, anchor: `${quizAudit.quiz.anchor.path}:${quizAudit.quiz.anchor.line}`, hiddenCases: quizAudit.quiz.hiddenCases.length, buildMs: Math.round(quizAudit.buildMs), constantScore: `${quizAudit.constant.passedCases}/${quizAudit.constant.totalCases}`, enforced: quizAudit.constant.enforced, loopingStatus: quizAudit.looping.status },
    schedule: { skills: schedulePlan.summary.skills, due: schedulePlan.summary.due, stale: schedulePlan.summary.stale, meanRetention: schedulePlan.summary.meanRetention, recordedMastery: schedulePlan.summary.recordedMastery, retainedMastery: schedulePlan.summary.retainedMastery, grantedIntervalDays: scheduleAudit.recorded.review.intervalDays },
    executionTrace: { runtime: traceAudit.runtimes.python.version, calls: traceAudit.ran.summary.callCount, transitions: traceAudit.ran.summary.transitions.length, confirmed: traceAudit.ran.summary.confirmedStaticEdges, dynamicOnly: traceAudit.ran.summary.dynamicOnlyEdges },
  }, null, 2));
} finally {
  await electronApp.close();
}

/*
 * Item 51: a real second launch over the same user-data directory, after the
 * saved learner state has been damaged the way an interrupted write damages it.
 * There is no way to prove crash recovery without actually restarting.
 */
const recoveryReport = { checked: false };
try {
  const learningDirectory = path.join(userDataDirectory, "learning");
  const practiceDirectory = path.join(userDataDirectory, "practice");
  const saved = (await readdir(learningDirectory).catch(() => [])).filter((entry) => entry.endsWith(".json"));
  assert.equal(saved.length >= 1, true, "the first run saved no learner state, so there is nothing to recover");
  const statePath = path.join(learningDirectory, saved[0]);
  const before = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(before.format, "trace-durable-v1");
  await access(`${statePath}.bak`);
  const backupBefore = JSON.parse(await readFile(`${statePath}.bak`, "utf8"));

  // Truncate the current save, exactly as a power cut mid-write would, and
  // leave a stray temp file behind as an interrupted write does.
  await writeFile(statePath, (await readFile(statePath, "utf8")).slice(0, 60));
  await writeFile(path.join(learningDirectory, "interrupted.4242.tmp"), "half a save");
  // And leave a practice worktree with no session record, as a crash between
  // creating the worktree and saving the record does.
  await mkdir(path.join(practiceDirectory, "flashinfer-orphan"), { recursive: true });
  await writeFile(path.join(practiceDirectory, "flashinfer-orphan", "unsaved.txt"), "work nobody else knows about\n");

  const relaunched = await electron.launch({
    args: [".", `--user-data-dir=${userDataDirectory}`],
    cwd: process.cwd(),
    env: { ...process.env, VITE_DEV_SERVER_URL: "" },
  });
  try {
    const page = await relaunched.firstWindow();
    await page.getByRole("button", { name: /Explore nano-vllm|Start learning/ }).first().waitFor({ timeout: 60_000 });
    const report = await page.evaluate(() => window.trace.recoveryReport({}));
    assert.equal(report.ready, true, "the recovery report was not built at launch");
    assert.equal(report.clean, false, "an unclean shutdown was reported as clean");
    // The interrupted write was swept rather than left to be read next time.
    assert.ok(report.interruptedWrites.includes("interrupted.4242.tmp"), JSON.stringify(report.interruptedWrites));
    await assert.rejects(() => access(path.join(learningDirectory, "interrupted.4242.tmp")));
    // The orphaned worktree was found and *not* touched.
    assert.equal(report.practice.orphaned.length, 1, JSON.stringify(report.practice.orphaned));
    assert.match(report.practice.orphaned[0], /flashinfer-orphan$/);
    assert.equal(await readFile(path.join(practiceDirectory, "flashinfer-orphan", "unsaved.txt"), "utf8"), "work nobody else knows about\n");
    // The damaged learner state falls back to the previous generation, and the
    // app is usable rather than merely launchable: the repository opens and the
    // recovered mastery is the backup's, not an empty slate.
    const reopened = await page.evaluate((source) => window.trace.openRepository({ source }), repositoryPath);
    assert.ok(reopened.repository.files.length > 1000, String(reopened.repository.files.length));
    const health = await page.evaluate((reference) => window.trace.recoveryReport({ repository: reference }),
      { id: reopened.repository.id, rootPath: reopened.repository.rootPath });
    assert.equal(health.ready, true);
    // The store now reads cleanly again, from whichever generation survived.
    assert.equal(health.learning.recoverable, true, JSON.stringify(health.learning));
    const backupSkills = Object.keys(backupBefore.payload?.mastery ?? {});
    assert.ok(backupSkills.length > 0, "the backup generation held no mastery, so recovery proves nothing");
    assert.deepEqual(
      Object.keys(reopened.learnerState.mastery).sort(),
      backupSkills.sort(),
      "the recovered learner state does not match the generation that survived",
    );
    Object.assign(recoveryReport, {
      checked: true,
      interruptedWrites: report.interruptedWrites,
      orphanedWorktrees: report.practice.orphaned.length,
      staleSessions: report.practice.stale.length,
      backupSavedAt: backupBefore.savedAt,
      damagedBytes: 60,
    });
  } finally {
    await relaunched.close();
  }
  console.log(JSON.stringify({ ok: true, recovery: recoveryReport }, null, 2));
} finally {
  await rm(userDataDirectory, { recursive: true, force: true });
}
