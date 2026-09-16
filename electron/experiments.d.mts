/**
 * Types for the shared experiment module, so the browser demo enforces the same
 * consent gate and runs the same analysis as the desktop app.
 */
import type { ExperimentAssignment, ExperimentReport, ExperimentResult } from "../src/types";

export type StoredExperimentState = {
  consent: { granted: boolean; grantedAt: string | null; revokedAt: string | null; participantId: string | null } | null;
  observations: Array<{ experimentId: string; arm: string; metric: string; value: number; at: string }>;
};

export type ExperimentDefinition = {
  id: string;
  question: string;
  applies: string;
  arms: Array<{ id: string; label: string; control: boolean; settings: Record<string, unknown> }>;
  metric: string;
  metricLabel: string;
  higherIsBetter: boolean;
  minimumSample: number;
};

export declare const EXPERIMENT_VERSION: number;
export declare const OBSERVATION_FIELDS: string[];
export declare const EXPERIMENTS: ExperimentDefinition[];
export declare function hash32(text: string): number;
export declare function experimentById(id: string): ExperimentDefinition | null;
export declare function controlArm(experiment: ExperimentDefinition): ExperimentDefinition["arms"][number];
export declare function assignArm(experiment: ExperimentDefinition, participantId: string): ExperimentDefinition["arms"][number];
export declare function sanitizeObservation(candidate: unknown): { ok: boolean; reason?: string; observation?: { experimentId: string; arm: string; metric: string; value: number; at: string } };
export declare function consentState(state: StoredExperimentState | null): ExperimentReport["consent"];
export declare function activeAssignments(state: StoredExperimentState | null): ExperimentAssignment[];
export declare function settingsFor(experimentId: string, state: StoredExperimentState | null): Record<string, unknown> & { arm?: string; enrolled?: boolean };
export declare function analyzeExperiment(experiment: ExperimentDefinition, observations: StoredExperimentState["observations"]): ExperimentResult;
export declare function experimentReport(state: StoredExperimentState | null): ExperimentReport;
