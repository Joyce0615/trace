/**
 * Types for the shared evaluation module.
 *
 * Like `search.mjs`, this module is free of Node built-ins so the browser demo
 * can run the same scorecards the desktop app runs.
 */
import type { Course, EvaluationReport, LessonScorecard, Repository, RetrievalScorecard, SkillGraph } from "../src/types";
import type { SearchIndex } from "./search.mjs";

export declare const EVALUATION_VERSION: number;
export declare function evaluateRetrieval(index: SearchIndex, repository: Repository, options?: { sampleSize?: number; limit?: number }): RetrievalScorecard;
export declare function evaluateTutorAnswer(answer: unknown, repository: Repository, options?: { lineCounts?: Record<string, number> }): {
  kind: "tutor";
  citations: number;
  validCitations: number;
  invalidCitations: Array<{ path: string; line: number; valid: boolean; reason: string | null }>;
  grounding: number;
  mentionedSymbols: number;
  unknownSymbols: string[];
  symbolPrecision: number;
  contextSources: number;
  usedContextSources: number;
  faithfulness: number;
  score: number;
  verdict: string;
  unverifiable: boolean;
};
export declare function evaluateLessons(course: Course, repository: Repository, skillGraph?: SkillGraph | null): LessonScorecard;
export declare function runEvaluation(input: {
  index: SearchIndex | null;
  repository: Repository;
  course?: Course | null;
  skillGraph?: SkillGraph | null;
  answers?: unknown[];
  options?: { retrieval?: { sampleSize?: number; limit?: number }; tutor?: { lineCounts?: Record<string, number> } };
}): EvaluationReport;
