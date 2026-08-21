import { randomUUID } from "node:crypto";
import { access, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const sessions = new Map();

function run(command, args, options = {}) {
  const { cwd, timeoutMs = 120_000, allowFailure = false } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      };
      if (code === 0 || allowFailure) resolve(result);
      else reject(new Error(result.stderr || result.stdout || `${command} exited with ${code}`));
    });
  });
}

function safeName(value) {
  return String(value || "repository").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 42) || "repository";
}

export async function createPracticeSession(repository, lesson, practiceDirectory) {
  const rootPath = await realpath(repository.rootPath);
  const gitRoot = await run("git", ["-C", rootPath, "rev-parse", "--show-toplevel"]);
  if (await realpath(gitRoot.stdout) !== rootPath) throw new Error("Practice sessions must start from the repository root.");
  const head = (await run("git", ["-C", rootPath, "rev-parse", "HEAD"])).stdout;
  await mkdir(practiceDirectory, { recursive: true });
  const id = randomUUID();
  const worktreePath = path.join(practiceDirectory, `${safeName(repository.name)}-${id.slice(0, 8)}`);
  await run("git", ["-C", rootPath, "worktree", "add", "--detach", "--", worktreePath, head], { timeoutMs: 180_000 });
  const session = {
    id,
    repositoryId: repository.id,
    repositoryRoot: rootPath,
    repositoryName: repository.name,
    worktreePath,
    baseCommit: head,
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    createdAt: new Date().toISOString(),
  };
  sessions.set(id, session);
  return session;
}

function getSession(id) {
  const session = sessions.get(id);
  if (!session) throw new Error("Practice session is not active in this app session.");
  return session;
}

export function getPracticeSessionPath(id) {
  return getSession(id).worktreePath;
}

export async function inspectPracticeSession(id) {
  const session = getSession(id);
  await access(session.worktreePath);
  const [status, diffStat, diffCheck] = await Promise.all([
    run("git", ["-C", session.worktreePath, "status", "--short"]),
    run("git", ["-C", session.worktreePath, "diff", "--stat", "HEAD"]),
    run("git", ["-C", session.worktreePath, "diff", "--check", "HEAD"], { allowFailure: true }),
  ]);
  return {
    sessionId: id,
    clean: !status.stdout,
    status: status.stdout,
    diffStat: diffStat.stdout,
    diffCheckPassed: diffCheck.code === 0,
    diffCheckOutput: diffCheck.stdout || diffCheck.stderr,
    checkedAt: new Date().toISOString(),
  };
}

export async function removePracticeSession(id, discardChanges = false) {
  const session = getSession(id);
  const report = await inspectPracticeSession(id);
  if (!report.clean && !discardChanges) return { removed: false, requiresConfirmation: true, report };
  await run("git", ["-C", session.repositoryRoot, "worktree", "remove", ...(discardChanges ? ["--force"] : []), "--", session.worktreePath], { timeoutMs: 120_000 });
  await run("git", ["-C", session.repositoryRoot, "worktree", "prune"]);
  sessions.delete(id);
  return { removed: true, requiresConfirmation: false };
}
