import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const SKIP_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".superpowers",
  ".trace",
  ".worktrees",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
]);

const BINARY_EXTENSIONS = new Set([
  ".gif",
  ".icns",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".webp",
  ".zip",
]);

const personalInitials = ["B", "J"].join("");
const oldPersonalNames = [
  ["Dongjun", "Xie"].join(" "),
  ["Joyce", "Xie"].join(" "),
  [["j", "in"].join(""), "zheng", "hui"].join(""),
].join("|");
const broadIdentityTerms = [
  ["b", ["j", "in"].join("")].join(""),
  ["nvi", "dia"].join(""),
  ["zheng", "hui"].join(""),
];
const segmentedIdentityTerm = ["j", "in"].join("");

const CONTENT_RULES = [
  [
    "absolute-home-path",
    new RegExp("(?:\\/Users\\/|\\/home\\/|[A-Z]:\\\\\\\\Users\\\\)", "g"),
  ],
  ["personal-initials", new RegExp(`\\b${personalInitials}\\b`, "g")],
  ["old-personal-name", new RegExp(`\\b(?:${oldPersonalNames})\\b`, "gi")],
  [
    "sensitive-identity-content",
    new RegExp(broadIdentityTerms.join("|"), "gi"),
  ],
  [
    "sensitive-identity-content",
    new RegExp(`(?<![A-Za-z0-9])${segmentedIdentityTerm}(?![A-Za-z0-9])`, "gi"),
  ],
  [
    "github-token",
    /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  ],
  [
    "jwt",
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  ],
  [
    "private-key",
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  ],
  [
    "secret-assignment",
    /\b(?:api[_-]?key|client[_-]?secret|password)\b\s*[:=]\s*["'][A-Za-z0-9_+\/=.-]{20,}["']/gi,
  ],
];

const CREDENTIAL_FILES =
  /(?:^|\/)(?:\.env(?:\..+)?|id_rsa|id_ed25519|credentials\.json|[^/]+\.(?:pem|p12|key))$/i;
const ALLOWED_CREDENTIAL_FILES = new Set([".env.example"]);

function normalized(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function sensitiveIdentityInPath(relativePath) {
  const lowerPath = normalized(relativePath).toLowerCase();
  if (broadIdentityTerms.some((term) => lowerPath.includes(term))) return true;
  return lowerPath
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .includes(segmentedIdentityTerm);
}

async function listFiles(rootPath, directory = rootPath, output = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) await listFiles(rootPath, absolutePath, output);
    else output.push(normalized(path.relative(rootPath, absolutePath)));
  }
  return output;
}

async function scanFile(rootPath, relativePath) {
  const violations = [];
  const safeRelativePath = normalized(relativePath);
  const baseName = path.basename(safeRelativePath);

  if (sensitiveIdentityInPath(safeRelativePath)) {
    violations.push({ path: safeRelativePath, rule: "sensitive-identity-path" });
  }

  if (
    CREDENTIAL_FILES.test(safeRelativePath) &&
    !ALLOWED_CREDENTIAL_FILES.has(baseName)
  ) {
    violations.push({ path: safeRelativePath, rule: "credential-file" });
  }

  const absolutePath = path.resolve(rootPath, safeRelativePath);
  const relationship = path.relative(path.resolve(rootPath), absolutePath);
  if (relationship.startsWith("..") || path.isAbsolute(relationship)) {
    return [...violations, { path: safeRelativePath, rule: "outside-root" }];
  }

  let details;
  try {
    details = await lstat(absolutePath);
  } catch {
    return violations;
  }
  if (details.isSymbolicLink()) {
    return [...violations, { path: safeRelativePath, rule: "symlink" }];
  }
  if (!details.isFile() || BINARY_EXTENSIONS.has(path.extname(baseName).toLowerCase())) {
    return violations;
  }

  const bytes = await readFile(absolutePath);
  if (bytes.includes(0)) return violations;
  const text = bytes.toString("utf8");
  for (const [rule, expression] of CONTENT_RULES) {
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) {
      violations.push({
        path: safeRelativePath,
        rule,
        line: lineNumber(text, match.index ?? 0),
      });
    }
  }
  return violations;
}

export async function scanPublicPaths(rootPath, relativePaths) {
  const groups = await Promise.all(
    [...new Set(relativePaths.map(normalized))].map((relativePath) =>
      scanFile(rootPath, relativePath),
    ),
  );
  return groups
    .flat()
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.rule.localeCompare(right.rule) ||
        (left.line ?? 0) - (right.line ?? 0),
    );
}

export async function scanPublicTree(rootPath) {
  const resolvedRoot = path.resolve(rootPath);
  return scanPublicPaths(resolvedRoot, await listFiles(resolvedRoot));
}

async function stagedPaths(rootPath) {
  const { stdout } = await execFile(
    "git",
    ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"],
    { cwd: rootPath, encoding: "buffer" },
  );
  return stdout.toString("utf8").split("\0").filter(Boolean);
}

async function main() {
  const rootPath = process.cwd();
  const violations = process.argv.includes("--staged")
    ? await scanPublicPaths(rootPath, await stagedPaths(rootPath))
    : await scanPublicTree(rootPath);

  if (violations.length) {
    for (const violation of violations) {
      const location = violation.line
        ? `${violation.path}:${violation.line}`
        : violation.path;
      process.stderr.write(`${location} [${violation.rule}]\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Public-safety scan passed.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
