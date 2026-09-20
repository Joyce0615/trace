/**
 * Types for the shared course-migration module, so the browser demo classifies
 * moves, renames, splits, and disappearances with exactly the same matcher the
 * desktop app uses.
 */
import type { CodeAnchor, Course, MigrationOperation, MigrationPlan } from "../src/types";

export interface SymbolSnapshotEntry {
  name: string;
  kind: string;
  path: string;
  line: number;
  endLine: number;
  container: string | null;
  tokenCount: number;
  fingerprint: number;
  shingles: number[];
  bodied: boolean;
}

export interface SymbolSnapshot {
  version: number;
  label: string | null;
  commit: string | null;
  sourceVersion: string | null;
  symbols: SymbolSnapshotEntry[];
  files: string[];
  bodied: boolean;
}

export interface MigrationApplication {
  course: Course;
  migration: { id: string; version: number; at: string; repointed: number; retired: number; added: number; skipped: number };
  applied: number;
  retired: number;
  added: number;
  skipped: number;
  orphaned: number;
  reviewRequired: number;
}

export declare const MIGRATION_VERSION: number;
export declare const DEFAULT_MIGRATION_THRESHOLDS: Record<string, number>;
export declare const DEAD_STATUSES: Set<string>;

export declare function bodyTokens(text: string): string[];
export declare function shingles(tokens: string[], size?: number, limit?: number): number[];
export declare function jaccard(left: number[], right: number[]): number;
export declare function coverage(target: number[], parts: number[][]): number;
export declare function buildSymbolSnapshot(
  symbols: Array<{ name: string; kind?: string; path: string; line: number; endLine?: number; container?: string | null }>,
  sources?: Record<string, string>,
  options?: { label?: string; commit?: string | null; sourceVersion?: string | null; files?: string[]; maxSymbols?: number; maxBodyLines?: number },
): SymbolSnapshot;
export declare function courseAnchorSites(course: Course): Array<{ moduleId: string; lessonId: string; lessonTitle: string; site: string; blockId: string | null; index: number; anchor: CodeAnchor }>;
export declare function rewriteCourseAnchors(course: Course, rewrite: (site: { lessonId: string; site: string; blockId: string | null; index: number; anchor: CodeAnchor }) => CodeAnchor | CodeAnchor[] | null): Course;
export declare function classifyAnchor(anchor: CodeAnchor, before: unknown, after: unknown, options?: { thresholds?: Record<string, number> }): unknown;
export declare function planMigration(course: Course, before: SymbolSnapshot, after: SymbolSnapshot, options?: { thresholds?: Record<string, number> }): MigrationPlan;
export declare function applyMigration(course: Course, plan: MigrationPlan, options?: { accept?: "auto" | "all" | string[]; retireMissing?: boolean; now?: string }): MigrationApplication;
export declare function revertMigration(course: Course, migrationId?: string | null): { course: Course; reverted: boolean; reason?: string; migrationId?: string; restored?: number };
export type { MigrationOperation, MigrationPlan };
