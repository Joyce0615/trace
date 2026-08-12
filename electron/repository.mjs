import { createHash } from "node:crypto";
import { access, lstat, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

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

function run(command, args, options = {}) {
  const { cwd, timeoutMs = 30_000 } = options;
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

function isRemoteRepository(value) {
  return /^(https?:\/\/|ssh:\/\/|git@)/i.test(value.trim());
}

function repositoryName(value) {
  const cleaned = value.replace(/[?#].*$/, "").replace(/\/$/, "");
  return path.basename(cleaned).replace(/\.git$/i, "") || "repository";
}

async function ensureLocalRepository(input, repositoriesDirectory) {
  const value = input.trim();
  if (!value) throw new Error("Choose a repository first.");

  if (!isRemoteRepository(value)) {
    const resolved = await realpath(path.resolve(value));
    const details = await stat(resolved);
    if (!details.isDirectory()) throw new Error("The selected path is not a directory.");
    return { rootPath: resolved, source: "local", remoteUrl: null };
  }

  await mkdir(repositoriesDirectory, { recursive: true });
  const fingerprint = createHash("sha256").update(value).digest("hex").slice(0, 9);
  const destination = path.join(repositoriesDirectory, `${repositoryName(value)}-${fingerprint}`);

  try {
    await access(path.join(destination, ".git"));
  } catch {
    await run("git", ["clone", "--depth=1", "--", value, destination], { timeoutMs: 120_000 });
  }

  return { rootPath: await realpath(destination), source: "remote", remoteUrl: value };
}

async function gitValue(rootPath, args, fallback = "") {
  try {
    return (await run("git", ["-C", rootPath, ...args])).stdout.trim();
  } catch {
    return fallback;
  }
}

async function walkDirectory(rootPath, currentPath = rootPath, output = []) {
  if (output.length >= 4_000) return output;
  const entries = await readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    if (output.length >= 4_000) break;
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(currentPath, entry.name);
    if (entry.isDirectory()) await walkDirectory(rootPath, absolute, output);
    else if (entry.isFile()) output.push(path.relative(rootPath, absolute));
  }
  return output;
}

async function listRepositoryFiles(rootPath) {
  try {
    const { stdout } = await run(
      "git",
      ["-C", rootPath, "ls-files", "-co", "--exclude-standard", "-z"],
      { timeoutMs: 45_000 },
    );
    const files = stdout.split("\0").filter(Boolean);
    if (files.length) return files.slice(0, 4_000);
  } catch {
    // A plain folder is still a valid learning source.
  }
  return walkDirectory(rootPath);
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

async function extractSymbols(rootPath, file) {
  if (file.size > 600_000) return [];
  const patterns = symbolPatterns(file.language);
  if (!patterns.length) return [];
  try {
    const source = await readFile(path.join(rootPath, file.path), "utf8");
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
  } catch {
    return [];
  }
}

export async function inspectRepository(input, repositoriesDirectory) {
  const location = await ensureLocalRepository(input, repositoriesDirectory);
  const rawFiles = await listRepositoryFiles(location.rootPath);
  const blobIds = await gitBlobIds(location.rootPath);
  const fileRecords = (
    await Promise.all(
      rawFiles.map(async (relativePath) => {
        try {
          const absolute = path.join(location.rootPath, relativePath);
          const details = await lstat(absolute);
          if (!details.isFile() || details.size > 2_000_000) return null;
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
      }),
    )
  ).filter(Boolean);

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
  const sourceFiles = fileRecords
    .filter((file) => symbolPatterns(file.language).length)
    .sort((left, right) => right.importance - left.importance || left.path.localeCompare(right.path));
  const symbolGroups = await Promise.all(sourceFiles.slice(0, 1_200).map((file) => extractSymbols(location.rootPath, file)));
  const symbols = [];
  for (let symbolIndex = 0; symbolIndex < 80 && symbols.length < 2_500; symbolIndex += 1) {
    for (const group of symbolGroups) {
      if (group[symbolIndex]) symbols.push(group[symbolIndex]);
      if (symbols.length >= 2_500) break;
    }
  }
  const languages = {};
  for (const file of fileRecords) languages[file.language] = (languages[file.language] ?? 0) + 1;

  const head = await gitValue(location.rootPath, ["rev-parse", "HEAD"], "unversioned");
  const branch = await gitValue(location.rootPath, ["branch", "--show-current"], "local");
  const statusText = await gitValue(location.rootPath, ["status", "--porcelain"], "");
  const diffSummary = await gitValue(location.rootPath, ["diff", "--numstat"], "");
  const changedPaths = new Set(
    statusText
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).replace(/^.* -> /, "")),
  );
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
  const changedFingerprint = [...changedPaths]
    .sort()
    .map((changedPath) => `${changedPath}:${fileRecords.find((file) => file.path === changedPath)?.blobId ?? "deleted"}`)
    .join("\n");
  const versionId = createHash("sha256")
    .update(`${head}\n${statusText}\n${diffSummary}\n${changedFingerprint}`)
    .digest("hex")
    .slice(0, 20);
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
    entryFiles,
    stats: {
      fileCount: fileRecords.length,
      symbolCount: symbols.length,
      languages,
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
