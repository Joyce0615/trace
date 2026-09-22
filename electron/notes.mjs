/**
 * What a note edit means.
 *
 * Kept apart from `notes-store.mjs` because that module talks to the file
 * system and to `node:crypto`, and the browser demo has neither. The split is
 * not cosmetic: the demo imported the store directly at first, Vite externalized
 * `node:crypto`, every `saveNote` rejected, and the renderer's optimistic local
 * copy hid it — notes looked saved and were not. Rules that both targets run
 * belong in a Node-free module; only persistence needs Node.
 */

export const NOTES_VERSION = 1;
export const MAX_NOTES = 500;
export const MAX_NOTE_CHARS = 8_000;

/**
 * Apply one edit.
 *
 * Deleting is "save empty text" rather than its own channel, because that is
 * what clearing the box in the UI means, and a delete reachable only through a
 * separate call is a delete that eventually diverges from the box.
 */
export function applyNoteEdit(notes, edit, now = new Date().toISOString()) {
  const existing = (notes ?? []).find((note) => note.id === edit.id);
  const text = String(edit.text ?? "").slice(0, MAX_NOTE_CHARS);
  if (!text.trim()) return { notes: (notes ?? []).filter((note) => note.id !== edit.id), removed: Boolean(existing), note: null };
  const next = {
    id: edit.id,
    lessonId: edit.lessonId ?? existing?.lessonId ?? null,
    anchor: edit.anchor ?? existing?.anchor ?? null,
    text,
    // Editing a note does not change when it was written.
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return {
    notes: existing ? (notes ?? []).map((note) => (note.id === edit.id ? next : note)) : [...(notes ?? []), next].slice(-MAX_NOTES),
    removed: false,
    note: next,
  };
}

/** Bound a set of notes to what the store will accept, without refusing it. */
export function boundNotes(notes) {
  return (notes ?? [])
    .filter((note) => note?.id && typeof note.text === "string")
    .slice(0, MAX_NOTES)
    .map((note) => ({ ...note, text: note.text.slice(0, MAX_NOTE_CHARS) }));
}
