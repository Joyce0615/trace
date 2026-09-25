import { createHash } from "node:crypto";
import path from "node:path";
import { readDurable, writeDurable } from "./durable-store.mjs";
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
  const read = await readDurable(notesPath(directory, repositoryId), { acceptLegacy: true });
  return Array.isArray(read.value?.notes) ? read.value.notes : [];
}

/**
 * Write the whole set atomically.
 *
 * A note is prose a learner typed; it can quote a config file with a token in
 * it, so it is redacted on the way to disk rather than on the way out.
 */
export async function saveNotes(directory, repositoryId, notes) {
  if (!repositoryId) throw new Error("Notes need a repository.");
  const bounded = boundNotes(notes);
  await writeDurable(notesPath(directory, repositoryId), redactValue({ version: NOTES_VERSION, repositoryId, notes: bounded, updatedAt: new Date().toISOString() }));
  return bounded;
}
