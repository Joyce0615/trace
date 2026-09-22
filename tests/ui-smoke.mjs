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

  // Item 39: teach-back, prediction-before-reveal, and contrast, all running the
  // same graders as the desktop app.
  const activities = page.locator(".activity-panel");
  await activities.waitFor();
  await activities.getByRole("button", { name: "Build activities" }).click();
  await activities.locator('.activity-block[data-block="teach-back"][data-available="true"]').waitFor();
  // A fluent teach-back that would plant a misconception must not pass.
  await activities.locator(".teach-input").fill(
    "It runs top to bottom in the order the lines appear, and nothing else calls it, so it is safe to change. For example, step() always returns a token straight away without waiting for anything, which is why the loop stays simple. See nanovllm/engine/llm_engine.py:9 for the code.",
  );
  await activities.getByRole("button", { name: "Check my explanation" }).click();
  await activities.locator(".teach-grade").waitFor();
  assert.equal(await activities.locator(".teach-grade").getAttribute("data-passed"), "false");
  await activities.locator('[data-misconception="execution-order"]').waitFor();
  await activities.locator('[data-misconception="single-caller"]').waitFor();
  // ...even though its surface moves are fine.
  assert.equal(await activities.locator('li[data-move="gives-example"]').getAttribute("data-passed"), "true");
  assert.equal(await activities.locator('li[data-move="cites-source"]').getAttribute("data-passed"), "true");

  // A prediction is answered before anything is revealed.
  const prediction = activities.locator('.prediction-item[data-metric="fan-in"]').first();
  await prediction.waitFor();
  const beforeCommit = await prediction.innerText();
  assert.equal(/is called from/.test(beforeCommit), false, `the answer was revealed before committing: ${beforeCommit}`);
  await prediction.locator("input").fill("97");
  await prediction.locator('button[data-confidence="0.95"]').click();
  await prediction.getByRole("button", { name: "Commit" }).click();
  await prediction.locator(".prediction-outcome").waitFor();
  assert.equal(await prediction.locator(".prediction-outcome").getAttribute("data-correct"), "false");
  assert.equal(await prediction.locator(".prediction-outcome").getAttribute("data-calibration"), "overconfident");
  assert.ok(Number(await prediction.locator("[data-brier]").getAttribute("data-brier")) > 0.9);
  assert.match(await prediction.locator(".prediction-outcome small").innerText(), /is called from \d+ file/);

  // Item 40: the hint ladder is progressive, priced, and never spells the answer.
  const hintTargetId = await activities.locator('.prediction-item[data-answered="false"]').first().getAttribute("data-prediction");
  const hintTarget = activities.locator(`.prediction-item[data-prediction="${hintTargetId}"]`);
  await hintTarget.waitFor();
  await hintTarget.getByRole("button", { name: /^Hint \(0\)$/ }).click();
  await hintTarget.locator(".hint-rung").waitFor();
  assert.equal(await hintTarget.locator(".hint-rung").count(), 1, "only the next rung is served");
  const firstRungId = await hintTarget.locator(".hint-rung").first().getAttribute("data-rung");
  await hintTarget.getByRole("button", { name: /^Hint \(1\)$/ }).click();
  await hintTarget.locator(".hint-rung").nth(1).waitFor();
  const secondRungId = await hintTarget.locator(".hint-rung").nth(1).getAttribute("data-rung");
  assert.notEqual(secondRungId, firstRungId, "the ladder must advance, not repeat");
  // Hints cost, and the cost accumulates.
  const penalty = Number(await hintTarget.locator(".hint-ladder").getAttribute("data-penalty"));
  assert.ok(penalty > 0 && penalty <= 0.45, String(penalty));
  // No rung contains the answer the learner is about to commit to.
  const rungText = await hintTarget.locator(".hint-ladder").innerText();
  await hintTarget.locator("input").fill("1");
  await hintTarget.getByRole("button", { name: "Commit" }).click();
  await hintTarget.locator(".prediction-outcome").waitFor();
  const revealedAnswer = (await hintTarget.locator(".prediction-outcome small").innerText()).match(/\b(\d+)\b/)?.[1];
  assert.ok(revealedAnswer, "the reveal names the real answer");
  assert.equal(new RegExp(`(?:^|[^0-9])${revealedAnswer}(?:[^0-9]|$)`).test(rungText), false, `a hint rung spelled the answer: ${rungText}`);

  // nano-vllm defines no function name twice, so the contrast honestly reports
  // that there is no ambiguity to contrast rather than inventing one.
  const contrast = activities.locator('.activity-block[data-block="contrast"]');
  assert.equal(await contrast.getAttribute("data-available"), "false");
  assert.match(await contrast.locator(".activity-note").innerText(), /defined in two files/);
  assert.equal(await contrast.locator(".contrast-options").count(), 0);
  await page.screenshot({ path: path.join(artifactDirectory, "activities.png") });

  // Item 41: analytics over the events this session actually produced.
  await page.locator(".content-tabs").getByRole("button", { name: "Diagram" }).click();
  const analytics = page.locator(".analytics-panel");
  await analytics.waitFor();
  await analytics.getByRole("button", { name: "Measure my learning" }).click();
  await analytics.locator(".analytics-cards").waitFor();
  assert.equal(await analytics.locator(".analytics-card").count(), 4, "four measures, never averaged");
  // The teach-back, predictions, and contrast completed above are real events.
  const measuredEvents = Number(await analytics.getAttribute("data-events"));
  assert.ok(measuredEvents >= 3, `expected the session's activities to be logged, got ${measuredEvents}`);
  // Hints were revealed above, so hint dependence has something to report.
  const hintedShare = analytics.locator('.analytics-card[data-card="hints"] [data-rate="attempts with a hint"]');
  assert.ok(Number(await hintedShare.getAttribute("data-samples")) >= 3, await hintedShare.getAttribute("data-samples"));
  assert.ok(Number(await hintedShare.getAttribute("data-value")) > 0, "at least one attempt used a hint");
  // A measure without enough evidence says so instead of showing a number.
  const retentionRate = analytics.locator('.analytics-card[data-card="retention"] [data-rate="recalled"]');
  assert.equal(await retentionRate.getAttribute("data-value"), "", "no reviews yet means no retention rate");
  await analytics.locator('.analytics-warnings [data-warning="retention"]').waitFor();
  assert.match(await analytics.locator('[data-warning="retention"]').innerText(), /insufficient evidence/);
  // Time on task is labelled as time between actions, not as attention.
  assert.match(await analytics.locator('.analytics-card[data-card="time"] .analytics-note').innerText(), /idle time/i);
  await page.screenshot({ path: path.join(artifactDirectory, "analytics.png") });

  // Item 44: a shareable package that states its provenance and license policy.
  const sharing = page.locator(".sharing-panel");
  await sharing.waitFor();
  await sharing.getByRole("button", { name: "Build a package" }).click();
  await sharing.locator(".sharing-provenance").waitFor();
  const anchorCount = Number(await sharing.locator(".sharing-provenance").getAttribute("data-anchors"));
  assert.ok(anchorCount >= 1, String(anchorCount));
  // Anchors only by default: nothing is redistributed without being asked for.
  assert.equal(await sharing.locator(".sharing-provenance").getAttribute("data-embeds"), "false");
  assert.match(await sharing.locator('[data-policy="anchors-only"]').innerText(), /no source is redistributed/);
  // Verifying against the repository it came from is an exact match.
  await sharing.getByRole("button", { name: "Verify against this repository" }).click();
  await sharing.locator(".sharing-result").waitFor();
  assert.equal(await sharing.locator(".sharing-result").getAttribute("data-verdict"), "exact");
  assert.equal(await sharing.locator(".sharing-result").getAttribute("data-imported"), "true");
  assert.match(await sharing.locator(".sharing-result small").innerText(), new RegExp(`${anchorCount}/${anchorCount} anchors usable`));
  // Item 45: the browser has no private key store, so it reports the package as
  // unsigned rather than presenting an unverifiable seal as trustworthy.
  assert.equal(await sharing.locator(".sharing-signature").count(), 0);
  const browserSignature = await page.evaluate(async () => window.trace
    ? null
    : (await import("/src/demo.ts")).browserBridge.verifyPackageSignature());
  assert.equal(browserSignature.signature.trust, "unsigned");
  assert.equal(browserSignature.anchorSignature.trust, "unsigned");
  await page.screenshot({ path: path.join(artifactDirectory, "course-package.png") });

  // Item 46: the same matcher the desktop app runs, over a shipped earlier
  // snapshot of the fixture, with the four repairs it can tell apart.
  const migration = page.locator(".migration-panel");
  await migration.waitFor();
  await migration.getByRole("button", { name: "Check anchors" }).click();
  await migration.locator(".migration-totals").waitFor();
  assert.equal(await migration.getAttribute("data-preview"), "true", "the demo says the migrated course is the shipped example");
  assert.match(await migration.locator('[data-note="preview"]').innerText(), /no git history/i);
  const totals = migration.locator(".migration-totals");
  assert.equal(await totals.getAttribute("data-anchors"), "5");
  assert.equal(await totals.getAttribute("data-dead"), "1");
  const migrationStatuses = await migration.locator(".migration-op").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-migration-status")));
  for (const expected of ["moved", "renamed", "split", "file-removed", "unchanged"]) {
    assert.ok(migrationStatuses.includes(expected), `${expected} missing from ${migrationStatuses.join(", ")}`);
  }
  // The ones needing a person are listed first.
  assert.equal(await migration.locator(".migration-op").first().getAttribute("data-review"), "true");
  // Evidence is shown, not just a verdict.
  await migration.locator('.migration-op[data-migration-status="split"] .migration-op-head').click();
  assert.match(await migration.locator('.migration-op[data-migration-status="split"] .migration-evidence').innerText(), /shares its body with 'step'/);
  await migration.getByRole("button", { name: "Migrate this course" }).click();
  await migration.locator(".migration-result").waitFor();
  const migrationResult = migration.locator(".migration-result");
  assert.equal(await migrationResult.getAttribute("data-applied"), "2", "the move and the rename are safe; the split is not");
  assert.equal(await migrationResult.getAttribute("data-retired"), "1");
  assert.equal(await migrationResult.getAttribute("data-orphaned"), "1");
  assert.match(await migrationResult.innerText(), /Prefix Cache Lookups: orphaned/);
  await page.screenshot({ path: path.join(artifactDirectory, "course-migration.png") });

  // Item 47: a note the learner writes is persisted through the bridge and then
  // travels in the offline archive alongside the source its anchors point at.
  await page.locator(".content-tabs").getByRole("button", { name: "Notes" }).click();
  const notesPane = page.locator(".lesson-notes");
  await notesPane.waitFor();
  const noteId = await notesPane.getAttribute("data-note-id");
  assert.match(noteId ?? "", /^lesson:/);
  await notesPane.locator("textarea").fill("The scheduler decides the batch; the runner executes it.");
  await page.waitForFunction(() => (window.traceWorkspace?.notes ?? []).some((note) => /scheduler decides the batch/.test(note.text)));
  // Switching to another view and back must not lose it: notes are App-owned.
  await page.locator(".content-tabs").getByRole("button", { name: "Lesson" }).click();
  await page.locator(".content-tabs").getByRole("button", { name: "Notes" }).click();
  await notesPane.waitFor();
  assert.match(await notesPane.locator("textarea").inputValue(), /scheduler decides the batch/);

  // The archive lives with the other course-level panels.
  await page.locator(".content-tabs").getByRole("button", { name: "Diagram" }).click();
  const archivePanel = page.locator(".archive-panel");
  await archivePanel.waitFor();
  await archivePanel.getByRole("button", { name: "Export everything" }).click();
  await archivePanel.locator(".archive-totals").waitFor();
  const archiveTotals = archivePanel.locator(".archive-totals");
  const archiveAnchors = Number(await archiveTotals.getAttribute("data-anchors"));
  assert.ok(archiveAnchors >= 4, String(archiveAnchors));
  assert.equal(await archiveTotals.getAttribute("data-excerpts"), String(archiveAnchors), "every anchor must carry its source");
  assert.equal(await archivePanel.getAttribute("data-offline"), "true");
  assert.match(await archivePanel.locator('[data-note="offline"]').innerText(), /studied with the repository closed/);
  assert.ok(Number(await archiveTotals.getAttribute("data-notes")) >= 2, "the note just written is in the archive");
  // Reading it back into the repository it came from finds every excerpt current.
  await archivePanel.getByRole("button", { name: "Check it", exact: true }).click();
  await archivePanel.locator(".archive-result").waitFor();
  assert.equal(await archivePanel.locator(".archive-result").getAttribute("data-verdict"), "intact");
  assert.match(await archivePanel.locator(".archive-result small").innerText(), new RegExp(`${archiveAnchors} excerpt\\(s\\) match the current source`));
  // An archive edited outside Trace is detected and refused.
  await archivePanel.getByRole("button", { name: "Check an edited copy" }).click();
  await page.locator('.archive-result[data-verdict="altered"]').waitFor();
  assert.match(await archivePanel.locator(".archive-result").innerText(), /checksum does not match/);
  // Reading the intact one back merges without conflicts and keeps the notes.
  await archivePanel.getByRole("button", { name: "Read it back" }).click();
  await page.locator('.archive-result[data-imported="true"]').waitFor();
  assert.equal(await archivePanel.locator(".archive-result").getAttribute("data-verdict"), "intact");
  await page.screenshot({ path: path.join(artifactDirectory, "offline-archive.png") });

  // Item 42: consent is the gate, and it is reversible.
  const experiments = page.locator(".experiment-panel");
  await experiments.waitFor();
  await experiments.locator(".experiment-item").first().waitFor();
  assert.equal(await experiments.getAttribute("data-consent"), "false", "nothing runs before consent");
  // Every experiment shows the control arm while unconsented.
  const unconsentedArms = await experiments.locator(".experiment-item").evaluateAll((items) => items.map((item) => ({
    enrolled: item.getAttribute("data-enrolled"),
    control: item.querySelector(".experiment-arm i")?.textContent,
  })));
  assert.ok(unconsentedArms.length >= 2, JSON.stringify(unconsentedArms));
  assert.ok(unconsentedArms.every((item) => item.enrolled === "false" && item.control === "control"), JSON.stringify(unconsentedArms));
  assert.match(await experiments.locator(".experiment-note").innerText(), /not taking part/);
  // The panel names exactly what would be stored.
  assert.match(await experiments.locator(".experiment-fields").innerText(), /no code, no paths, no answers/);
  await experiments.getByRole("button", { name: "Take part" }).click();
  await page.locator('.experiment-panel[data-consent="true"]').waitFor();
  assert.equal(await experiments.getAttribute("data-consent"), "true");
  assert.ok(await experiments.locator('.experiment-item[data-enrolled="true"]').count() >= 2);
  // Nothing has been measured yet, so no experiment claims a result.
  const verdicts = await experiments.locator(".experiment-result").evaluateAll((items) => items.map((item) => item.getAttribute("data-verdict")));
  assert.ok(verdicts.every((verdict) => verdict === "underpowered"), JSON.stringify(verdicts));
  // Withdrawing returns every arm to the control behaviour.
  await experiments.getByRole("button", { name: "Withdraw" }).click();
  await experiments.locator('.experiment-item[data-enrolled="false"]').first().waitFor();
  assert.equal(await experiments.getAttribute("data-consent"), "false");
  await experiments.getByRole("button", { name: "Delete everything" }).click();
  await experiments.locator("[data-deleted]").waitFor();
  await page.screenshot({ path: path.join(artifactDirectory, "experiments.png") });

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

  // Item 37: the browser has no interpreter and no sandbox, so the executable
  // quiz refuses to exist rather than faking a graded run.
  const quizPanel = page.locator(".quiz-panel");
  await quizPanel.waitFor();
  await quizPanel.getByRole("button", { name: "Build a quiz" }).click();
  await quizPanel.locator('.quiz-note[data-reason="unavailable"]').waitFor();
  assert.equal(await quizPanel.getAttribute("data-status"), "unavailable");
  assert.match(await quizPanel.locator(".quiz-note").innerText(), /resource-limited local sandbox/);
  assert.equal(await quizPanel.locator(".quiz-editor").count(), 0, "no editor is offered when nothing can run it");
  assert.equal(await quizPanel.locator(".quiz-grade").count(), 0);

  // Item 38: grading an explanation needs a real recorded run, so the browser
  // says so rather than grading against a made-up trace.
  const explainPanel = page.locator(".explain-panel");
  await explainPanel.waitFor();
  await explainPanel.locator(".explain-snippet").fill("import nanovllm\nprint(nanovllm.LLM)");
  await explainPanel.getByRole("button", { name: "Record a run" }).click();
  await explainPanel.locator('.explain-note[data-reason="unavailable"]').waitFor();
  assert.equal(await explainPanel.getAttribute("data-status"), "unavailable");
  assert.match(await explainPanel.locator(".explain-note").innerText(), /real recorded run/);
  assert.equal(await explainPanel.locator(".explain-rubric").count(), 0, "no rubric is shown when nothing was recorded");
  assert.equal(await explainPanel.locator(".explain-observed").count(), 0);

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

  // Item 32: imported evidence, and an honest note about what is unavailable offline.
  const evidence = page.locator('.evidence-panel[data-status="ready"]');
  await evidence.waitFor();
  assert.equal(await evidence.getAttribute("data-total"), "1");
  assert.equal(await evidence.getAttribute("data-linked"), "1");
  assert.match(await evidence.locator(".evidence-unavailable").innerText(), /git history/);
  assert.equal(await evidence.locator('.evidence-item[data-kind="doc"]').count(), 1);
  await evidence.locator('.evidence-tabs button[data-kind="test"]').click();
  await evidence.locator(".evidence-empty").waitFor();
  await evidence.locator('.evidence-tabs button[data-kind="all"]').click();
  await evidence.locator('.evidence-item[data-kind="doc"] .evidence-anchors button').first().click();
  await page.locator(".monaco-editor").waitFor({ timeout: 20_000 });
  await page.getByText("README.md", { exact: false }).first().waitFor();

  // Item 33: hybrid search runs the same retrieval code as the desktop app.
  await page.locator(".content-tabs").getByRole("button", { name: "Code" }).click();
  await page.locator(".explorer-search input").fill("scheduler");
  const searchPanel = page.locator('.search-results[data-state="ready"]');
  await searchPanel.waitFor();
  assert.ok(Number(await searchPanel.getAttribute("data-count")) >= 2, await searchPanel.getAttribute("data-count"));
  assert.match(await searchPanel.locator(".search-heading small").innerText(), /lexical \d+ · symbol \d+ · graph \d+ · embedding \d+/);
  // The Scheduler class is found by the symbol retriever, with its definition line.
  const symbolResult = searchPanel.locator('.search-result[data-strategies*="symbol"]').first();
  await symbolResult.waitFor();
  assert.match(await symbolResult.locator(".search-result-head small").innerText(), /nanovllm\/engine\/scheduler\.py:\d+/);
  // At least one result was found by more than one retriever.
  const strategyLists = await searchPanel.locator(".search-result").evaluateAll((items) => items.map((item) => (item.getAttribute("data-strategies") ?? "").split(",").length));
  assert.ok(Math.max(...strategyLists) >= 2, strategyLists.join(","));
  // A misspelling still finds the file through fuzzy and embedding retrieval.
  await page.locator(".explorer-search input").fill("Schedular");
  await page.waitForTimeout(400);
  assert.ok(await searchPanel.locator('.search-result[data-path="nanovllm/engine/scheduler.py"]').count() >= 1);
  await searchPanel.locator('.search-result[data-path="nanovllm/engine/scheduler.py"]').first().click();
  await page.getByText("nanovllm/engine/scheduler.py", { exact: false }).first().waitFor();
  await page.locator(".explorer-search input").fill("");

  // Item 43: the same repository ranked differently for different goals.
  await page.locator(".content-tabs").getByRole("button", { name: "Diagram" }).click();
  const goals = page.locator(".goal-panel");
  await goals.waitFor();
  await goals.locator(".goal-target").first().waitFor();
  assert.equal(await goals.locator("[data-goal-option]").count(), 5, "five named goals");
  const rankingFor = async (goalId) => {
    await goals.locator(`[data-goal-option="${goalId}"]`).click();
    await page.locator(`.goal-panel[data-goal="${goalId}"]`).waitFor();
    await goals.locator(".goal-target").first().waitFor();
    return goals.locator(".goal-target").evaluateAll((items) => items.map((item) => item.getAttribute("data-path")));
  };
  const performanceRanking = await rankingFor("performance");
  const securityRanking = await rankingFor("security");
  const onboardingRanking = await rankingFor("onboarding");
  assert.ok(performanceRanking.length >= 2, JSON.stringify(performanceRanking));
  // Genuinely different orderings, not a relabelled list.
  assert.notDeepEqual(performanceRanking, securityRanking, JSON.stringify({ performanceRanking, securityRanking }));
  assert.notDeepEqual(onboardingRanking, performanceRanking);
  // Every ranking explains itself with counted evidence.
  const reasons = await goals.locator(".goal-target").first().locator(".goal-reasons span").allInnerTexts();
  assert.ok(reasons.length >= 1, JSON.stringify(reasons));
  assert.ok(reasons.every((reason) => /\d/.test(reason)), JSON.stringify(reasons));
  // The goal recommends the activities that suit it, and the reordered lessons
  // put the relevant ones first.
  assert.ok((await goals.locator(".goal-activities span").count()) >= 2);
  const relevance = await goals.locator(".goal-lessons button").evaluateAll((items) => items.map((item) => item.getAttribute("data-relevant")));
  assert.ok(relevance.length >= 1, JSON.stringify(relevance));
  // A target opens the real file.
  await goals.locator(".goal-target > button").first().click();
  await page.locator(".monaco-editor").waitFor({ timeout: 20_000 });
  await page.locator(".content-tabs").getByRole("button", { name: "Diagram" }).click();
  await page.screenshot({ path: path.join(artifactDirectory, "goals.png") });

  // Item 34: three quality scorecards, never averaged into one number.
  await page.locator(".content-tabs").getByRole("button", { name: "Diagram" }).click();
  const evaluation = page.locator(".evaluation-panel");
  await evaluation.waitFor();
  await evaluation.getByRole("button", { name: "Run evaluation" }).click();
  await evaluation.locator('.scorecard[data-card="retrieval"]').waitFor({ timeout: 30_000 });
  assert.equal(await evaluation.locator(".scorecard").count(), 3);
  const recallAt5 = Number((await evaluation.locator('[data-metric="recall5"]').innerText()).replace("%", ""));
  assert.ok(recallAt5 >= 50, `recall@5 was ${recallAt5}%`);
  assert.equal(await evaluation.locator('[data-metric="anchors"]').innerText(), "100%");
  assert.equal(await evaluation.locator('[data-metric="quiz"]').innerText(), "100%");
  assert.equal(await evaluation.locator('.scorecard[data-card="lessons"]').getAttribute("data-verdict"), "solid");
  // Tutor answers are graded only once there are answers to grade.
  await evaluation.locator('.scorecard[data-card="tutor"]').getByText("no answers yet").waitFor();
  await page.screenshot({ path: path.join(artifactDirectory, "scorecards.png") });

  // Item 35: calibrated confidence and a probe that names the misconception.
  const diagnosis = page.locator(".diagnosis-panel");
  await diagnosis.waitFor();
  await diagnosis.locator(".diagnosis-input").fill("It runs top to bottom, and nothing else calls it.");
  await diagnosis.getByRole("button", { name: "Run diagnosis" }).click();
  await diagnosis.locator(".diagnosis-skill").first().waitFor();
  // Both misconceptions in the learner's own words are named.
  await diagnosis.locator('[data-misconception="execution-order"]').first().waitFor();
  await diagnosis.locator('[data-misconception="single-caller"]').first().waitFor();
  // A skill with evidence is reported with a narrower interval than one without.
  const spreads = await diagnosis.locator(".diagnosis-skill").evaluateAll((items) => items.map((item) => ({
    evidence: item.querySelector(".diagnosis-evidence")?.textContent ?? "",
    confidence: Number(item.querySelector("[data-confidence]")?.getAttribute("data-confidence") ?? 0),
  })));
  const assessed = spreads.filter((entry) => !entry.evidence.startsWith("0 evidence"));
  const unassessed = spreads.filter((entry) => entry.evidence.startsWith("0 evidence"));
  assert.ok(assessed.length >= 1 && unassessed.length >= 1, JSON.stringify(spreads));
  assert.ok(Math.max(...assessed.map((entry) => entry.confidence)) > Math.max(...unassessed.map((entry) => entry.confidence)), JSON.stringify(spreads));
  // A wrong probe answer names the misconception it encodes, with remediation.
  const firstSkill = diagnosis.locator(".diagnosis-skill").first();
  await firstSkill.locator('.probe button[data-option="call-vs-definition"]').click();
  await firstSkill.locator('.probe-result[data-correct="false"]').waitFor();
  assert.match(await firstSkill.locator(".probe-result strong").innerText(), /call site/i);
  assert.match(await firstSkill.locator(".probe-result p").innerText(), /definition anchor/);
  await page.screenshot({ path: path.join(artifactDirectory, "diagnosis.png") });

  // Item 36: spaced repetition, forgetting curves, and mastery decay.
  const schedule = page.locator(".schedule-panel");
  await schedule.waitFor();
  await schedule.getByRole("button", { name: "Plan my reviews" }).click();
  await schedule.locator(".schedule-summary").waitFor();
  // The demo starts with one skill studied three weeks ago and one yesterday.
  const retainedNow = Number((await schedule.locator('[data-summary="retained"]').innerText()).replace("%", ""));
  const recordedNow = Number((await schedule.locator('[data-summary="recorded"]').innerText()).replace("%", ""));
  assert.ok(recordedNow > retainedNow, `decay must be visible: recorded ${recordedNow}% vs retained ${retainedNow}%`);
  // The overdue skill is queued; the one reviewed yesterday is not.
  await schedule.locator('.schedule-item[data-skill="skill-prefix-cache"]').waitFor();
  assert.equal(await schedule.locator('.schedule-item[data-skill="skill-sequence-state"]').count(), 0, "a retained skill is not review work");
  const overdueRecall = Number(await schedule.locator('.schedule-item[data-skill="skill-prefix-cache"] [data-retention]').getAttribute("data-retention"));
  assert.ok(overdueRecall > 0 && overdueRecall < 0.9, `21 days on a 4-day interval should be well below target: ${overdueRecall}`);
  assert.equal(await schedule.locator('.schedule-item[data-skill="skill-prefix-cache"]').getAttribute("data-reason"), "retention-below-target");
  // Grading the review extends the interval and draws the new curve.
  await schedule.locator('.schedule-item[data-skill="skill-prefix-cache"] button[data-grade="good"]').click();
  await schedule.locator(".schedule-result").waitFor();
  const grantedInterval = Number(await schedule.locator(".schedule-result").getAttribute("data-interval"));
  assert.ok(grantedInterval > 4, `a successful late recall must extend the 4-day interval: ${grantedInterval}`);
  assert.equal(await schedule.locator('.schedule-item[data-skill="skill-prefix-cache"]').count(), 0, "a reviewed skill leaves the queue");
  await schedule.locator(".forgetting-curve").waitFor();
  assert.equal(Number(await schedule.locator(".forgetting-curve").getAttribute("data-stability")), grantedInterval);
  await page.screenshot({ path: path.join(artifactDirectory, "recall-schedule.png") });

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
