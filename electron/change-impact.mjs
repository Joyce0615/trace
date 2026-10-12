import { buildSymbolSnapshot, courseAnchorSites } from "./course-migration.mjs";

export { buildSymbolSnapshot };

/**
 * Change-impact and stale-lesson analysis (item 8).
 *
 * Every teaching artifact in this app — a lesson anchor, a skill's mastery
 * fingerprint, a quiz, a note — is a claim about a specific `path:line` in a
 * specific version of the repository. Items 44/45 can tell a *reader*
 * whether one such claim still points at the right place; item 46 can
 * *repair* a course's anchors after a rename. Neither answers the question a
 * learner (or a maintainer re-running the course after a pull) actually has
 * first: "the repository changed — what, across *everything* I've built on
 * it, might now be wrong?"
 *
 * This module answers that in one pass. "Changed" is deliberately **not**
 * "the knowledge graph's partition digest differs": a partition digest hashes
 * every node and edge a file contributed, which also changes on a pure
 * line-shift (a comment added above a function moves every later line, and
 * therefore the `@line` suffix of every node id after it) even though no
 * definition's actual content moved. That is exactly the distinction
 * `course-migration.mjs` already drew for anchor repair — a body
 * **fingerprint** (hashed token shingles of the definition's own body) does
 * not change when a definition only moves, and does change when it does not
 * — so symbol-level change detection here reuses `buildSymbolSnapshot`'s
 * fingerprints directly rather than inventing a second, weaker notion of
 * "changed" that would flag every reflowed file as impacted.
 *
 * From the set of symbols that were added, removed, or whose fingerprint
 * actually changed, impact is traced along four different kinds of claim,
 * because collapsing them into one "stale" bucket is exactly the mistake
 * `course-migration.mjs`'s own module docs warn against for anchors alone:
 *
 *   - **callers** — direct and transitive callers of a changed symbol, via
 *     the knowledge graph's own `calls` edges (item 55), so this can never
 *     disagree with what the graph already says about who calls what;
 *   - **tests** — test files whose resolved call edges exercise a changed
 *     symbol, so "this test still runs" and "this test is evidence for the
 *     new behavior" are not conflated;
 *   - **lessons/quizzes/notes** — any course anchor (reusing
 *     `course-migration.mjs`'s own `courseAnchorSites`, so a lesson anchor
 *     found stale here is identically found by the migration planner), note
 *     anchor, or quiz anchor naming a changed path or symbol;
 *   - **mastery evidence** — skill-graph nodes (item 42) whose
 *     `sourceFingerprint` was computed over a changed anchor, which is the
 *     exact signal `skill-graph.mjs`'s own `reconcileLearnerState` already
 *     uses to flag a skill `"stale"` — this module explains *why*, instead
 *     of leaving the learner with only the fact of staleness.
 *
 * Pure: no fs/network, no Node builtins beyond what `course-migration.mjs`
 * already uses (none) — every input (two symbol snapshots, the after
 * knowledge graph, the course, notes, evidence items) is already in memory
 * by the time a caller (an IPC handler) needs this, so the module runs
 * identically in the browser demo.
 */

export const CHANGE_IMPACT_VERSION = 1;

function keyOf(symbol) {
  return `${symbol.path}#${symbol.name}`;
}

/**
 * Symbols added, removed, or whose body fingerprint changed between two
 * `buildSymbolSnapshot` snapshots of the same repository.
 *
 * Fingerprint-based, not line-based: a definition that only moved (its line
 * shifted because something above it in the file changed) keeps its
 * fingerprint and is correctly reported as unchanged. A same-named
 * definition whose fingerprint changed is "modified" even if its line did
 * not move (e.g. the file grew below it). A name present only in one
 * snapshot's file set is added/removed.
 */
export function changedSymbols(beforeSnapshot, afterSnapshot) {
  const beforeByKey = new Map((beforeSnapshot?.symbols ?? []).map((symbol) => [keyOf(symbol), symbol]));
  const afterByKey = new Map((afterSnapshot?.symbols ?? []).map((symbol) => [keyOf(symbol), symbol]));
  const beforeFiles = new Set(beforeSnapshot?.files ?? []);
  const afterFiles = new Set(afterSnapshot?.files ?? []);

  const removed = [];
  for (const [key, symbol] of beforeByKey) {
    if (afterByKey.has(key)) continue;
    // Only call it "removed" when the symbol's file still exists; a file that
    // disappeared entirely removes every symbol in it, which is reported
    // once per symbol here (the module leaves file-level removal to the
    // caller's own `changedFiles`, which already lists the file).
    removed.push({ ...symbol, changeKind: "removed", stillInFile: afterFiles.has(symbol.path) });
  }
  const added = [];
  const modified = [];
  for (const [key, symbol] of afterByKey) {
    const before = beforeByKey.get(key);
    if (!before) {
      added.push({ ...symbol, changeKind: "added", isNewFile: !beforeFiles.has(symbol.path) });
      continue;
    }
    if (before.fingerprint !== symbol.fingerprint) {
      modified.push({ ...symbol, changeKind: "modified", previousLine: before.line });
    }
  }

  const changedFiles = new Set();
  for (const symbol of [...added, ...removed, ...modified]) changedFiles.add(symbol.path);
  for (const path of beforeFiles) if (!afterFiles.has(path)) changedFiles.add(path);
  for (const path of afterFiles) if (!beforeFiles.has(path)) changedFiles.add(path);

  return {
    changedFiles: [...changedFiles],
    added,
    removed,
    modified,
    all: [...added, ...modified, ...removed],
  };
}

/** The after-graph's `defines`-created symbol node for a changed `path#name` entry, if the graph still has one (absent for `removed`). */
function graphNodeFor(graph, symbol) {
  const key = keyOf(symbol);
  return (graph?.nodes ?? []).find((node) => node.kind === "symbol" && node.key === key) ?? null;
}

/**
 * Direct and transitive callers of a set of changed symbols, via the
 * knowledge graph's own `calls` edges.
 *
 * Walks resolved `calls` edges backward (`to` the symbol, `from` its caller)
 * up to `maxDepth` hops (default 6), so a caller of a caller is still
 * reported — a two-hop-removed function that merely forwards a changed
 * return value is exactly as affected as a function that calls the changed
 * symbol directly. Cycles are broken via `visited` regardless of the depth
 * bound.
 */
export function tracedCallers(graph, changedSymbolEntries, options = {}) {
  const maxDepth = Math.max(1, options.maxDepth ?? 6);
  const startIds = new Set();
  for (const symbol of changedSymbolEntries) {
    const node = graphNodeFor(graph, symbol);
    if (node) startIds.add(node.id);
  }

  const callersOf = new Map();
  for (const edge of graph?.edges ?? []) {
    if (edge.kind !== "calls" || !edge.resolved) continue;
    if (!callersOf.has(edge.to)) callersOf.set(edge.to, []);
    callersOf.get(edge.to).push(edge.from);
  }
  const byId = new Map((graph?.nodes ?? []).map((node) => [node.id, node]));

  const result = new Map();
  for (const startId of startIds) {
    const visited = new Set([startId]);
    let frontier = [startId];
    for (let depth = 1; depth <= maxDepth && frontier.length; depth += 1) {
      const next = [];
      for (const id of frontier) {
        for (const callerId of callersOf.get(id) ?? []) {
          if (visited.has(callerId)) continue;
          visited.add(callerId);
          next.push(callerId);
          const node = byId.get(callerId);
          if (!node || node.kind !== "symbol") continue;
          if (!result.has(callerId)) result.set(callerId, { ...node, depth, changedKeys: new Set() });
          result.get(callerId).changedKeys.add(startId);
          if (depth < result.get(callerId).depth) result.get(callerId).depth = depth;
        }
      }
      frontier = next;
    }
  }
  return [...result.values()]
    .map((entry) => ({ ...entry, changedKeys: [...entry.changedKeys] }))
    .sort((left, right) => left.depth - right.depth || left.path.localeCompare(right.path) || left.line - right.line);
}

const TEST_PATH = /(^|\/)(tests?|spec|specs|__tests__)(\/|$)/i;
const TEST_FILE_NAME = /^test_.+|.+[._](test|spec)\.[a-z]+$/i;

/** Same test-file recognition `evidence-import.mjs` uses, so a file counted as test evidence there is the same file traced as a test here. */
export function isTestPath(filePath) {
  const name = filePath.split("/").at(-1) ?? filePath;
  const directory = filePath.slice(0, filePath.length - name.length);
  return TEST_PATH.test(directory) || TEST_FILE_NAME.test(name);
}

/**
 * Test files whose resolved `calls` edges exercise a changed symbol.
 *
 * Grounded in the same `callEdges`/`resolved` data `evidence-import.mjs`
 * uses to call a test "covers" something, not a name-matching guess: a test
 * file only appears here if the graph can show a resolved call from that
 * file into the changed symbol's definition.
 */
export function tracedTests(graph, changedSymbolEntries) {
  const changedIds = new Set();
  for (const symbol of changedSymbolEntries) {
    const node = graphNodeFor(graph, symbol);
    if (node) changedIds.add(node.id);
  }
  const byId = new Map((graph?.nodes ?? []).map((node) => [node.id, node]));
  const byPath = new Map();
  for (const edge of graph?.edges ?? []) {
    if (edge.kind !== "calls" || !edge.resolved || !changedIds.has(edge.to)) continue;
    const fromNode = byId.get(edge.from);
    const path = fromNode?.path ?? (edge.from.startsWith("file:") ? edge.from.slice(5) : null);
    if (!path || !isTestPath(path)) continue;
    if (!byPath.has(path)) byPath.set(path, { path, changedKeys: new Set(), callers: new Set() });
    const entry = byPath.get(path);
    entry.changedKeys.add(edge.to);
    if (fromNode?.kind === "symbol") entry.callers.add(fromNode.label);
  }
  return [...byPath.values()]
    .map((entry) => ({ path: entry.path, changedKeys: [...entry.changedKeys], callers: [...entry.callers] }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function changedByPathIndex(changedSymbolEntries) {
  const byPath = new Map();
  for (const symbol of changedSymbolEntries) {
    if (!byPath.has(symbol.path)) byPath.set(symbol.path, []);
    byPath.get(symbol.path).push(symbol);
  }
  return byPath;
}

function anchorMatchesChange(anchor, changedFileSet, changedByPath) {
  if (!anchor?.path) return false;
  if (!changedFileSet.has(anchor.path)) return false;
  if (!anchor.symbol) return true; // A file-level anchor is stale on any change to that file.
  return (changedByPath.get(anchor.path) ?? []).some((symbol) => symbol.name === anchor.symbol);
}

/**
 * Course lessons whose anchors name a changed path or symbol.
 *
 * Reuses `course-migration.mjs`'s own `courseAnchorSites` to enumerate every
 * anchor a course carries (lesson anchors, diagram nodes, timeline/call-chain
 * steps), so a lesson flagged stale here is identically the set of anchors
 * `planMigration` would try to repair — the two can never disagree about
 * what counts as an anchor.
 */
export function tracedLessons(course, changedFiles, changedSymbolEntries) {
  const changedFileSet = new Set(changedFiles);
  const changedByPath = changedByPathIndex(changedSymbolEntries);
  const bySite = new Map();
  for (const site of courseAnchorSites(course)) {
    if (!anchorMatchesChange(site.anchor, changedFileSet, changedByPath)) continue;
    if (!bySite.has(site.lessonId)) {
      bySite.set(site.lessonId, { lessonId: site.lessonId, moduleId: site.moduleId, title: site.lessonTitle, anchors: [] });
    }
    bySite.get(site.lessonId).anchors.push(site.anchor);
  }
  return [...bySite.values()];
}

/** Notes whose anchor names a changed path or symbol. */
export function tracedNotes(notes, changedFiles, changedSymbolEntries) {
  const changedFileSet = new Set(changedFiles);
  const changedByPath = changedByPathIndex(changedSymbolEntries);
  return (notes ?? [])
    .filter((note) => anchorMatchesChange(note.anchor, changedFileSet, changedByPath))
    .map((note) => ({ id: note.id, lessonId: note.lessonId ?? null, anchor: note.anchor }));
}

/** Executable/race/localization quizzes (anything with a quiz-shaped `anchor`) whose anchor names a changed path or symbol. */
export function tracedQuizzes(quizzes, changedFiles, changedSymbolEntries) {
  const changedFileSet = new Set(changedFiles);
  const changedByPath = changedByPathIndex(changedSymbolEntries);
  return (quizzes ?? [])
    .filter((quiz) => anchorMatchesChange(quiz.anchor, changedFileSet, changedByPath))
    .map((quiz) => ({ id: quiz.id, entry: quiz.entry ?? null, anchor: quiz.anchor }));
}

/**
 * Skill-graph nodes whose recorded mastery evidence was earned against a
 * changed anchor.
 *
 * `skill-graph.mjs`'s own `reconcileLearnerState` already flags a skill
 * `"stale"` by comparing `sourceFingerprint`s; this reuses the *same*
 * decision (so the two can never disagree about whether a skill is stale)
 * but reports *which* of the skill's anchors changed, which the fingerprint
 * comparison alone discards.
 */
export function tracedMasteryEvidence(skillGraph, learnerState, changedFiles) {
  const changedFileSet = new Set(changedFiles);
  const flagged = [];
  for (const node of skillGraph?.nodes ?? []) {
    const changedAnchors = (node.anchors ?? []).filter((anchor) => changedFileSet.has(anchor.path));
    if (!changedAnchors.length) continue;
    const mastery = learnerState?.mastery?.[node.id];
    if (!mastery || (Number(mastery.mastery) || 0) <= 0) continue; // Nothing was ever recorded, so there is no evidence to call stale.
    flagged.push({ skillId: node.id, title: node.title, recordedMastery: mastery.mastery, changedAnchors });
  }
  return flagged;
}

/**
 * One change-impact report, tracing every changed symbol to callers, tests,
 * lessons, quizzes, notes, and mastery evidence.
 *
 * `beforeSnapshot`/`afterSnapshot` are `buildSymbolSnapshot` results
 * (`course-migration.mjs`); `afterGraph` is a `buildKnowledgeGraph` result
 * for the *same* version as `afterSnapshot`. `course`/`notes`/`quizzes`/
 * `skillGraph`/`learnerState` are all optional: a caller with only the two
 * snapshots and a graph (e.g. a CI job diffing two commits with no course
 * built yet) still gets `symbols`/`callers`/`tests`.
 */
export function analyzeChangeImpact(beforeSnapshot, afterSnapshot, afterGraph, context = {}) {
  const symbols = changedSymbols(beforeSnapshot, afterSnapshot);
  const callers = tracedCallers(afterGraph, symbols.all, context.callers);
  const tests = tracedTests(afterGraph, symbols.all);
  const lessons = context.course ? tracedLessons(context.course, symbols.changedFiles, symbols.all) : [];
  const notes = context.notes ? tracedNotes(context.notes, symbols.changedFiles, symbols.all) : [];
  const quizzes = context.quizzes ? tracedQuizzes(context.quizzes, symbols.changedFiles, symbols.all) : [];
  const masteryEvidence = context.skillGraph
    ? tracedMasteryEvidence(context.skillGraph, context.learnerState, symbols.changedFiles)
    : [];

  return {
    version: CHANGE_IMPACT_VERSION,
    afterVersion: afterGraph?.version ?? null,
    symbols,
    callers,
    tests,
    lessons,
    notes,
    quizzes,
    masteryEvidence,
    summary: {
      changedFileCount: symbols.changedFiles.length,
      changedSymbolCount: symbols.all.length,
      callerCount: callers.length,
      testCount: tests.length,
      lessonCount: lessons.length,
      noteCount: notes.length,
      quizCount: quizzes.length,
      masteryEvidenceCount: masteryEvidence.length,
    },
  };
}

/** A compact text block for the renderer or a prompt. */
export function renderChangeImpact(report) {
  const lines = [
    `Change impact: ${report.summary.changedSymbolCount} changed symbol(s) across ${report.summary.changedFileCount} file(s).`,
  ];
  if (report.callers.length) lines.push(`- ${report.callers.length} caller(s) may now be affected, up to depth ${Math.max(...report.callers.map((c) => c.depth))}.`);
  if (report.tests.length) lines.push(`- ${report.tests.length} test file(s) exercised the changed code.`);
  if (report.lessons.length) lines.push(`- ${report.lessons.length} lesson(s) anchor into the changed code.`);
  if (report.notes.length) lines.push(`- ${report.notes.length} note(s) anchor into the changed code.`);
  if (report.quizzes.length) lines.push(`- ${report.quizzes.length} quiz(zes) anchor into the changed code.`);
  if (report.masteryEvidence.length) lines.push(`- ${report.masteryEvidence.length} skill(s) have mastery recorded against now-changed code.`);
  if (lines.length === 1) lines.push("- nothing downstream is affected.");
  return lines.join("\n");
}
