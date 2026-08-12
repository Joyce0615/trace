import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";

const repositoryPath = process.env.TRACE_ELECTRON_REPO ?? process.cwd();
const repositoryName = path.basename(repositoryPath);
const expectedCourseTitle = `${repositoryName} Deep Dive`;
const lookupQuestion = process.env.TRACE_ELECTRON_REPO
  ? "How many files are indexed?"
  : "Where is inspectRepository defined?";
const qaArtifactDirectory = path.resolve("artifacts", "qa");
const tutorialDirectory = path.resolve("tutorial", "screenshots");
const tutorialMode = process.env.TRACE_TUTORIAL_SCREENSHOTS === "1";
const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), "trace-electron-"));
await mkdir(qaArtifactDirectory, { recursive: true });
if (tutorialMode) await mkdir(tutorialDirectory, { recursive: true });

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
  await page.getByText(expectedCourseTitle).waitFor({ timeout: 30_000 });

  assert.equal(await page.evaluate(() => Boolean(window.trace)), true);
  assert.ok(await page.locator(".skill-node").count() >= 4);

  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.locator(".tutor-input textarea").fill(lookupQuestion);
  await page.locator(".tutor-input button").click();
  if (process.env.TRACE_ELECTRON_REPO) {
    await page.getByText(new RegExp(`${repositoryName} contains \\d[\\d,]* indexed files\\.`)).waitFor({ timeout: 30_000 });
  } else {
    await page.getByText(/inspectRepository is defined at electron\/repository\.mjs:/).waitFor({ timeout: 30_000 });
  }
  await page.getByText(/0 agent credits/).waitFor();
  await page.screenshot({ path: path.join(qaArtifactDirectory, "electron-self-dogfood-chat.png") });
  await page.getByRole("button", { name: "Learn", exact: true }).click();
  await page.getByText("YOUR NEXT MOVE").waitFor();
  await page.getByRole("button", { name: "Take checkpoint" }).waitFor();

  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }));
  assert.deepEqual(overflow, { x: false, y: false });
  const finalScreenshot = tutorialMode
    ? path.join(tutorialDirectory, "06-trace-self-dogfood.png")
    : path.join(qaArtifactDirectory, "electron-self-dogfood.png");
  await page.screenshot({ path: finalScreenshot });
  console.log(JSON.stringify({
    ok: true,
    repository: process.env.TRACE_ELECTRON_REPO ? "configured override" : "project root",
    screenshot: path.relative(process.cwd(), finalScreenshot),
  }, null, 2));
} finally {
  await electronApp.close();
  await rm(userDataDirectory, { recursive: true, force: true });
}
