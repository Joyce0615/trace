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
    executionTrace: { runtime: traceAudit.runtimes.python.version, calls: traceAudit.ran.summary.callCount, transitions: traceAudit.ran.summary.transitions.length, confirmed: traceAudit.ran.summary.confirmedStaticEdges, dynamicOnly: traceAudit.ran.summary.dynamicOnlyEdges },
  }, null, 2));
} finally {
  await electronApp.close();
  await rm(userDataDirectory, { recursive: true, force: true });
}
