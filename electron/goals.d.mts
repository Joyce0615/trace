/**
 * Types for the shared goal module, so the renderer and the browser demo use the
 * same goal keywords and ranking rules as the desktop app.
 */
import type { Course, GoalPlan, GoalTarget, LearnerGoal, Repository } from "../src/types";

export declare const GOALS_VERSION: number;
export declare const GOALS: Array<{
  id: string;
  title: string;
  summary: string;
  lessonKeywords: RegExp;
  activities: string[];
  signals: Array<{ id: string; weight: number; pattern: RegExp; detail: (count: number) => string }>;
}>;
export declare const LEGACY_GOAL_ALIASES: Record<string, string>;
export declare function goalKeywords(id: string): RegExp;
export declare function resolveGoal(id: string): (typeof GOALS)[number] | null;
export declare function rankTargets(repository: Partial<Repository>, goalId: LearnerGoal, sources: Record<string, string>, options?: { limit?: number }): GoalTarget[];
export declare function orderLessonsForGoal(course: Course | null, goalId: LearnerGoal): NonNullable<GoalPlan["lessonOrder"]>;
export declare function goalPlan(
  repository: Partial<Repository>,
  goalId: string,
  options?: { sources?: Record<string, string>; course?: Course | null; limit?: number },
): GoalPlan;
export declare function publicGoals(): GoalPlan["goals"];
