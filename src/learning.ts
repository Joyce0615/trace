import { goalKeywords } from "../electron/goal-keywords.mjs";
import type { LearnerGoal, LearnerState, LearningEvidence, SkillGraph, SkillMastery, SkillNode } from "./types";

export function createClientLearnerState(repositoryId: string, sourceVersion: string | undefined, graph: SkillGraph): LearnerState {
  const mastery: Record<string, SkillMastery> = {};
  graph.nodes.forEach((node) => {
    mastery[node.id] = {
      skillId: node.id,
      mastery: 0,
      confidence: 0,
      status: node.prerequisites.length ? "locked" : "available",
      evidence: [],
      sourceFingerprint: node.sourceFingerprint,
    };
  });
  return recommend({ repositoryId, sourceVersion, diagnosticCompleted: false, mastery, memory: [], updatedAt: new Date().toISOString() }, graph);
}

function prerequisitesMet(node: SkillNode, state: LearnerState) {
  return node.prerequisites.every((id) => (state.mastery[id]?.mastery ?? 0) >= 0.6);
}

/**
 * Recompute curriculum status (locked/available/recommended/mastered) from raw
 * mastery and prerequisites.
 *
 * This is the single writer for every skill that has *not* yet entered the
 * spaced-repetition cycle. Once a skill carries a `review` record, ownership of
 * its status passes to `electron/spaced-repetition.mjs`'s `applyReview` — the
 * only place that knows about forgetting, lapses, and source-change restarts.
 * `recommend` runs on every `addEvidence`/`completeDiagnostic` call over the
 * *whole* graph (because unlocking is a graph-wide effect: finishing one skill
 * can make several others available), so without this guard, any unrelated
 * client-side edit — marking a different skill familiar, finishing an unrelated
 * lesson, answering one diagnostic question — would silently recompute a
 * reviewed skill's status from its bare mastery number and overwrite whatever
 * the reviewer had just decided (observed: a skill the reviewer had just
 * demoted to "active" after a forgotten review was reset to "recommended" by
 * the very next unrelated evidence call). A skill's own mastery number is still
 * read by `prerequisitesMet` below, so reviewed skills continue to gate the
 * skills built on them correctly — only the *status label itself* is left to
 * its owner.
 */
export function recommend(state: LearnerState, graph: SkillGraph): LearnerState {
  const mastery = { ...state.mastery };
  for (const node of graph.nodes) {
    const previous = mastery[node.id] ?? { skillId: node.id, mastery: 0, confidence: 0, status: "locked", evidence: [], sourceFingerprint: node.sourceFingerprint };
    if (previous.review) {
      // Owned by the spaced-repetition reviewer; carry its status through
      // unchanged, exactly like the pre-existing `sourceFingerprint` field.
      mastery[node.id] = { ...previous, sourceFingerprint: node.sourceFingerprint };
      continue;
    }
    let status = previous.status;
    if (previous.status === "stale") status = "stale";
    else if (previous.mastery >= 0.75) status = "mastered";
    else status = prerequisitesMet(node, { ...state, mastery }) ? "available" : "locked";
    mastery[node.id] = { ...previous, status, sourceFingerprint: node.sourceFingerprint };
  }
  const candidate = graph.nodes
    .filter((node) => mastery[node.id]?.status === "available")
    .sort((left, right) => {
      const score = (node: SkillNode) => node.importance * (1 - (mastery[node.id]?.mastery ?? 0));
      return score(right) - score(left);
    })[0];
  if (candidate) mastery[candidate.id] = { ...mastery[candidate.id], status: "recommended" };
  return { ...state, mastery, updatedAt: new Date().toISOString() };
}

export function addEvidence(state: LearnerState, graph: SkillGraph, skillId: string, evidence: Omit<LearningEvidence, "id" | "skillId" | "createdAt">): LearnerState {
  const current = state.mastery[skillId];
  if (!current) return state;
  const item: LearningEvidence = {
    ...evidence,
    id: `${evidence.kind}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    skillId,
    createdAt: new Date().toISOString(),
  };
  const strength = Math.max(0, Math.min(1, evidence.strength));
  const mastery = 1 - (1 - current.mastery) * (1 - strength);
  const next: LearnerState = {
    ...state,
    mastery: {
      ...state.mastery,
      [skillId]: {
        ...current,
        mastery,
        confidence: Math.max(current.confidence, Math.min(1, strength + 0.1)),
        status: mastery >= 0.75 ? "mastered" : current.status,
        evidence: [...current.evidence, item].slice(-30),
      },
    },
    updatedAt: new Date().toISOString(),
  };
  return recommend(next, graph);
}

export function completeDiagnostic(state: LearnerState, graph: SkillGraph, answers: Record<string, number>): LearnerState {
  let next = state;
  for (const question of graph.diagnostic) {
    const answer = answers[question.id] ?? question.options.length - 1;
    const strength = answer === 0 ? 0.72 : answer === 1 ? 0.35 : 0.05;
    next = addEvidence(next, graph, question.skillId, {
      kind: "diagnostic",
      strength,
      detail: `${question.prompt} — ${question.options[answer]}`,
    });
  }
  return recommend({ ...next, diagnosticCompleted: true }, graph);
}

export function skillForLesson(graph: SkillGraph, lessonId: string) {
  return graph.nodes.find((node) => node.lessonId === lessonId);
}

export function learningMemorySummary(state: LearnerState) {
  return state.memory.slice(-6).map((item) => item.text).join(" · ");
}

/**
 * Reweight a skill graph for a goal using item 43's shared keyword patterns, so
 * the start-screen goal, the generated curriculum, and the goal planner all
 * agree on what a goal considers relevant.
 */
export function personalizeSkillGraph(graph: SkillGraph, goal: LearnerGoal): SkillGraph {
  const pattern = goalKeywords(goal);
  return { ...graph, nodes: graph.nodes.map((node) => ({ ...node, importance: node.importance + (pattern.test(`${node.title} ${node.branch} ${node.summary ?? ""}`) ? 28 : 0) })) };
}
