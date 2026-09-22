import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { NOTES_VERSION, boundNotes } from "./notes.mjs";
import { redactValue } from "./secret-scanner.mjs";

/**
 * Learner notes, on disk.
 *
 * The rules for what an edit means live in `notes.mjs`, which is Node-free and
 * shared with the browser demo; this module is only the persistence half.
 *
 * Notes used to live in `localStorage`, keyed by repository and lesson. That
 * was fine while a note was a scratchpad, and wrong the moment item 47 made
 * notes something a learner carries between machines: `localStorage` cannot be
 * exported, is not redacted, is invisible to the main process, and — because
 * Electron scopes it to the app's origin — is silently shared with every
 * repository the same window has ever opened. Notes are now first-class,
 * per-repository, redacted, and atomically written like every other piece of
 * learner state.
 */

function notesPath(directory, repositoryId) {
  const key = createHash("sha256").update(String(repositoryId)).digest("hex").slice(0, 24);
  return path.join(directory, `${key}.json`);
}

export async function loadNotes(directory, repositoryId) {
  try {
    const parsed = JSON.parse(await readFile(notesPath(directory, repositoryId), "utf8"));
    return Array.isArray(parsed?.notes) ? parsed.notes : [];
  } catch {
    return [];
  }
}

/**
 * Write the whole set atomically.
 *
 * A note is prose a learner typed; it can quote a config file with a token in
 * it, so it is redacted on the way to disk rather than on the way out.
 */
export async function saveNotes(directory, repositoryId, notes) {
  if (!repositoryId) throw new Error("Notes need a repository.");
  await mkdir(directory, { recursive: true });
  const bounded = boundNotes(notes);
  const destination = notesPath(directory, repositoryId);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(redactValue({ version: NOTES_VERSION, repositoryId, notes: bounded, updatedAt: new Date().toISOString() }), null, 2));
  await rename(temporary, destination);
  return bounded;
}
