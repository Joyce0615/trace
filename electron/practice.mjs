import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { readDurable, writeDurable } from "./durable-store.mjs";

/**
 * Practice sessions used to live only in this Map, which meant a crash lost the
 * *record* of a session while leaving its worktree on disk: the app could no
 * longer see it, could no longer clean it up, and the learner's unfinished work
 * sat in a directory nothing would ever mention again. Sessions are now written
 * durably as they are created and removed, and `reconcilePracticeSessions`
 * compares the record against the disk on launch (item 51).
 */
const sessions = new Map();
let sessionFile = null;

function sessionsPath(practiceDirectory) {
  return path.join(practiceDirectory, "sessions.json");
}

async function persistSessions() {
  if (!sessionFile) return;
  await writeDurable(sessionFile, { sessions: [...sessions.values()] });
}

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
  sessionFile = sessionsPath(practiceDirectory);
  await persistSessions();
  return session;
}

/**
 * Reconcile the recorded sessions against what is actually on disk.
 *
 * Three outcomes and each needs a different answer: a session whose worktree is
 * still there is *restored* so the learner can carry on; a session whose
 * worktree is gone is *stale* and dropped from the record; and a worktree with
 * no session is *orphaned* — almost certainly a crash between creating the
 * worktree and writing the record — and is reported rather than deleted,
 * because it may hold work nobody else knows about.
 */
export async function reconcilePracticeSessions(practiceDirectory) {
  sessionFile = sessionsPath(practiceDirectory);
  const read = await readDurable(sessionFile, { fallback: { sessions: [] } });
  const recorded = Array.isArray(read.value?.sessions) ? read.value.sessions : [];

  const restored = [];
  const stale = [];
  for (const session of recorded) {
    try {
      await access(session.worktreePath);
      sessions.set(session.id, session);
      restored.push(session);
    } catch {
      // The record outlived its worktree. Dropping it from memory as well as
      // from the file matters: the first attempt wrote the map back out and
      // carried the dead session into every subsequent launch.
      sessions.delete(session.id);
      stale.push(session);
    }
  }

  let entries = [];
  try {
    entries = await readdir(practiceDirectory, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const known = new Set(restored.map((session) => path.resolve(session.worktreePath)));
  const orphaned = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(practiceDirectory, entry.name))
    .filter((candidate) => !known.has(path.resolve(candidate)));

  if (stale.length) await persistSessions();
  return {
    restored: restored.map((session) => ({ id: session.id, worktreePath: session.worktreePath, lessonId: session.lessonId, createdAt: session.createdAt })),
    stale: stale.map((session) => ({ id: session.id, worktreePath: session.worktreePath })),
    orphaned,
    source: read.source,
    recovered: read.recovered,
    problems: read.problems,
  };
}

/** Forget an orphaned worktree's git bookkeeping without touching its contents. */
export async function releaseOrphanedWorktree(repositoryRoot, worktreePath) {
  await run("git", ["-C", repositoryRoot, "worktree", "prune"], { allowFailure: true });
  return { released: worktreePath };
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
  await persistSessions();
  return { removed: true, requiresConfirmation: false };
}
