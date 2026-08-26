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
  const graphSummary = await page.evaluate(() => window.trace.graphSummary({ repository: window.traceWorkspace.repository }));
  assert.equal(graphSummary.format, "kg-v1");
  assert.equal(graphSummary.version, graphVersion);
  assert.ok(graphSummary.stats.nodeCount > 1_000, JSON.stringify(graphSummary.stats));
  assert.ok(graphSummary.stats.resolvedCallEdges > 0);
  assert.equal(graphSummary.stats.danglingEdges, 0);
  const hood = await page.evaluate(() => window.trace.graphNeighborhood({ repository: window.traceWorkspace.repository, nodeId: `repository:${window.traceWorkspace.repository.id}`, depth: 1 }));
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
