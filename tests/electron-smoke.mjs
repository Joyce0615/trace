import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";

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
  assert.ok(quizAudit.quiz.example.expected.length > 0);
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
  assert.equal(quizAudit.serialized.includes('"expected"'), true, "only the worked example carries an expected value");
  assert.equal((quizAudit.serialized.match(/"expected"/g) ?? []).length, 1);
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
  await page.locator(".content-tabs").getByRole("button", { name: "Code" }).click();
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
    explanation: { entry: explainAudit.task.entry.name, observedOrder: explainAudit.grounded.observed.order.join(" → "), groundedScore: explainAudit.grounded.score, groundedBand: explainAudit.grounded.band, fabricatedScore: explainAudit.fabricated.score, contradictions: explainAudit.fabricated.contradictions.map((item) => item.claim) },
    executableQuiz: { entry: quizAudit.quiz.entry, anchor: `${quizAudit.quiz.anchor.path}:${quizAudit.quiz.anchor.line}`, hiddenCases: quizAudit.quiz.hiddenCases.length, buildMs: Math.round(quizAudit.buildMs), constantScore: `${quizAudit.constant.passedCases}/${quizAudit.constant.totalCases}`, enforced: quizAudit.constant.enforced, loopingStatus: quizAudit.looping.status },
    schedule: { skills: schedulePlan.summary.skills, due: schedulePlan.summary.due, stale: schedulePlan.summary.stale, meanRetention: schedulePlan.summary.meanRetention, recordedMastery: schedulePlan.summary.recordedMastery, retainedMastery: schedulePlan.summary.retainedMastery, grantedIntervalDays: scheduleAudit.recorded.review.intervalDays },
    executionTrace: { runtime: traceAudit.runtimes.python.version, calls: traceAudit.ran.summary.callCount, transitions: traceAudit.ran.summary.transitions.length, confirmed: traceAudit.ran.summary.confirmedStaticEdges, dynamicOnly: traceAudit.ran.summary.dynamicOnlyEdges },
  }, null, 2));
} finally {
  await electronApp.close();
  await rm(userDataDirectory, { recursive: true, force: true });
}
