import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { emptyContinuity } from "./project-continuity.mjs";
import { readDurable, writeDurable } from "./durable-store.mjs";
import { redactValue } from "./secret-scanner.mjs";

/**
 * Where one repository's multi-session continuity record lives (item 42,
 * this cycle — see `project-continuity.mjs` for the numbering-reuse note).
 *
 * One file per repository, keyed the same way `learning-store.mjs` and
 * `notes-store.mjs` already key theirs (a truncated sha256 of the repository
 * id), written through `durable-store.mjs`'s atomic-write-plus-backup
 * machinery rather than a second implementation of it. A hypothesis's text or
 * a thread turn's answer summary can quote source, exactly like a learner
 * note, so the payload is redacted on the way to disk, following
 * `notes-store.mjs`/`learning-store.mjs`'s own rule for the same reason.
 */

export const PROJECT_CONTINUITY_STORE_VERSION = 1;

function continuityPath(directory, repositoryId) {
  const key = createHash("sha256").update(String(repositoryId)).digest("hex").slice(0, 24);
  return path.join(directory, `${key}.json`);
}

/** Load a repository's continuity record, or an empty/unconsented one if none exists yet. */
export async function loadContinuity(directory, repositoryId) {
  const read = await readDurable(continuityPath(directory, repositoryId), { acceptLegacy: true, fallback: emptyContinuity(repositoryId) });
  return read.value?.repositoryId === repositoryId ? read.value : emptyContinuity(repositoryId);
}

/** Save the whole record atomically. */
export async function saveContinuity(directory, record) {
  if (!record?.repositoryId) throw new Error("A continuity record needs a repository.");
  await writeDurable(continuityPath(directory, record.repositoryId), redactValue({ ...record, updatedAt: new Date().toISOString() }));
  return record;
}

/**
 * Delete everything kept for one repository: the file itself, not a blanked
 * copy of it — the same "delete means delete the file" rule
 * `experiment-store.mjs`/`telemetry-store.mjs` already apply, so withdrawing
 * consent and then checking disk cannot find anything left to recover.
 */
export async function forgetContinuity(directory, repositoryId) {
  const existing = await loadContinuity(directory, repositoryId);
  const target = continuityPath(directory, repositoryId);
  await rm(target, { force: true });
  await rm(`${target}.bak`, { force: true });
  return {
    deletedHypotheses: existing.hypotheses?.length ?? 0,
    deletedEvidence: existing.evidence?.length ?? 0,
    deletedThreadTurns: existing.thread?.length ?? 0,
    hadConsent: Boolean(existing.consent?.granted),
  };
}
