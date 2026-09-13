/**
 * Types for the shared activity module, so the browser demo runs the same
 * teach-back, prediction, and contrast builders as the desktop app.
 */
import type { ActivitySet, ContrastGrade, ContrastTask, MisconceptionFinding, PredictionItem, PredictionOutcome, Repository, TeachBackGrade, TeachBackTask } from "../src/types";

type Sources = Record<string, string>;

export declare const ACTIVITY_VERSION: number;
export declare function restatementRatio(text: string, source: string): number;
export declare function excerptFor(sources: Sources, filePath: string, line: number, span?: number): { path: string; startLine: number; text: string } | null;
export declare function headerParameters(sources: Sources, filePath: string, line: number): string[] | null;
export declare function buildTeachBack(repository: Partial<Repository>, sources: Sources, options?: { symbol?: string }): TeachBackTask & { reference?: string };
export declare function gradeTeachBack(task: TeachBackTask & { reference?: string; symbol?: string }, submission: string, repository: Partial<Repository>): TeachBackGrade;
export declare function buildPredictions(repository: Partial<Repository>, sources: Sources, options?: { limit?: number }): Array<PredictionItem & { answer: number | string; tolerance: number; reveal: string }>;
export declare function gradePrediction(prediction: PredictionItem & { answer: number | string; tolerance: number; reveal: string; kind: "numeric" | "path" }, guess: string | number, confidence?: number): PredictionOutcome;
export declare function summarizePredictions(grades: PredictionOutcome[]): {
  predictions: number;
  accuracy: number;
  creditedAccuracy?: number;
  meanConfidence: number;
  brier: number | null;
  overconfident: number;
  underconfident: number;
};
export declare function contrastDifferences(left: unknown, right: unknown): Array<{ id: string; detail: string }>;
export declare function buildContrast(repository: Partial<Repository>, sources: Sources, options?: { symbol?: string }): ContrastTask & { answerId?: string; differences?: Array<{ id: string; detail: string }> };
export declare function gradeContrast(task: ContrastTask & { answerId?: string; differences?: Array<{ id: string; detail: string }>; symbol?: string }, choiceId?: string): ContrastGrade;
/** The internal set, answers included. Only `publicActivitySet` output may ship. */
export type InternalActivitySet = {
  version: number;
  teachBack: TeachBackTask & { reference?: string; symbol?: string };
  predictions: Array<PredictionItem & { answer: number | string; tolerance: number; reveal: string; kind: "numeric" | "path" }>;
  contrast: ContrastTask & { answerId?: string; differences?: Array<{ id: string; detail: string }>; symbol?: string };
};
export declare function buildActivitySet(repository: Partial<Repository>, sources: Sources, options?: { symbol?: string }): InternalActivitySet;
export declare function publicActivitySet(set: InternalActivitySet): ActivitySet;
export declare function detectMisconceptions(text: string): MisconceptionFinding[];
