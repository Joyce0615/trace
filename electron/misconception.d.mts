/**
 * Types for the shared misconception and calibration module, which the browser
 * demo imports so its diagnosis behaves exactly like the desktop app's.
 */
import type { DiagnosisReport, LearnerState, ProbeGrade, Repository, SkillGraph, MisconceptionFinding } from "../src/types";

export declare const MISCONCEPTION_VERSION: number;
export declare const MISCONCEPTIONS: Array<{ id: string; title: string; summary: string; patterns: RegExp[]; remediation: string; activity: string }>;
export declare function misconceptionById(id: string): { id: string; title: string; summary: string; remediation: string; activity: string } | null;
export declare function detectMisconceptions(text: string, options?: { source?: string }): MisconceptionFinding[];
export declare function buildProbe(skill: SkillGraph["nodes"][number], repository: Pick<Repository, "symbols" | "callEdges">): {
  id: string;
  skillId: string;
  prompt: string;
  anchor: { path: string; line: number; symbol: string | null } | null;
  options: Array<{ id: string; text: string }>;
  answerId: string;
  misconceptionByOption: Record<string, string>;
  fanIn: number;
};
export declare function gradeProbe(probe: ReturnType<typeof buildProbe>, choiceId: string): ProbeGrade;
export declare function calibrateSkill(mastery: unknown): Omit<DiagnosisReport["skills"][number], "title" | "misconceptions" | "probe">;
export declare function diagnoseLearner(
  learnerState: LearnerState | Record<string, never>,
  skillGraph: SkillGraph,
  repository: Pick<Repository, "symbols" | "callEdges">,
  options?: { findings?: Record<string, MisconceptionFinding[]> },
): DiagnosisReport & { probes: Record<string, ReturnType<typeof buildProbe>> };
