import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const targetUrl = process.env.TRACE_URL ?? "http://127.0.0.1:5173";
const artifactDirectory = path.resolve("artifacts", "qa");
await mkdir(artifactDirectory, { recursive: true });

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
const requestedScripts = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("request", (request) => { if (["script", "fetch", "xhr", "other"].includes(request.resourceType())) requestedScripts.push(request.url()); });
const monacoRequests = () => requestedScripts.filter((url) => /editor\.api|editor\.main|monaco-editor/.test(url));
const languageRequests = () => requestedScripts.filter((url) => /languages\/definitions|\/(python|typescript|cpp|rust|go)-/.test(url));

try {
  await page.goto(targetUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Large text" }).click();
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-boost").trim()), "4px");
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.getByRole("button", { name: "Large text" }).getAttribute("aria-pressed"), "true");
  // Item 23: external links are classified before they are clickable.
  await page.locator('.external-link[data-decision="allow"]').waitFor();
  assert.equal(await page.locator('.external-link[data-decision="allow"]').getAttribute("data-reason"), "allowlisted-origin");
  const gated = page.locator('.external-link[data-decision="confirm"]');
  await gated.waitFor();
  assert.equal(await gated.getAttribute("data-reason"), "unlisted-origin");
  assert.equal(await gated.locator(".link-gate").innerText(), "confirm");
  page.once("dialog", (dialog) => dialog.dismiss());
  await gated.click();
  await page.screenshot({ path: path.join(artifactDirectory, "welcome.png") });
  await page.getByRole("button", { name: /Explore nano-vllm/ }).click();
  await page.getByRole("dialog", { name: "Adaptive skill assessment" }).waitFor();
  await page.screenshot({ path: path.join(artifactDirectory, "adaptive-diagnostic.png") });

  const diagnosticQuestions = page.locator(".diagnostic-questions fieldset");
  for (let index = 0; index < await diagnosticQuestions.count(); index += 1) {
    await diagnosticQuestions.nth(index).locator('input[type="radio"]').first().check();
  }
  await page.getByRole("button", { name: "Build my skill tree" }).click();
  await page.getByText("nano-vllm: Build an LLM Engine").waitFor();
  assert.equal(await page.locator(".index-badge").getAttribute("data-indexer"), "tree-sitter");
  // Item 18: the versioned knowledge graph summary is surfaced in the sidebar.
  await page.locator(".knowledge-graph-card").waitFor();
  assert.equal(await page.locator(".knowledge-graph-card").getAttribute("data-graph-version"), "nano-vllm-featured-v1");
  assert.match(await page.locator(".knowledge-graph-card strong").innerText(), /^\d+ nodes · \d+ edges$/);
  assert.match(await page.locator(".index-badge").getAttribute("title") ?? "", /resolved call edges/);
  await page.locator(".skill-tree").waitFor();
  assert.equal(await page.locator(".skill-node.recommended").count(), 1);
  await page.getByText("YOUR NEXT MOVE").waitFor();
  // Item 19: the editor core must not be fetched while the learner is still reading the lesson.
  await page.waitForTimeout(400);
  assert.deepEqual(monacoRequests(), [], `Monaco was fetched before the Code view: ${monacoRequests().join(", ")}`);
  await page.getByRole("button", { name: "Continue to source" }).click();
  await page.locator(".monaco-editor").waitFor({ timeout: 20_000 });
  assert.ok(monacoRequests().length > 0, "Monaco was never fetched after opening the Code view");
  // Only the grammar for the file being read is fetched.
  const grammars = languageRequests();
  assert.ok(grammars.some((url) => /python/.test(url)), `expected the python grammar, got ${grammars.join(", ")}`);
  assert.equal(grammars.some((url) => /\/(ruby|php|sql|swift)-/.test(url)), false, `unused grammars were fetched: ${grammars.join(", ")}`);
  await page.getByRole("button", { name: "I found the flow" }).click();
  await page.getByRole("button", { name: "Open Quick Ask" }).waitFor();
  await page.screenshot({ path: path.join(artifactDirectory, "skill-tree.png") });

  await page.locator(".content-tabs").getByRole("button", { name: "Diagram" }).click();
  await page.getByText("Request-to-token architecture").waitFor();
  await page.screenshot({ path: path.join(artifactDirectory, "illustrated-lesson.png") });
  await page.getByRole("button", { name: /LLMEngine\.step/ }).click();
  await page.locator(".monaco-editor").waitFor({ timeout: 20_000 });
  await page.getByText("nanovllm/engine/llm_engine.py", { exact: false }).first().waitFor();

  // Item 17: imports and language-server resolution, degrading to the static index.
  await page.locator(".import-section").waitFor();
  assert.equal(await page.locator(".import-section .symbol-heading small").innerText(), "3/4");
  await page.locator(".import-section button.resolved", { hasText: "nanovllm.engine.scheduler" }).click();
  await page.getByText("nanovllm/engine/scheduler.py", { exact: false }).first().waitFor();
  await page.getByRole("button", { name: "Resolve at cursor" }).click();
  await page.locator(".resolution-detail").waitFor();
  assert.equal((await page.locator(".resolution-source").innerText()).toLowerCase(), "static-index");
  await page.getByText(/No language server for python/).waitFor();

  // Item 26: cross-file call chains with grounded, main-process-graded predictions.
  await page.locator(".content-tabs").getByRole("button", { name: "Chains" }).click();
  await page.locator('.call-chain-panel[data-status="ready"]').waitFor();
  assert.equal(
    await page.locator(".chain-steps").getAttribute("data-summary"),
    "LLM() \u2192 generate() \u2192 step() \u2192 schedule() \u2192 allocate()",
  );
  assert.equal(await page.locator(".chain-steps li").count(), 5);
  // The rendered exercise must not leak which option is correct.
  const exercise = page.locator(".chain-exercise").first();
  assert.equal(await exercise.getAttribute("data-graded"), "pending");
  const optionLabels = await exercise.locator(".chain-options label strong").allInnerTexts();
  assert.ok(optionLabels.includes("generate()"), optionLabels.join(", "));
  assert.equal(await exercise.evaluate((element) => /answerId|correct/i.test(element.outerHTML)), false);
  // A wrong prediction is rejected with the real answer and a source anchor.
  const wrongOption = optionLabels.find((label) => label !== "generate()");
  await exercise.locator(".chain-options label", { hasText: wrongOption }).click();
  await exercise.getByRole("button", { name: "Check prediction" }).click();
  await exercise.locator(".chain-feedback.incorrect").waitFor();
  assert.match(await exercise.locator(".chain-feedback strong").innerText(), /the answer is generate\(\)/);
  await exercise.locator(".chain-options label", { hasText: "generate()" }).click();
  await exercise.getByRole("button", { name: "Check prediction" }).click();
  await exercise.locator(".chain-feedback.correct").waitFor();
  assert.match(await exercise.locator(".chain-feedback p").innerText(), /nanovllm\/engine\/llm_engine\.py:\d+/);
  await page.screenshot({ path: path.join(artifactDirectory, "call-chains.png") });
  // Chain steps navigate back to the source they were derived from.
  await page.locator(".chain-steps button").nth(2).click();
  await page.locator(".monaco-editor").waitFor({ timeout: 20_000 });
  await page.getByText("nanovllm/engine/llm_engine.py", { exact: false }).first().waitFor();

  // Item 27: localization drill scores coverage separately from context efficiency.
  await page.locator(".content-tabs").getByRole("button", { name: "Locate" }).click();
  await page.getByRole("button", { name: "Start localization exercise" }).click();
  const drill = page.locator(".localization-panel[data-exercise]");
  await drill.waitFor();
  assert.equal(await drill.getAttribute("data-gold"), "2");
  const prompt = await drill.locator(".localization-prompt").innerText();
  assert.match(prompt, /`generate\(\)`/);
  // The gold paths must not be present in the DOM before submission.
  assert.equal(await drill.evaluate((element) => element.outerHTML.includes("llm_engine.py")), false);
  // Open one relevant and one irrelevant file; both count toward efficiency.
  await drill.locator(".localization-search input").fill("nanovllm/engine/llm_engine.py");
  await drill.locator(".localization-results button", { hasText: "Open" }).first().click();
  await page.locator(".content-tabs").getByRole("button", { name: "Locate" }).click();
  await drill.locator(".localization-search input").fill("nanovllm/models/qwen3.py");
  await drill.locator(".localization-results button", { hasText: "Open" }).first().click();
  await page.locator(".content-tabs").getByRole("button", { name: "Locate" }).click();
  assert.equal(await drill.locator(".localization-trail em").getAttribute("data-inspected"), "2");
  // Selecting only the definition file gives partial coverage and full precision.
  await drill.locator(".localization-trail label", { hasText: "nanovllm/engine/llm_engine.py" }).click();
  await drill.getByRole("button", { name: /^Submit 1 file$/ }).click();
  await drill.locator(".localization-score").waitFor();
  assert.equal(await drill.locator('[data-metric="coverage"]').innerText(), "50%");
  assert.equal(await drill.locator('[data-metric="precision"]').innerText(), "100%");
  assert.equal(await drill.locator(".localization-score").getAttribute("data-passed"), "false");
  assert.match(await drill.locator(".score-missed button").innerText(), /nanovllm\/llm\.py/);
  // A revealed hint is progressive and priced.
  await drill.getByRole("button", { name: /Reveal a hint \(0\/3\)/ }).click();
  await drill.locator(".localization-hint").waitFor();
  assert.match(await drill.locator(".localization-hint span").innerText(), /written in python/);
  assert.equal(await drill.locator(".localization-hint em").innerText(), "-5%");
  await page.screenshot({ path: path.join(artifactDirectory, "localization-drill.png") });

  // Item 28: RACE-style review grades three stages against three rubrics.
  await page.locator(".content-tabs").getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Start graded review" }).click();
  const review = page.locator(".review-panel[data-task]");
  await review.waitFor();
  assert.match(await review.locator(".review-issue").innerText(), /`generate\(\)`/);
  assert.equal(await review.locator('.review-stage[data-stage="understanding"] .review-rubric li').count(), 5);
  assert.equal(await review.locator('.review-stage[data-stage="plan"] .review-rubric li').count(), 5);
  assert.deepEqual(
    await review.locator('.review-stage[data-stage="understanding"] .review-rubric li').evaluateAll((items) => items.map((item) => item.getAttribute("data-met"))),
    ["pending", "pending", "pending", "pending", "pending"],
  );
  await review.locator('.review-stage[data-stage="understanding"] textarea').fill(
    "The generate function in llm_engine.py loops over prompts and sampling_params, but callers in llm.py expect finished sequences to come back in order, so the result is wrong instead of sorted.",
  );
  await review.locator('.review-stage[data-stage="plan"] textarea').fill(
    "1. Change nanovllm/engine/llm_engine.py so that generate preserves the original request ordering.\n2. Check the caller in llm.py for any ordering assumptions it makes.\n3. Add a regression test for the new ordering and run pytest.",
  );
  await review.locator('.review-files label', { hasText: "nanovllm/engine/llm_engine.py" }).click();
  await review.getByRole("button", { name: "Grade my review" }).click();
  await review.locator(".review-report").waitFor();
  assert.equal(await review.locator('[data-criterion="names-symbol"]').getAttribute("data-met"), "true");
  assert.equal(await review.locator('[data-criterion="target-file"]').getAttribute("data-met"), "true");
  assert.equal(await review.locator('[data-criterion="validation"]').getAttribute("data-met"), "true");
  assert.equal(await review.locator('[data-stage-score="understanding"]').innerText(), "100%");
  assert.equal(await review.locator('[data-stage-score="plan"]').innerText(), "100%");
  // Only one of the two gold files was selected, so localization is the weak stage.
  assert.equal(await review.locator(".review-report").getAttribute("data-weakest"), "localization");
  assert.match(await review.locator(".review-next").innerText(), /call edges/);
  await page.screenshot({ path: path.join(artifactDirectory, "graded-review.png") });

  // Item 29: the browser demo cannot start an interpreter and says so honestly.
  await page.locator(".content-tabs").getByRole("button", { name: "Chains" }).click();
  const tracePanel = page.locator(".execution-trace");
  await tracePanel.waitFor();
  assert.equal(await tracePanel.getAttribute("data-runtime"), "unavailable");
  await tracePanel.locator(".trace-snippet").fill("import nanovllm.engine.llm_engine");
  await tracePanel.getByRole("button", { name: "Run and trace" }).click();
  await tracePanel.locator('.trace-problem[data-status="unavailable"]').waitFor();
  assert.match(await tracePanel.locator(".trace-problem pre").innerText(), /only available in the Trace desktop app/);
  assert.equal(await tracePanel.locator(".trace-summary").count(), 0);

  // Item 30: module layers, boundaries, and the current symbol's callers/callees.
  await page.locator(".content-tabs").getByRole("button", { name: "Code" }).click();
  await page.locator(".explorer-search input").fill("engine/llm_engine.py");
  await page.locator(".file-row").first().click();
  await page.locator(".symbol-section button", { hasText: "step" }).first().click();
  await page.locator(".explorer-search input").fill("");
  await page.locator(".content-tabs").getByRole("button", { name: "Diagram" }).click();
  const architecture = page.locator('.architecture-panel[data-status="ready"]');
  await architecture.waitFor();
  assert.ok(Number(await architecture.getAttribute("data-layers")) >= 2, await architecture.getAttribute("data-layers"));
  const layerColumns = await architecture.locator(".layer-column").count();
  assert.ok(layerColumns >= 2, String(layerColumns));
  // nano-vllm really does have a package/engine import cycle, and the view says so
  // instead of inventing a layer for it: both modules share one layer.
  assert.equal(await architecture.getAttribute("data-cycles"), "1");
  const engineLayer = await architecture.locator('.module-card[data-module="nanovllm/engine"]').evaluate((element) => element.closest(".layer-column")?.getAttribute("data-layer"));
  const rootLayer = await architecture.locator('.module-card[data-module="nanovllm"]').evaluate((element) => element.closest(".layer-column")?.getAttribute("data-layer"));
  assert.equal(engineLayer, rootLayer, `cyclic modules must share a layer: ${rootLayer} vs ${engineLayer}`);
  assert.ok(await architecture.locator(".module-card.cyclic").count() >= 2);
  const modelsLayer = await architecture.locator('.module-card[data-module="nanovllm/models"]').evaluate((element) => element.closest(".layer-column")?.getAttribute("data-layer"));
  assert.ok(Number(modelsLayer) > Number(engineLayer), `${engineLayer} -> ${modelsLayer}`);
  await architecture.locator('.boundary-violations button[data-kind="cycle"]').first().waitFor();
  await architecture.locator('.module-card[data-module="nanovllm/engine"]').click();
  await architecture.locator('.module-detail[data-module="nanovllm/engine"]').waitFor();
  assert.ok(await architecture.locator(".module-edges button").count() >= 1);
  // Callers, callees, and data flow for the symbol under the cursor.
  const flow = architecture.locator(".symbol-flow");
  await flow.waitFor();
  assert.equal(await flow.getAttribute("data-symbol"), "step");
  assert.deepEqual(
    (await flow.locator('[data-column="callees"] button').allInnerTexts()).map((text) => text.split("(")[0]).sort(),
    ["postprocess", "run", "schedule"],
  );
  assert.ok((await flow.locator('[data-column="callers"] button').allInnerTexts()).some((text) => text.startsWith("generate")));
  await flow.locator('[data-parameter="self"]').waitFor({ state: "detached" }).catch(() => undefined);
  await page.screenshot({ path: path.join(artifactDirectory, "architecture.png") });

  // Item 31: the demo has no git work tree, so history reports that honestly.
  const history = page.locator(".history-panel");
  await history.waitFor();
  assert.equal(await history.getAttribute("data-status"), "unavailable");
  assert.match(await history.locator('[data-reason="no-history"]').innerText(), /no git history to read/);

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
  await page.screenshot({ path: path.join(artifactDirectory, "side-chat-context.png") });

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
  await page.screenshot({ path: path.join(artifactDirectory, "workspace-compact.png") });
  assert.equal(compactFit.x, false);
  assert.equal(compactFit.y, false);
  assert.ok((compactFit.tutorBottom ?? Infinity) <= compactFit.height + 1, JSON.stringify(compactFit));

  assert.deepEqual(errors, [], `Browser errors:\n${errors.join("\n")}`);
  console.log(JSON.stringify({ ok: true, screenshots: artifactDirectory, fit, compactFit }, null, 2));
} finally {
  await context.close();
  await browser.close();
  webServer?.kill("SIGTERM");
}
