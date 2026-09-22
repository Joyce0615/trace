/**
 * Types for the shared, Node-free note-edit rules, so the browser demo applies
 * exactly the same create/update/delete semantics as the persisted desktop store.
 */
import type { CodeAnchor, LearnerNote } from "../src/types";

export declare const NOTES_VERSION: number;
export declare const MAX_NOTES: number;
export declare const MAX_NOTE_CHARS: number;

export declare function applyNoteEdit(
  notes: LearnerNote[],
  edit: { id: string; lessonId?: string | null; anchor?: CodeAnchor | null; text: string },
  now?: string,
): { notes: LearnerNote[]; removed: boolean; note: LearnerNote | null };

export declare function boundNotes(notes: LearnerNote[]): LearnerNote[];
