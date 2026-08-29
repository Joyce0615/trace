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

  await page.getByRole("button", { name: "Learn", exact: true }).click();
  await page.getByText("YOUR NEXT MOVE").waitFor();
  await page.getByRole("button", { name: "Take checkpoint" }).waitFor();

  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }));
  assert.deepEqual(overflow, { x: false, y: false });
  await page.screenshot({ path: path.join(artifactDirectory, "flashinfer-electron.png") });
  console.log(JSON.stringify({ ok: true, repositoryPath, screenshot: path.join(artifactDirectory, "flashinfer-electron.png") }, null, 2));
} finally {
  await electronApp.close();
  await rm(userDataDirectory, { recursive: true, force: true });
}
