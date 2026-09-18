import { redactValue } from "./secret-scanner.mjs";

/**
 * Portable course packages with provenance.
 *
 * A course is only meaningful next to the source it was written against: a
 * lesson that says "read line 88" is worthless — or worse, misleading — if the
 * importer's copy has moved on twenty commits. So a package is not just the
 * course. It carries the repository identity, the exact commit and index
 * version it was built from, and the **blob id of every file it anchors into**,
 * which is what lets an importer say precisely which anchors still hold.
 *
 * Two decisions here are deliberate and worth stating:
 *
 *   - **Source excerpts are excluded by default.** Embedding someone's code in
 *     a shareable file redistributes it, and a course generated from a
 *     repository whose license Trace could not identify has no business doing
 *     that silently. `embedSource` therefore requires a license the packager
 *     recognised as permissive, and the package records which policy applied.
 *   - **Verification reports drift instead of pass/fail.** Anchors that moved
 *     within a file, files that changed content, and files that disappeared are
 *     three different problems with three different fixes, and collapsing them
 *     into "invalid" would tell an importer nothing useful.
 *
 * The module is Node-free so both processes and the tests can use it directly.
 */

export const COURSE_PACKAGE_FORMAT = "trace-course-v1";
export const COURSE_PACKAGE_VERSION = 1;

/**
 * Licenses recognised well enough to allow embedding source excerpts. The list
 * is deliberately short: an unrecognised license means "do not redistribute",
 * not "probably fine".
 */
export const PERMISSIVE_LICENSES = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense"];

const LICENSE_SIGNATURES = [
  { id: "Apache-2.0", pattern: /Apache License\s*,?\s*Version 2\.0/i },
  { id: "MIT", pattern: /\bMIT License\b|Permission is hereby granted, free of charge/i },
  { id: "BSD-3-Clause", pattern: /Redistributions of source code must retain[\s\S]{0,1200}Neither the name of/i },
  { id: "BSD-2-Clause", pattern: /Redistributions of source code must retain/i },
  { id: "ISC", pattern: /\bISC License\b|Permission to use, copy, modify, and\/or distribute/i },
  { id: "0BSD", pattern: /\bBSD Zero Clause License\b/i },
  { id: "Unlicense", pattern: /This is free and unencumbered software released into the public domain/i },
  { id: "MPL-2.0", pattern: /Mozilla Public License Version 2\.0/i },
  { id: "GPL-3.0", pattern: /GNU GENERAL PUBLIC LICENSE\s*Version 3/i },
  { id: "AGPL-3.0", pattern: /GNU AFFERO GENERAL PUBLIC LICENSE/i },
  { id: "LGPL-3.0", pattern: /GNU LESSER GENERAL PUBLIC LICENSE/i },
];

/** Identify a repository's license from its own LICENSE text. */
export function detectLicense(sources = {}) {
  const candidates = Object.entries(sources)
    .filter(([filePath]) => /^(?:LICEN[CS]E|COPYING)(?:\.\w+)?$/i.test(filePath.split("/").at(-1) ?? ""))
    .sort(([left], [right]) => left.split("/").length - right.split("/").length);
  for (const [filePath, text] of candidates) {
    if (typeof text !== "string") continue;
    const matched = LICENSE_SIGNATURES.find((signature) => signature.pattern.test(text));
    if (matched) return { id: matched.id, file: filePath, permissive: PERMISSIVE_LICENSES.includes(matched.id), detected: true };
    return { id: "unrecognized", file: filePath, permissive: false, detected: false };
  }
  return { id: "unknown", file: null, permissive: false, detected: false };
}

function lessonsOf(course) {
  return (course?.modules ?? []).flatMap((module) => (module.lessons ?? []).map((lesson) => ({ moduleId: module.id, lesson })));
}

/** Every anchor a course points at, with the blob id of the file it points into. */
export function anchorManifest(course, repository) {
  const blobs = new Map((repository?.files ?? []).map((file) => [file.path, file.blobId ?? null]));
  const manifest = [];
  for (const { lesson } of lessonsOf(course)) {
    for (const anchor of lesson.anchors ?? []) {
      manifest.push({
        lessonId: lesson.id,
        path: anchor.path,
        line: anchor.line,
        symbol: anchor.symbol ?? null,
        blobId: blobs.get(anchor.path) ?? null,
        indexed: blobs.has(anchor.path),
      });
    }
  }
  return manifest;
}

/**
 * Build a shareable package.
 *
 * Everything that goes in is redacted first: a course objective can quote a
 * commit message, and a remote URL can carry a token.
 */
export function packageCourse(repository, course, options = {}) {
  const license = options.license ?? detectLicense(options.sources ?? {});
  const wantsSource = Boolean(options.embedSource);
  // The gate: embedding source is only allowed under a license the packager
  // actually recognised as permissive.
  const embedsSource = wantsSource && license.permissive;
  const manifest = anchorManifest(course, repository);
  const excerpts = embedsSource
    ? Object.fromEntries(
      [...new Set(manifest.map((entry) => entry.path))]
        .filter((filePath) => typeof options.sources?.[filePath] === "string")
        .slice(0, 200)
        .map((filePath) => [filePath, String(options.sources[filePath]).slice(0, 40_000)]),
    )
    : {};

  return redactValue({
    format: COURSE_PACKAGE_FORMAT,
    version: COURSE_PACKAGE_VERSION,
    packagedAt: options.now ?? new Date().toISOString(),
    provenance: {
      repositoryId: repository?.id ?? null,
      repositoryName: repository?.name ?? null,
      remote: repository?.remoteUrl ?? repository?.remote ?? null,
      branch: repository?.branch ?? null,
      commit: repository?.head ?? repository?.commit ?? null,
      sourceVersion: repository?.versionId ?? null,
      indexer: repository?.stats?.indexer ?? null,
      fileCount: repository?.stats?.fileCount ?? (repository?.files?.length ?? 0),
      generatedBy: course?.generatedBy ?? "starter",
      packagedBy: options.packagedBy ?? "trace",
    },
    license: {
      ...license,
      // Stated on the package, not inferred by the importer.
      policy: embedsSource ? "source-embedded" : wantsSource ? "source-withheld-unrecognized-license" : "anchors-only",
      embedsSource,
    },
    content: {
      course,
      skillGraph: options.skillGraph ?? null,
    },
    integrity: {
      anchors: manifest,
      anchorCount: manifest.length,
      lessonCount: lessonsOf(course).length,
      // Present only when the license allowed it; an importer can tell the
      // difference between "no excerpts" and "excerpts stripped".
      excerpts,
      excerptCount: Object.keys(excerpts).length,
    },
    signature: options.signature ?? null,
  });
}

/**
 * Verify a package against the repository the importer actually has.
 *
 * The four anchor outcomes are kept separate because they need different
 * responses: a moved line can be re-found, a changed blob means the lesson may
 * now be wrong, a missing file means the lesson is dead, and a match means
 * nothing needs doing.
 */
export function verifyPackage(packaged, repository) {
  const problems = [];
  if (packaged?.format !== COURSE_PACKAGE_FORMAT) {
    return { valid: false, verdict: "unreadable", reason: `Not a Trace course package (${packaged?.format ?? "no format"}).`, anchors: null, problems: ["format"] };
  }
  if (Number(packaged.version) > COURSE_PACKAGE_VERSION) {
    return { valid: false, verdict: "unreadable", reason: `Package version ${packaged.version} is newer than this build understands (${COURSE_PACKAGE_VERSION}).`, anchors: null, problems: ["version"] };
  }

  const files = new Map((repository?.files ?? []).map((file) => [file.path, file]));
  const symbols = repository?.symbols ?? [];
  // Not every index records per-file blob ids (a bundled or non-git repository
  // does not). The repository's own version id already covers the whole tree
  // state, so it is the fallback integrity signal — otherwise a package
  // verified against the very repository it came from would report drift.
  const sameVersion = Boolean(packaged.provenance?.sourceVersion) && packaged.provenance.sourceVersion === repository?.versionId;
  const results = (packaged.integrity?.anchors ?? []).map((anchor) => {
    const file = files.get(anchor.path);
    if (!file) return { ...anchor, status: "missing-file", currentLine: null };
    const sameBlob = anchor.blobId && file.blobId ? anchor.blobId === file.blobId : null;
    if (sameBlob === true || (sameBlob === null && sameVersion)) return { ...anchor, status: "exact", currentLine: anchor.line };
    // The file changed: if the anchored symbol still exists, the lesson can be
    // re-pointed; if it does not, the anchor is genuinely stale.
    const moved = anchor.symbol
      ? symbols.find((symbol) => symbol.path === anchor.path && symbol.name === anchor.symbol)
      : null;
    if (moved) return { ...anchor, status: moved.line === anchor.line ? "changed-file" : "moved", currentLine: moved.line };
    return { ...anchor, status: sameBlob === null ? "unverifiable" : "changed-file", currentLine: anchor.line };
  });

  const counts = results.reduce((totals, entry) => ({ ...totals, [entry.status]: (totals[entry.status] ?? 0) + 1 }), {});
  const sameRepository = Boolean(packaged.provenance?.repositoryId) && packaged.provenance.repositoryId === repository?.id;
  const currentCommit = repository?.head ?? repository?.commit ?? null;
  const sameCommit = Boolean(packaged.provenance?.commit) && packaged.provenance.commit === currentCommit;
  const exact = counts.exact ?? 0;
  const total = results.length;
  const usable = exact + (counts.moved ?? 0);

  let verdict;
  if (!total) verdict = "empty";
  else if (!sameRepository && (counts["missing-file"] ?? 0) === total) verdict = "foreign";
  else if (exact === total && (sameCommit || sameVersion)) verdict = "exact";
  else if (usable / total >= 0.75) verdict = "compatible";
  else if (usable > 0) verdict = "drifted";
  else verdict = "foreign";

  if (counts["missing-file"]) problems.push(`${counts["missing-file"]} anchor(s) point at files this repository does not have`);
  if (counts.moved) problems.push(`${counts.moved} anchor(s) moved and were re-found by symbol`);
  if (counts["changed-file"]) problems.push(`${counts["changed-file"]} anchor(s) are in files whose contents changed`);
  if (counts.unverifiable) problems.push(`${counts.unverifiable} anchor(s) could not be checked because no blob id was recorded`);

  return {
    valid: verdict === "exact" || verdict === "compatible",
    verdict,
    sameRepository,
    sameCommit,
    sameVersion,
    packagedFrom: packaged.provenance ?? null,
    license: packaged.license ?? null,
    anchors: { total, counts, results, usable, usableRatio: total ? Number((usable / total).toFixed(4)) : 0 },
    problems,
    reason: null,
  };
}

/**
 * Import a package into the open repository, re-pointing anchors that moved and
 * dropping the ones that cannot be honoured.
 *
 * An anchor that no longer resolves is *removed* rather than shipped as a dead
 * link: a lesson that opens nothing is worse than a lesson with one fewer
 * reference, and item 34's evaluation would flag it anyway.
 */
export function importCourse(packaged, repository, options = {}) {
  const verification = verifyPackage(packaged, repository);
  if (verification.verdict === "unreadable") return { imported: false, verification, course: null, skillGraph: null };
  if (!verification.valid && !options.force) {
    return { imported: false, verification, course: null, skillGraph: null, reason: `The package does not match this repository well enough to import (${verification.verdict}).` };
  }

  const byKey = new Map((verification.anchors?.results ?? []).map((entry) => [`${entry.lessonId}|${entry.path}|${entry.line}`, entry]));
  let repointed = 0;
  let dropped = 0;
  const course = {
    ...packaged.content.course,
    modules: (packaged.content.course?.modules ?? []).map((module) => ({
      ...module,
      lessons: (module.lessons ?? []).map((lesson) => ({
        ...lesson,
        anchors: (lesson.anchors ?? []).flatMap((anchor) => {
          const entry = byKey.get(`${lesson.id}|${anchor.path}|${anchor.line}`);
          if (!entry || entry.status === "missing-file") { dropped += 1; return []; }
          if (entry.status === "moved" && entry.currentLine !== anchor.line) {
            repointed += 1;
            return [{ ...anchor, line: entry.currentLine }];
          }
          return [anchor];
        }),
      })),
    })),
  };

  return {
    imported: true,
    verification,
    course: { ...course, generatedBy: `imported:${packaged.provenance?.generatedBy ?? "unknown"}` },
    skillGraph: packaged.content.skillGraph ?? null,
    repointed,
    dropped,
    // An importer should know what they may do with any embedded excerpts.
    licenseNotice: packaged.license?.embedsSource
      ? `This package embeds source excerpts under ${packaged.license.id}. Keep that license with them.`
      : "This package carries anchors only; no source was redistributed.",
  };
}
