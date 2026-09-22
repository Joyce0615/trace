/**
 * Types for the shared offline-archive module, so the browser demo builds,
 * verifies, and merges archives with exactly the rules the desktop app uses.
 */
import type { ArchiveExcerpt, ArchiveImportResult, ArchiveVerification, CodeAnchor, Course, LearnerNote, LearnerState, OfflineArchive, Repository, SkillGraph } from "../src/types";

export declare const ARCHIVE_FORMAT: string;
export declare const ARCHIVE_VERSION: number;
export declare const DEFAULT_ARCHIVE_LIMITS: Record<string, number>;

export declare function digestOfText(text: string): string;
export declare function canonicalJson(value: unknown): string;
export declare function excerptAround(sourceText: string | undefined, anchor: CodeAnchor, options?: { limits?: Partial<typeof DEFAULT_ARCHIVE_LIMITS> }): Omit<ArchiveExcerpt, "symbol" | "blobId" | "language"> | null;
export declare function buildArchive(input: {
  repository?: Partial<Repository> | null;
  course?: Course | null;
  skillGraph?: SkillGraph | null;
  learnerState?: LearnerState | null;
  notes?: LearnerNote[];
  sources?: Record<string, string>;
  limits?: Partial<typeof DEFAULT_ARCHIVE_LIMITS>;
  exportedBy?: string;
  now?: string;
}): OfflineArchive;
export declare function verifyArchive(archive: OfflineArchive, options?: { sources?: Record<string, string> | null }): ArchiveVerification;
export declare function mergeProgress(local: LearnerState | null, imported: LearnerState | null, options?: { maxMemories?: number }): {
  state: LearnerState;
  conflicts: Array<{ kind: string; skillId: string; detail: string; kept: unknown }>;
  gained: { evidence: number; memories: number; skills: number };
};
export declare function mergeNotes(local?: LearnerNote[], imported?: LearnerNote[], options?: { limits?: Partial<typeof DEFAULT_ARCHIVE_LIMITS> }): {
  notes: LearnerNote[];
  conflicts: Array<{ kind: string; noteId: string; detail: string; kept: string }>;
  added: number;
  identical: number;
};
export declare function importArchive(archive: OfflineArchive, options?: {
  sources?: Record<string, string> | null;
  mode?: "merge" | "replace";
  learnerState?: LearnerState | null;
  notes?: LearnerNote[];
  force?: boolean;
}): ArchiveImportResult;
