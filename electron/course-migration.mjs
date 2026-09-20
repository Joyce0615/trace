/**
 * Course migrations across source change.
 *
 * Items 44 and 45 answer "is this the course I was given, unaltered?". This
 * module answers a different and harder question: "the repository moved on —
 * what is this course still *about*?"
 *
 * A course anchors into source by `path:line`. Every one of those anchors is a
 * claim that decays. The four ways it decays need four different answers, and
 * collapsing them into "stale" is what makes a course rot silently:
 *
 *   - **moved** — the same definition, further down the file, or in a file that
 *     was renamed. Nothing about the lesson is wrong; only the coordinate is.
 *     This is repairable without a human.
 *   - **renamed** — the definition survived under a new name. The lesson text
 *     that names the old symbol is now wrong, so the anchor can be repaired but
 *     the prose must be looked at.
 *   - **split** — one definition became several. There is no single right
 *     answer here: the lesson may now be about the part that was extracted, the
 *     part that remained, or both. Auto-repair would quietly change what the
 *     lesson teaches, so a split is *always* held for review.
 *   - **disappeared** — the definition is gone. The honest response is neither
 *     to keep a dead anchor (it opens nothing) nor to delete it (the author
 *     loses the evidence of what the lesson used to point at). It is retired:
 *     removed from the live anchors, preserved with its reason, and revertible.
 *
 * Matching is done on **body fingerprints**, not names, because a name is
 * exactly the thing that stops being reliable during a rename. Bodies are
 * reduced to token shingles so that reformatting, comment churn, and small
 * edits do not look like a different function, while a genuinely different
 * function does not look like the same one.
 *
 * Nothing here is destructive and nothing is hidden: every operation carries
 * the evidence that produced it, a confidence, and whether it is safe to apply
 * without a person. The applied migration is recorded on the course with the
 * anchors it replaced, so `revertMigration` can put them back exactly.
 *
 * The module is Node-free so the main process, the browser demo, and the tests
 * all run the identical matcher.
 */

import { hash32 } from "./hashing.mjs";

export const MIGRATION_VERSION = 1;

/**
 * Thresholds are stated here rather than scattered through the matcher so the
 * cost of being wrong is visible: `rename` too low invents relationships,
 * `auto` too low rewrites a course without asking.
 */
export const DEFAULT_MIGRATION_THRESHOLDS = {
  /** Body similarity below which two definitions are not the same definition. */
  rename: 0.6,
  /** Fraction of an old body that must be accounted for before calling it a split. */
  split: 0.5,
  /** The least a fragment may contribute and still count as one of the parts. */
  splitContribution: 0.15,
  /** Similarity above which a surviving same-name definition is "the same code". */
  intact: 0.75,
  /** How far the best candidate must beat the runner-up before it is chosen. */
  margin: 0.12,
  /** Confidence at or above which an operation applies without review. */
  auto: 0.8,
};

/** Statuses that mean the anchor no longer points at anything. */
export const DEAD_STATUSES = new Set(["disappeared", "file-removed"]);

const COMMENT_LINE = /^\s*(?:#|\/\/|\/\*|\*\/|\*|--|;;)/;

/**
 * Tokens of a definition body, with whole-line comments dropped.
 *
 * Comments are excluded deliberately: adding a docstring above a function moves
 * every line below it, and that is a *move*, not an edit to the code. Counting
 * comment churn as a body change would report the entire repository as edited
 * after a documentation pass.
 */
export function bodyTokens(text) {
  const tokens = [];
  for (const line of String(text ?? "").split("\n")) {
    if (COMMENT_LINE.test(line)) continue;
    const matches = line.match(/[A-Za-z_][A-Za-z0-9_]*|\d+|[^\s\w]/g);
    if (matches) tokens.push(...matches);
  }
  return tokens;
}

/**
 * Overlapping token n-grams, as a sorted array of hashes.
 *
 * n-grams rather than a bag of tokens because order carries meaning: two
 * functions built from the same twelve identifiers in a different order are not
 * the same function, and a bag would say they were.
 */
export function shingles(tokens, size = 3, limit = 600) {
  const found = new Set();
  if (!tokens.length) return [];
  if (tokens.length < size) return [hash32(tokens.join("\u0000"))];
  for (let index = 0; index + size <= tokens.length && found.size < limit; index += 1) {
    found.add(hash32(tokens.slice(index, index + size).join("\u0000")));
  }
  return [...found].sort((left, right) => left - right);
}

/** Jaccard similarity of two shingle arrays; 0 when either side is empty. */
export function jaccard(left, right) {
  if (!left?.length || !right?.length) return 0;
  const smaller = left.length <= right.length ? new Set(left) : new Set(right);
  const larger = left.length <= right.length ? right : left;
  let shared = 0;
  for (const value of larger) if (smaller.has(value)) shared += 1;
  const union = left.length + right.length - shared;
  return union ? Number((shared / union).toFixed(4)) : 0;
}

/** How much of `target` is present in `parts`; asymmetric, unlike Jaccard. */
export function coverage(target, parts) {
  if (!target?.length) return 0;
  const present = new Set(parts.flat());
  let shared = 0;
  for (const value of target) if (present.has(value)) shared += 1;
  return Number((shared / target.length).toFixed(4));
}

/**
 * A comparable picture of one version's definitions.
 *
 * `files` is carried separately from the symbols so that "this file has no
 * definitions any more" and "this file is gone" stay distinguishable; without
 * it every empty file would look deleted.
 */
export function buildSymbolSnapshot(symbols, sources = {}, options = {}) {
  const maxSymbols = options.maxSymbols ?? 4_000;
  const maxBodyLines = options.maxBodyLines ?? 400;
  const lineCache = new Map();
  const linesOf = (filePath) => {
    if (!lineCache.has(filePath)) {
      const source = sources?.[filePath];
      lineCache.set(filePath, typeof source === "string" ? source.split("\n") : null);
    }
    return lineCache.get(filePath);
  };

  // The regex indexer reports a definition's first line but not its last, so a
  // body would be a single line and every similarity would collapse to noise.
  // The next definition in the same file is the best available end bound.
  const nextStart = new Map();
  const byFile = new Map();
  for (const symbol of symbols ?? []) {
    if (!symbol?.name || !symbol?.path) continue;
    if (!byFile.has(symbol.path)) byFile.set(symbol.path, []);
    byFile.get(symbol.path).push(symbol);
  }
  for (const [filePath, group] of byFile) {
    const starts = [...new Set(group.map((symbol) => Math.max(1, Number(symbol.line) || 1)))].sort((left, right) => left - right);
    starts.forEach((start, index) => nextStart.set(`${filePath}:${start}`, starts[index + 1] ?? Number.POSITIVE_INFINITY));
  }

  const entries = [];
  for (const symbol of symbols ?? []) {
    if (entries.length >= maxSymbols) break;
    if (!symbol?.name || !symbol?.path) continue;
    const lines = linesOf(symbol.path);
    const start = Math.max(1, Number(symbol.line) || 1);
    const declaredEndLine = Number(symbol.endLine) || 0;
    const inferredEnd = declaredEndLine > start
      ? declaredEndLine
      : Math.min((nextStart.get(`${symbol.path}:${start}`) ?? Number.POSITIVE_INFINITY) - 1, lines ? lines.length : start);
    const declaredEnd = Math.max(start, Number.isFinite(inferredEnd) ? inferredEnd : start);
    const end = Math.min(declaredEnd, start + maxBodyLines);
    const body = lines ? lines.slice(start - 1, end).join("\n") : "";
    const tokens = bodyTokens(body);
    entries.push({
      name: String(symbol.name),
      kind: symbol.kind ?? "symbol",
      path: symbol.path,
      line: start,
      endLine: declaredEnd,
      container: symbol.container ?? null,
      tokenCount: tokens.length,
      fingerprint: tokens.length ? hash32(tokens.join(" ")) : 0,
      shingles: shingles(tokens),
      // Whether a body was actually available; a snapshot taken without source
      // can still detect moves and disappearances, just not renames or splits.
      bodied: Boolean(lines) && tokens.length > 0,
    });
  }

  const files = options.files?.length ? [...new Set(options.files)] : [...new Set(entries.map((entry) => entry.path))];
  // Whole-file digests, because not every anchor names a definition: a lesson
  // that says "start at the top of pyproject.toml" is a claim about a file, and
  // the only evidence that can confirm or refute it is the file's own content.
  const fileDigests = {};
  for (const [filePath, text] of Object.entries(sources ?? {})) {
    if (typeof text === "string") fileDigests[filePath] = hash32(text);
  }
  return {
    version: MIGRATION_VERSION,
    label: options.label ?? null,
    commit: options.commit ?? null,
    sourceVersion: options.sourceVersion ?? null,
    symbols: entries,
    files,
    fileDigests,
    bodied: entries.some((entry) => entry.bodied),
  };
}

function indexSnapshot(snapshot) {
  const byPath = new Map();
  const byName = new Map();
  for (const symbol of snapshot?.symbols ?? []) {
    if (!byPath.has(symbol.path)) byPath.set(symbol.path, []);
    byPath.get(symbol.path).push(symbol);
    if (!byName.has(symbol.name)) byName.set(symbol.name, []);
    byName.get(symbol.name).push(symbol);
  }
  return {
    byPath,
    byName,
    files: new Set(snapshot?.files ?? []),
    digests: new Map(Object.entries(snapshot?.fileDigests ?? {})),
    symbols: snapshot?.symbols ?? [],
  };
}

/**
 * Every place a course points at source.
 *
 * Lesson `anchors` are the obvious ones, but a diagram node, a timeline step,
 * and a call-chain step are all clickable anchors too. Migrating only the
 * lesson list would leave a lesson whose header opens the right code and whose
 * diagram opens the wrong code, which is worse than either.
 */
export function courseAnchorSites(course) {
  const sites = [];
  for (const module of course?.modules ?? []) {
    for (const lesson of module.lessons ?? []) {
      (lesson.anchors ?? []).forEach((anchor, index) => {
        if (anchor?.path) sites.push({ moduleId: module.id, lessonId: lesson.id, lessonTitle: lesson.title ?? lesson.id, site: "lesson", blockId: null, index, anchor });
      });
      for (const block of lesson.content ?? []) {
        const carriers = block.type === "diagram" ? block.nodes ?? []
          : block.type === "timeline" || block.type === "callchain" ? block.steps ?? []
            : [];
        carriers.forEach((carrier, index) => {
          if (carrier?.anchor?.path) {
            sites.push({ moduleId: module.id, lessonId: lesson.id, lessonTitle: lesson.title ?? lesson.id, site: block.type, blockId: block.id, index, anchor: carrier.anchor });
          }
        });
      }
    }
  }
  return sites;
}

/**
 * Rewrite a course's anchors through a callback keyed by site identity.
 *
 * Returning `null` removes the anchor: a lesson anchor is dropped from the
 * list, while a diagram node or timeline step *keeps its label* and loses only
 * its link, because deleting the node would silently change the diagram.
 */
export function rewriteCourseAnchors(course, rewrite) {
  return {
    ...course,
    modules: (course?.modules ?? []).map((module) => ({
      ...module,
      lessons: (module.lessons ?? []).map((lesson) => {
        const anchors = [];
        // A split can add a part that another operation already re-pointed to,
        // so the list is de-duplicated as it is built rather than shipping a
        // lesson that opens the same code twice.
        const seen = new Set();
        const keep = (anchor) => {
          const key = `${anchor.path}:${anchor.line}:${anchor.symbol ?? ""}`;
          if (seen.has(key)) return;
          seen.add(key);
          anchors.push(anchor);
        };
        (lesson.anchors ?? []).forEach((anchor, index) => {
          if (!anchor?.path) { anchors.push(anchor); return; }
          const next = rewrite({ lessonId: lesson.id, site: "lesson", blockId: null, index, anchor });
          if (Array.isArray(next)) next.filter(Boolean).forEach(keep);
          else if (next) keep(next);
        });
        const content = (lesson.content ?? []).map((block) => {
          if (block.type === "diagram") {
            return {
              ...block,
              nodes: (block.nodes ?? []).map((node, index) => {
                if (!node?.anchor?.path) return node;
                const next = rewrite({ lessonId: lesson.id, site: "diagram", blockId: block.id, index, anchor: node.anchor });
                const chosen = Array.isArray(next) ? next[0] ?? null : next;
                return chosen ? { ...node, anchor: chosen } : { ...node, anchor: undefined };
              }),
            };
          }
          if (block.type === "timeline" || block.type === "callchain") {
            return {
              ...block,
              steps: (block.steps ?? []).map((step, index) => {
                if (!step?.anchor?.path) return step;
                const next = rewrite({ lessonId: lesson.id, site: block.type, blockId: block.id, index, anchor: step.anchor });
                const chosen = Array.isArray(next) ? next[0] ?? null : next;
                return chosen ? { ...step, anchor: chosen } : { ...step, anchor: undefined };
              }),
            };
          }
          return block;
        });
        return lesson.content ? { ...lesson, anchors, content } : { ...lesson, anchors };
      }),
    })),
  };
}

/** The definition an anchor was pointing at, in the version it was written for. */
function locateOriginal(before, anchor) {
  const candidates = before.byPath.get(anchor.path) ?? [];
  if (anchor.symbol) {
    const named = candidates.filter((symbol) => symbol.name === anchor.symbol);
    if (named.length === 1) return named[0];
    if (named.length > 1) {
      return named.reduce((best, symbol) => (Math.abs(symbol.line - anchor.line) < Math.abs(best.line - anchor.line) ? symbol : best));
    }
  }
  // An anchor with no symbol name (a file-level "start here" anchor) is matched
  // by containment, which is the only claim it actually made.
  const containing = candidates.filter((symbol) => symbol.line <= anchor.line && anchor.line <= symbol.endLine);
  if (containing.length) {
    return containing.reduce((best, symbol) => (symbol.endLine - symbol.line < best.endLine - best.line ? symbol : best));
  }
  return null;
}

function rank(candidates, original) {
  return candidates
    .map((candidate) => ({ candidate, similarity: original?.bodied && candidate.bodied ? jaccard(original.shingles, candidate.shingles) : 0 }))
    .sort((left, right) => right.similarity - left.similarity || left.candidate.line - right.candidate.line);
}

const symbolKey = (symbol) => `${symbol.path}:${symbol.line}:${symbol.name}`;

/**
 * Definitions that are new in `after`, with the old definition each one most
 * plausibly succeeds.
 *
 * The claim step exists because of a false positive found in testing: when
 * `finish_batch` was renamed to `postprocess` and, separately, `run_batch` had
 * a helper extracted, `postprocess` scored high enough against `run_batch`'s
 * body — both loop over `zip(...)` and append tokens — to be reported as one of
 * `run_batch`'s split parts. A newcomer that is clearly *another* definition's
 * successor cannot also be a fragment of this one, so it is claimed once,
 * globally, before any anchor is classified.
 */
function newcomerClaims(before, after, thresholds) {
  if (after.claims) return after.claims;
  const fresh = after.symbols.filter((symbol) => !(before.byName.get(symbol.name) ?? []).length);
  const claims = new Map();
  for (const symbol of fresh) {
    let bestOriginal = null;
    let bestSimilarity = 0;
    if (symbol.bodied) {
      for (const original of before.symbols) {
        if (!original.bodied) continue;
        // Only a *vanished* definition can have a successor; one that still
        // exists under its own name is not looking for a replacement.
        if ((after.byName.get(original.name) ?? []).length) continue;
        const similarity = jaccard(original.shingles, symbol.shingles);
        if (similarity > bestSimilarity) { bestSimilarity = similarity; bestOriginal = original; }
      }
    }
    claims.set(symbolKey(symbol), bestSimilarity >= thresholds.rename ? symbolKey(bestOriginal) : null);
  }
  after.claims = claims;
  after.fresh = fresh;
  return claims;
}

function newcomersFor(before, after, thresholds, original) {
  const claims = newcomerClaims(before, after, thresholds);
  const ownKey = original ? symbolKey(original) : null;
  return after.fresh.filter((symbol) => {
    const claimed = claims.get(symbolKey(symbol));
    return !claimed || claimed === ownKey;
  });
}

/**
 * Classify one anchor against the new snapshot.
 *
 * The order of the checks is the point. Identity is tried first so a symbol
 * that simply moved is never mistaken for a rename of something else; splits
 * are tried before "disappeared" so an extracted helper is reported as what it
 * is; and every branch that cannot be certain says so instead of guessing.
 */
export function classifyAnchor(anchor, before, after, options = {}) {
  const thresholds = { ...DEFAULT_MIGRATION_THRESHOLDS, ...(options.thresholds ?? {}) };
  const original = locateOriginal(before, anchor);
  const name = anchor.symbol ?? original?.name ?? null;
  const evidence = [];
  const fileKnown = after.files.size === 0 || after.files.has(anchor.path);
  // --- 0. A file-level anchor ----------------------------------------------
  // Found by running against real history: a course anchors "start here" at the
  // top of a README or a build file, where there is no definition to follow.
  // Treating that as a vanished symbol retired a perfectly good anchor and
  // orphaned four working lessons. A file anchor claims only that the file
  // exists, so only the file disappearing can refute it.
  if (!name) {
    const here = { path: anchor.path, line: anchor.line, name: anchor.symbol ?? null, kind: "file" };
    if (!fileKnown) {
      evidence.push(`${anchor.path} does not exist in the new version`);
      return { status: "file-removed", target: null, secondary: [], similarity: 0, coverage: 0, confidence: 0, evidence, original: null };
    }
    const wasDigest = before.digests.get(anchor.path);
    const isDigest = after.digests.get(anchor.path);
    if (wasDigest !== undefined && isDigest !== undefined && wasDigest !== isDigest) {
      evidence.push(`${anchor.path} still exists and this anchor names no definition, but the file's contents changed`);
      return { status: "edited", target: here, secondary: [], similarity: 0, coverage: 1, confidence: 1, evidence, original: null };
    }
    evidence.push(`${anchor.path} still exists and this anchor names no definition, so there is nothing to re-point`);
    return { status: "unchanged", target: here, secondary: [], similarity: 1, coverage: 1, confidence: 1, evidence, original: null };
  }
  if (!original) evidence.push(`no definition covering ${anchor.path}:${anchor.line} was recorded in the previous version`);

  // Whether the anchor's *line* was ever derived from this definition. A course
  // may deliberately anchor "open this file, the symbol of interest is X" at
  // line 1; following X down the file would then silently move an anchor the
  // author placed on purpose. Migration follows change — it does not re-decide
  // where a lesson should point.
  const anchorOnDefinition = Boolean(original) && original.line <= anchor.line && anchor.line <= original.endLine;

  // --- 1. The same name in the same file -----------------------------------
  const identity = name ? (after.byPath.get(anchor.path) ?? []).filter((symbol) => symbol.name === name) : [];
  if (identity.length) {
    const best = rank(identity, original)[0];
    const target = best.candidate;
    const similarity = best.similarity;
    const parts = original?.bodied
      ? newcomersFor(before, after, thresholds, original)
        .filter((symbol) => symbol.path === anchor.path || symbol.container === original.container)
        .map((symbol) => ({ symbol, share: coverage(original.shingles, [symbol.shingles]) }))
        .filter((entry) => entry.share >= thresholds.splitContribution)
        .sort((left, right) => right.share - left.share)
        .slice(0, 3)
      : [];
    // A definition that kept its name but shed a large, identifiable piece of
    // itself into a brand-new sibling is a split, not an edit.
    if (parts.length && similarity < thresholds.intact) {
      const covered = coverage(original.shingles, [target.shingles, ...parts.map((entry) => entry.symbol.shingles)]);
      evidence.push(`'${name}' kept its name but now shares its body with ${parts.map((entry) => `'${entry.symbol.name}' (${entry.share})`).join(", ")}`);
      evidence.push(`body similarity with the surviving definition is ${similarity}; together they account for ${covered} of the original`);
      return {
        status: "split", target, secondary: parts.map((entry) => entry.symbol), similarity, coverage: covered,
        confidence: Number((covered * 0.9).toFixed(4)), evidence, original,
      };
    }
    // Where the line is the author's choice rather than the definition's, only
    // report; do not move it. Running this against 400 commits of real history
    // caught the alternative: five anchors placed at line 1 were "repaired"
    // onto definitions further down, rewriting the course for no reason.
    if (!anchorOnDefinition) {
      const description = target.line === anchor.line ? "" : ` (the definition is at line ${target.line})`;
      if (original && original.fingerprint !== target.fingerprint) {
        evidence.push(`'${name}' still exists${description}, but its body changed (similarity ${similarity}); the anchor's line was not derived from it, so it is left where the author put it`);
        return { status: "edited", target: { ...target, line: anchor.line }, secondary: [], similarity, coverage: 1, confidence: 1, evidence, original };
      }
      evidence.push(`'${name}' is unchanged${description}, and this anchor's line was not derived from it`);
      return { status: "unchanged", target: { ...target, line: anchor.line }, secondary: [], similarity: 1, coverage: 1, confidence: 1, evidence, original };
    }
    if (target.line !== anchor.line) {
      evidence.push(`'${name}' kept its name and file and moved from line ${anchor.line} to line ${target.line}`);
      if (original?.bodied) evidence.push(`body similarity ${similarity}`);
      return { status: "moved", target, secondary: [], similarity, coverage: 1, confidence: 1, evidence, original };
    }
    if (original && original.fingerprint !== target.fingerprint) {
      evidence.push(`'${name}' is still at ${anchor.path}:${anchor.line} but its body changed (similarity ${similarity})`);
      return { status: "edited", target, secondary: [], similarity, coverage: 1, confidence: 1, evidence, original };
    }
    evidence.push(`'${name}' is unchanged at ${anchor.path}:${anchor.line}`);
    return { status: "unchanged", target, secondary: [], similarity: 1, coverage: 1, confidence: 1, evidence, original };
  }

  // --- 2. The same name somewhere else -------------------------------------
  const elsewhere = name ? (after.byName.get(name) ?? []) : [];
  if (elsewhere.length) {
    const ranked = rank(elsewhere, original);
    const best = ranked[0];
    const runnerUp = ranked[1]?.similarity ?? 0;
    const decided = ranked.length === 1 || best.similarity - runnerUp >= thresholds.margin;
    evidence.push(`'${name}' is no longer defined in ${anchor.path}; ${elsewhere.length} definition(s) of that name exist elsewhere`);
    if (!decided) {
      evidence.push(`the best candidate ${best.candidate.path}:${best.candidate.line} (${best.similarity}) does not clearly beat ${ranked[1].candidate.path}:${ranked[1].candidate.line} (${runnerUp})`);
      return { status: "ambiguous", target: best.candidate, secondary: ranked.slice(1, 3).map((entry) => entry.candidate), similarity: best.similarity, coverage: 0, confidence: Number((best.similarity * 0.5).toFixed(4)), evidence, original };
    }
    evidence.push(`the definition now lives at ${best.candidate.path}:${best.candidate.line}${original?.bodied ? ` with body similarity ${best.similarity}` : " (matched by name; no body was available to compare)"}`);
    const confidence = original?.bodied && best.candidate.bodied ? Number((0.6 + 0.4 * best.similarity).toFixed(4)) : 0.6;
    return { status: "moved-file", target: best.candidate, secondary: [], similarity: best.similarity, coverage: 1, confidence, evidence, original };
  }

  if (name) evidence.push(`'${name}' is not defined anywhere in the new version`);

  // --- 3. Renamed ----------------------------------------------------------
  if (original?.bodied) {
    const fresh = newcomersFor(before, after, thresholds, original);
    const ranked = rank(fresh, original).filter((entry) => entry.similarity >= thresholds.rename);
    if (ranked.length) {
      const best = ranked[0];
      const runnerUp = ranked[1]?.similarity ?? 0;
      if (ranked.length > 1 && best.similarity - runnerUp < thresholds.margin) {
        evidence.push(`two new definitions match the old body about equally: '${best.candidate.name}' (${best.similarity}) and '${ranked[1].candidate.name}' (${runnerUp})`);
        return { status: "ambiguous", target: best.candidate, secondary: ranked.slice(1, 3).map((entry) => entry.candidate), similarity: best.similarity, coverage: 0, confidence: Number((best.similarity * 0.5).toFixed(4)), evidence, original };
      }
      evidence.push(`'${best.candidate.name}' at ${best.candidate.path}:${best.candidate.line} is new and shares ${best.similarity} of the old body`);
      // A rename inside the same file updates the name the anchor carries; it
      // only moves the line if the line was on the definition to begin with.
      const renameTarget = !anchorOnDefinition && best.candidate.path === anchor.path
        ? { ...best.candidate, line: anchor.line }
        : best.candidate;
      return { status: "renamed", target: renameTarget, secondary: [], similarity: best.similarity, coverage: 1, confidence: best.similarity, evidence, original };
    }

    // --- 4. Split into several new definitions ------------------------------
    const contributions = fresh
      .map((symbol) => ({ symbol, share: coverage(original.shingles, [symbol.shingles]) }))
      .filter((entry) => entry.share >= thresholds.splitContribution)
      .sort((left, right) => right.share - left.share)
      .slice(0, 4);
    if (contributions.length >= 2) {
      const covered = coverage(original.shingles, contributions.map((entry) => entry.symbol.shingles));
      if (covered >= thresholds.split) {
        evidence.push(`the old body is now spread across ${contributions.map((entry) => `'${entry.symbol.name}' (${entry.share})`).join(", ")}, together accounting for ${covered}`);
        return {
          status: "split", target: contributions[0].symbol, secondary: contributions.slice(1).map((entry) => entry.symbol),
          similarity: contributions[0].share, coverage: covered, confidence: Number((covered * 0.9).toFixed(4)), evidence, original,
        };
      }
      evidence.push(`fragments of the old body survive in ${contributions.length} new definitions but only account for ${covered}`);
    }
  }

  // --- 5. Gone -------------------------------------------------------------
  if (!fileKnown) {
    evidence.push(`${anchor.path} does not exist in the new version`);
    return { status: "file-removed", target: null, secondary: [], similarity: 0, coverage: 0, confidence: 0, evidence, original };
  }
  // "The index never knew about it" is not "it was deleted". Found against real
  // history: an anchor naming a CUDA kernel that the C++ definition query does
  // not capture looked exactly like a deletion, and retiring it would have
  // thrown away a live anchor on the strength of an indexer gap.
  if (!(before.byName.get(name) ?? []).length) {
    evidence.push(`no definition named '${name}' was recorded in either version, so whether it was removed cannot be decided from the index`);
    return { status: "unverified", target: null, secondary: [], similarity: 0, coverage: 0, confidence: 0, evidence, original };
  }
  return { status: "disappeared", target: null, secondary: [], similarity: 0, coverage: 0, confidence: 0, evidence, original };
}

const AUTO_STATUSES = new Set(["unchanged", "edited", "moved", "moved-file", "renamed"]);

const LESSON_STATUS_RANK = { intact: 0, migrated: 1, "needs-review": 2, orphaned: 3 };

/**
 * Plan the migration of a whole course between two snapshots.
 *
 * Planning is separated from applying so the plan can be shown, argued with,
 * and partially accepted. An operation that rewrites a learner's course without
 * ever being visible is indistinguishable from a bug.
 */
export function planMigration(course, beforeSnapshot, afterSnapshot, options = {}) {
  const thresholds = { ...DEFAULT_MIGRATION_THRESHOLDS, ...(options.thresholds ?? {}) };
  const before = indexSnapshot(beforeSnapshot);
  const after = indexSnapshot(afterSnapshot);
  const sites = courseAnchorSites(course);

  const operations = sites.map((site, ordinal) => {
    const verdict = classifyAnchor(site.anchor, before, after, { thresholds });
    const target = verdict.target;
    const autoApply = AUTO_STATUSES.has(verdict.status) && verdict.confidence >= thresholds.auto;
    return {
      id: `op-${ordinal + 1}`,
      moduleId: site.moduleId,
      lessonId: site.lessonId,
      lessonTitle: site.lessonTitle,
      site: site.site,
      blockId: site.blockId,
      index: site.index,
      status: verdict.status,
      from: { path: site.anchor.path, line: site.anchor.line, symbol: site.anchor.symbol ?? null },
      to: target ? { path: target.path, line: target.line, symbol: target.name } : null,
      secondary: (verdict.secondary ?? []).map((symbol) => ({ path: symbol.path, line: symbol.line, symbol: symbol.name })),
      similarity: verdict.similarity,
      coverage: verdict.coverage,
      confidence: verdict.confidence,
      autoApply,
      requiresReview: !autoApply,
      changesAnchor: Boolean(target) && (target.path !== site.anchor.path || target.line !== site.anchor.line || target.name !== site.anchor.symbol),
      evidence: verdict.evidence,
    };
  });

  const counts = operations.reduce((totals, operation) => ({ ...totals, [operation.status]: (totals[operation.status] ?? 0) + 1 }), {});
  const lessons = [];
  const byLesson = new Map();
  for (const operation of operations) {
    if (!byLesson.has(operation.lessonId)) {
      const entry = { lessonId: operation.lessonId, moduleId: operation.moduleId, title: operation.lessonTitle, anchors: 0, dead: 0, review: 0, changed: 0, status: "intact" };
      byLesson.set(operation.lessonId, entry);
      lessons.push(entry);
    }
    const entry = byLesson.get(operation.lessonId);
    entry.anchors += 1;
    if (DEAD_STATUSES.has(operation.status)) entry.dead += 1;
    if (operation.requiresReview) entry.review += 1;
    if (operation.changesAnchor) entry.changed += 1;
  }
  for (const entry of lessons) {
    entry.status = entry.dead === entry.anchors ? "orphaned"
      : entry.review ? "needs-review"
        : entry.changed ? "migrated" : "intact";
  }

  const applicable = operations.filter((operation) => operation.autoApply && operation.changesAnchor).length;
  const review = operations.filter((operation) => operation.requiresReview).length;
  return {
    version: MIGRATION_VERSION,
    courseId: course?.id ?? null,
    from: { commit: beforeSnapshot?.commit ?? null, sourceVersion: beforeSnapshot?.sourceVersion ?? null, symbolCount: beforeSnapshot?.symbols?.length ?? 0, bodied: Boolean(beforeSnapshot?.bodied) },
    to: { commit: afterSnapshot?.commit ?? null, sourceVersion: afterSnapshot?.sourceVersion ?? null, symbolCount: afterSnapshot?.symbols?.length ?? 0, bodied: Boolean(afterSnapshot?.bodied) },
    thresholds,
    operations,
    counts,
    lessons: lessons.sort((left, right) => LESSON_STATUS_RANK[right.status] - LESSON_STATUS_RANK[left.status] || left.lessonId.localeCompare(right.lessonId)),
    totals: {
      anchors: operations.length,
      unchanged: counts.unchanged ?? 0,
      applicable,
      review,
      dead: operations.filter((operation) => DEAD_STATUSES.has(operation.status)).length,
      orphanedLessons: lessons.filter((entry) => entry.status === "orphaned").length,
    },
    // A snapshot without bodies can still see moves and disappearances; saying
    // so is better than reporting zero renames as if none had happened.
    limitation: beforeSnapshot?.bodied && afterSnapshot?.bodied
      ? null
      : "No source bodies were available for one of the versions, so renames and splits could not be detected — only moves and disappearances.",
  };
}

function noteFor(operation) {
  const where = `${operation.from.path}:${operation.from.line}${operation.from.symbol ? ` (${operation.from.symbol})` : ""}`;
  switch (operation.status) {
    case "renamed": return `${where} was renamed to '${operation.to.symbol}' — the lesson text still uses the old name.`;
    case "split": return `${where} was split across ${[operation.to, ...operation.secondary].map((entry) => `'${entry.symbol}'`).join(", ")} — decide which part this lesson is about.`;
    case "edited": return `${where} is in the same place but its body changed — check that the lesson still describes it.`;
    case "ambiguous": return `${where} has more than one equally good successor — pick one.`;
    case "file-removed": return `${where} was retired: the file no longer exists.`;
    case "disappeared": return `${where} was retired: the definition no longer exists.`;
    case "unverified": return `${where} names something the index did not record in either version — check it by hand rather than trusting this migration.`;
    // Every remaining status carries a successor; anything that does not is a
    // status this function has not been taught about, and saying so beats
    // crashing on a null or inventing a reassuring message.
    default: return operation.to
      ? `${where} moved to ${operation.to.path}:${operation.to.line}.`
      : `${where} could not be resolved (${operation.status}).`;
  }
}


/** Fields `applyMigration` may add to a lesson, and `revertMigration` must undo. */
const MIGRATION_LESSON_FIELDS = ["anchors", "reviewNotes", "retiredAnchors", "migrationStatus"];

function lessonFieldsBefore(lesson) {
  const before = {};
  for (const field of MIGRATION_LESSON_FIELDS) {
    if (Object.hasOwn(lesson, field)) before[field] = structuredClone(lesson[field]);
  }
  return before;
}

/**
 * Apply a plan to a course.
 *
 * `accept` is "auto" (only the operations the plan marked safe), "all", or an
 * explicit list of operation ids, because a reviewer who has looked at three
 * splits should be able to take two of them.
 *
 * Dead anchors are retired regardless of acceptance unless `retireMissing` is
 * turned off: an anchor that opens nothing is not a decision anyone needs to
 * confirm, and retiring preserves it on the lesson rather than deleting it.
 */
export function applyMigration(course, plan, options = {}) {
  const accept = options.accept ?? "auto";
  const retireMissing = options.retireMissing ?? true;
  const accepted = new Set(
    accept === "all" ? plan.operations.map((operation) => operation.id)
      : Array.isArray(accept) ? accept
        : plan.operations.filter((operation) => operation.autoApply).map((operation) => operation.id),
  );
  const siteKey = (site) => `${site.lessonId}|${site.site}|${site.blockId ?? ""}|${site.index}`;
  const bySite = new Map(plan.operations.map((operation) => [siteKey(operation), operation]));

  let repointed = 0;
  let retired = 0;
  let added = 0;
  const notesByLesson = new Map();
  const retiredByLesson = new Map();
  const touched = new Set();
  const addNote = (lessonId, note) => {
    touched.add(lessonId);
    if (!notesByLesson.has(lessonId)) notesByLesson.set(lessonId, []);
    if (!notesByLesson.get(lessonId).includes(note)) notesByLesson.get(lessonId).push(note);
  };

  // Captured before anything is rewritten so a revert restores the exact prior
  // state rather than a reconstruction of it.
  const lessonsBefore = [];
  for (const module of course?.modules ?? []) {
    for (const lesson of module.lessons ?? []) lessonsBefore.push({ lessonId: lesson.id, fields: lessonFieldsBefore(lesson) });
  }
  const contentBefore = courseAnchorSites(course)
    .filter((site) => site.site !== "lesson")
    .map((site) => ({ key: siteKey(site), anchor: { ...site.anchor } }));

  const migrated = rewriteCourseAnchors(course, (site) => {
    const operation = bySite.get(siteKey(site));
    if (!operation) return site.anchor;
    if (DEAD_STATUSES.has(operation.status)) {
      addNote(site.lessonId, noteFor(operation));
      if (!retireMissing) return site.anchor;
      retired += 1;
      if (!retiredByLesson.has(site.lessonId)) retiredByLesson.set(site.lessonId, []);
      retiredByLesson.get(site.lessonId).push({ ...site.anchor, reason: operation.status, evidence: operation.evidence.slice(0, 2) });
      return null;
    }
    if (!accepted.has(operation.id)) {
      if (operation.requiresReview) addNote(site.lessonId, noteFor(operation));
      return site.anchor;
    }
    if (operation.status === "unchanged") return site.anchor;
    if (operation.status === "edited") { addNote(site.lessonId, noteFor(operation)); return site.anchor; }
    if (!operation.to) return site.anchor;
    repointed += 1;
    touched.add(site.lessonId);
    if (operation.requiresReview) addNote(site.lessonId, noteFor(operation));
    const next = { path: operation.to.path, line: operation.to.line, symbol: operation.to.symbol };
    if (operation.status === "split" && site.site === "lesson" && operation.secondary.length) {
      added += operation.secondary.length;
      // Only a lesson's own anchor list gains the extra parts: a diagram node is
      // one box on a picture and cannot honestly point at two places.
      return [next, ...operation.secondary.map((entry) => ({ path: entry.path, line: entry.line, symbol: entry.symbol }))];
    }
    return next;
  });

  const record = {
    id: `mig-${(plan.from.commit ?? plan.from.sourceVersion ?? "unknown").slice(0, 12)}-${(plan.to.commit ?? plan.to.sourceVersion ?? "unknown").slice(0, 12)}`,
    version: MIGRATION_VERSION,
    at: options.now ?? new Date().toISOString(),
    from: plan.from,
    to: plan.to,
    accept: Array.isArray(accept) ? [...accept] : accept,
    acceptedIds: [...accepted],
    counts: plan.counts,
    repointed,
    retired,
    added,
    skipped: plan.operations.filter((operation) => !accepted.has(operation.id) && !DEAD_STATUSES.has(operation.status)).length,
    // Exactly what to put back, captured before the rewrite.
    undo: { lessons: lessonsBefore, content: contentBefore, previousSourceCommit: course?.sourceCommit ?? null, previousSourceVersion: course?.sourceVersion ?? null },
  };

  const result = {
    ...migrated,
    sourceCommit: plan.to.commit ?? course?.sourceCommit ?? null,
    sourceVersion: plan.to.sourceVersion ?? course?.sourceVersion ?? null,
    migrations: [...(course?.migrations ?? []), record],
    modules: migrated.modules.map((module) => ({
      ...module,
      lessons: module.lessons.map((lesson) => {
        const notes = notesByLesson.get(lesson.id) ?? [];
        const retiredAnchors = retiredByLesson.get(lesson.id) ?? [];
        if (!notes.length && !retiredAnchors.length && !touched.has(lesson.id)) return lesson;
        const summary = plan.lessons.find((entry) => entry.lessonId === lesson.id);
        return {
          ...lesson,
          ...(notes.length ? { reviewNotes: notes } : {}),
          ...(retiredAnchors.length ? { retiredAnchors: [...(lesson.retiredAnchors ?? []), ...retiredAnchors] } : {}),
          // A lesson with no anchors left is flagged, never deleted: the author
          // wrote it, and only the author can decide what replaces it.
          migrationStatus: (lesson.anchors ?? []).length === 0 ? "orphaned" : notes.length ? "needs-review" : (summary?.status ?? "migrated"),
        };
      }),
    })),
  };

  return {
    course: result,
    migration: record,
    applied: repointed,
    retired,
    added,
    skipped: record.skipped,
    orphaned: result.modules.flatMap((module) => module.lessons).filter((lesson) => lesson.migrationStatus === "orphaned").length,
    // Operations still awaiting a decision. A retired dead anchor is *not* one
    // of them: it was acted on, and the attention its lesson now needs is
    // carried by the lesson's status and notes rather than counted twice.
    reviewRequired: plan.operations.filter((operation) => operation.requiresReview
      && !accepted.has(operation.id)
      && !(retireMissing && DEAD_STATUSES.has(operation.status))).length,
  };
}

/**
 * Undo a migration exactly.
 *
 * Reversibility is what makes automatic re-pointing acceptable at all: if the
 * matcher is wrong, the cost of being wrong must be one click, not a rebuilt
 * course. The restore uses the fields captured before the rewrite rather than
 * inverting each operation, because inverting a split — one anchor became
 * three — cannot be done reliably from the operation alone.
 */
export function revertMigration(course, migrationId = null) {
  const history = course?.migrations ?? [];
  const record = migrationId ? history.find((entry) => entry.id === migrationId) : history.at(-1);
  if (!record) return { course, reverted: false, reason: "This course carries no migration to revert." };

  const fieldsByLesson = new Map((record.undo?.lessons ?? []).map((entry) => [entry.lessonId, entry.fields]));
  const anchorByKey = new Map((record.undo?.content ?? []).map((entry) => [entry.key, entry.anchor]));

  let restored = 0;
  const restore = {
    ...course,
    sourceCommit: record.undo?.previousSourceCommit ?? course?.sourceCommit ?? null,
    sourceVersion: record.undo?.previousSourceVersion ?? course?.sourceVersion ?? null,
    migrations: history.filter((entry) => entry.id !== record.id),
    modules: (course.modules ?? []).map((module) => ({
      ...module,
      lessons: (module.lessons ?? []).map((lesson) => {
        const before = fieldsByLesson.get(lesson.id);
        const content = (lesson.content ?? []).map((block) => {
          const carrierKey = (index) => `${lesson.id}|${block.type}|${block.id ?? ""}|${index}`;
          if (block.type === "diagram") {
            return { ...block, nodes: (block.nodes ?? []).map((node, index) => {
              const anchor = anchorByKey.get(carrierKey(index));
              if (!anchor) return node;
              restored += 1;
              return { ...node, anchor };
            }) };
          }
          if (block.type === "timeline" || block.type === "callchain") {
            return { ...block, steps: (block.steps ?? []).map((step, index) => {
              const anchor = anchorByKey.get(carrierKey(index));
              if (!anchor) return step;
              restored += 1;
              return { ...step, anchor };
            }) };
          }
          return block;
        });
        const next = { ...lesson };
        if (before) {
          for (const field of MIGRATION_LESSON_FIELDS) {
            if (Object.hasOwn(before, field)) next[field] = structuredClone(before[field]);
            else delete next[field];
          }
          restored += 1;
        }
        return lesson.content ? { ...next, content } : next;
      }),
    })),
  };

  return { course: restore, reverted: true, migrationId: record.id, restored };
}
