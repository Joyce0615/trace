import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const targetUrl = process.env.TRACE_URL ?? "http://127.0.0.1:5173";
const qaArtifactDirectory = path.resolve("artifacts", "qa");
const tutorialDirectory = path.resolve("tutorial", "screenshots");
const tutorialMode = process.env.TRACE_TUTORIAL_SCREENSHOTS === "1";
await mkdir(qaArtifactDirectory, { recursive: true });
if (tutorialMode) await mkdir(tutorialDirectory, { recursive: true });

function screenshotPath(qaName, tutorialName) {
  return tutorialMode && tutorialName
    ? path.join(tutorialDirectory, tutorialName)
    : path.join(qaArtifactDirectory, qaName);
}

async function reachable(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

let webServer;
if (!(await reachable(targetUrl))) {
  if (process.env.TRACE_URL) throw new Error(`TRACE_URL is not reachable: ${targetUrl}`);
  webServer = spawn(process.execPath, [path.resolve("node_modules/vite/bin/vite.js"), "--host", "127.0.0.1"], {
    cwd: process.cwd(),
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 100 && !(await reachable(targetUrl)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!(await reachable(targetUrl))) throw new Error("Vite did not start for the UI smoke test.");
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1580, height: 980 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

try {
  await page.goto(targetUrl, { waitUntil: "networkidle" });
  assert.equal(
    await page.getByText(/Indexing and storage stay local/).count(),
    1,
  );
  assert.equal(await page.getByText(/Your code stays local/).count(), 0);
  await page.getByRole("button", { name: "Large text" }).click();
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-boost").trim()), "4px");
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.getByRole("button", { name: "Large text" }).getAttribute("aria-pressed"), "true");
  await page.screenshot({ path: screenshotPath("welcome.png", "01-welcome.png") });
  await page.getByRole("button", { name: /Explore nano-vllm/ }).click();
  await page.getByRole("dialog", { name: "Adaptive skill assessment" }).waitFor();
  await page.screenshot({ path: screenshotPath("adaptive-diagnostic.png", "02-adaptive-diagnostic.png") });

  const diagnosticQuestions = page.locator(".diagnostic-questions fieldset");
  for (let index = 0; index < await diagnosticQuestions.count(); index += 1) {
    await diagnosticQuestions.nth(index).locator('input[type="radio"]').first().check();
  }
  await page.getByRole("button", { name: "Build my skill tree" }).click();
  await page.getByText("nano-vllm: Build an LLM Engine").waitFor();
  await page.locator(".skill-tree").waitFor();
  assert.equal(await page.locator(".skill-node.recommended").count(), 1);
  await page.getByText("YOUR NEXT MOVE").waitFor();
  await page.getByRole("button", { name: "Continue to source" }).click();
  await page.locator(".monaco-editor").waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "I found the flow" }).click();
  await page.getByRole("button", { name: "Open Quick Ask" }).waitFor();
  await page.screenshot({ path: screenshotPath("skill-tree.png", "03-skill-tree-and-guide.png") });

  await page.locator(".content-tabs").getByRole("button", { name: "Diagram" }).click();
  await page.getByText("Request-to-token architecture").waitFor();
  await page.screenshot({ path: screenshotPath("illustrated-lesson.png", "04-source-linked-diagram.png") });
  await page.getByRole("button", { name: /LLMEngine\.step/ }).click();
  await page.locator(".monaco-editor").waitFor({ timeout: 20_000 });
  await page.getByText("nanovllm/engine/llm_engine.py", { exact: false }).first().waitFor();

  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.getByText("Ask without losing your place.").waitFor();
  await page.locator(".tutor-input textarea").fill("Where is Scheduler defined?");
  await page.locator(".tutor-input button").click();
  await page.getByText(/Scheduler is defined at nanovllm\/engine\/scheduler.py:8/).waitFor();
  await page.getByText(/0 agent credits/).waitFor();
  await page.locator(".context-pack-card > button").click();
  await page.getByText("LEAN PACK").waitFor();
  await page.getByRole("button", { name: "Save to memory" }).click();
  await page.getByText("1 saved learning memories").waitFor();
  await page.screenshot({ path: screenshotPath("side-chat-context.png", "05-side-chat-context.png") });

  await page.getByRole("button", { name: "Learn", exact: true }).click();
  await page.getByRole("button", { name: "Trace the data flow" }).click();
  await page.getByText(/The key idea in/).waitFor();
  await page.getByRole("button", { name: "Quiz", exact: true }).click();
  await page.getByRole("button", { name: "Show hint" }).click();
  await page.getByText("Separate control-plane scheduling from GPU execution.").waitFor();

  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await page.getByText("GUIDED PRACTICE", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Create isolated practice workspace" }).click();
  await page.getByText("Isolated workspace ready").waitFor();
  await page.getByRole("button", { name: "Inspect changes" }).click();
  await page.getByText("No changes yet").waitFor();
  await page.getByRole("button", { name: "End session" }).click();
  await page.getByRole("button", { name: "Create isolated practice workspace" }).waitFor();

  await page.getByRole("button", { name: "Mark lesson complete" }).click();
  await page.getByText("Lesson completed").waitFor();
  await page.locator(".sidebar-view-switch").getByRole("button", { name: "Skill Map" }).click();
  assert.ok(await page.locator(".skill-node.mastered").count() >= 1);

  await page.getByRole("button", { name: "Recompile with Codex" }).click();
  await page.getByText("Reading repository map").waitFor();
  await page.getByText("CODEX CURATED").waitFor();
  await page.getByRole("button", { name: "Claude", exact: true }).click();
  assert.ok(await page.getByRole("button", { name: "Claude", exact: true }).evaluate((element) => element.classList.contains("active")));
  await page.getByRole("button", { name: "Codex", exact: true }).click();

  const fit = await page.evaluate(() => {
    const selectors = [".app-bar", ".course-sidebar", ".code-workspace", ".tutor-panel", ".tutor-input", ".mark-complete"];
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentOverflow: { x: document.documentElement.scrollWidth > document.documentElement.clientWidth, y: document.documentElement.scrollHeight > document.documentElement.clientHeight },
      regions: selectors.map((selector) => { const box = document.querySelector(selector)?.getBoundingClientRect(); return { selector, exists: Boolean(box), top: box?.top, right: box?.right, bottom: box?.bottom, left: box?.left }; }),
    };
  });
  assert.equal(fit.documentOverflow.x, false);
  assert.equal(fit.documentOverflow.y, false);
  for (const region of fit.regions) {
    assert.equal(region.exists, true, `${region.selector} is missing`);
    assert.ok((region.left ?? -1) >= 0 && (region.right ?? Infinity) <= fit.viewport.width + 1, `${region.selector} clips horizontally`);
    assert.ok((region.top ?? -1) >= 0 && (region.bottom ?? Infinity) <= fit.viewport.height + 1, `${region.selector} clips vertically`);
  }

  await page.setViewportSize({ width: 1120, height: 720 });
  await page.waitForTimeout(250);
  const compactFit = await page.evaluate(() => ({ x: document.documentElement.scrollWidth > document.documentElement.clientWidth, y: document.documentElement.scrollHeight > document.documentElement.clientHeight, tutorBottom: document.querySelector(".tutor-panel")?.getBoundingClientRect().bottom, height: window.innerHeight }));
  await page.screenshot({ path: path.join(qaArtifactDirectory, "workspace-compact.png") });
  assert.equal(compactFit.x, false);
  assert.equal(compactFit.y, false);
  assert.ok((compactFit.tutorBottom ?? Infinity) <= compactFit.height + 1, JSON.stringify(compactFit));

  assert.deepEqual(errors, [], `Browser errors:\n${errors.join("\n")}`);
  console.log(JSON.stringify({
    ok: true,
    screenshots: path.relative(process.cwd(), tutorialMode ? tutorialDirectory : qaArtifactDirectory),
    fit,
    compactFit,
  }, null, 2));
} finally {
  await context.close();
  await browser.close();
  webServer?.kill("SIGTERM");
}
