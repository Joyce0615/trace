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
  await page.getByLabel("Repository path or URL").fill(repositoryPath);
  await page.getByRole("button", { name: "Start learning" }).click();
  await page.getByRole("dialog", { name: "Adaptive skill assessment" }).waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByText("flashinfer Deep Dive").waitFor({ timeout: 30_000 });

  assert.equal(await page.evaluate(() => Boolean(window.trace)), true);
  assert.ok(await page.locator(".skill-node").count() >= 4);
  // Item 16: the real repository index must come from tree-sitter with resolved call edges.
  assert.equal(await page.locator(".index-badge").getAttribute("data-indexer"), "tree-sitter");
  const indexSummary = await page.locator(".index-badge").getAttribute("title") ?? "";
  const resolvedEdges = Number(indexSummary.match(/(\d+)\/\d+ resolved call edges/)?.[1] ?? 0);
  assert.ok(resolvedEdges > 0, `expected resolved call edges, got: ${indexSummary}`);

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
