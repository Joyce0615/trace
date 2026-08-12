import { createHash } from "node:crypto";

function depthFor(difficulty) {
  return difficulty === "advanced" ? "deep" : difficulty === "intermediate" ? "working" : "foundation";
}

function goalBoost(profile, module, lesson) {
  const text = `${module.title} ${lesson.title} ${lesson.objective}`.toLowerCase();
  if (profile?.goal === "critical_path" && /flow|path|trace|execution|scheduler/.test(text)) return 24;
  if (profile?.goal === "contribute" && /test|practice|project|change|contribut/.test(text)) return 30;
  if (profile?.goal === "review" && /design|boundary|test|correct|trade/.test(text)) return 24;
  if (profile?.goal === "architecture" && /map|purpose|structure|entry|architecture/.test(text)) return 20;
  return 0;
}

export function buildSkillGraph(repository, course) {
  const nodes = [];
  course.modules.forEach((module, moduleIndex) => {
    module.lessons.forEach((lesson, lessonIndex) => {
      const previousModule = course.modules[moduleIndex - 1];
      const moduleRoot = module.lessons[0];
      const prerequisites = [];
      if (moduleIndex > 0 && lessonIndex === 0) {
        const previousRoot = previousModule?.lessons[0];
        if (previousRoot) prerequisites.push(`skill-${previousRoot.id}`);
      } else if (lessonIndex > 0 && moduleRoot) {
        prerequisites.push(`skill-${moduleRoot.id}`);
      }
      nodes.push({
        id: `skill-${lesson.id}`,
        title: lesson.title,
        summary: lesson.objective,
        lessonId: lesson.id,
        prerequisites,
        anchors: lesson.anchors,
        depth: depthFor(lesson.difficulty),
        branch: module.title,
        importance: Math.max(25, 100 - moduleIndex * 12 - lessonIndex * 4 + goalBoost(course.profile, module, lesson)),
        estimatedMinutes: lesson.duration,
        sourceFingerprint: createHash("sha256")
          .update(
            lesson.anchors
              .map((anchor) => `${anchor.path}:${repository.files?.find((file) => file.path === anchor.path)?.blobId ?? repository.versionId}`)
              .join("|"),
          )
          .digest("hex")
          .slice(0, 16),
      });
    });
  });

  const diagnostic = nodes.slice(0, 4).map((node, index) => ({
    id: `diagnostic-${node.id}`,
    skillId: node.id,
    prompt: index === 0
      ? `How confidently could you explain “${node.title}” using a concrete source reference?`
      : `Which statement best describes your current understanding of “${node.title}”?`,
    options: index === 0
      ? ["I can explain it and point to the implementation", "I know the idea but not this implementation", "This is new to me"]
      : ["I could trace it through the code", "I recognize the concept", "I would like to learn it from the beginning"],
    correctIndex: 0,
    explanation: `Trace will verify confidence later with the source anchors for ${node.title}.`,
  }));
  const digest = createHash("sha256").update(`${repository.id}:${repository.versionId}:${nodes.map((node) => node.id).join(":")}`).digest("hex").slice(0, 12);
  return {
    id: `skills-${digest}`,
    repositoryId: repository.id,
    sourceVersion: repository.versionId,
    generatedBy: course.generatedBy,
    nodes,
    diagnostic,
  };
}

export function createLearnerState(repository, skillGraph) {
  const mastery = {};
  skillGraph.nodes.forEach((node, index) => {
    const root = node.prerequisites.length === 0;
    mastery[node.id] = {
      skillId: node.id,
      mastery: 0,
      confidence: 0,
      status: root ? (index === 0 ? "recommended" : "available") : "locked",
      evidence: [],
      sourceFingerprint: node.sourceFingerprint,
    };
  });
  return {
    repositoryId: repository.id,
    sourceVersion: repository.versionId,
    diagnosticCompleted: false,
    mastery,
    memory: [],
    updatedAt: new Date().toISOString(),
  };
}

export function reconcileLearnerState(repository, skillGraph, saved) {
  if (!saved || saved.repositoryId !== repository.id) return createLearnerState(repository, skillGraph);
  const next = createLearnerState(repository, skillGraph);
  next.diagnosticCompleted = Boolean(saved.diagnosticCompleted);
  next.memory = Array.isArray(saved.memory) ? saved.memory.slice(-50) : [];
  for (const node of skillGraph.nodes) {
    const previous = saved.mastery?.[node.id];
    if (!previous) continue;
    next.mastery[node.id] = {
      ...next.mastery[node.id],
      ...previous,
      skillId: node.id,
      status: previous.sourceFingerprint
        && node.sourceFingerprint
        && previous.sourceFingerprint !== node.sourceFingerprint
        && previous.mastery > 0
        ? "stale"
        : previous.status,
      evidence: Array.isArray(previous.evidence) ? previous.evidence.slice(-30) : [],
      sourceFingerprint: node.sourceFingerprint,
    };
  }
  next.sourceVersion = repository.versionId;
  next.updatedAt = new Date().toISOString();
  return next;
}
