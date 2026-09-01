import { createHash } from "node:crypto";
import { access, lstat, mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { analyzeSource, treeSitterSupports } from "./tree-sitter-index.mjs";
import { resolveImportsStatically } from "./language-server.mjs";
import { cloneArguments, cloneDestination, cloneEnvironment, looksRemote, parseRemoteSource, summarizeSubmodules, verifyExistingClone } from "./clone-guard.mjs";

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".trace",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

const LANGUAGE_BY_EXTENSION = {
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cu": "cuda",
  ".cuh": "cuda",
  ".cs": "csharp",
  ".css": "css",
  ".go": "go",
  ".html": "html",
  ".h": "c",
  ".hpp": "cpp",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascript",
  ".json": "json",
  ".kt": "kotlin",
  ".md": "markdown",
  ".mjs": "javascript",
  ".php": "php",
  ".py": "python",
  ".rb": "ruby",
  ".rst": "rst",
  ".rs": "rust",
  ".scss": "scss",
  ".sh": "shell",
  ".sql": "sql",
  ".swift": "swift",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".vue": "vue",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
};

const ENTRY_BASENAMES = new Set([
  "__main__.py",
  "app.py",
  "cli.py",
  "index.js",
  "index.ts",
  "index.tsx",
  "main.go",
  "main.py",
  "main.rs",
  "main.ts",
  "build_backend.py",
  "server.js",
  "server.py",
  "server.ts",
]);

export const DEFAULT_INDEX_LIMITS = {
  maxFiles: 4_000,
  maxFileBytes: 2_000_000,
  maxTotalBytes: 900_000_000,
  maxAnalyzedFiles: 1_200,
  maxSymbols: 2_500,
  maxReferences: 20_000,
  maxCallEdges: 20_000,
  maxImports: 20_000,
  analysisBatchSize: 48,
};

export class IndexCancelledError extends Error {
  constructor(phase) {
    super("Repository indexing was cancelled.");
    this.name = "IndexCancelledError";
    this.cancelled = true;
    this.phase = phase;
  }
}

function throwIfCancelled(signal, phase) {
  if (signal?.aborted) throw new IndexCancelledError(phase);
}

function resolveLimits(overrides = {}) {
  const limits = { ...DEFAULT_INDEX_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (key in limits && Number.isFinite(value) && value > 0) limits[key] = Math.floor(value);
  }
  return limits;
}

function progressReporter(onProgress) {
  let lastPhase = null;
  return (phase, completed, total, message) => {
    if (typeof onProgress !== "function") return;
    lastPhase = phase;
    try {
      onProgress({
        phase,
        completed: Math.max(0, Math.round(completed)),
        total: Math.max(0, Math.round(total)),
        ratio: total > 0 ? Math.min(1, completed / total) : 0,
        message,
        at: Date.now(),
      });
    } catch {
      // A failing progress listener must never fail the index.
      void lastPhase;
    }
  };
}

function run(command, args, options = {}) {
  const { cwd, timeoutMs = 30_000, signal = null, env = process.env } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new IndexCancelledError("run")); return; }
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onAbort = () => { child.kill("SIGTERM"); reject(new IndexCancelledError("run")); };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else reject(new Error(result.stderr.trim() || `${command} exited with ${code}`));
    });
  });
}

async function ensureLocalRepository(input, repositoriesDirectory, options = {}) {
  const value = String(input ?? "").trim();
  throwIfCancelled(options.signal, "prepare");
  if (!value) throw new Error("Choose a repository first.");

  if (!looksRemote(value)) {
    const resolved = await realpath(path.resolve(value));
    const details = await stat(resolved);
    if (!details.isDirectory()) throw new Error("The selected path is not a directory.");
    return { rootPath: resolved, source: "local", remoteUrl: null, submodules: summarizeSubmodules(await readOptionalFile(path.join(resolved, ".gitmodules"))) };
  }

  // Every remote is validated before it reaches git: protocol allowlist, no
  // embedded credentials, no transport helpers, no archives, no option injection.
  const remote = parseRemoteSource(value);
  await mkdir(repositoriesDirectory, { recursive: true });
  const destination = cloneDestination(repositoriesDirectory, remote);

  let reuse = { reusable: false, reason: "absent" };
  try {
    await access(path.join(destination, ".git"));
    const origin = await gitValue(destination, ["config", "--get", "remote.origin.url"], "");
    reuse = verifyExistingClone(remote, origin);
    if (!reuse.reusable) {
      // A cached directory must never be silently repointed at a different remote.
      await rm(destination, { recursive: true, force: true });
    }
  } catch {
    reuse = { reusable: false, reason: "absent" };
  }

  if (!reuse.reusable) {
    await run("git", cloneArguments(remote, destination), {
      timeoutMs: options.cloneTimeoutMs ?? 180_000,
      signal: options.signal,
      env: cloneEnvironment(),
    });
  }

  const rootPath = await realpath(destination);
  const submodules = summarizeSubmodules(await readOptionalFile(path.join(rootPath, ".gitmodules")));
  return { rootPath, source: "remote", remoteUrl: remote.normalized, remote, submodules, reusedClone: reuse.reusable };
}

async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function gitValue(rootPath, args, fallback = "") {
  try {
    return (await run("git", ["-C", rootPath, ...args])).stdout.trim();
  } catch {
    return fallback;
  }
}

/** Untrimmed git output: porcelain status lines start with a significant space. */
async function gitOutput(rootPath, args, fallback = "") {
  try {
    return (await run("git", ["-C", rootPath, ...args])).stdout;
  } catch {
    return fallback;
  }
}

/** Parse `git status --porcelain` into the set of paths whose working tree differs from HEAD. */
export function changedPathsFromStatus(statusText) {
  return new Set(
    statusText
      .split(/\r?\n/)
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).replace(/^.* -> /, "").replace(/^"(.*)"$/, "$1").trim())
      .filter(Boolean),
  );
}

async function walkDirectory(rootPath, currentPath = rootPath, output = [], maxFiles = DEFAULT_INDEX_LIMITS.maxFiles, signal = null) {
  if (output.length >= maxFiles) return output;
  throwIfCancelled(signal, "discover");
  const entries = await readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    if (output.length >= maxFiles) break;
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(currentPath, entry.name);
    if (entry.isDirectory()) await walkDirectory(rootPath, absolute, output, maxFiles, signal);
    else if (entry.isFile()) output.push(path.relative(rootPath, absolute));
  }
  return output;
}

async function listRepositoryFiles(rootPath, limits = DEFAULT_INDEX_LIMITS, signal = null) {
  try {
    const { stdout } = await run(
      "git",
      ["-C", rootPath, "ls-files", "-co", "--exclude-standard", "-z"],
      { timeoutMs: 45_000 },
    );
    const files = stdout.split("\0").filter(Boolean);
    if (files.length) return { files: files.slice(0, limits.maxFiles), discovered: files.length };
  } catch {
    // A plain folder is still a valid learning source.
  }
  const walked = await walkDirectory(rootPath, rootPath, [], limits.maxFiles, signal);
  return { files: walked, discovered: walked.length };
}

async function gitBlobIds(rootPath) {
  try {
    const { stdout } = await run("git", ["-C", rootPath, "ls-files", "-s", "-z"], { timeoutMs: 45_000 });
    const entries = new Map();
    for (const record of stdout.split("\0").filter(Boolean)) {
      const match = record.match(/^\d+\s+([0-9a-f]+)\s+\d+\t(.+)$/);
      if (match) entries.set(match[2], match[1]);
    }
    return entries;
  } catch {
    return new Map();
  }
}

function languageFor(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  return LANGUAGE_BY_EXTENSION[path.extname(base)] ?? "plaintext";
}

const LANGUAGE_FAMILIES = { c: "c-family", cpp: "c-family", cuda: "c-family", javascript: "js-family", typescript: "js-family" };

/** Languages that can legitimately call into each other's definitions. */
export function languageFamily(language) {
  return LANGUAGE_FAMILIES[language ?? ""] ?? language ?? "unknown";
}

export function fileImportance(filePath, language = languageFor(filePath)) {
  const normalized = filePath.split(path.sep).join("/");
  const parts = normalized.split("/");
  const top = parts[0];
  const base = parts.at(-1)?.toLowerCase() ?? "";
  let score = Math.max(0, 30 - parts.length * 3);

  if (parts.length === 1) score += 80;
  if (top.startsWith(".")) score -= 100;
  if (["3rdparty", "vendor", "generated", "dist", "build"].includes(top)) score -= 140;
  if (["src", "lib", "app"].includes(top)) score += 95;
  if (["include", "csrc"].includes(top)) score += 82;
  if (["tests", "test"].includes(top)) score += 50;
  if (["examples", "example"].includes(top)) score += 35;
  if (["benchmarks", "benchmark", "ci", "scripts"].includes(top)) score -= 15;
  if (["python", "typescript", "javascript", "go", "rust", "cuda", "cpp", "c"].includes(language)) score += 25;
  if (["__main__.py", "main.py", "main.ts", "index.ts", "index.js", "core.py", "api.py", "env.py"].includes(base)) score += 35;
  if (base === "__init__.py") score += parts.length === 2 ? 35 : -25;
  if (/^(readme|contributing|architecture)(\.|$)/i.test(base)) score += parts.length === 1 ? 80 : 10;
  if (/^(test_|.*\.(test|spec)\.)/.test(base)) score -= 5;
  return score;
}

function symbolPatterns(language) {
  if (language === "python") {
    return [
      { kind: "class", expression: /^\s*class\s+([A-Za-z_]\w*)/ },
      { kind: "function", expression: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    ];
  }
  if (["typescript", "javascript"].includes(language)) {
    return [
      { kind: "class", expression: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/ },
      { kind: "interface", expression: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
      { kind: "type", expression: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
      { kind: "function", expression: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
      { kind: "function", expression: /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/ },
    ];
  }
  if (language === "go") {
    return [{ kind: "function", expression: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ }];
  }
  if (language === "rust") {
    return [
      { kind: "struct", expression: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/ },
      { kind: "function", expression: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
    ];
  }
  if (["cuda", "cpp", "c"].includes(language)) {
    return [
      { kind: "class", expression: /^\s*(?:template\s*<[^;]+>\s*)?(?:class|struct)\s+([A-Za-z_]\w*)/ },
      { kind: "function", expression: /^\s*(?:(?:static|inline|constexpr|__host__|__device__|__global__|extern)\s+)*(?:[A-Za-z_][\w:<>]*[\s*&]+)+([A-Za-z_]\w*)\s*\(/ },
    ];
  }
  if (["java", "kotlin", "csharp"].includes(language)) {
    return [{ kind: "class", expression: /^\s*(?:public\s+)?(?:abstract\s+)?(?:class|interface)\s+([A-Za-z_]\w*)/ }];
  }
  return [];
}

// Per-blob analysis cache: re-indexing a repository only re-parses files whose
// content hash changed, which is what makes knowledge-graph rebuilds incremental.
const ANALYSIS_CACHE_LIMIT = 8_000;
const analysisCache = new Map();
let analysisCacheHits = 0;

export function analysisCacheStats() {
  return { entries: analysisCache.size, hits: analysisCacheHits, limit: ANALYSIS_CACHE_LIMIT };
}

export function resetAnalysisCache() {
  analysisCache.clear();
  analysisCacheHits = 0;
}

function regexSymbols(file, source) {
  const patterns = symbolPatterns(file.language);
  if (!patterns.length) return [];
  const symbols = [];
  source.split(/\r?\n/).forEach((line, index) => {
    for (const pattern of patterns) {
      const match = line.match(pattern.expression);
      if (match) {
        symbols.push({ name: match[1], kind: pattern.kind, path: file.path, line: index + 1 });
        break;
      }
    }
  });
  return symbols.slice(0, 80);
}

/**
 * Structural index for one file. Tree-sitter supplies definitions, references,
 * and call edges; the regex indexer remains the deterministic fallback for
 * languages without a grammar or when a parse fails.
 */
export async function analyzeFile(rootPath, file) {
  const empty = { symbols: [], references: [], callEdges: [], imports: [], indexer: "none" };
  if (file.size > 600_000) return empty;
  const canParse = treeSitterSupports(file.language, file.path);
  if (!canParse && !symbolPatterns(file.language).length) return empty;
  const cacheKey = file.blobId ? `${file.path}:${file.blobId}` : null;
  if (cacheKey && analysisCache.has(cacheKey)) {
    analysisCacheHits += 1;
    return analysisCache.get(cacheKey);
  }
  let source;
  try {
    source = await readFile(path.join(rootPath, file.path), "utf8");
  } catch {
    return empty;
  }
  let result = null;
  if (canParse) {
    const analysis = await analyzeSource(file.path, file.language, source);
    if (analysis?.definitions.length || analysis?.imports.length) {
      result = {
        symbols: analysis.definitions.slice(0, 80),
        references: analysis.references,
        callEdges: analysis.callEdges,
        imports: analysis.imports,
        indexer: "tree-sitter",
      };
    }
  }
  if (!result) {
    const symbols = regexSymbols(file, source);
    result = { symbols, references: [], callEdges: [], imports: [], indexer: symbols.length ? "regex" : "none" };
  }
  if (cacheKey) {
    analysisCache.set(cacheKey, result);
    if (analysisCache.size > ANALYSIS_CACHE_LIMIT) analysisCache.delete(analysisCache.keys().next().value);
  }
  return result;
}

async function extractSymbols(rootPath, file) {
  return (await analyzeFile(rootPath, file)).symbols;
}

export async function inspectRepository(input, repositoriesDirectory, options = {}) {
  const limits = resolveLimits(options.limits);
  const signal = options.signal ?? null;
  const report = progressReporter(options.onProgress);
  const truncated = [];

  report("prepare", 0, 1, "Locating the repository");
  throwIfCancelled(signal, "prepare");
  const location = await ensureLocalRepository(input, repositoriesDirectory, { signal });

  report("discover", 0, 1, "Listing tracked and untracked files");
  throwIfCancelled(signal, "discover");
  const discovery = await listRepositoryFiles(location.rootPath, limits, signal);
  const rawFiles = discovery.files;
  if (discovery.discovered > rawFiles.length) {
    truncated.push({ limit: "maxFiles", value: limits.maxFiles, discovered: discovery.discovered });
  }
  report("discover", rawFiles.length, rawFiles.length, `Found ${rawFiles.length} files`);

  const blobIds = await gitBlobIds(location.rootPath);
  const fileRecords = [];
  let totalBytes = 0;
  let skippedTooLarge = 0;
  let stoppedForTotalBytes = false;
  // Streaming file intake: records are appended in batches so progress is
  // observable and cancellation lands within one batch instead of at the end.
  for (let start = 0; start < rawFiles.length; start += limits.analysisBatchSize) {
    throwIfCancelled(signal, "read");
    const batch = rawFiles.slice(start, start + limits.analysisBatchSize);
    const records = await Promise.all(batch.map(async (relativePath) => {
      try {
        const absolute = path.join(location.rootPath, relativePath);
        const details = await lstat(absolute);
        if (!details.isFile()) return null;
        if (details.size > limits.maxFileBytes) { skippedTooLarge += 1; return null; }
        const normalizedRelativePath = relativePath.split(path.sep).join("/");
        return {
          path: normalizedRelativePath,
          name: path.basename(relativePath),
          directory: path.dirname(relativePath) === "." ? "" : path.dirname(relativePath),
          language: languageFor(relativePath),
          size: details.size,
          blobId: blobIds.get(normalizedRelativePath)
            ?? createHash("sha256").update(await readFile(absolute)).digest("hex"),
        };
      } catch {
        return null;
      }
    }));
    for (const record of records) {
      if (!record) continue;
      if (totalBytes + record.size > limits.maxTotalBytes) { stoppedForTotalBytes = true; break; }
      totalBytes += record.size;
      fileRecords.push(record);
    }
    report("read", Math.min(start + batch.length, rawFiles.length), rawFiles.length, "Reading file metadata");
    if (stoppedForTotalBytes) break;
  }
  if (skippedTooLarge) truncated.push({ limit: "maxFileBytes", value: limits.maxFileBytes, skipped: skippedTooLarge });
  if (stoppedForTotalBytes) truncated.push({ limit: "maxTotalBytes", value: limits.maxTotalBytes, indexedBytes: totalBytes });

  report("git", 0, 1, "Reading git version information");
  throwIfCancelled(signal, "git");
  const head = await gitValue(location.rootPath, ["rev-parse", "HEAD"], "unversioned");
  const branch = await gitValue(location.rootPath, ["branch", "--show-current"], "local");
  const statusText = await gitOutput(location.rootPath, ["status", "--porcelain"], "");
  const diffSummary = await gitValue(location.rootPath, ["diff", "--numstat"], "");
  const changedPaths = changedPathsFromStatus(statusText);
  // Refresh content hashes for working-tree changes before analysis so the
  // per-blob analysis cache never serves a stale parse for a modified file.
  await Promise.all(
    fileRecords
      .filter((file) => changedPaths.has(file.path))
      .map(async (file) => {
        try {
          file.blobId = createHash("sha256")
            .update(await readFile(path.join(location.rootPath, file.path)))
            .digest("hex");
        } catch {
          file.blobId = `missing-${file.size}`;
        }
      }),
  );
  report("git", 1, 1, "Repository version resolved");

  const packageRoots = new Set(
    fileRecords
      .filter((file) => file.name === "__init__.py" && file.path.split("/").length === 2)
      .map((file) => file.path.split("/")[0])
      .filter((directory) => !["tests", "test"].includes(directory)),
  );
  for (const file of fileRecords) {
    file.importance = fileImportance(file.path, file.language);
    if (packageRoots.has(file.path.split("/")[0])) file.importance += 100;
  }
  const parseableFiles = fileRecords
    .filter((file) => symbolPatterns(file.language).length || treeSitterSupports(file.language, file.path))
    .sort((left, right) => right.importance - left.importance || left.path.localeCompare(right.path));
  const sourceFiles = parseableFiles.slice(0, limits.maxAnalyzedFiles);
  if (parseableFiles.length > sourceFiles.length) {
    truncated.push({ limit: "maxAnalyzedFiles", value: limits.maxAnalyzedFiles, skipped: parseableFiles.length - sourceFiles.length });
  }

  // Streaming analysis: bounded-concurrency batches with progress between batches.
  const analyses = [];
  for (let start = 0; start < sourceFiles.length; start += limits.analysisBatchSize) {
    throwIfCancelled(signal, "analyze");
    const batch = sourceFiles.slice(start, start + limits.analysisBatchSize);
    analyses.push(...await Promise.all(batch.map((file) => analyzeFile(location.rootPath, file))));
    report("analyze", analyses.length, sourceFiles.length, "Extracting definitions and call edges");
  }

  report("link", 0, 1, "Resolving references and imports");
  throwIfCancelled(signal, "link");
  const symbolGroups = analyses.map((analysis) => analysis.symbols);
  const symbols = [];
  for (let symbolIndex = 0; symbolIndex < 80 && symbols.length < limits.maxSymbols; symbolIndex += 1) {
    for (const group of symbolGroups) {
      if (group[symbolIndex]) symbols.push(group[symbolIndex]);
      if (symbols.length >= limits.maxSymbols) break;
    }
  }
  const totalSymbols = symbolGroups.reduce((sum, group) => sum + group.length, 0);
  if (totalSymbols > symbols.length) truncated.push({ limit: "maxSymbols", value: limits.maxSymbols, skipped: totalSymbols - symbols.length });

  const allReferences = analyses.flatMap((analysis) => analysis.references);
  const references = allReferences.slice(0, limits.maxReferences);
  if (allReferences.length > references.length) truncated.push({ limit: "maxReferences", value: limits.maxReferences, skipped: allReferences.length - references.length });

  const definitionIndex = new Map();
  for (const symbol of symbols) {
    if (!definitionIndex.has(symbol.name)) definitionIndex.set(symbol.name, []);
    definitionIndex.get(symbol.name).push(symbol);
  }
  const allCallEdges = analyses.flatMap((analysis) => analysis.callEdges);
  if (allCallEdges.length > limits.maxCallEdges) truncated.push({ limit: "maxCallEdges", value: limits.maxCallEdges, skipped: allCallEdges.length - limits.maxCallEdges });
  const languageByPath = new Map(fileRecords.map((file) => [file.path, file.language]));
  const callEdges = allCallEdges
    .slice(0, limits.maxCallEdges)
    .map((edge) => {
      const targets = definitionIndex.get(edge.callee) ?? [];
      // A call can only land in the same file or in a file of the same language
      // family. Without this, a Python `int(...)` call resolves to a C++ `int`
      // declaration in a header and invents a call chain that cannot exist.
      const family = languageFamily(languageByPath.get(edge.path));
      const target = targets.find((candidate) => candidate.path === edge.path)
        ?? targets.find((candidate) => languageFamily(languageByPath.get(candidate.path)) === family)
        ?? null;
      return { ...edge, targetPath: target?.path ?? null, targetLine: target?.line ?? null, resolved: Boolean(target) };
    });
  const indexerCounts = analyses.reduce((counts, analysis) => {
    counts[analysis.indexer] = (counts[analysis.indexer] ?? 0) + 1;
    return counts;
  }, {});
  const indexer = indexerCounts["tree-sitter"] ? "tree-sitter" : indexerCounts.regex ? "regex" : "none";
  const allImports = analyses.flatMap((analysis) => analysis.imports ?? []);
  if (allImports.length > limits.maxImports) truncated.push({ limit: "maxImports", value: limits.maxImports, skipped: allImports.length - limits.maxImports });
  const imports = resolveImportsStatically({ files: fileRecords }, allImports.slice(0, limits.maxImports));
  const languages = {};
  for (const file of fileRecords) languages[file.language] = (languages[file.language] ?? 0) + 1;
  report("link", 1, 1, "Index linked");

  const changedFingerprint = [...changedPaths]
    .sort()
    .map((changedPath) => `${changedPath}:${fileRecords.find((file) => file.path === changedPath)?.blobId ?? "deleted"}`)
    .join("\n");
  const versionId = createHash("sha256")
    .update(`${head}\n${statusText}\n${diffSummary}\n${changedFingerprint}`)
    .digest("hex")
    .slice(0, 20);
  report("finalize", 1, 1, "Index ready");
  const entryFiles = fileRecords
    .filter((file) => ENTRY_BASENAMES.has(file.name.toLowerCase()) || (file.name === "__init__.py" && file.path.split("/").length === 2 && !["tests", "test"].includes(file.path.split("/")[0])))
    .sort((left, right) => {
      const entryScore = (file) => file.importance + (file.name === "__main__.py" ? 90 : 0) + (file.name === "__init__.py" ? 40 : 0);
      return entryScore(right) - entryScore(left) || left.path.localeCompare(right.path);
    })
    .map((file) => file.path)
    .slice(0, 20);

  return {
    ...location,
    id: createHash("sha256").update(location.rootPath).digest("hex").slice(0, 16),
    name: path.basename(location.rootPath),
    head,
    versionId,
    branch,
    isDirty: Boolean(statusText),
    files: fileRecords,
    symbols,
    references,
    callEdges,
    imports,
    entryFiles,
    stats: {
      fileCount: fileRecords.length,
      symbolCount: symbols.length,
      referenceCount: references.length,
      callEdgeCount: callEdges.length,
      resolvedCallEdgeCount: callEdges.filter((edge) => edge.resolved).length,
      importCount: imports.length,
      resolvedImportCount: imports.filter((item) => item.resolved).length,
      indexer,
      indexerCounts,
      languages,
      totalBytes,
      limits,
      truncated,
      complete: truncated.length === 0,
      submodules: location.submodules ?? { declared: 0, urls: [], checkedOut: false, note: "This repository declares no submodules." },
    },
    indexedAt: new Date().toISOString(),
  };
}

export async function readRepositoryFile(rootPath, relativePath) {
  const root = await realpath(rootPath);
  const requested = path.resolve(root, relativePath);
  const relationship = path.relative(root, requested);
  if (relationship.startsWith("..") || path.isAbsolute(relationship)) {
    throw new Error("File path is outside the repository.");
  }
  const resolved = await realpath(requested);
  const resolvedRelationship = path.relative(root, resolved);
  if (resolvedRelationship.startsWith("..") || path.isAbsolute(resolvedRelationship)) {
    throw new Error("Symlink target is outside the repository.");
  }
  const details = await stat(resolved);
  if (details.size > 2_000_000) throw new Error("This file is too large to preview.");
  return readFile(resolved, "utf8");
}

export { languageFor };
