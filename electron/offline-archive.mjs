import { hash32 } from "./hashing.mjs";
import { redactValue } from "./secret-scanner.mjs";

/**
 * Offline export and import of everything a learner owns.
 *
 * Item 44 packages a *course* to give to somebody else. This is the other
 * direction and a different problem: it is the learner's own work — what they
 * have mastered, what is due for review, what they wrote down — and the point
 * of moving it is to keep studying somewhere the repository is not.
 *
 * That last clause is the whole design. A course anchored at `path:line` is
 * useless on a plane, so an archive that only carries anchors is not offline at
 * all; it is a promise to be useful later. So the archive carries **verified
 * source excerpts**: the lines each anchor points at, each with a digest over
 * the excerpt text itself. The digest does two separate jobs, and keeping them
 * separate is what makes the verdicts meaningful:
 *
 *   - Without the repository, the digest proves the excerpt is the text that
 *     was exported and not something edited into the file afterwards. An
 *     archive is a plain JSON file that anybody can open.
 *   - With the repository, the excerpt is compared against the source as it is
 *     *now*, so `current` and `drifted` are distinguishable — the learner is
 *     told which of their excerpts the code has moved on from rather than being
 *     quietly shown stale code as if it were live.
 *
 * The second design rule is that **importing cannot lose work**. Someone who
 * exports on a laptop, studies on a desktop, and then imports the laptop's
 * archive has two divergent histories, and the tempting resolutions — newest
 * wins, imported wins — both silently throw away real reviews and real notes.
 * Evidence and review history are *events*, so they merge by union and mastery
 * is recomputed rather than picked; notes with the same id and different text
 * are both kept and the collision is reported. Nothing is overwritten, and
 * anything the merge could not decide is stated instead of resolved.
 *
 * Node-free so the main process, the browser demo, and the tests all run the
 * same code.
 */

export const ARCHIVE_FORMAT = "trace-archive-v1";
export const ARCHIVE_VERSION = 1;

export const DEFAULT_ARCHIVE_LIMITS = {
  /** Excerpts are the bulk of an archive; enough for a whole course, not a whole repository. */
  maxExcerpts: 400,
  maxExcerptChars: 4_000,
  /** Lines either side of the anchor, so an excerpt is readable on its own. */
  contextLines: 18,
  maxNotes: 500,
  maxNoteChars: 8_000,
  maxMemories: 200,
};

/** A stable digest over text, used only to compare an excerpt with itself or with source. */
export function digestOfText(text) {
  return `h32:${hash32(String(text ?? "")).toString(16).padStart(8, "0")}`;
}

/**
 * Canonical JSON: keys sorted recursively so a checksum survives a round trip
 * through JSON and an IPC structured clone. Array order is preserved, because
 * for anchors and evidence the order is part of the meaning.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Read the lines around an anchor.
 *
 * The excerpt is a window rather than the exact symbol body because an archive
 * is read *without* the repository: a reader who cannot scroll needs the lines
 * either side to make sense of the ones in the middle.
 */
export function excerptAround(sourceText, anchor, options = {}) {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...(options.limits ?? {}) };
  if (typeof sourceText !== "string") return null;
  const lines = sourceText.split("\n");
  const anchored = Math.min(Math.max(1, Number(anchor?.line) || 1), lines.length);
  const startLine = Math.max(1, anchored - limits.contextLines);
  const endLine = Math.min(lines.length, anchored + limits.contextLines);
  let text = lines.slice(startLine - 1, endLine).join("\n");
  const truncated = text.length > limits.maxExcerptChars;
  if (truncated) text = text.slice(0, limits.maxExcerptChars);
  return {
    path: anchor.path,
    line: anchored,
    startLine,
    endLine,
    text,
    truncated,
    digest: digestOfText(text),
    // The whole-file digest is what makes "the file changed" answerable when
    // the excerpt window happens to be untouched.
    fileDigest: digestOfText(sourceText),
  };
}

function courseAnchors(course) {
  const anchors = [];
  const push = (anchor) => { if (anchor?.path && Number.isFinite(Number(anchor.line))) anchors.push({ path: anchor.path, line: Number(anchor.line), symbol: anchor.symbol ?? null }); };
  for (const module of course?.modules ?? []) {
    for (const lesson of module.lessons ?? []) {
      (lesson.anchors ?? []).forEach(push);
      for (const block of lesson.content ?? []) {
        if (block.type === "diagram") (block.nodes ?? []).forEach((node) => push(node.anchor));
        if (block.type === "timeline" || block.type === "callchain") (block.steps ?? []).forEach((step) => push(step.anchor));
      }
    }
  }
  return anchors;
}

function normalizeNote(note, limits) {
  if (!note?.id || typeof note.text !== "string") return null;
  return {
    id: String(note.id).slice(0, 120),
    lessonId: note.lessonId ? String(note.lessonId).slice(0, 120) : null,
    anchor: note.anchor?.path ? { path: note.anchor.path, line: Number(note.anchor.line) || 1, symbol: note.anchor.symbol ?? null } : null,
    text: note.text.slice(0, limits.maxNoteChars),
    createdAt: note.createdAt ?? null,
    updatedAt: note.updatedAt ?? note.createdAt ?? null,
  };
}

/**
 * Build the archive.
 *
 * Every part is optional and its absence is *recorded* rather than implied: an
 * archive that could not read the source is still a valid archive, but it says
 * it is not readable offline instead of looking complete.
 */
export function buildArchive(input = {}) {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...(input.limits ?? {}) };
  const { repository, course, skillGraph, learnerState, sources } = input;
  const anchors = courseAnchors(course);
  const unique = [];
  const seen = new Set();
  for (const anchor of anchors) {
    const key = `${anchor.path}:${anchor.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(anchor);
  }

  const excerpts = [];
  const missing = [];
  const truncatedBy = [];
  for (const anchor of unique) {
    if (excerpts.length >= limits.maxExcerpts) { truncatedBy.push({ limit: "maxExcerpts", value: limits.maxExcerpts, skipped: unique.length - excerpts.length }); break; }
    const excerpt = excerptAround(sources?.[anchor.path], anchor, { limits });
    if (!excerpt) { missing.push({ path: anchor.path, line: anchor.line, reason: "source-not-available" }); continue; }
    const file = (repository?.files ?? []).find((candidate) => candidate.path === anchor.path);
    excerpts.push({ ...excerpt, symbol: anchor.symbol ?? null, blobId: file?.blobId ?? null, language: file?.language ?? null });
  }

  const notes = (input.notes ?? [])
    .map((note) => normalizeNote(note, limits))
    .filter(Boolean)
    .slice(0, limits.maxNotes);
  if ((input.notes ?? []).length > notes.length) truncatedBy.push({ limit: "maxNotes", value: limits.maxNotes, skipped: input.notes.length - notes.length });

  const progress = learnerState
    ? {
      repositoryId: learnerState.repositoryId ?? repository?.id ?? null,
      sourceVersion: learnerState.sourceVersion ?? null,
      diagnosticCompleted: Boolean(learnerState.diagnosticCompleted),
      mastery: learnerState.mastery ?? {},
      memory: (learnerState.memory ?? []).slice(-limits.maxMemories),
      updatedAt: learnerState.updatedAt ?? null,
    }
    : null;

  const payload = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: input.now ?? new Date().toISOString(),
    provenance: {
      repositoryId: repository?.id ?? null,
      repositoryName: repository?.name ?? null,
      commit: repository?.head ?? null,
      sourceVersion: repository?.versionId ?? null,
      exportedBy: input.exportedBy ?? "trace",
    },
    content: {
      course: course ?? null,
      skillGraph: skillGraph ?? null,
      progress,
      notes,
      excerpts,
    },
    completeness: {
      anchors: unique.length,
      excerpted: excerpts.length,
      missing,
      notes: notes.length,
      skills: Object.keys(progress?.mastery ?? {}).length,
      reviews: Object.values(progress?.mastery ?? {}).filter((entry) => entry?.review?.reviews).length,
      memories: progress?.memory?.length ?? 0,
      truncated: truncatedBy,
      // The claim the archive is actually making: this can be studied with no
      // repository present.
      offlineReadable: unique.length > 0 && excerpts.length === unique.length,
    },
  };
  // Notes are learner prose and can quote a token out of a config file, so the
  // whole archive is redacted before its checksum is taken — never after, or the
  // checksum would certify text the archive does not contain.
  const redacted = redactValue(payload);
  return { ...redacted, checksum: digestOfText(canonicalJson(redacted)) };
}

/**
 * Check an archive, with or without the repository it came from.
 *
 * Three verdicts are kept apart on purpose. `unreadable` means this build
 * cannot open it. `altered` means the bytes changed after export, which is a
 * statement about the file. `drifted` means the source moved on, which is a
 * statement about the repository — and only the last of those is normal.
 */
export function verifyArchive(archive, options = {}) {
  if (archive?.format !== ARCHIVE_FORMAT) {
    return { readable: false, verdict: "unreadable", reason: `Not a Trace archive (${archive?.format ?? "no format"}).`, problems: ["format"] };
  }
  if (Number(archive.version) > ARCHIVE_VERSION) {
    return { readable: false, verdict: "unreadable", reason: `Archive version ${archive.version} is newer than this build understands (${ARCHIVE_VERSION}).`, problems: ["version"] };
  }

  const problems = [];
  // Both the checksum and the seal are attached *after* the archive is built,
  // so neither can be inside the bytes they certify. Item 45 shipped exactly
  // this bug once — the anchor seal was included in the package it signed, so
  // every package failed its own verification — and the shape is identical here.
  const { checksum, signature, ...payload } = archive;
  void signature;
  const recomputed = digestOfText(canonicalJson(payload));
  const checksumOk = checksum === recomputed;
  if (!checksumOk) problems.push("The archive's checksum does not match its contents; it was edited after export.");

  const excerpts = archive.content?.excerpts ?? [];
  const altered = excerpts.filter((excerpt) => excerpt.digest !== digestOfText(excerpt.text));
  if (altered.length) problems.push(`${altered.length} excerpt(s) do not match their own digest.`);

  // Against the repository, if it is here.
  const sources = options.sources ?? null;
  const counts = { current: 0, drifted: 0, absent: 0, unchecked: 0 };
  const results = excerpts.map((excerpt) => {
    if (!sources) { counts.unchecked += 1; return { path: excerpt.path, line: excerpt.line, status: "unchecked" }; }
    const source = sources[excerpt.path];
    if (typeof source !== "string") { counts.absent += 1; return { path: excerpt.path, line: excerpt.line, status: "absent" }; }
    // The stored line range is re-read exactly rather than re-derived from the
    // anchor: near the top of a file the window is clamped, so recomputing it
    // produces a shorter span and reports every such excerpt as drifted.
    const current = source.split("\n").slice(excerpt.startLine - 1, excerpt.endLine).join("\n");
    const same = (excerpt.truncated ? current.slice(0, excerpt.text.length) : current) === excerpt.text;
    if (same) { counts.current += 1; return { path: excerpt.path, line: excerpt.line, status: "current" }; }
    counts.drifted += 1;
    return { path: excerpt.path, line: excerpt.line, status: "drifted" };
  });
  if (counts.absent) problems.push(`${counts.absent} excerpt(s) point at files this repository does not have.`);
  if (counts.drifted) problems.push(`${counts.drifted} excerpt(s) no longer match the current source.`);

  const intact = checksumOk && altered.length === 0;
  const verdict = !intact ? "altered" : counts.drifted || counts.absent ? "drifted" : "intact";
  return {
    readable: true,
    verdict,
    intact,
    checksumOk,
    alteredExcerpts: altered.length,
    // Restated from the archive but re-derived, so a hand-edited claim of
    // completeness does not survive verification.
    offlineReadable: excerpts.length > 0 && excerpts.length === (archive.completeness?.anchors ?? 0),
    excerpts: { total: excerpts.length, counts, results },
    provenance: archive.provenance ?? null,
    contents: archive.completeness ?? null,
    problems,
    reason: null,
  };
}

const evidenceKey = (entry) => entry?.id ?? `${entry?.skillId}|${entry?.kind}|${entry?.createdAt}|${entry?.detail}`;

/** Later of two ISO timestamps; `null` sorts earliest. */
function laterOf(left, right) {
  if (!left) return right ?? null;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

/**
 * Merge two divergent progress records without losing either.
 *
 * Evidence is an append-only log, so the union is the honest answer and mastery
 * is *recomputed* from it rather than chosen between two numbers. Review
 * scheduling is genuinely a single current state — you cannot be two intervals
 * into the same card — so the later review wins and the collision is reported
 * rather than hidden.
 */
export function mergeProgress(local, imported, options = {}) {
  const conflicts = [];
  const skills = new Set([...Object.keys(local?.mastery ?? {}), ...Object.keys(imported?.mastery ?? {})]);
  const mastery = {};
  let gainedEvidence = 0;

  for (const skillId of skills) {
    const here = local?.mastery?.[skillId] ?? null;
    const there = imported?.mastery?.[skillId] ?? null;
    if (!here) { mastery[skillId] = there; gainedEvidence += (there?.evidence ?? []).length; continue; }
    if (!there) { mastery[skillId] = here; continue; }

    const byKey = new Map((here.evidence ?? []).map((entry) => [evidenceKey(entry), entry]));
    let added = 0;
    for (const entry of there.evidence ?? []) {
      const key = evidenceKey(entry);
      if (byKey.has(key)) continue;
      byKey.set(key, entry);
      added += 1;
    }
    gainedEvidence += added;
    const evidence = [...byKey.values()].sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")));

    const hereReview = here.review ?? null;
    const thereReview = there.review ?? null;
    let review = hereReview ?? thereReview ?? undefined;
    if (hereReview && thereReview) {
      const winner = laterOf(hereReview.lastReviewedAt, thereReview.lastReviewedAt);
      review = winner === thereReview.lastReviewedAt && winner !== hereReview.lastReviewedAt ? thereReview : hereReview;
      if (hereReview.lastReviewedAt !== thereReview.lastReviewedAt) {
        conflicts.push({
          kind: "review-schedule",
          skillId,
          detail: `both copies were reviewed (${hereReview.lastReviewedAt ?? "never"} here, ${thereReview.lastReviewedAt ?? "never"} imported); the later one was kept`,
          kept: winner,
        });
      }
      // Lapses and review counts are tallies of events, so the higher tally is
      // the one that saw more of them.
      review = { ...review, reviews: Math.max(hereReview.reviews ?? 0, thereReview.reviews ?? 0), lapses: Math.max(hereReview.lapses ?? 0, thereReview.lapses ?? 0) };
    }

    // Mastery follows the union of evidence, not a comparison of two numbers.
    const strongest = Math.max(here.mastery ?? 0, there.mastery ?? 0);
    const recomputed = evidence.length
      ? Math.min(1, Number(Math.max(strongest, evidence.reduce((sum, entry) => sum + (Number(entry.strength) || 0), 0) / Math.max(1, evidence.length)).toFixed(4)))
      : strongest;
    if (Math.abs((here.mastery ?? 0) - (there.mastery ?? 0)) > 0.2) {
      conflicts.push({ kind: "mastery", skillId, detail: `mastery differed by more than 0.2 (${here.mastery} here, ${there.mastery} imported); the union of evidence gives ${recomputed}`, kept: recomputed });
    }
    mastery[skillId] = {
      ...here,
      ...(review ? { review } : {}),
      evidence,
      mastery: recomputed,
      confidence: Math.max(here.confidence ?? 0, there.confidence ?? 0),
      status: here.status === "mastered" || there.status === "mastered" ? "mastered" : here.status ?? there.status,
    };
  }

  const memoryByKey = new Map((local?.memory ?? []).map((entry) => [entry.id ?? `${entry.createdAt}|${entry.text}`, entry]));
  let gainedMemories = 0;
  for (const entry of imported?.memory ?? []) {
    const key = entry.id ?? `${entry.createdAt}|${entry.text}`;
    if (memoryByKey.has(key)) continue;
    memoryByKey.set(key, entry);
    gainedMemories += 1;
  }

  return {
    state: {
      repositoryId: local?.repositoryId ?? imported?.repositoryId ?? null,
      sourceVersion: local?.sourceVersion ?? imported?.sourceVersion ?? null,
      diagnosticCompleted: Boolean(local?.diagnosticCompleted || imported?.diagnosticCompleted),
      mastery,
      memory: [...memoryByKey.values()].slice(-(options.maxMemories ?? DEFAULT_ARCHIVE_LIMITS.maxMemories)),
      updatedAt: laterOf(local?.updatedAt, imported?.updatedAt),
    },
    conflicts,
    gained: { evidence: gainedEvidence, memories: gainedMemories, skills: skills.size - Object.keys(local?.mastery ?? {}).length },
  };
}

/**
 * Merge notes without overwriting any.
 *
 * A note is somebody's writing. When the same id carries different text on the
 * two sides there is no way to tell which is the better one, so both are kept —
 * the imported copy under a suffixed id — and the collision is reported. The
 * alternative, keeping the newer, destroys work whose only copy was on the
 * other machine.
 */
export function mergeNotes(local = [], imported = [], options = {}) {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...(options.limits ?? {}) };
  const merged = new Map((local ?? []).map((note) => [note.id, note]));
  // Text, not id, decides whether a note is already here. Without this the fork
  // is not idempotent: importing the same archive twice forks the same note
  // again over its own copy, which is harmless but reports work that did not
  // happen — and a count nobody can trust is a count nobody reads.
  const present = new Set([...merged.values()].map((note) => note.text));
  const conflicts = [];
  let added = 0;
  let identical = 0;
  for (const raw of imported ?? []) {
    const note = normalizeNote(raw, limits);
    if (!note) continue;
    const here = merged.get(note.id);
    if (!here) { merged.set(note.id, note); present.add(note.text); added += 1; continue; }
    if (here.text === note.text || present.has(note.text)) { identical += 1; continue; }
    const forkedId = `${note.id}~imported`;
    merged.set(forkedId, { ...note, id: forkedId, forkedFrom: note.id });
    present.add(note.text);
    added += 1;
    conflicts.push({ kind: "note", noteId: note.id, detail: "the same note differs on both copies; the imported one was kept alongside it", kept: forkedId });
  }
  return { notes: [...merged.values()].slice(0, limits.maxNotes), conflicts, added, identical };
}

/**
 * Import an archive into whatever the learner already has here.
 *
 * `replace` exists for the first import onto a fresh machine, where merging
 * against nothing is just slower. It is never the default, because on a machine
 * with any history it is the one mode that can destroy work.
 */
export function importArchive(archive, options = {}) {
  const verification = verifyArchive(archive, { sources: options.sources ?? null });
  if (!verification.readable) return { imported: false, verification, reason: verification.reason };
  // An altered archive is refused rather than merged: unlike drift, it is not a
  // difference of version, it is evidence the file is not what was exported.
  if (!verification.intact && !options.force) {
    return { imported: false, verification, reason: "The archive was altered after export, so it was not imported." };
  }

  const mode = options.mode === "replace" ? "replace" : "merge";
  const importedProgress = archive.content?.progress ?? null;
  const importedNotes = archive.content?.notes ?? [];
  const progress = mode === "replace"
    ? { state: importedProgress, conflicts: [], gained: { evidence: 0, memories: 0, skills: 0 } }
    : mergeProgress(options.learnerState ?? null, importedProgress);
  const notes = mode === "replace"
    ? { notes: importedNotes, conflicts: [], added: importedNotes.length, identical: 0 }
    : mergeNotes(options.notes ?? [], importedNotes);

  return {
    imported: true,
    mode,
    verification,
    course: archive.content?.course ?? null,
    skillGraph: archive.content?.skillGraph ?? null,
    learnerState: progress.state,
    notes: notes.notes,
    excerpts: archive.content?.excerpts ?? [],
    merge: {
      conflicts: [...progress.conflicts, ...notes.conflicts],
      evidenceGained: progress.gained.evidence,
      memoriesGained: progress.gained.memories,
      notesAdded: notes.added,
      notesIdentical: notes.identical,
    },
    // Stated so a learner knows whether they can close the repository and keep
    // working, rather than finding out when an excerpt is blank.
    offlineReadable: verification.offlineReadable,
  };
}
