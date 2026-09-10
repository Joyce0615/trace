/**
 * Types for the shared spaced-repetition module, which the browser demo imports
 * so its review schedule behaves exactly like the desktop app's.
 */
import type { ForgettingCurve, LearnerState, ReviewGradeId, ReviewPlan, ReviewResult, ReviewSchedulingState, ScheduledSkill, SkillGraph, SkillMastery, SkillNode } from "../src/types";

export declare const SPACED_REPETITION_VERSION: number;
export declare const DEFAULT_SCHEDULER: {
  targetRetention: number;
  initialStabilityDays: number;
  minimumStabilityDays: number;
  maximumStabilityDays: number;
  initialDifficulty: number;
  difficultyFloor: number;
  difficultyCeiling: number;
  lapseStabilityFactor: number;
  masteryFloor: number;
  masteryLearningRate: number;
  dailyLimit: number;
};
export declare const REVIEW_GRADES: Record<ReviewGradeId, {
  id: ReviewGradeId;
  label: string;
  recalled: boolean;
  strength: number;
  stabilityGain: number;
  difficultyDelta: number;
  firstStabilityDays: number;
}>;
export declare const REVIEW_GRADE_IDS: ReviewGradeId[];

export declare function retention(elapsedDays: number, stabilityDays: number, options?: { targetRetention?: number }): number;
export declare function intervalForRetention(stabilityDays: number, wanted: number, options?: { targetRetention?: number }): number;
export declare function reviewStateOf(mastery: Partial<SkillMastery> | null | undefined, options?: Record<string, number>): ReviewSchedulingState;
export declare function gradeReview(
  state: Partial<ReviewSchedulingState> | null,
  request: { grade: ReviewGradeId; now?: string; elapsedDays?: number; parameters?: Record<string, number> },
): ReviewResult;
export declare function decayedMastery(recorded: number, retentionNow: number | null, options?: Record<string, number>): number;
export declare function forgettingCurve(state: { stability?: number }, options?: { horizonDays?: number; points?: number } & Record<string, number>): ForgettingCurve;
export declare function scheduleSkill(
  mastery: Partial<SkillMastery> | null | undefined,
  node: SkillNode,
  options?: { now?: string } & Record<string, unknown>,
): ScheduledSkill;
export declare function orderQueue(entries: ScheduledSkill[], skillGraph: SkillGraph | null): ScheduledSkill[];
export declare function reviewPlan(
  learnerState: LearnerState | null,
  skillGraph: SkillGraph | null,
  options?: { now?: string; dailyLimit?: number } & Record<string, unknown>,
): ReviewPlan;
export declare function applyReview(
  learnerState: LearnerState,
  skillGraph: SkillGraph,
  request: { skillId: string; grade: ReviewGradeId; now?: string; parameters?: Record<string, number> },
): { learnerState: LearnerState; review: ReviewResult; plan: ReviewPlan };
