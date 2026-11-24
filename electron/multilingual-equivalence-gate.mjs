/**
 * Verify multilingual pedagogical equivalence (item 58).
 *
 * This app's hint ladders, misconception findings, evidence citations,
 * difficulty labels, and faithfulness verdicts are all authored and checked
 * in English. Nothing in the codebase renders any of those into another
 * language, so nothing has ever checked whether a translation preserves the
 * safety properties the English original already earned. Confirmed by grep
 * before writing a line here: zero prior matches for
 * `multilingual-equivalence`/`MultilingualEquivalence`/
 * `containsAnswerToken`/`verifyTranslatedScaffold`/`verifyHintRungEquivalence`
 * as implementation identifiers anywhere in `electron/*.mjs`. (There is an
 * unrelated `electron/localization.mjs` — a code-location *exercise* module,
 * named for finding a symbol in a repository, not for human-language
 * translation. Same word, orthogonal concept.)
 *
 * This is not a speculative gap. `answer-guard.mjs`'s own leak regex —
 * `(?:^|[^A-Za-z0-9_])${answer}(?:[^A-Za-z0-9_]|$)` — is ASCII- and
 * case-sensitive. Verified live against the two renderings a machine
 * translator actually produces:
 *
 *   - **Title case at a sentence boundary.** A French rendering such as
 *     "Bubble_sort est la fonction appelée ici." contains the withheld
 *     answer "bubble_sort" with its first letter capitalized by ordinary
 *     sentence casing. `buildScaffold`'s regex reports no leak; the
 *     published, item-6-approved per-task leak check would miss it on this
 *     translated rung text.
 *   - **Fullwidth characters.** A Japanese rendering that keeps the Latin
 *     identifier but renders its first letter as the fullwidth form ("ｂ"
 *     instead of "b") also spells the same answer in a way `[A-Za-z0-9_]`
 *     never matches, for the same reason.
 *
 * Six axes, independently scored, never blended into one translation-quality
 * score, the same discipline every other gate in this app already keeps:
 *
 *   - **Evidence** — reuses `explanation-grader.mjs`'s own `checkCitations`
 *     (item 20) unmodified: the set of `path:line` references and their
 *     validity must match between the two renderings.
 *   - **Misconception** — the diagnosed finding's `id`/`activity` (from
 *     `misconception.mjs`, item 29) must survive translation unchanged, and a
 *     finding on one side with none on the other is a failure, not a
 *     silent match.
 *   - **Hint rung** — `buildScaffold`/`nextHintRung`'s own rung id, level,
 *     and price (item 6) must be identical across renderings; translation
 *     may only change rung *text*.
 *   - **Difficulty** — the lesson's own `difficulty` label must be the same
 *     string on both sides.
 *   - **Leakage** — `containsAnswerToken` below is a Unicode-aware repair of
 *     `answer-guard.mjs`'s leak check, applied to the rendered hint text in
 *     whichever language it was translated into.
 *   - **Abstention** — reuses `faithfulness-guard.mjs`'s own `Verdict` three-
 *     state (item 19) unmodified: the same underlying claim must not drift
 *     from FAITHFUL/UNFAITHFUL/ABSTAIN to a different verdict just because
 *     it was asked about in translation.
 */

import { checkCitations } from "./explanation-grader.mjs";

export const MULTILINGUAL_EQUIVALENCE_GATE_VERSION = 1;

/** Fixed order, matching the item's own stated list. */
export const SEMANTIC_AXES = ["evidence", "misconception", "hint-rung", "difficulty", "leakage", "abstention"];

/**
 * A Unicode-aware, case-insensitive repair of `answer-guard.mjs`'s own leak
 * regex, for checking *rendered* (translated) text rather than the English
 * original `buildScaffold` already approved.
 *
 * NFKC normalization folds fullwidth Latin letters to their ASCII forms
 * before the comparison, and the comparison itself is case-insensitive, so
 * both gaps demonstrated above are caught. It stays deliberately insensitive
 * to identifier-style variants such as `BubbleSort` or `bubble-sort`: style
 * normalization is an orthogonal, different problem this item does not
 * claim to solve, and folding it in here would risk false leak reports on
 * ordinary unrelated camelCase prose.
 */
export function containsAnswerToken(text, answer) {
  const needle = typeof answer === "string" ? answer : answer === null || answer === undefined ? "" : String(answer);
  if (!needle || needle.length < 2) return false;
  const haystack = String(text ?? "").normalize("NFKC").toLowerCase();
  const target = needle.normalize("NFKC").toLowerCase();
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9_])${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^A-Za-z0-9_]|$)`, "u");
  return pattern.test(haystack);
}

/**
 * Re-check each rung of an already-approved scaffold against its localized
 * (translated) rendering. `translatedRungText` is keyed by rung id; a rung
 * with no provided translation falls back to the original, already-approved
 * English text rather than being silently skipped — an untranslated rung is
 * still served to the learner, so it still needs to be checked.
 */
export function verifyTranslatedScaffoldLeakage(scaffold, translatedRungText, answer) {
  const findings = (scaffold?.rungs ?? []).map((rung) => {
    const rendered = translatedRungText?.[rung.id] ?? rung.text;
    return { id: rung.id, leaked: containsAnswerToken(rendered, answer), rendered };
  });
  const leaking = findings.filter((item) => item.leaked);
  return { ok: leaking.length === 0, leakingRungs: leaking.map((item) => item.id), findings };
}

/**
 * Translation may only change rung *text*. Reordering, adding, dropping, or
 * re-pricing a rung changes what the hint ladder actually does, not just how
 * it reads, so those are failures distinct from leakage.
 */
export function verifyHintRungEquivalence(originalScaffold, translatedScaffold) {
  const original = originalScaffold?.rungs ?? [];
  const translated = translatedScaffold?.rungs ?? [];
  if (original.length !== translated.length) {
    return { ok: false, reason: "rung-count-mismatch", originalCount: original.length, translatedCount: translated.length };
  }
  for (let index = 0; index < original.length; index += 1) {
    const left = original[index];
    const right = translated[index];
    if (left.id !== right.id) return { ok: false, reason: "rung-reordered", index, expected: left.id, found: right.id };
    if (left.level !== right.level) return { ok: false, reason: "rung-relevelled", id: left.id, expected: left.level, found: right.level };
    if (left.price !== right.price) return { ok: false, reason: "rung-repriced", id: left.id, expected: left.price, found: right.price };
  }
  return { ok: true };
}

/** The lesson's own difficulty label must be identical across renderings. */
export function verifyDifficultyEquivalence(originalLesson, translatedLesson) {
  const original = originalLesson?.difficulty ?? null;
  const translated = translatedLesson?.difficulty ?? null;
  if (original === null && translated === null) return { ok: true, difficulty: null };
  if (original === null || translated === null) {
    return { ok: false, reason: "difficulty-missing-on-one-side", original, translated };
  }
  if (original !== translated) return { ok: false, reason: "difficulty-mismatch", original, translated };
  return { ok: true, difficulty: original };
}

/**
 * Reuses `explanation-grader.mjs`'s own `checkCitations`, unmodified, on
 * both renderings of the same explanation. The set of cited `path:line`
 * references and their individual validity must match; a citation present
 * in one rendering and missing in the other means the translation silently
 * dropped (or invented) evidence.
 */
export function verifyEvidenceEquivalence(originalText, translatedText, repository) {
  const key = (citation) => `${citation.path}:${citation.line}`;
  const original = checkCitations(originalText, repository);
  const translated = checkCitations(translatedText, repository);
  const originalKeys = new Set(original.map(key));
  const translatedKeys = new Set(translated.map(key));
  const dropped = [...originalKeys].filter((item) => !translatedKeys.has(item));
  const added = [...translatedKeys].filter((item) => !originalKeys.has(item));
  const originalValidity = new Map(original.map((citation) => [key(citation), citation.valid]));
  const driftedValidity = translated.filter((citation) => originalValidity.has(key(citation)) && originalValidity.get(key(citation)) !== citation.valid);
  const ok = dropped.length === 0 && added.length === 0 && driftedValidity.length === 0;
  return { ok, dropped, added, driftedValidity: driftedValidity.map(key) };
}

/**
 * A diagnosed misconception finding's `id`/`activity` (from
 * `misconception.mjs`) must survive translation unchanged, and its
 * remediation sentence must still be present (translated, not dropped). A
 * finding on only one side is a failure: it is never treated as a match by
 * assuming the missing side silently agrees.
 */
export function verifyMisconceptionEquivalence(originalFinding, translatedFinding) {
  if (!originalFinding && !translatedFinding) return { ok: true, finding: null };
  if (!originalFinding || !translatedFinding) {
    return { ok: false, reason: "finding-present-on-one-side-only", original: originalFinding?.id ?? null, translated: translatedFinding?.id ?? null };
  }
  if (originalFinding.id !== translatedFinding.id) {
    return { ok: false, reason: "finding-id-drifted", original: originalFinding.id, translated: translatedFinding.id };
  }
  if (originalFinding.activity !== translatedFinding.activity) {
    return { ok: false, reason: "finding-activity-drifted", original: originalFinding.activity, translated: translatedFinding.activity };
  }
  if (!translatedFinding.remediation || !String(translatedFinding.remediation).trim()) {
    return { ok: false, reason: "remediation-empty-in-translation", id: originalFinding.id };
  }
  return { ok: true, finding: originalFinding.id };
}

/**
 * Reuses `faithfulness-guard.mjs`'s own `Verdict` three-state, unmodified.
 * The same underlying claim must resolve to the same verdict whether it was
 * checked against the English original or a translated rendering; a
 * FAITHFUL claim that becomes ABSTAIN or UNFAITHFUL in translation (or vice
 * versa) is a drift this axis names explicitly.
 */
export function verifyAbstentionEquivalence(originalVerdict, translatedVerdict) {
  if (originalVerdict === null || originalVerdict === undefined || translatedVerdict === null || translatedVerdict === undefined) {
    return { ok: false, reason: "verdict-missing", original: originalVerdict ?? null, translated: translatedVerdict ?? null };
  }
  if (originalVerdict !== translatedVerdict) {
    return { ok: false, reason: "verdict-drifted", original: originalVerdict, translated: translatedVerdict };
  }
  return { ok: true, verdict: originalVerdict };
}

/**
 * Evaluate all six axes for one translated rendering against its English
 * original. Each axis is scored independently; `ok` is the conjunction, and
 * `failingAxes` names exactly which ones failed rather than collapsing the
 * reasons into a single pass/fail bit.
 */
export function evaluateMultilingualEquivalence(input) {
  const results = {
    evidence: verifyEvidenceEquivalence(input.originalExplanationText, input.translatedExplanationText, input.repository),
    misconception: verifyMisconceptionEquivalence(input.originalFinding ?? null, input.translatedFinding ?? null),
    "hint-rung": verifyHintRungEquivalence(input.originalScaffold, input.translatedScaffold),
    difficulty: verifyDifficultyEquivalence(input.originalLesson, input.translatedLesson),
    leakage: verifyTranslatedScaffoldLeakage(input.originalScaffold, input.translatedRungText ?? {}, input.answer),
    abstention: verifyAbstentionEquivalence(input.originalVerdict, input.translatedVerdict),
  };
  const failingAxes = SEMANTIC_AXES.filter((axis) => !results[axis].ok);
  return { version: MULTILINGUAL_EQUIVALENCE_GATE_VERSION, ok: failingAxes.length === 0, failingAxes, results };
}

export function renderMultilingualEquivalenceReport(report) {
  if (report.ok) return "Multilingual equivalence: EQUIVALENT across evidence, misconception, hint rung, difficulty, leakage, and abstention.";
  const lines = [`Multilingual equivalence: GAPS DETECTED on ${report.failingAxes.join(", ")}`];
  for (const axis of SEMANTIC_AXES) {
    const result = report.results[axis];
    lines.push(`  ${axis}: ${result.ok ? "ok" : `fail (${result.reason ?? "leak"})`}`);
  }
  return lines.join("\n");
}
