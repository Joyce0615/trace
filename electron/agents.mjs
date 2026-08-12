import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const COURSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "subtitle", "modules"],
  properties: {
    title: { type: "string" },
    subtitle: { type: "string" },
    modules: {
      type: "array",
      minItems: 2,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "summary", "lessons"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          lessons: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "title", "objective", "summary", "duration", "difficulty", "kind", "anchor", "quiz"],
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                objective: { type: "string" },
                summary: { type: "string" },
                duration: { type: "number" },
                difficulty: { type: "string", enum: ["foundation", "intermediate", "advanced"] },
                kind: { type: "string", enum: ["lesson", "quiz", "practice", "project"] },
                anchor: {
                  type: "object",
                  additionalProperties: false,
                  required: ["path", "line", "symbol"],
                  properties: {
                    path: { type: "string" },
                    line: { type: "number" },
                    symbol: { type: ["string", "null"] },
                  },
                },
                quiz: {
                  type: "object",
                  additionalProperties: false,
                  required: ["question", "hint"],
                  properties: { question: { type: "string" }, hint: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

function execute(command, args, options = {}) {
  const { cwd, timeoutMs = 180_000 } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} did not finish within ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errors = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) resolve(output);
      else reject(new Error(errors || output || `${command} exited with ${code}`));
    });
  });
}

async function commandVersion(command) {
  try {
    const output = await execute(command, ["--version"], { timeoutMs: 8_000 });
    return { available: true, version: output.split("\n")[0] };
  } catch {
    return { available: false, version: null };
  }
}

export async function detectAgents() {
  const [codex, claude] = await Promise.all([commandVersion("codex"), commandVersion("claude")]);
  return { codex, claude };
}

function tutorPrompt(context) {
  const lesson = context.lesson;
  const anchorText = lesson.anchors
    .map((anchor) => `${anchor.path}:${anchor.line}${anchor.symbol ? ` (${anchor.symbol})` : ""}`)
    .join(", ");
  const packedContext = context.contextPack?.sections
    ?.map((section) => `### ${section.title}${section.source ? ` (${section.source})` : ""}\nReason included: ${section.reason}\n${section.content}`)
    .join("\n\n") ?? "No additional context was selected.";

  return `You are a patient codebase tutor. You are teaching the repository in your current working directory.

Active lesson: ${lesson.title}
Learning objective: ${lesson.objective}
Relevant code anchors: ${anchorText || "Use the repository index to find the best anchor."}
Learner question: ${context.question}

Context pack (${context.contextPack?.mode ?? "balanced"}, approximately ${context.contextPack?.estimatedTokens ?? "unknown"} tokens):
${packedContext}

Answer in concise, approachable English. Ground every important explanation in this repository. Cite source locations as relative/path.ext:line. Guide the learner with one concrete next observation or action. Do not modify files or run destructive commands.`;
}

export async function askAgent(provider, rootPath, context) {
  const prompt = tutorPrompt(context);
  if (provider === "codex") {
    return execute(
      "codex",
      ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--color", "never", "-C", rootPath, prompt],
      { cwd: rootPath },
    );
  }
  if (provider === "claude") {
    return execute(
      "claude",
      ["-p", "--permission-mode", "plan", "--tools", "Read,Grep,Glob", "--output-format", "text", prompt],
      { cwd: rootPath },
    );
  }
  throw new Error(`Unsupported agent provider: ${provider}`);
}

function coursePrompt(repository, starterCourse) {
  const languageSummary = Object.entries(repository.stats.languages)
    .sort((left, right) => right[1] - left[1])
    .map(([language, count]) => `${language}: ${count}`)
    .join(", ");
  const importantSymbols = repository.symbols.slice(0, 120).map((symbol) => `${symbol.path}:${symbol.line} ${symbol.kind} ${symbol.name}`).join("\n");
  const starterOutline = starterCourse.modules.map((module) => ({
    title: module.title,
    summary: module.summary,
    lessons: module.lessons.map((lesson) => ({ id: lesson.id, title: lesson.title, objective: lesson.objective, difficulty: lesson.difficulty, kind: lesson.kind, anchors: lesson.anchors })),
  }));
  return `Act as a senior engineer designing a systematic English-language course for this repository. Inspect the repository read-only before answering.

Repository: ${repository.name}
Languages: ${languageSummary}
Entrypoints: ${repository.entryFiles.join(", ") || "unknown"}
Learning goal: ${starterCourse.profile?.goal ?? "architecture"}
Learner level: ${starterCourse.profile?.level ?? "adaptive"}
Known symbols:\n${importantSymbols}

Compact starter outline for orientation:\n${JSON.stringify(starterOutline)}

Build a concise course that can be compiled into a prerequisite-based skill tree. Teach architecture, one or two critical execution paths, tests, and a final practice or project. Create meaningful branches when learners could pursue systems, implementation, or contribution depth independently. Order lessons by prerequisites. Every lesson must anchor to a real repository-relative path and useful line. Keep the total between 6 and 14 lessons. Return only data matching the requested JSON schema; all learner-facing text must be English.`;
}

function parseStructuredOutput(output) {
  const trimmed = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(trimmed);
  if (parsed?.structured_output) return parsed.structured_output;
  if (typeof parsed?.result === "string") return JSON.parse(parsed.result.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  return parsed;
}

export async function generateCourseWithAgent(provider, rootPath, repository, starterCourse) {
  const prompt = coursePrompt(repository, starterCourse);
  if (provider === "codex") {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trace-course-"));
    const schemaPath = path.join(temporaryDirectory, "course.schema.json");
    try {
      await writeFile(schemaPath, JSON.stringify(COURSE_SCHEMA));
      const output = await execute(
        "codex",
        ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--color", "never", "--output-schema", schemaPath, "-C", rootPath, prompt],
        { cwd: rootPath, timeoutMs: 300_000 },
      );
      return parseStructuredOutput(output);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
  if (provider === "claude") {
    const output = await execute(
      "claude",
      ["-p", "--permission-mode", "plan", "--tools", "Read,Grep,Glob", "--output-format", "json", "--json-schema", JSON.stringify(COURSE_SCHEMA), prompt],
      { cwd: rootPath, timeoutMs: 300_000 },
    );
    return parseStructuredOutput(output);
  }
  throw new Error(`Unsupported agent provider: ${provider}`);
}
