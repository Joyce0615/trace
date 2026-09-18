/** Types for the shared goal keyword table (item 43). */
export declare const GOAL_LESSON_KEYWORDS: Record<string, RegExp>;
export declare const LEGACY_GOAL_ALIASES: Record<string, string>;
export declare function canonicalGoalId(id: string): string | null;
export declare function goalKeywords(id: string): RegExp;
