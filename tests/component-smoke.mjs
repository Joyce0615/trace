import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { auditSnapshot, collectAccessibilitySnapshot } from "../electron/accessibility.mjs";

/**
 * Component tests (item 53).
 *
 * The smoke tests drive the whole application, which is the right way to learn
 * whether it works and the wrong way to learn whether a *component* does.
 * Reaching a panel's empty state, its error state, or a list of five thousand
 * rows through the real app means arranging for a real failure or a real
 * repository, so those branches went untested for fifteen items. Each component
 * here is mounted alone, with props chosen to hit exactly the state under test.
 *
 * The harness is served by the dev server rather than built into the app, so
 * none of this reaches the shipped bundle.
 */

const targetUrl = process.env.TRACE_URL ?? "http://127.0.0.1:5174";

async function reachable(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

let webServer;
if (!(await reachable(targetUrl))) {
  webServer = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", "5174", "--strictPort"], { stdio: "ignore", detached: false });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !(await reachable(targetUrl))) await new Promise((resolve) => setTimeout(resolve, 300));
  if (!(await reachable(targetUrl))) throw new Error("The dev server did not start.");
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

const mount = async (component, props = {}) => {
  await page.goto(`${targetUrl}/components.html?component=${component}&props=${encodeURIComponent(JSON.stringify(props))}`, { waitUntil: "networkidle" });
  await page.locator('[data-harness="ready"]').waitFor();
};

const results = [];
try {
  // --- The windowed list, at a size no fixture can reach -------------------
  await mount("VirtualList", { total: 5_000, height: 260 });
  const list = page.locator(".file-list");
  await list.waitFor();
  assert.equal(await list.getAttribute("data-virtual-total"), "5000");
  const rendered = Number(await list.getAttribute("data-virtual-rendered"));
  assert.ok(rendered > 0 && rendered < 40, `${rendered} rows rendered for a 260px viewport`);
  assert.equal(await page.locator(".file-list .file-row").count(), rendered);
  assert.equal(await list.evaluate((node) => node.scrollHeight), 5_000 * 26);
  // The first row is row 0, and scrolling to the end shows row 4,999 — which is
  // the property the old truncating list could not satisfy at any size.
  assert.equal(await page.locator(".file-list .file-row").first().getAttribute("title"), "row-0");
  await list.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await page.waitForFunction(() => Number(document.querySelector(".file-list").dataset.virtualEnd) === 5_000);
  assert.equal(await page.locator(".file-list .file-row").last().getAttribute("title"), "row-4999");
  assert.ok(await page.locator(".file-list .file-row").count() < 40, "the DOM grew while scrolling");
  // Scrolling to the middle shows the middle, not a re-rendered top.
  await list.evaluate((node) => { node.scrollTop = node.scrollHeight / 2; });
  await page.waitForTimeout(150);
  const middle = await page.locator(".file-list .file-row").first().getAttribute("title");
  assert.match(middle, /^row-2\d{3}$/, `the middle of the list showed ${middle}`);
  results.push({ component: "VirtualList", total: 5_000, rendered });

  // --- An empty list is a list, not a crash --------------------------------
  await mount("VirtualList", { total: 0, height: 260 });
  assert.equal(await page.locator(".file-list").getAttribute("data-virtual-total"), "0");
  assert.equal(await page.locator(".file-list .file-row").count(), 0);
  // ...and a list of one renders exactly one row.
  await mount("VirtualList", { total: 1, height: 260 });
  assert.equal(await page.locator(".file-list .file-row").count(), 1);
  results.push({ component: "VirtualList", edgeCases: ["empty", "single"] });

  // --- Panels in their idle state, mounted with no data --------------------
  // Every one of these is a state the full app passes through in milliseconds
  // and never sits in, so it is exactly what a component test is for.
  const repository = { id: "component-repo", rootPath: "/component", name: "component", files: [], symbols: [], stats: {} };
  const idleStates = [
    ["SharingPanel", { repository, course: null, skillGraph: null, state: { packaged: null, result: null, embedSource: false, status: "idle" }, onState: null }, ".sharing-panel"],
    ["MigrationPanel", { repository, course: null, state: { result: null, applied: null, expanded: null, accept: "auto", status: "idle" } }, ".migration-panel"],
    ["ArchivePanel", { repository, course: null, skillGraph: null, learnerState: null, state: { archive: null, result: null, mode: "merge", status: "idle" } }, ".archive-panel"],
  ];
  for (const [component, props, selector] of idleStates) {
    await mount(component, props);
    const panel = page.locator(selector);
    await panel.waitFor();
    assert.equal(await panel.getAttribute("data-status"), "idle", `${component} did not start idle`);
    // With no course there is nothing to package, migrate, or export, and the
    // control that would try must be disabled rather than throwing.
    const primary = panel.locator("button").first();
    assert.equal(await primary.isDisabled(), true, `${component}'s primary action is enabled with no course`);
    results.push({ component, state: "idle", primaryDisabled: true });
  }

  // --- The error state, which the app only reaches when something breaks ---
  await mount("SharingPanel", { repository, course: null, skillGraph: null, state: { packaged: null, result: null, embedSource: false, status: "error" } });
  await page.locator('.sharing-panel[data-status="error"]').waitFor();
  assert.match(await page.locator(".sharing-note").innerText(), /unavailable/i);
  await mount("MigrationPanel", { repository, course: null, state: { result: { available: false, reason: "Commit 0000 is not in this repository's history.", plan: null }, applied: null, expanded: null, accept: "auto", status: "unavailable" } });
  assert.match(await page.locator('[data-reason="unavailable"]').innerText(), /not in this repository's history/);
  results.push({ component: "SharingPanel", state: "error" }, { component: "MigrationPanel", state: "unavailable" });

  // --- A component is accessible on its own, not only inside the app -------
  // A panel that only passes the audit because the shell around it supplies a
  // landmark is a panel that will fail the moment it is reused.
  for (const [component, props] of [["VirtualList", { total: 40, height: 200 }], ...idleStates.map(([name, panelProps]) => [name, panelProps])]) {
    await mount(component, props);
    await page.waitForTimeout(150);
    const audit = auditSnapshot(await page.evaluate(collectAccessibilitySnapshot), { skipRules: ["landmark-main"] });
    assert.deepEqual(
      audit.violations,
      [],
      `${component} has accessibility violations in isolation:\n${audit.violations.map((violation) => `  ${violation.rule} ${violation.selector} — ${violation.detail}`).join("\n")}`,
    );
    results.push({ component, isolatedAudit: "clean", elements: audit.rendered });
  }

  // --- An unknown component is reported, so a typo in a test is not silent -
  await mount("NotAComponent");
  assert.match(await page.locator('[data-harness="unknown"]').innerText(), /No component named/);

  assert.deepEqual(errors, [], `Component errors:\n${errors.join("\n")}`);
  console.log(JSON.stringify({ ok: true, components: results.length, results }, null, 2));
} finally {
  await browser.close();
  if (webServer) webServer.kill("SIGTERM");
}
