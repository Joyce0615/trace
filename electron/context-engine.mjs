import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { readRepositoryFile } from "./repository.mjs";

const BUDGETS = { lean: 2_400, balanced: 5_200, deep: 10_000 };
const excerptCache = new Map();

export function estimateTokens(value) {
  return Math.max(1, Math.ceil(String(value ?? "").length / 4));
}

function classifyIntent(question) {
  const text = question.toLowerCase();
  if (/where|defined|definition|which file|entry point/.test(text)) return "lookup";
  if (/call|flow|trace|from .* to|data path/.test(text)) return "trace";
  if (/trade.?off|design|why|architecture|compare/.test(text)) return "design";
  if (/practice|exercise|implement|change|test/.test(text)) return "practice";
  return "explain";
}

async function excerpt(repository, filePath, startLine, endLine) {
  const key = `${repository.versionId}:${filePath}:${startLine}:${endLine}`;
  if (excerptCache.has(key)) return { content: excerptCache.get(key), cached: true };
  const source = await readRepositoryFile(repository.rootPath, filePath);
  const lines = source.split(/\r?\n/);
  const start = Math.max(1, startLine);
  const end = Math.min(lines.length, Math.max(start, endLine));
  const content = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n");
  excerptCache.set(key, content);
  if (excerptCache.size > 1_000) excerptCache.delete(excerptCache.keys().next().value);
  return { content, cached: false };
}

function section(kind, title, reason, content, priority, source, cached = false) {
  return {
    id: createHash("sha1").update(`${kind}:${title}:${source ?? ""}`).digest("hex").slice(0, 10),
    kind,
    title,
    source,
    reason,
    content,
    estimatedTokens: estimateTokens(content),
    priority,
    cached,
  };
}

export function answerFromLocalIndex(repository, question) {
  const lookup = question.match(/(?:where is|where's|definition of|defined)\s+[`'“\"]?([A-Za-z_$][\w$]*)/i);
  if (lookup) {
    const matches = repository.symbols.filter((symbol) => symbol.name.toLowerCase() === lookup[1].toLowerCase()).slice(0, 5);
    if (matches.length) {
      return `${lookup[1]} is defined at ${matches.map((match) => `${match.path}:${match.line}`).join(", ")}. Open the source anchor to inspect the implementation.`;
    }
  }
  if (/how many files|file count/i.test(question)) return `${repository.name} contains ${repository.stats.fileCount.toLocaleString()} indexed files.`;
  if (/entry point|where .* start/i.test(question) && repository.entryFiles.length) {
    return `The strongest entry-point candidates are ${repository.entryFiles.slice(0, 4).map((file) => `\`${file}\``).join(", ")}.`;
  }
  return null;
}

export async function buildContextPack(repository, context) {
  const mode = BUDGETS[context.mode] ? context.mode : "balanced";
  const budget = BUDGETS[mode];
  const intent = classifyIntent(context.question);
  const candidates = [];
  candidates.push(section("instruction", "Tutor contract", "Keeps the answer source-grounded and read-only.", "Teach the learner in concise English. Cite repository-relative source locations. End with one concrete next observation. Never modify files.", 100));
  if (context.scope.lesson) {
    candidates.push(section("lesson", context.lesson.title, "Defines the active learning objective.", `${context.lesson.objective}\n${context.lesson.summary}`, 95));
  }
  if (context.skill) {
    candidates.push(section("lesson", `Skill: ${context.skill.title}`, "Connects the answer to the learner's active skill node.", `${context.skill.summary}\nDepth: ${context.skill.depth}\nBranch: ${context.skill.branch}`, 92));
  }
  if (context.memory?.length) {
    const memory = context.memory.slice(-6).map((item) => `- ${item.text}`).join("\n");
    candidates.push(section("memory", "Learning memory", "Avoids repeating concepts the learner already established.", memory, 82));
  }
  const languageSummary = Object.entries(repository.stats.languages).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([language, count]) => `${language} ${count}`).join(", ");
  candidates.push(section("repository", "Repository map", "Provides orientation without sending the whole repository.", `Repository: ${repository.name}\nLanguages: ${languageSummary}\nEntry points: ${repository.entryFiles.slice(0, 6).join(", ") || "unknown"}`, 60));

  if (context.scope.selection && context.openFile?.selection) {
    const selected = await excerpt(repository, context.openFile.path, context.openFile.selection.startLine, context.openFile.selection.endLine);
    candidates.push(section("selection", "Selected code", "The learner explicitly selected this code.", selected.content, 99, `${context.openFile.path}:${context.openFile.selection.startLine}`, selected.cached));
  }
  if (context.scope.currentFile && context.openFile?.path) {
    const radius = mode === "lean" ? 24 : mode === "balanced" ? 55 : 110;
    const current = await excerpt(repository, context.openFile.path, context.openFile.line - radius, context.openFile.line + radius);
    candidates.push(section("source", "Current source window", "The learner is viewing this file and line.", current.content, 90, `${context.openFile.path}:${context.openFile.line}`, current.cached));
  }
  if (context.scope.lesson) {
    for (const anchor of context.lesson.anchors.slice(0, mode === "deep" ? 4 : 2)) {
      if (anchor.path === context.openFile?.path && context.scope.currentFile) continue;
      const radius = mode === "lean" ? 18 : mode === "balanced" ? 38 : 75;
      const anchored = await excerpt(repository, anchor.path, anchor.line - radius, anchor.line + radius);
      candidates.push(section("source", anchor.symbol ?? anchor.path, "This is a validated source anchor for the active lesson.", anchored.content, 88, `${anchor.path}:${anchor.line}`, anchored.cached));
    }
  }
  if (context.scope.dependencies) {
    const activeDirectory = context.openFile?.path.split("/").slice(0, -1).join("/");
    const related = repository.symbols
      .filter((symbol) => symbol.path !== context.openFile?.path && (!activeDirectory || symbol.path.startsWith(activeDirectory)))
      .slice(0, mode === "deep" ? 18 : 8)
      .map((symbol) => `${symbol.path}:${symbol.line} ${symbol.kind} ${symbol.name}`)
      .join("\n");
    if (related) candidates.push(section("related", "Nearby symbols", "Offers a low-cost dependency view before adding more raw files.", related, 68));
  }

  candidates.sort((left, right) => right.priority - left.priority);
  const sections = [];
  const omitted = [];
  let total = estimateTokens(context.question) + 120;
  for (const candidate of candidates) {
    if (total + candidate.estimatedTokens <= budget) {
      sections.push(candidate);
      total += candidate.estimatedTokens;
    } else {
      omitted.push({ title: candidate.title, reason: `Excluded to stay within the ${mode} budget.`, estimatedTokens: candidate.estimatedTokens });
    }
  }
  const naiveTotal = candidates.reduce((sum, candidate) => sum + candidate.estimatedTokens, estimateTokens(context.question));
  return {
    id: createHash("sha256").update(`${repository.versionId}:${context.lesson.id}:${mode}:${context.question}:${sections.map((item) => item.id).join(":")}`).digest("hex").slice(0, 16),
    mode,
    budget,
    estimatedTokens: total,
    savedTokens: Math.max(0, naiveTotal - total),
    sections,
    omitted,
    intent,
    cacheHit: sections.filter((item) => item.kind === "source" || item.kind === "selection").every((item) => item.cached),
  };
}

function responsePath(directory, key) {
  return path.join(directory, `${key}.json`);
}

export function responseCacheKey(repository, provider, context, pack) {
  return createHash("sha256").update(`${repository.versionId}:${provider}:${context.lesson.id}:${pack.mode}:${context.question.trim().toLowerCase()}:${pack.sections.map((item) => item.id).join(":")}`).digest("hex").slice(0, 32);
}

export async function loadCachedResponse(directory, key) {
  try { return JSON.parse(await readFile(responsePath(directory, key), "utf8")); } catch { return null; }
}

export async function saveCachedResponse(directory, key, value) {
  await mkdir(directory, { recursive: true });
  const destination = responsePath(directory, key);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, destination);
}
