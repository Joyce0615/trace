/**
 * Explanation-to-source faithfulness checks (item 19).
 *
 * `evaluation.mjs`'s `evaluateLessons` already rejects a lesson anchor that
 * points at a file the repository does not contain, and `evaluateTutorAnswer`
 * already rejects a `path:line` citation outside the file it names. Both stop
 * one step short of what "faithful to the source" actually requires:
 *
 *   - **`evaluateLessons` checks the symbol's *name* is defined somewhere in
 *     the anchor's file — never the anchor's own `line`.** A lesson anchor
 *     claiming `doThing` is at line 10 scores `symbolAccuracy: 1` even when
 *     the repository's own index says `doThing` is really defined at line
 *     999, because `symbolIndex` is a `Set` of names per path, not a set of
 *     `(name, line)` pairs. A hallucinated or stale line passes silently.
 *     (Verified live: constructing exactly that mismatch and calling
 *     `evaluateLessons` returns `symbolAccuracy: 1`, not `0`.)
 *   - **`evaluateTutorAnswer` never checks a *relational* claim.** "`fetchUser`
 *     calls `validateToken`" is checkable against the repository's own
 *     resolved `callEdges` — and when no such edge exists (or a different,
 *     real edge contradicts it), that is exactly the class of fluent,
 *     plausible, ungrounded claim this item asks for. `evaluateTutorAnswer`
 *     scores only whether the two symbol *names* are individually known, not
 *     whether the relationship between them is real; the same fabricated
 *     claim above scores `grounding: 1`. (Verified live, same way.)
 *   - **Neither module ever abstains.** Every verdict in both scorecards is
 *     forced into "valid" or "invalid" even when there is not enough evidence
 *     to tell — a quiz claim about a function this repository's indexer
 *     could not parse (regex fallback, no `callEdges` at all) gets scored as
 *     if the claim were checked, when it never was.
 *
 * This module adds the missing third state everywhere `evaluation.mjs`
 * currently has only two. A claim about this repository is one of:
 *
 *   - **faithful** — checked against an exact `(path, line, symbol)` triple,
 *     a real resolved call/import edge, or a version-pinned snapshot, and it
 *     matched;
 *   - **unfaithful** — checked the same way, and it did not match (including a
 *     real edge that *contradicts* the claim, not just an absent one);
 *   - **abstain** — there was not enough retrieval evidence to check the claim
 *     at all (unresolved edge, unparsed file, version mismatch, or a claim
 *     with nothing to check against), which is reported honestly rather than
 *     folded into either "pass" or "fail".
 *
 * Every verdict carries the exact evidence that produced it (the symbol
 * record, the edge, or the reason retrieval could not reach a verdict) so a
 * caller can audit the check rather than trust it. This module is pure and
 * Node-free: it never spawns a model and never reads the filesystem, so the
 * browser demo and the tests run the identical checker the main process does.
 */

export const FAITHFULNESS_GUARD_VERSION = 1;

/** The three-state result every check in this module produces. */
export const Verdict = Object.freeze({ FAITHFUL: "faithful", UNFAITHFUL: "unfaithful", ABSTAIN: "abstain" });

function verdict(status, reason, evidence) {
  return { status, reason, evidence: evidence ?? null };
}

/**
 * Index the repository's own symbols by exact `(path, name)` so a claim can
 * be checked against the precise line the index recorded, not merely against
 * "a symbol with this name exists somewhere in this file".
 */
function symbolIndexByPathAndName(repository) {
  const index = new Map();
  for (const symbol of repository?.symbols ?? []) {
    const key = `${symbol.path}\u0000${symbol.name}`;
    if (!index.has(key)) index.set(key, symbol);
  }
  return index;
}

/**
 * Whether this repository's own index ever ran a real extractor over a file.
 * The regex fallback produces symbols with no call/import edges at all (see
 * `repository.mjs`'s `analyzeFile`); asking "does a real call edge exist"
 * about a file no real extractor ever touched is not a question this
 * repository's evidence can answer, so it is reported as `abstain`, not as
 * "no such edge" (which would read as a confident negative this index never
 * actually established).
 */
function hasStructuralEvidence(repository) {
  return Boolean((repository?.callEdges ?? []).length || (repository?.imports ?? []).length);
}

/**
 * Check one anchor (`{ path, line, symbol }`) against the exact symbol record
 * the index holds for that `(path, symbol)` pair.
 *
 * Unlike `evaluateLessons`'s `symbolAccuracy` (name-only), this checks the
 * anchor's own `line` against the symbol's recorded `line`, so a stale or
 * hallucinated line is caught even when the symbol name is real and really
 * defined somewhere in that file.
 */
export function verifyAnchorClaim(anchor, repository) {
  const files = new Set((repository?.files ?? []).map((file) => file.path));
  if (!anchor?.path) return verdict(Verdict.ABSTAIN, "The claim names no source file to check against.", null);
  if (!files.has(anchor.path)) return verdict(Verdict.UNFAITHFUL, `${anchor.path} is not a file in this repository.`, { path: anchor.path });
  if (!anchor.symbol) {
    // A file-only anchor (no symbol named) is faithful as soon as the file
    // exists; there is no symbol claim to check further.
    return verdict(Verdict.FAITHFUL, "The anchor names a real file and claims no specific symbol.", { path: anchor.path });
  }
  const symbolsByIndex = symbolIndexByPathAndName(repository);
  const exact = symbolsByIndex.get(`${anchor.path}\u0000${anchor.symbol}`);
  if (!exact) {
    const sameNameElsewhere = (repository?.symbols ?? []).filter((symbol) => symbol.name === anchor.symbol);
    if (!sameNameElsewhere.length) {
      return verdict(Verdict.UNFAITHFUL, `\`${anchor.symbol}\` is not a symbol this repository's index knows about.`, { symbol: anchor.symbol });
    }
    return verdict(
      Verdict.UNFAITHFUL,
      `\`${anchor.symbol}\` exists, but not in ${anchor.path} — this repository defines it in ${sameNameElsewhere.map((symbol) => symbol.path).join(", ")}.`,
      { symbol: anchor.symbol, actualPaths: sameNameElsewhere.map((symbol) => symbol.path) },
    );
  }
  if (Number.isFinite(anchor.line) && anchor.line !== exact.line) {
    return verdict(
      Verdict.UNFAITHFUL,
      `\`${anchor.symbol}\` is really defined at ${anchor.path}:${exact.line}, not line ${anchor.line} as the anchor claims.`,
      { claimedLine: anchor.line, actualLine: exact.line, symbol: anchor.symbol, path: anchor.path },
    );
  }
  return verdict(Verdict.FAITHFUL, `\`${anchor.symbol}\` is defined at ${anchor.path}:${exact.line}, exactly as claimed.`, { path: anchor.path, line: exact.line, symbol: anchor.symbol });
}

/**
 * Check a `{ path, line }` citation (no symbol attached — a prose reference to
 * a location, the shape `evaluateTutorAnswer`'s `CITATION` regex extracts)
 * against the repository's own file list and, when supplied, the file's line
 * count. Distinct from `verifyAnchorClaim`, which also checks a named symbol.
 */
export function verifyCitationClaim(citation, repository, lineCounts = {}) {
  const files = new Map((repository?.files ?? []).map((file) => [file.path, file]));
  if (!citation?.path) return verdict(Verdict.ABSTAIN, "The citation names no file.", null);
  const file = files.get(citation.path);
  if (!file) return verdict(Verdict.UNFAITHFUL, `${citation.path} is not a file in this repository.`, { path: citation.path });
  const knownLines = lineCounts[citation.path];
  if (knownLines === undefined) {
    // The file is real, but without a line count this module has no basis to
    // say the cited line is inside it or past the end — an honest abstain
    // rather than a pass that happened to not be checked.
    return verdict(Verdict.ABSTAIN, `The line count for ${citation.path} was not supplied, so the cited line cannot be checked.`, { path: citation.path });
  }
  if (!Number.isFinite(citation.line) || citation.line < 1 || citation.line > knownLines) {
    return verdict(Verdict.UNFAITHFUL, `${citation.path} has ${knownLines} lines; line ${citation.line} is out of range.`, { path: citation.path, line: citation.line, knownLines });
  }
  return verdict(Verdict.FAITHFUL, `${citation.path}:${citation.line} is inside the file.`, { path: citation.path, line: citation.line });
}

/**
 * Check a relational claim — "`caller` calls `callee`" — against this
 * repository's own resolved call edges.
 *
 * This is the check `evaluateTutorAnswer` never performs: it scores whether
 * each symbol name is individually known, never whether the claimed
 * relationship between them is real. Three outcomes, not two:
 *
 *   - a matching resolved edge exists: **faithful**;
 *   - this repository's index has structural evidence (real call edges) for
 *     the caller's file, the caller symbol is one this run actually
 *     extracted edges from, and no edge to that callee exists: **unfaithful**
 *     — this is a real negative, not an absence of evidence;
 *   - the index never extracted structural evidence for this file at all (the
 *     regex fallback, or the caller is simply not a symbol this index found
 *     an outgoing edge from): **abstain** — there is nothing to check this
 *     claim against, so no verdict is manufactured.
 */
export function verifyCallClaim(claim, repository) {
  const caller = claim?.caller ?? null;
  const callee = claim?.callee ?? null;
  if (!caller || !callee) return verdict(Verdict.ABSTAIN, "A call claim needs both a caller and a callee to check.", null);
  if (!hasStructuralEvidence(repository)) {
    return verdict(Verdict.ABSTAIN, "This repository's index recorded no call or import edges at all (likely the regex fallback), so there is no structural evidence to check a call claim against.", { caller, callee });
  }
  const edges = (repository?.callEdges ?? []).filter((edge) => edge.caller === caller);
  if (!edges.length) {
    // Edges exist elsewhere in the repository, but never originating from this
    // exact caller name — the index never recorded an outgoing edge for this
    // symbol at all (it may not even be a function, or it was never called
    // from any extracted site), so this specific claim was never evidenced.
    return verdict(Verdict.ABSTAIN, `This repository's index never recorded any outgoing call edge from \`${caller}\`, so this claim cannot be checked either way.`, { caller, callee });
  }
  const matching = edges.find((edge) => edge.callee === callee);
  if (!matching) {
    return verdict(
      Verdict.UNFAITHFUL,
      `\`${caller}\` really calls ${edges.map((edge) => `\`${edge.callee}\``).join(", ")} — never \`${callee}\`.`,
      { caller, callee, actualCallees: edges.map((edge) => edge.callee) },
    );
  }
  if (!matching.resolved) {
    return verdict(Verdict.ABSTAIN, `\`${caller}\` does reference \`${callee}\`, but the index could not resolve that edge to a real definition, so the relationship is unconfirmed.`, { caller, callee });
  }
  return verdict(Verdict.FAITHFUL, `\`${caller}\` really calls \`${callee}\`, resolved to ${matching.targetPath}:${matching.targetLine}.`, { caller, callee, targetPath: matching.targetPath, targetLine: matching.targetLine, resolutionKind: matching.resolutionKind ?? null });
}

/**
 * Check that a claim is being evaluated against the exact repository state it
 * was made about, mirroring `rag-eval.mjs`'s own `verifyFixedIngestionSnapshot`
 * discipline: a lesson/quiz/hint generated against one `versionId` and graded
 * against another is not evidence about the live repository at all, no matter
 * how its anchors read.
 */
export function verifyVersionPin(claimedVersion, repository) {
  const liveVersion = repository?.versionId ?? null;
  if (!claimedVersion || !liveVersion) {
    return verdict(Verdict.ABSTAIN, "No version was pinned to check the claim against.", { claimedVersion, liveVersion });
  }
  if (claimedVersion !== liveVersion) {
    return verdict(Verdict.UNFAITHFUL, `This claim was made about ${claimedVersion}, but the repository being checked is now ${liveVersion}.`, { claimedVersion, liveVersion });
  }
  return verdict(Verdict.FAITHFUL, "The claim is pinned to the exact repository state being checked.", { version: liveVersion });
}

function combineClaimVerdicts(verdicts) {
  if (!verdicts.length) return Verdict.ABSTAIN;
  if (verdicts.some((entry) => entry.status === Verdict.UNFAITHFUL)) return Verdict.UNFAITHFUL;
  if (verdicts.some((entry) => entry.status === Verdict.ABSTAIN)) return Verdict.ABSTAIN;
  return Verdict.FAITHFUL;
}

/**
 * Verify one lesson: its own anchors, every anchor inside its content blocks,
 * and the course's version pin against the live repository.
 *
 * A lesson is only `faithful` when every anchor it carries is faithful *and*
 * the course itself is pinned to the live repository state; one unfaithful
 * anchor fails the whole lesson (a course is read as a connected claim about
 * this repository, not a bag of independently-scored anchors), and any
 * abstain without an outright contradiction holds the lesson at `abstain`
 * rather than passing it by default.
 */
export function verifyLessonFaithfulness(lesson, course, repository) {
  const versionVerdict = verifyVersionPin(course?.sourceVersion, repository);
  const anchorClaims = [
    ...(lesson?.anchors ?? []).map((anchor) => verifyAnchorClaim(anchor, repository)),
    ...(lesson?.content ?? []).flatMap((block) => [
      ...(block.steps ?? []).map((step) => step.anchor).filter(Boolean),
      ...(block.nodes ?? []).map((node) => node.anchor).filter(Boolean),
    ]).map((anchor) => verifyAnchorClaim(anchor, repository)),
  ];
  const allVerdicts = [versionVerdict, ...anchorClaims];
  return {
    lessonId: lesson?.id ?? null,
    status: combineClaimVerdicts(allVerdicts),
    version: versionVerdict,
    anchors: anchorClaims,
    checked: anchorClaims.length,
    unfaithful: anchorClaims.filter((entry) => entry.status === Verdict.UNFAITHFUL).length,
    abstained: anchorClaims.filter((entry) => entry.status === Verdict.ABSTAIN).length,
  };
}

/**
 * Verify an answer's relational claims against the repository's real call
 * edges, complementing `evaluateTutorAnswer`'s citation/symbol checks (which
 * this module does not duplicate) with the one check that module has no
 * concept of: is the *relationship* between two named symbols real?
 *
 * `claims` is `[{ caller, callee }]`, typically produced by extracting
 * `` `a` calls `b` `` / `` `a` invokes `b` `` patterns from the answer text, or
 * supplied directly by a caller that already parsed the claim structurally
 * (e.g. from `explanation-grader.mjs`'s own `mentionedSymbols` output).
 */
export function verifyAnswerFaithfulness(claims, repository) {
  const checked = (claims ?? []).map((claim) => ({ claim, result: verifyCallClaim(claim, repository) }));
  return {
    status: combineClaimVerdicts(checked.map((entry) => entry.result)),
    claims: checked,
    checked: checked.length,
    unfaithful: checked.filter((entry) => entry.result.status === Verdict.UNFAITHFUL).length,
    abstained: checked.filter((entry) => entry.result.status === Verdict.ABSTAIN).length,
  };
}

/**
 * Extract `` `a` calls `b` `` / `` `a` invokes `b` `` relational claims out of
 * free text, the same back-quoted-identifier convention
 * `explanation-grader.mjs`'s `mentionedSymbols` already uses for an
 * unambiguous symbol reference. Intentionally narrow (two back-quoted names
 * joined by one of a short, explicit verb list) so this never invents a claim
 * prose did not actually make; text outside that shape produces no claim,
 * which is a sign to abstain rather than a sign nothing was said.
 */
const RELATION_VERBS = /\bcalls?\b|\binvokes?\b/i;
export function extractCallClaims(text) {
  const value = String(text ?? "");
  const claims = [];
  for (const match of value.matchAll(/`([A-Za-z_][\w$]*)`\s*([^`.;!?\n]{0,40})`([A-Za-z_][\w$]*)`/g)) {
    const [, caller, between, callee] = match;
    if (!RELATION_VERBS.test(between)) continue;
    claims.push({ caller, callee });
  }
  return claims;
}

/**
 * Verify a quiz claim: the localization exercise's gold file set
 * (`buildLocalizationExercise`'s own `goldFiles`/`definition` shape) or the
 * executable quiz's definition anchor, against the live repository.
 *
 * Both exercise kinds already compute their gold set from the repository at
 * build time, so this does not re-derive the gold answer — it re-checks that
 * the files the exercise still claims as gold are still real and that the
 * definition anchor is still exact, the same two things that can silently go
 * stale between when an exercise is built and when it is graded (a stale
 * cached exercise, or a repository that moved on since).
 */
export function verifyQuizFaithfulness(quiz, repository) {
  const files = new Set((repository?.files ?? []).map((file) => file.path));
  const goldFiles = Array.isArray(quiz?.goldFiles) ? quiz.goldFiles : [];
  const fileChecks = goldFiles.map((filePath) => (files.has(filePath)
    ? verdict(Verdict.FAITHFUL, `${filePath} is still a real file in this repository.`, { path: filePath })
    : verdict(Verdict.UNFAITHFUL, `${filePath} is claimed as gold but is no longer a file in this repository.`, { path: filePath })));
  const definitionVerdict = quiz?.definition ? verifyAnchorClaim(quiz.definition, repository) : verdict(Verdict.ABSTAIN, "The quiz carries no definition anchor to check.", null);
  const allVerdicts = [definitionVerdict, ...fileChecks];
  return {
    quizId: quiz?.id ?? null,
    status: combineClaimVerdicts(allVerdicts),
    definition: definitionVerdict,
    goldFiles: fileChecks,
    checked: fileChecks.length + 1,
    unfaithful: allVerdicts.filter((entry) => entry.status === Verdict.UNFAITHFUL).length,
    abstained: allVerdicts.filter((entry) => entry.status === Verdict.ABSTAIN).length,
  };
}

/**
 * Verify a hint's claims. `answer-guard.mjs`'s `buildScaffold` already
 * guarantees a rung never spells out the answer; this checks the separate,
 * unrelated property this item asks for: when a hint names a concrete source
 * location (an `anchorPath`/`entryPath`/`importSpecifier` field carried on the
 * hint context, or an embedded `path:line` in the hint's own text), that
 * location is real.
 */
const HINT_LOCATION_FIELDS = ["anchorPath", "entryPath"];
const HINT_CITATION = /\b([\w./-]+\.[A-Za-z]{1,6}):(\d+)\b/g;
export function verifyHintFaithfulness(hint, repository, lineCounts = {}) {
  const files = new Set((repository?.files ?? []).map((file) => file.path));
  const fieldChecks = HINT_LOCATION_FIELDS
    .filter((field) => typeof hint?.[field] === "string" && hint[field])
    .map((field) => (files.has(hint[field])
      ? verdict(Verdict.FAITHFUL, `${hint[field]} is a real file.`, { field, path: hint[field] })
      : verdict(Verdict.UNFAITHFUL, `${field} names ${hint[field]}, which is not a file in this repository.`, { field, path: hint[field] })));
  const text = typeof hint?.text === "string" ? hint.text : "";
  const citationChecks = [...text.matchAll(HINT_CITATION)].map((match) => verifyCitationClaim({ path: match[1], line: Number(match[2]) }, repository, lineCounts));
  const allVerdicts = [...fieldChecks, ...citationChecks];
  return {
    hintId: hint?.id ?? null,
    status: combineClaimVerdicts(allVerdicts),
    checks: allVerdicts,
    checked: allVerdicts.length,
    unfaithful: allVerdicts.filter((entry) => entry.status === Verdict.UNFAITHFUL).length,
    abstained: allVerdicts.filter((entry) => entry.status === Verdict.ABSTAIN).length,
  };
}

/**
 * Run every check in this module over a whole course plus a set of answers,
 * and report one combined verdict per claim family (lessons, quizzes, hints,
 * answers) — deliberately not merged into a single score, the same
 * `runEvaluation` discipline `evaluation.mjs` already states explicitly:
 * a course with faithful lessons and an answer that invents a call edge is
 * two different problems, and averaging them would hide both.
 */
export function verifyCourseFaithfulness({ course, repository, quizzes = [], hints = [], answers = [], lineCounts = {} } = {}) {
  const lessons = (course?.modules ?? []).flatMap((module) => module.lessons ?? []);
  const lessonResults = lessons.map((lesson) => verifyLessonFaithfulness(lesson, course, repository));
  const quizResults = quizzes.map((quiz) => verifyQuizFaithfulness(quiz, repository));
  const hintResults = hints.map((hint) => verifyHintFaithfulness(hint, repository, lineCounts));
  const answerResults = answers.map((answer) => verifyAnswerFaithfulness(extractCallClaims(answer?.text ?? answer ?? ""), repository));

  const familyStatus = (results) => combineClaimVerdicts(results.map((entry) => ({ status: entry.status })));

  return {
    version: FAITHFULNESS_GUARD_VERSION,
    separate: true,
    lessons: lessons.length ? { kind: "lessons", status: familyStatus(lessonResults), count: lessonResults.length, unfaithful: lessonResults.filter((entry) => entry.status === Verdict.UNFAITHFUL).length, abstained: lessonResults.filter((entry) => entry.status === Verdict.ABSTAIN).length, details: lessonResults } : null,
    quizzes: quizResults.length ? { kind: "quizzes", status: familyStatus(quizResults), count: quizResults.length, unfaithful: quizResults.filter((entry) => entry.status === Verdict.UNFAITHFUL).length, abstained: quizResults.filter((entry) => entry.status === Verdict.ABSTAIN).length, details: quizResults } : null,
    hints: hintResults.length ? { kind: "hints", status: familyStatus(hintResults), count: hintResults.length, unfaithful: hintResults.filter((entry) => entry.status === Verdict.UNFAITHFUL).length, abstained: hintResults.filter((entry) => entry.status === Verdict.ABSTAIN).length, details: hintResults } : null,
    answers: answerResults.length ? { kind: "answers", status: familyStatus(answerResults), count: answerResults.length, unfaithful: answerResults.filter((entry) => entry.status === Verdict.UNFAITHFUL).length, abstained: answerResults.filter((entry) => entry.status === Verdict.ABSTAIN).length, details: answerResults } : null,
    generatedAt: new Date().toISOString(),
  };
}
