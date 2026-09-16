/**
 * Types for the shared analytics module, so the browser demo computes retention,
 * transfer, time-on-task, and hint dependence exactly as the desktop app does.
 */
import type { AnalyticsRate, AnalyticsReport, LearnerState, SkillGraph } from "../src/types";

export type ActivityEvent = {
  id?: string;
  at: string;
  kind: string;
  taskId?: string;
  skillId?: string;
  path?: string | null;
  symbol?: string | null;
  correct?: boolean;
  score?: number;
  hints?: number;
  hintPenalty?: number;
  elapsedDays?: number;
  stability?: number;
  confidence?: number;
};

export declare const ANALYTICS_VERSION: number;
export declare const MIN_SAMPLE: number;
export declare const SESSION_GAP_MS: number;
export declare const RETENTION_BUCKETS: Array<{ id: string; maxDays: number; label: string }>;

export declare function rate(successes: number, total: number, minimum?: number): AnalyticsRate;
export declare function normalizeEvents(events: unknown[]): Array<ActivityEvent & { time: number }>;
export declare function retentionAnalytics(events: unknown[], learnerState: LearnerState | null, skillGraph: SkillGraph | null, options?: { now?: string }): AnalyticsReport["retention"];
export declare function transferAnalytics(events: unknown[], learnerState: LearnerState | null, options?: { studiedPaths?: string[] }): AnalyticsReport["transfer"];
export declare function timeOnTaskAnalytics(events: unknown[], options?: { sessionGapMs?: number }): AnalyticsReport["timeOnTask"];
export declare function hintAnalytics(events: unknown[]): AnalyticsReport["hints"];
export declare function analyticsReport(input?: {
  events?: unknown[];
  learnerState?: LearnerState | null;
  skillGraph?: SkillGraph | null;
  now?: string;
  studiedPaths?: string[];
  sessionGapMs?: number;
}): AnalyticsReport;
