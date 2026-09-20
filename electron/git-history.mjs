import { spawn } from "node:child_process";
import { redactValue } from "./secret-scanner.mjs";

/**
 * Repository history as teaching material.
 *
 * A file's git history answers questions the current snapshot cannot: who owns
 * this code, how it grew, where regressions cluster, and why a decision was
 * taken. This module reads real `git log` output (never a summary written by a
 * model) and turns it into four grounded views:
 *
 *   - ownership: authorship share per file and module, with a bus factor;
 *   - evolution: churn over time and the files that keep changing;
 *   - regressions: fix and revert density per file;
 *   - decisions: commits that explain themselves in prose.
 *
 * Everything is bounded (commit limit, timeout, output cap) and redacted, since
 * commit messages routinely contain email addresses.
 */

export const GIT_HISTORY_VERSION = 1;

const UNIT = "\u001f";
const RECORD = "\u001e";

export const DEFAULT_HISTORY_LIMITS = { commits: 400, timeoutMs: 30_000, maxOutputBytes: 12_000_000 };

const FIX_PATTERN = /\b(fix|fixes|fixed|bug|bugfix|hotfix|patch|regression|crash|broken|workaround)\b/i;
const REVERT_PATTERN = /^revert\b|\breverts?\s+commit\b/i;
const DECISION_PATTERN = /\b(design|architecture|rfc|adr|decision|rationale|refactor|redesign|migrate|deprecate|introduce)\b/i;

function runGit(rootPath, args, limits) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("git", ["-C", rootPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ ok: false, stdout: "", stderr: "git is unavailable" });
      return;
    }
    const chunks = [];
    let bytes = 0;
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, limits.timeoutMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= limits.maxOutputBytes) chunks.push(chunk);
      else if (!killed) { killed = true; child.kill("SIGKILL"); }
    });
    const errors = [];
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", () => { clearTimeout(timer); resolve({ ok: false, stdout: "", stderr: "git is unavailable" }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !killed, stdout: Buffer.concat(chunks).toString("utf8"), stderr: Buffer.concat(errors).toString("utf8") });
    });
  });
}

/**
 * Parse two `git log` reads into commits with per-file line counts.
 *
 * Metadata and numstat are read separately on purpose: a commit body is
 * multi-line, so interleaving it with numstat output in one format string makes
 * the record boundary ambiguous and silently drops commits.
 */
export function parseHistory(metaText, statText = "") {
  const stats = new Map();
  for (const record of statText.split(RECORD)) {
    const lines = record.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) continue;
    const hash = lines[0].trim();
    const files = [];
    for (const line of lines.slice(1)) {
      const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!match) continue;
      // Renames arrive as `old => new` or `dir/{old => new}`; keep the new path.
      const raw = match[3].includes(" => ") ? match[3].replace(/^.*\{?.* => (.*?)\}?$/, "$1") : match[3];
      files.push({
        path: raw.trim(),
        added: match[1] === "-" ? 0 : Number(match[1]),
        removed: match[2] === "-" ? 0 : Number(match[2]),
        binary: match[1] === "-",
      });
    }
    stats.set(hash, files);
  }

  const commits = [];
  for (const record of metaText.split(RECORD)) {
    if (!record.trim()) continue;
    const [rawHash, author, email, date, subject, ...bodyParts] = record.split(UNIT);
    const hash = (rawHash ?? "").trim();
    if (!hash || !author) continue;
    const files = stats.get(hash) ?? [];
    commits.push({
      hash,
      author,
      email,
      date,
      subject: subject ?? "",
      body: bodyParts.join(UNIT).trim(),
      files,
      lines: files.reduce((sum, file) => sum + file.added + file.removed, 0),
      isFix: FIX_PATTERN.test(subject ?? ""),
      isRevert: REVERT_PATTERN.test(subject ?? ""),
    });
  }
  return commits;
}

function share(part, whole) {
  return whole > 0 ? Number((part / whole).toFixed(4)) : 0;
}

/**
 * Bus factor: how many authors it takes to cover half of the changed lines.
 * One author owning everything is the classic single point of failure.
 */
export function busFactor(authors) {
  const total = authors.reduce((sum, author) => sum + author.lines, 0);
  if (!total) return 0;
  let covered = 0;
  let count = 0;
  for (const author of [...authors].sort((left, right) => right.lines - left.lines)) {
    covered += author.lines;
    count += 1;
    if (covered / total > 0.5) break;
  }
  return count;
}

function ownershipFor(commits, keyOf) {
  const groups = new Map();
  for (const commit of commits) {
    for (const file of commit.files) {
      const key = keyOf(file.path);
      if (!key) continue;
      const entry = groups.get(key) ?? { key, commits: new Set(), lines: 0, authors: new Map(), lastChange: commit.date, fixes: 0 };
      entry.commits.add(commit.hash);
      entry.lines += file.added + file.removed;
      if (commit.isFix) entry.fixes += 1;
      const author = entry.authors.get(commit.author) ?? { name: commit.author, commits: 0, lines: 0 };
      author.commits += 1;
      author.lines += file.added + file.removed;
      entry.authors.set(commit.author, author);
      if (commit.date > entry.lastChange) entry.lastChange = commit.date;
      groups.set(key, entry);
    }
  }
  return [...groups.values()].map((entry) => {
    const authors = [...entry.authors.values()].sort((left, right) => right.lines - left.lines);
    return {
      key: entry.key,
      commits: entry.commits.size,
      lines: entry.lines,
      fixes: entry.fixes,
      lastChange: entry.lastChange,
      authors: authors.slice(0, 5).map((author) => ({ ...author, share: share(author.lines, entry.lines) })),
      authorCount: authors.length,
      busFactor: busFactor(authors),
      topAuthorShare: share(authors[0]?.lines ?? 0, entry.lines),
    };
  }).sort((left, right) => right.lines - left.lines || left.key.localeCompare(right.key));
}

/**
 * Read raw commits. Shared by the history summary and the evidence importer so
 * both see the same parsed history.
 */
export async function readCommits(rootPath, options = {}) {
  const limits = { ...DEFAULT_HISTORY_LIMITS, ...(options.limits ?? {}) };
  const mergeArgs = options.includeMerges ? [] : ["--no-merges"];
  const format = RECORD + ["%H", "%an", "%ae", "%aI", "%s", "%b"].join(UNIT);
  const meta = await runGit(rootPath, ["log", ...mergeArgs, `-n${limits.commits}`, `--pretty=format:${format}`], limits);
  if (!meta.ok || !meta.stdout.trim()) {
    return { ok: false, commits: [], reason: meta.stderr.trim() || "This repository has no readable git history." };
  }
  const stats = await runGit(rootPath, ["log", ...mergeArgs, `-n${limits.commits}`, `--pretty=format:${RECORD}%H`, "--numstat"], limits);
  return { ok: true, commits: parseHistory(meta.stdout, stats.ok ? stats.stdout : ""), limits };
}

/**
 * Read one file as it was at a revision, without touching the working tree.
 *
 * Course migration needs the *previous* version of a file to compare bodies
 * against. Checking the old commit out would be a consequential edit to the
 * learner's repository — and would fail outright on a dirty tree — so the blob
 * is read straight out of the object database instead.
 */
export async function readFileAtCommit(rootPath, commit, filePath, options = {}) {
  const limits = { ...DEFAULT_HISTORY_LIMITS, ...(options.limits ?? {}) };
  if (!/^[0-9a-zA-Z_./^~-]{1,120}$/.test(String(commit ?? "")) || !filePath) return { ok: false, content: null, reason: "unreadable-revision" };
  const read = await runGit(rootPath, ["show", `${commit}:${filePath}`], { ...limits, maxOutputBytes: options.maxBytes ?? 600_000 });
  if (!read.ok) return { ok: false, content: null, reason: read.stderr.trim() || "not-in-revision" };
  return { ok: true, content: read.stdout, reason: null };
}

/** Paths tracked at a revision, so "the file is gone" stays distinguishable from "the file has no definitions". */
export async function listFilesAtCommit(rootPath, commit, options = {}) {
  const limits = { ...DEFAULT_HISTORY_LIMITS, ...(options.limits ?? {}) };
  if (!/^[0-9a-zA-Z_./^~-]{1,120}$/.test(String(commit ?? ""))) return { ok: false, files: [] };
  const read = await runGit(rootPath, ["ls-tree", "-r", "--name-only", commit], limits);
  if (!read.ok) return { ok: false, files: [] };
  return { ok: true, files: read.stdout.split("\n").map((line) => line.trim()).filter(Boolean) };
}

/**
 * Git's own rename detection between two revisions.
 *
 * Body similarity finds a definition that moved between files even when git
 * reports no rename, but where git *does* report one it is stronger evidence
 * than a heuristic — and it is also what tells a migration which new files are
 * worth reading at all.
 */
export async function detectRenames(rootPath, fromCommit, toCommit = "HEAD", options = {}) {
  const limits = { ...DEFAULT_HISTORY_LIMITS, ...(options.limits ?? {}) };
  if (!/^[0-9a-zA-Z_./^~-]{1,120}$/.test(String(fromCommit ?? ""))) return { ok: false, renames: [] };
  const read = await runGit(rootPath, ["diff", "--find-renames", "--name-status", "-M", `${fromCommit}..${toCommit}`], limits);
  if (!read.ok) return { ok: false, renames: [] };
  const renames = [];
  for (const line of read.stdout.split("\n")) {
    const parts = line.split("\t");
    if (!/^R\d*$/.test(parts[0] ?? "") || parts.length < 3) continue;
    renames.push({ from: parts[1], to: parts[2], similarity: Number(parts[0].slice(1)) / 100 || null });
  }
  return { ok: true, renames };
}

/** Read and summarize repository history. Returns `available:false` outside git. */
export async function historySummary(rootPath, options = {}) {
  const limits = { ...DEFAULT_HISTORY_LIMITS, ...(options.limits ?? {}) };
  const read = await readCommits(rootPath, { limits });
  if (!read.ok) {
    return { version: GIT_HISTORY_VERSION, available: false, reason: read.reason, commitCount: 0 };
  }
  const commits = read.commits;
  if (!commits.length) {
    return { version: GIT_HISTORY_VERSION, available: false, reason: "No commits were parsed from git log.", commitCount: 0 };
  }

  const moduleDepth = options.moduleDepth ?? 2;
  const files = ownershipFor(commits, (filePath) => filePath);
  const modules = ownershipFor(commits, (filePath) => {
    const parts = filePath.split("/");
    return parts.length === 1 ? "<root>" : parts.slice(0, Math.min(moduleDepth, parts.length - 1)).join("/");
  });

  const buckets = new Map();
  for (const commit of commits) {
    const month = commit.date.slice(0, 7);
    const entry = buckets.get(month) ?? { month, commits: 0, lines: 0, authors: new Set() };
    entry.commits += 1;
    entry.lines += commit.lines;
    entry.authors.add(commit.author);
    buckets.set(month, entry);
  }

  const fixCommits = commits.filter((commit) => commit.isFix);
  const revertCommits = commits.filter((commit) => commit.isRevert);
  const fixesByFile = new Map();
  for (const commit of fixCommits) {
    for (const file of commit.files) {
      const entry = fixesByFile.get(file.path) ?? { path: file.path, fixes: 0, lastFix: commit.date, examples: [] };
      entry.fixes += 1;
      if (commit.date > entry.lastFix) entry.lastFix = commit.date;
      if (entry.examples.length < 3) entry.examples.push({ hash: commit.hash.slice(0, 8), subject: commit.subject.slice(0, 120), date: commit.date });
      fixesByFile.set(file.path, entry);
    }
  }

  const decisions = commits
    .filter((commit) => (commit.body && commit.body.length >= 120) || DECISION_PATTERN.test(commit.subject))
    .slice(0, 12)
    .map((commit) => ({
      hash: commit.hash.slice(0, 8),
      subject: commit.subject.slice(0, 160),
      excerpt: commit.body.split(/\r?\n/).filter(Boolean).slice(0, 4).join(" ").slice(0, 400),
      date: commit.date,
      author: commit.author,
      files: commit.files.slice(0, 5).map((file) => file.path),
      reason: DECISION_PATTERN.test(commit.subject) ? "subject-keyword" : "explained-in-body",
    }));

  const authorTotals = new Map();
  for (const commit of commits) {
    const entry = authorTotals.get(commit.author) ?? { name: commit.author, commits: 0, lines: 0 };
    entry.commits += 1;
    entry.lines += commit.lines;
    authorTotals.set(commit.author, entry);
  }
  const authors = [...authorTotals.values()].sort((left, right) => right.lines - left.lines);

  // Commit messages routinely contain email addresses and occasionally secrets.
  return redactValue({
    version: GIT_HISTORY_VERSION,
    available: true,
    commitCount: commits.length,
    truncated: commits.length >= limits.commits,
    since: commits.at(-1)?.date ?? null,
    until: commits[0]?.date ?? null,
    authors: authors.slice(0, 10).map((author) => ({ ...author, share: share(author.lines, commits.reduce((sum, commit) => sum + commit.lines, 0)) })),
    authorCount: authors.length,
    repositoryBusFactor: busFactor(authors),
    ownership: { files: files.slice(0, 20), modules: modules.slice(0, 15) },
    evolution: {
      buckets: [...buckets.values()].sort((left, right) => left.month.localeCompare(right.month)).map((entry) => ({ month: entry.month, commits: entry.commits, lines: entry.lines, authors: entry.authors.size })),
      hotFiles: files.slice(0, 10).map((entry) => ({ path: entry.key, commits: entry.commits, lines: entry.lines, lastChange: entry.lastChange })),
    },
    regressions: {
      fixCommits: fixCommits.length,
      revertCommits: revertCommits.length,
      fixRatio: share(fixCommits.length, commits.length),
      hotspots: [...fixesByFile.values()].sort((left, right) => right.fixes - left.fixes || left.path.localeCompare(right.path)).slice(0, 10),
      reverts: revertCommits.slice(0, 5).map((commit) => ({ hash: commit.hash.slice(0, 8), subject: commit.subject.slice(0, 160), date: commit.date, files: commit.files.slice(0, 4).map((file) => file.path) })),
    },
    decisions,
  });
}

/**
 * Turn a history summary into source-anchored lessons.
 * Anchors are validated against the current index, so a lesson never points at
 * a file that has since been deleted or renamed.
 */
export function historyLessons(summary, repository) {
  if (!summary?.available) return [];
  const existing = new Set((repository.files ?? []).map((file) => file.path));
  const anchorFor = (filePath) => (existing.has(filePath) ? { path: filePath, line: 1, symbol: null } : null);
  const lessons = [];

  const ownedFile = summary.ownership.files.find((entry) => existing.has(entry.key));
  if (ownedFile) {
    lessons.push({
      id: "history-ownership",
      title: `Who owns ${ownedFile.key.split("/").at(-1)}`,
      objective: `Find out who to ask about ${ownedFile.key}, and how concentrated that knowledge is.`,
      summary: `${ownedFile.authorCount} author${ownedFile.authorCount === 1 ? "" : "s"} touched this file; the top author wrote ${Math.round(ownedFile.topAuthorShare * 100)}% of the changed lines (bus factor ${ownedFile.busFactor}).`,
      duration: 8,
      difficulty: "foundation",
      kind: "lesson",
      status: "ready",
      anchors: [anchorFor(ownedFile.key)].filter(Boolean),
      quiz: {
        question: `If ${ownedFile.authors[0]?.name ?? "the main author"} were unavailable, who else has enough context to review a change to ${ownedFile.key}?`,
        hint: "Compare the second and third authors' shares with the first.",
      },
      content: [
        { id: "history-ownership-story", type: "narrative", eyebrow: "REPOSITORY HISTORY", title: "Ownership is a review path", body: `Reviews go faster when they reach someone who has actually changed the code. ${ownedFile.key} has ${ownedFile.commits} commits across ${ownedFile.authorCount} author(s), last touched ${ownedFile.lastChange.slice(0, 10)}.` },
        { id: "history-ownership-table", type: "comparison", title: "Change share by author", columns: ownedFile.authors.slice(0, 3).map((author) => ({ title: author.name, items: [`${author.commits} commits`, `${author.lines} lines changed`, `${Math.round(author.share * 100)}% of this file`] })) },
      ],
    });
  }

  // Churn is the story here, not calendar length: a repository whose whole
  // history sits in one month still has files that keep changing.
  if (summary.evolution.hotFiles.length) {
    const busiest = [...summary.evolution.buckets].sort((left, right) => right.commits - left.commits)[0];
    lessons.push({
      id: "history-evolution",
      title: "How this repository grew",
      objective: "Read the shape of the project's activity and find the code that keeps changing.",
      summary: `${summary.commitCount} commits from ${summary.since?.slice(0, 10)} to ${summary.until?.slice(0, 10)}, peaking in ${busiest.month} with ${busiest.commits} commits.`,
      duration: 10,
      difficulty: "foundation",
      kind: "lesson",
      status: "ready",
      anchors: summary.evolution.hotFiles.map((entry) => anchorFor(entry.path)).filter(Boolean).slice(0, 3),
      quiz: { question: "Which file changes most often, and what does that tell you about where the design is still unsettled?", hint: "High churn usually means either an unstable interface or a very central one." },
      content: [
        { id: "history-evolution-timeline", type: "timeline", title: "Churn over time", steps: summary.evolution.hotFiles.slice(0, 5).map((entry) => ({ label: entry.path.split("/").at(-1), detail: `${entry.commits} commits · ${entry.lines} lines · last ${entry.lastChange.slice(0, 10)}`, anchor: anchorFor(entry.path) ?? undefined })) },
      ],
    });
  }

  if (summary.regressions.hotspots.length) {
    const hotspot = summary.regressions.hotspots.find((entry) => existing.has(entry.path)) ?? summary.regressions.hotspots[0];
    lessons.push({
      id: "history-regressions",
      title: "Where regressions cluster",
      objective: "Learn which code has needed the most fixes, and read one of those fixes.",
      summary: `${summary.regressions.fixCommits} of ${summary.commitCount} commits are fixes (${Math.round(summary.regressions.fixRatio * 100)}%), and ${hotspot.path} needed ${hotspot.fixes}.`,
      duration: 12,
      difficulty: "intermediate",
      kind: "lesson",
      status: "ready",
      anchors: [anchorFor(hotspot.path)].filter(Boolean),
      quiz: { question: `Read the most recent fix to ${hotspot.path}. What invariant was being restored?`, hint: "Look for the condition the fix adds or the assumption it removes." },
      content: [
        { id: "history-regressions-list", type: "timeline", title: "Recent fixes here", steps: hotspot.examples.map((example) => ({ label: example.hash, detail: `${example.subject} (${example.date.slice(0, 10)})`, anchor: anchorFor(hotspot.path) ?? undefined })) },
      ],
    });
  }

  if (summary.decisions.length) {
    const decision = summary.decisions[0];
    lessons.push({
      id: "history-decisions",
      title: "A design decision in its own words",
      objective: "Read the commit that explains a design choice, then find the code it changed.",
      summary: `${decision.subject} — ${decision.author}, ${decision.date.slice(0, 10)}.`,
      duration: 10,
      difficulty: "intermediate",
      kind: "lesson",
      status: "ready",
      anchors: decision.files.map((filePath) => anchorFor(filePath)).filter(Boolean).slice(0, 3),
      quiz: { question: "What alternative does this commit implicitly reject, and what would have broken if it had been chosen?", hint: "The rationale is usually in the body, not the subject." },
      content: [
        { id: "history-decisions-story", type: "narrative", eyebrow: `COMMIT ${decision.hash}`, title: decision.subject, body: decision.excerpt || "This commit's subject explains the change; open the files it touched to see the shape of the decision." },
      ],
    });
  }

  return lessons;
}
