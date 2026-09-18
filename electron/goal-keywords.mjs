/**
 * Goal keyword patterns, split out from `goals.mjs`.
 *
 * The renderer needs only "does this lesson serve this goal" to reweight a skill
 * graph, while the full goal module carries every source-signal detector. Keeping
 * them together pushed the application entry chunk to within a kilobyte of item
 * 19's budget, so the shared part lives here and both sides import it.
 */

export const GOAL_LESSON_KEYWORDS = {
  debugging: /flow|path|trace|execution|error|fail|handle|debug|exception|state/i,
  onboarding: /map|purpose|structure|entry|overview|start|introduc|api|public/i,
  architecture: /architecture|module|boundary|layer|structure|design|depend|system/i,
  security: /secur|valid|trust|input|auth|token|permission|sanitiz|escape/i,
  performance: /perform|speed|latency|throughput|batch|cache|kernel|gpu|parallel|optim/i,
};

/**
 * The four profile goals shipped before item 43 map onto the five named ones, so
 * a saved profile keeps working instead of silently losing its personalization.
 */
export const LEGACY_GOAL_ALIASES = {
  architecture: "architecture",
  critical_path: "performance",
  contribute: "onboarding",
  review: "security",
};

export function canonicalGoalId(id) {
  if (id in GOAL_LESSON_KEYWORDS) return id;
  return LEGACY_GOAL_ALIASES[id] ?? null;
}

/** The lesson-matching pattern for a goal; an unknown goal matches nothing. */
export function goalKeywords(id) {
  return GOAL_LESSON_KEYWORDS[canonicalGoalId(id)] ?? /$^/;
}
