import type { LearnerState, LearningEvidence, SkillGraph, SkillMastery, SkillNode } from "./types";

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

export function recommend(state: LearnerState, graph: SkillGraph): LearnerState {
  const mastery = { ...state.mastery };
  for (const node of graph.nodes) {
    const previous = mastery[node.id] ?? { skillId: node.id, mastery: 0, confidence: 0, status: "locked", evidence: [], sourceFingerprint: node.sourceFingerprint };
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

export function personalizeSkillGraph(graph: SkillGraph, goal: "architecture" | "critical_path" | "contribute" | "review"): SkillGraph {
  const matchers = {
    architecture: /system|map|engine|architecture|boundary/i,
    critical_path: /loop|scheduler|prefill|decode|runner|flow/i,
    contribute: /project|practice|test|scheduler/i,
    review: /state|cache|design|system|correct/i,
  };
  return { ...graph, nodes: graph.nodes.map((node) => ({ ...node, importance: node.importance + (matchers[goal].test(`${node.title} ${node.branch}`) ? 28 : 0) })) };
}
