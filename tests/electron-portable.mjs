import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { auditSnapshot, collectAccessibilitySnapshot } from "../electron/accessibility.mjs";
import { createFixtureRepository } from "../scripts/preflight.mjs";

/**
 * The desktop suite, on any machine (item 54).
 *
 * `electron-smoke.mjs` runs against a real 2,196-file repository and asserts
 * real numbers — 2,196 files, a specific commit, a specific symbol at a
 * specific line. That is why it has found so many real defects, and it is also
 * why it cannot run on a CI runner, which has no such repository and should not
 * depend on somebody else's staying where it is.
 *
 * So this file asserts the same *properties* against a repository it builds
 * itself: the numbers are smaller, the invariants are identical. It is the file
 * the CI matrix runs on macOS, Linux, and Windows; the machine-specific one
 * stays as the deeper evidence where a real repository is available.
 *
 * Nothing here hard-codes a path, a line ending, or a path separator.
 */

const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), "trace-portable-"));
const repositoryPath = process.env.TRACE_PORTABLE_REPO ?? await createFixtureRepository();
const startedAt = Date.now();

const electronApp = await electron.launch({
  args: [".", `--user-data-dir=${userDataDirectory}`],
  cwd: process.cwd(),
  env: { ...process.env, VITE_DEV_SERVER_URL: "", TRACE_NO_PROTOCOL_REGISTRATION: "1" },
});

const report = { platform: `${os.platform()}-${os.arch()}`, node: process.version, repositoryPath };
try {
  const page = await electronApp.firstWindow();
  await page.locator(".welcome-card").waitFor({ timeout: 60_000 });

  // --- Indexing a repository this machine just made -----------------------
  const opened = await page.evaluate((source) => window.trace.openRepository({ source }), repositoryPath);
  assert.ok(opened.repository.files.length >= 8, `only ${opened.repository.files.length} files were indexed`);
  assert.ok(opened.repository.symbols.length >= 8, `only ${opened.repository.symbols.length} symbols were found`);
  assert.ok(["tree-sitter", "regex"].includes(opened.repository.stats.indexer), opened.repository.stats.indexer);
  assert.ok(opened.course.modules.length >= 1);
  const anchors = opened.course.modules.flatMap((module) => module.lessons).flatMap((lesson) => lesson.anchors);
  const indexedPaths = new Set(opened.repository.files.map((file) => file.path));
  assert.ok(anchors.every((anchor) => indexedPaths.has(anchor.path)), "a generated anchor left the index");
  // Paths are repository-relative and separator-normalised on every platform.
  assert.ok(opened.repository.files.every((file) => !file.path.includes("\\") && !path.isAbsolute(file.path)),
    `a path is absolute or uses a backslash: ${opened.repository.files.find((file) => file.path.includes("\\") || path.isAbsolute(file.path))?.path}`);
  const reference = { id: opened.repository.id, rootPath: opened.repository.rootPath };
  report.index = { files: opened.repository.files.length, symbols: opened.repository.symbols.length, indexer: opened.repository.stats.indexer };

  // --- Containment still holds wherever the temporary directory is --------
  const escaped = await page.evaluate((root) => window.trace.readFile(root, "../../../etc/passwd").then(() => "read").catch((error) => error.message), opened.repository.rootPath);
  assert.match(escaped, /outside the repository/i);
  const readBack = await page.evaluate((root) => window.trace.readFile(root, "engine/scheduler.py"), opened.repository.rootPath);
  assert.match(String(readBack), /class Scheduler/);

  // --- Search, over an index built on this machine ------------------------
  const found = await page.evaluate((repository) => window.trace.search({ repository, query: "schedule", limit: 5 }), reference);
  assert.ok(found.results.length >= 1, JSON.stringify(found.strategies));
  assert.ok(found.results.every((result) => indexedPaths.has(result.path)));

  // --- Migration across the fixture's own two commits ---------------------
  // The second commit inserts a comment that moves a definition down, so a
  // course written against the first must follow it. Same property the
  // FlashInfer run checks across 400 commits.
  // The first commit is read straight from the repository this test built, so
  // the migration runs against real history rather than a fabricated id.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const firstCommit = (await promisify(execFile)("git", ["-C", repositoryPath, "rev-list", "--max-parents=0", "HEAD"])).stdout.trim().split("\n")[0];
  assert.match(firstCommit, /^[0-9a-f]{40}$/);
  const course = {
    id: "portable", sourceCommit: firstCommit,
    modules: [{ id: "m", number: "01", title: "T", summary: "", lessons: [{
      id: "l1", title: "Runner", objective: "", summary: "", duration: 5, difficulty: "foundation", kind: "lesson", status: "ready",
      anchors: [{ path: "engine/runner.py", line: 4, symbol: "round_up" }],
      quiz: { question: "", hint: "" },
    }] }],
  };
  const migration = await page.evaluate(({ repository, candidate, commit }) => window.trace.migrateCourse({ repository, course: candidate, fromCommit: commit, apply: true }), { repository: reference, candidate: course, commit: firstCommit });
  assert.equal(migration.available, true, migration.reason);
  const operation = migration.plan.operations[0];
  assert.equal(operation.status, "moved", JSON.stringify(operation));
  assert.equal(operation.to.line, 5, "the definition moved down by the comment added in the second commit");
  assert.equal(migration.applied, 1);
  const reverted = await page.evaluate(({ repository, candidate }) => window.trace.revertCourseMigration({ repository, course: candidate }), { repository: reference, candidate: migration.course });
  assert.equal(JSON.stringify(reverted.course.modules), JSON.stringify(course.modules), "the revert was not exact");
  report.migration = { from: firstCommit.slice(0, 8), status: operation.status, movedTo: operation.to.line };

  // --- Offline archive, with excerpts of this repository's source ---------
  const archive = await page.evaluate(({ repository, candidate }) => window.trace.exportArchive({ repository, course: candidate }), { repository: reference, candidate: opened.course });
  assert.equal(archive.completeness.excerpted, archive.completeness.anchors);
  assert.equal(archive.completeness.offlineReadable, true, JSON.stringify(archive.completeness.missing));
  const checked = await page.evaluate(({ repository, candidate }) => window.trace.importArchive({ repository, archive: candidate }), { repository: reference, candidate: archive });
  assert.equal(checked.verification.verdict, "intact");
  assert.equal(checked.verification.excerpts.counts.drifted, 0);
  report.archive = { anchors: archive.completeness.anchors, excerpts: archive.completeness.excerpted };

  // --- Deep links and window lifecycle ------------------------------------
  const link = await page.evaluate((root) => window.trace.openDeepLink(`trace://open?repo=${encodeURIComponent(root)}&file=engine/engine.py&line=3`), opened.repository.rootPath);
  assert.equal(link.valid, true, link.detail);
  assert.equal(link.intent.file, "engine/engine.py");
  const traversal = await page.evaluate((root) => window.trace.openDeepLink(`trace://open?repo=${encodeURIComponent(root)}&file=../../secrets`), opened.repository.rootPath);
  assert.equal(traversal.reason, "unsafe-path");
  const windows = await page.evaluate(() => window.trace.windowState());
  assert.equal(windows.windows, 1);
  assert.deepEqual(windows.indexed, [opened.repository.id]);

  // --- Recovery, themes, virtualization, accessibility --------------------
  const recovery = await page.evaluate((repository) => window.trace.recoveryReport({ repository }), reference);
  assert.equal(recovery.ready, true);
  assert.equal(recovery.clean, true, `a fresh user-data directory reported an unclean launch: ${JSON.stringify(recovery)}`);

  // The workspace is entered through the interface, not through IPC, because
  // that is the path a learner takes and the one the audit has to hold on.
  await page.getByLabel("Repository path or URL").fill(repositoryPath);
  await page.getByRole("button", { name: "Start learning" }).click();
  await page.getByRole("dialog", { name: "Adaptive skill assessment" }).waitFor({ timeout: 120_000 });
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.locator(".content-tabs").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
  const audit = auditSnapshot(await page.evaluate(collectAccessibilitySnapshot));
  assert.deepEqual(audit.violations, [], `accessibility violations on ${os.platform()}:\n${audit.violations.map((violation) => `  ${violation.rule} ${violation.selector} — ${violation.detail}`).join("\n")}`);
  assert.ok(audit.rendered > 100, String(audit.rendered));
  report.accessibility = { rendered: audit.rendered, interactive: audit.interactive };

  const themes = [];
  for (const theme of ["dark", "light"]) {
    for (const contrast of ["normal", "high"]) {
      await page.evaluate(([selectedTheme, selectedContrast]) => {
        document.documentElement.dataset.theme = selectedTheme;
        document.documentElement.dataset.contrast = selectedContrast;
      }, [theme, contrast]);
      await page.waitForTimeout(150);
      const themed = auditSnapshot(await page.evaluate(collectAccessibilitySnapshot));
      assert.deepEqual(themed.violations, [], `${theme}/${contrast} on ${os.platform()}: ${JSON.stringify(themed.violations.slice(0, 3))}`);
      themes.push(`${theme}/${contrast}`);
    }
  }
  report.themes = themes;

  await page.locator(".content-tabs").getByRole("tab", { name: "Code" }).click();
  await page.locator(".file-list").waitFor();
  const fileList = page.locator(".file-list");
  assert.equal(Number(await fileList.getAttribute("data-virtual-total")), opened.repository.files.length);
  assert.ok(Number(await fileList.getAttribute("data-virtual-rendered")) <= opened.repository.files.length);

  report.ok = true;
  report.durationMs = Date.now() - startedAt;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await electronApp.close();
  await rm(userDataDirectory, { recursive: true, force: true });
  if (!process.env.TRACE_PORTABLE_REPO) await rm(repositoryPath, { recursive: true, force: true });
}
