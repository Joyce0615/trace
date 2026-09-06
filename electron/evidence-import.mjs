import { createHash } from "node:crypto";
import { readRepositoryFile } from "./repository.mjs";
import { redactValue } from "./secret-scanner.mjs";

/**
 * Import the artifacts a team already wrote as learning evidence.
 *
 * A repository carries more explanation than its source: merged pull requests,
 * referenced issues, architecture decision records, prose documentation, and
 * tests that encode the intended behaviour. This module collects all five from
 * material that is already on disk or already in git, links each item to real
 * files and symbols, and scores how confident that link is.
 *
 * Everything here is offline by design. Live issue and pull-request APIs need
 * network access and credentials, so instead pull requests are recovered from
 * merge commits and squash subjects, and issues from the references commits
 * make to them. That keeps the feature working for a cloned repository with no
 * account attached.
 */

export const EVIDENCE_VERSION = 1;

const PULL_REQUEST_MERGE = /^Merge pull request #(\d+) from (\S+)/i;
const PULL_REQUEST_SQUASH = /\(#(\d+)\)\s*$/;
const ISSUE_REFERENCE = /\b(?:closes|close|closed|fixes|fix|fixed|resolves|resolve|resolved|refs?|see)\s+#(\d+)\b/gi;
const ADR_HEADING = /^#\s*(?:ADR[- ]?\d+[:.]?\s*)?(.+)$/m;
const ADR_STATUS = /^\s*(?:##\s*)?status\s*:?\s*(.+)$/im;
const CODE_REFERENCE = /`([\w./-]+\.(?:py|ts|tsx|js|jsx|go|rs|c|h|cc|cpp|cu|cuh|java|kt|rb|php|swift|cs))`|`([A-Za-z_]\w{2,})\(\)`/g;

function evidenceId(kind, key) {
  return `${kind}-${createHash("sha1").update(key).digest("hex").slice(0, 10)}`;
}

function anchorsFor(repository, paths) {
  const known = new Set((repository.files ?? []).map((file) => file.path));
  return [...new Set(paths)]
    .filter((filePath) => known.has(filePath))
    .slice(0, 6)
    .map((filePath) => {
      const symbol = (repository.symbols ?? []).find((candidate) => candidate.path === filePath);
      return { path: filePath, line: symbol?.line ?? 1, symbol: symbol?.name ?? null };
    });
}

/** Pull requests and issue references recovered from commit history. */
export function evidenceFromHistory(commits, repository) {
  const items = [];
  const issues = new Map();
  for (const commit of commits) {
    const merge = commit.subject.match(PULL_REQUEST_MERGE);
    const squash = commit.subject.match(PULL_REQUEST_SQUASH);
    const number = merge?.[1] ?? squash?.[1] ?? null;
    if (number) {
      const paths = commit.files.map((file) => file.path);
      items.push({
        id: evidenceId("pull-request", `${number}:${commit.hash}`),
        kind: "pull-request",
        reference: `#${number}`,
        title: (merge ? commit.body.split(/\r?\n/).find((line) => line.trim()) ?? commit.subject : commit.subject).slice(0, 160),
        summary: `${commit.author} · ${commit.date.slice(0, 10)} · ${commit.files.length} file${commit.files.length === 1 ? "" : "s"} changed`,
        source: `commit ${commit.hash.slice(0, 8)}`,
        body: commit.body.slice(0, 600),
        anchors: anchorsFor(repository, paths),
        paths: paths.slice(0, 10),
        confidence: merge ? 1 : 0.8,
      });
    }
    for (const match of commit.subject.concat("\n", commit.body).matchAll(ISSUE_REFERENCE)) {
      const key = match[1];
      const entry = issues.get(key) ?? { number: key, commits: [], paths: new Set() };
      entry.commits.push({ hash: commit.hash.slice(0, 8), subject: commit.subject.slice(0, 140), date: commit.date });
      for (const file of commit.files) entry.paths.add(file.path);
      issues.set(key, entry);
    }
  }
  for (const entry of issues.values()) {
    items.push({
      id: evidenceId("issue", entry.number),
      kind: "issue",
      reference: `#${entry.number}`,
      title: entry.commits[0].subject,
      summary: `${entry.commits.length} commit${entry.commits.length === 1 ? "" : "s"} reference this issue`,
      source: `commits ${entry.commits.slice(0, 3).map((commit) => commit.hash).join(", ")}`,
      body: entry.commits.slice(0, 4).map((commit) => `${commit.hash} ${commit.subject}`).join("\n"),
      anchors: anchorsFor(repository, [...entry.paths]),
      paths: [...entry.paths].slice(0, 10),
      confidence: 0.7,
    });
  }
  return items;
}

function isAdrPath(filePath) {
  return /(^|\/)(adr|adrs|decisions|rfcs?)\//i.test(filePath) && /\.mdx?$/i.test(filePath);
}

function isDocPath(filePath) {
  return /\.(md|mdx|rst)$/i.test(filePath) && !isAdrPath(filePath);
}

function isTestPath(file) {
  return /(^|\/)(tests?|spec|specs|__tests__)(\/|$)/i.test(file.directory ?? "")
    || /^test_.+|.+[._](test|spec)\.[a-z]+$/i.test(file.name ?? "");
}

function referencedCode(text) {
  const paths = [];
  const symbols = [];
  for (const match of text.matchAll(CODE_REFERENCE)) {
    if (match[1]) paths.push(match[1]);
    else if (match[2]) symbols.push(match[2]);
  }
  return { paths: [...new Set(paths)], symbols: [...new Set(symbols)] };
}

function resolveReferences(repository, references) {
  const files = repository.files ?? [];
  const resolvedPaths = references.paths
    .map((candidate) => files.find((file) => file.path === candidate || file.path.endsWith(`/${candidate}`) || file.name === candidate)?.path)
    .filter(Boolean);
  const resolvedSymbols = references.symbols
    .map((name) => (repository.symbols ?? []).find((symbol) => symbol.name === name))
    .filter(Boolean)
    .slice(0, 6);
  return { paths: [...new Set(resolvedPaths)], symbols: resolvedSymbols };
}

/**
 * Read checked-in documentation, ADRs, and tests, and link them to source.
 * `read` defaults to the sandboxed repository reader.
 */
export async function evidenceFromFiles(repository, options = {}) {
  const read = options.read ?? ((filePath) => readRepositoryFile(repository.rootPath, filePath));
  const limit = options.limit ?? 40;
  const items = [];
  const files = repository.files ?? [];

  const adrFiles = files.filter((file) => isAdrPath(file.path)).slice(0, limit);
  for (const file of adrFiles) {
    let text = "";
    try { text = await read(file.path); } catch { continue; }
    const heading = text.match(ADR_HEADING)?.[1]?.trim() ?? file.name;
    const status = text.match(ADR_STATUS)?.[1]?.trim().replace(/[*_`]/g, "") ?? null;
    const references = resolveReferences(repository, referencedCode(text));
    items.push({
      id: evidenceId("adr", file.path),
      kind: "adr",
      reference: file.name.replace(/\.mdx?$/i, ""),
      title: heading.slice(0, 160),
      summary: status ? `Status: ${status}` : "Architecture decision record",
      source: file.path,
      body: text.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#")).slice(0, 6).join(" ").slice(0, 600),
      status,
      anchors: anchorsFor(repository, [file.path, ...references.paths]),
      paths: references.paths.slice(0, 10),
      symbols: references.symbols.map((symbol) => ({ name: symbol.name, path: symbol.path, line: symbol.line })),
      confidence: references.paths.length || references.symbols.length ? 0.9 : 0.6,
    });
  }

  const docFiles = files
    .filter((file) => isDocPath(file.path))
    .sort((left, right) => (right.importance ?? 0) - (left.importance ?? 0))
    .slice(0, limit);
  for (const file of docFiles) {
    let text = "";
    try { text = await read(file.path); } catch { continue; }
    const references = resolveReferences(repository, referencedCode(text));
    if (!references.paths.length && !references.symbols.length && !/^#\s/m.test(text)) continue;
    const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? file.name;
    items.push({
      id: evidenceId("doc", file.path),
      kind: "doc",
      reference: file.path,
      title: heading.slice(0, 160),
      summary: `${references.paths.length} file reference${references.paths.length === 1 ? "" : "s"}, ${references.symbols.length} symbol reference${references.symbols.length === 1 ? "" : "s"}`,
      source: file.path,
      body: text.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#")).slice(0, 4).join(" ").slice(0, 400),
      anchors: anchorsFor(repository, [...references.paths, file.path]),
      paths: references.paths.slice(0, 10),
      symbols: references.symbols.map((symbol) => ({ name: symbol.name, path: symbol.path, line: symbol.line })),
      confidence: references.paths.length ? 0.85 : 0.5,
    });
  }

  // Tests are linked through their resolved imports and the symbols they name,
  // which is what makes them usable as evidence for a specific skill.
  const testFiles = files.filter((file) => isTestPath(file)).slice(0, limit);
  const importsByPath = new Map();
  for (const item of repository.imports ?? []) {
    if (!item.targetPath) continue;
    if (!importsByPath.has(item.path)) importsByPath.set(item.path, new Set());
    importsByPath.get(item.path).add(item.targetPath);
  }
  for (const file of testFiles) {
    const imported = [...(importsByPath.get(file.path) ?? [])];
    const exercised = (repository.callEdges ?? [])
      .filter((edge) => edge.path === file.path && edge.resolved && edge.targetPath && edge.targetPath !== file.path)
      .map((edge) => ({ name: edge.callee, path: edge.targetPath, line: edge.targetLine }));
    const cases = (repository.symbols ?? []).filter((symbol) => symbol.path === file.path && /^(test|it|should)/i.test(symbol.name));
    if (!imported.length && !exercised.length && !cases.length) continue;
    items.push({
      id: evidenceId("test", file.path),
      kind: "test",
      reference: file.name,
      title: `${cases.length || "Unnamed"} test${cases.length === 1 ? "" : "s"} in ${file.name}`,
      summary: `Covers ${imported.length} imported module${imported.length === 1 ? "" : "s"} and ${new Set(exercised.map((item) => item.name)).size} symbol${new Set(exercised.map((item) => item.name)).size === 1 ? "" : "s"}`,
      source: file.path,
      body: cases.slice(0, 6).map((symbol) => `${symbol.name} (${file.path}:${symbol.line})`).join("\n"),
      anchors: anchorsFor(repository, [file.path, ...imported]),
      paths: imported.slice(0, 10),
      symbols: [...new Map(exercised.map((item) => [item.name, item])).values()].slice(0, 8),
      cases: cases.slice(0, 10).map((symbol) => ({ name: symbol.name, line: symbol.line })),
      confidence: exercised.length ? 0.95 : 0.7,
    });
  }

  return items;
}

/** Group every evidence item by the repository file it explains. */
export function evidenceByPath(items) {
  const byPath = new Map();
  for (const item of items) {
    for (const anchor of item.anchors) {
      if (!byPath.has(anchor.path)) byPath.set(anchor.path, []);
      byPath.get(anchor.path).push({ id: item.id, kind: item.kind, title: item.title, reference: item.reference, confidence: item.confidence });
    }
  }
  return byPath;
}

/** Attach evidence to skills by matching their lesson anchors. */
export function evidenceForSkills(items, skillGraph) {
  const byPath = evidenceByPath(items);
  const result = {};
  for (const node of skillGraph?.nodes ?? []) {
    const matched = node.anchors.flatMap((anchor) => byPath.get(anchor.path) ?? []);
    if (matched.length) result[node.id] = [...new Map(matched.map((item) => [item.id, item])).values()].slice(0, 8);
  }
  return result;
}

/** Collect every offline evidence source into one bounded, redacted payload. */
export async function importEvidence(repository, options = {}) {
  const fileItems = await evidenceFromFiles(repository, options);
  const historyItems = options.commits?.length ? evidenceFromHistory(options.commits, repository) : [];
  // A busy repository has hundreds of merged pull requests and a handful of
  // ADRs. Capping per kind first keeps every source represented instead of
  // letting the largest one crowd the others out of the global cap.
  const maxPerKind = options.maxPerKind ?? 40;
  const perKind = new Map();
  const items = [];
  for (const item of [...historyItems, ...fileItems].sort((left, right) => right.confidence - left.confidence || left.kind.localeCompare(right.kind) || left.title.localeCompare(right.title))) {
    const used = perKind.get(item.kind) ?? 0;
    if (used >= maxPerKind) continue;
    perKind.set(item.kind, used + 1);
    items.push(item);
    if (items.length >= (options.maxItems ?? 160)) break;
  }
  const counts = items.reduce((totals, item) => ({ ...totals, [item.kind]: (totals[item.kind] ?? 0) + 1 }), {});
  const linked = items.filter((item) => item.anchors.length > 0);
  return redactValue({
    version: EVIDENCE_VERSION,
    items,
    stats: {
      total: items.length,
      byKind: counts,
      maxPerKind,
      linked: linked.length,
      unlinked: items.length - linked.length,
      coverage: items.length ? Number((linked.length / items.length).toFixed(3)) : 0,
    },
    // Live issue and pull-request APIs need credentials; everything here is local.
    sources: {
      offline: ["git history", "checked-in ADRs", "documentation", "test files"],
      unavailable: options.commits?.length ? [] : ["git history (no commits were provided)"],
    },
  });
}
