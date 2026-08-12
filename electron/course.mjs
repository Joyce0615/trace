import { createHash } from "node:crypto";

function anchorFor(repo, filePath, preferredSymbol) {
  const symbols = repo.symbols.filter((symbol) => symbol.path === filePath);
  const symbol = preferredSymbol ?? symbols[0];
  return {
    path: filePath,
    line: symbol?.line ?? 1,
    symbol: symbol?.name ?? null,
  };
}

function rankedMatch(repo, predicate, fallbackIndex = 0) {
  return [...repo.files]
    .filter(predicate)
    .sort((left, right) => (right.importance ?? 0) - (left.importance ?? 0) || left.path.localeCompare(right.path))[0]?.path
    ?? repo.files[fallbackIndex]?.path
    ?? null;
}

function defaultContent(id, title, objective, anchor) {
  const safeAnchor = anchor ?? { path: "README.md", line: 1, symbol: null };
  return [
    { id: `${id}-story`, type: "narrative", eyebrow: "SOURCE-GROUNDED LESSON", title, body: objective },
    { id: `${id}-walkthrough`, type: "timeline", title: "Read this node in three passes", steps: [
      { label: "Orient", detail: "Identify the module boundary and public surface.", anchor: { ...safeAnchor, line: 1 } },
      { label: "Trace", detail: "Follow inputs, state changes, and outputs.", anchor: safeAnchor },
      { label: "Explain", detail: "Connect the implementation back to the lesson objective.", anchor: safeAnchor },
    ] },
  ];
}

function lesson(id, title, objective, anchor, options = {}) {
  return {
    id,
    title,
    objective,
    summary: options.summary ?? objective,
    duration: options.duration ?? 12,
    difficulty: options.difficulty ?? "foundation",
    kind: options.kind ?? "lesson",
    status: "ready",
    anchors: anchor ? [anchor] : [],
    quiz: options.quiz ?? {
      question: `In your own words, explain the role of “${title}” in this repository.`,
      hint: "Structure your answer around inputs, the main processing steps, and outputs.",
    },
    content: options.content ?? defaultContent(id, title, objective, anchor),
  };
}

export function generateStarterCourse(repo, profile = { goal: "architecture", level: "adaptive" }) {
  if (!repo.files.length) throw new Error("The repository does not contain readable files.");

  const readme = rankedMatch(repo, (file) => /^readme(\.|$)/i.test(file.name));
  const manifest = rankedMatch(repo, (file) => ["package.json", "pyproject.toml", "cargo.toml", "go.mod", "setup.py"].includes(file.name.toLowerCase()));
  const entry = repo.entryFiles[0] ?? rankedMatch(repo, (file) => ["typescript", "javascript", "python", "go", "rust", "cuda", "cpp"].includes(file.language));
  const testFile = rankedMatch(repo, (file) => /(^|\/)(test|tests|spec|__tests__)(\/|\.)/i.test(file.path) && (/^test_.+|.+\.(test|spec)\./i.test(file.name)));

  const directoryScores = new Map();
  for (const file of repo.files) {
    const directory = file.directory.split("/")[0];
    if (!directory || directory.startsWith(".") || ["3rdparty", "vendor", "ci", "scripts", "benchmarks"].includes(directory)) continue;
    if (!repo.symbols.some((symbol) => symbol.path === file.path)) continue;
    directoryScores.set(directory, Math.max(directoryScores.get(directory) ?? -Infinity, file.importance ?? 0));
  }
  const directories = [...directoryScores.entries()].sort((left, right) => right[1] - left[1]).slice(0, 3).map(([directory]) => directory);
  const coreFiles = directories
    .map((directory) => rankedMatch(repo, (file) => file.path.startsWith(`${directory}/`) && repo.symbols.some((symbol) => symbol.path === file.path)))
    .filter(Boolean);
  if (!coreFiles.length && entry) coreFiles.push(entry);

  const modules = [
    {
      id: "orientation",
      number: "01",
      title: "Build the System Map",
      summary: "Understand why the repository exists, how it is organized, and where execution begins.",
      lessons: [
        lesson("purpose", "Repository Purpose and Boundaries", "Identify the problem this project solves, its primary users, and what it deliberately leaves out.", anchorFor(repo, readme ?? manifest ?? entry), { duration: 8 }),
        lesson("structure", "Directory Structure and Stack", "Build a mental model of the top-level directories, core dependencies, and language distribution.", anchorFor(repo, manifest ?? readme ?? entry), { duration: 10 }),
        lesson("entry", "Find the Execution Entry Point", "Follow the startup file through the first important initialization steps.", anchorFor(repo, entry ?? manifest), { duration: 14 }),
      ],
    },
    {
      id: "core-flow",
      number: "02",
      title: "Trace the Critical Path",
      summary: "Move from the entry point into the modules that carry the system's core behavior.",
      lessons: coreFiles.slice(0, 3).map((filePath, index) => {
        const symbol = repo.symbols.find((candidate) => candidate.path === filePath);
        return lesson(
          `core-${index + 1}`,
          symbol ? `Understand ${symbol.name}` : `Explore ${filePath.split("/")[0]}`,
          "Trace what this module receives, what it changes, and which neighboring components it depends on.",
          anchorFor(repo, filePath, symbol),
          { duration: 16 + index * 2, difficulty: index ? "intermediate" : "foundation" },
        );
      }),
    },
    {
      id: "confidence",
      number: "03",
      title: "Validate Your Understanding",
      summary: "Turn passive reading into demonstrable understanding through tests and a small change.",
      lessons: [
        lesson("tests", "How Tests Define Correctness", "Understand the test structure, fixtures, and the most important behavioral assertions.", anchorFor(repo, testFile ?? entry), { duration: 14, difficulty: "intermediate" }),
        lesson("practice", "Make a Safe Change", "Complete a small change in an isolated worktree and validate it with tests.", anchorFor(repo, entry ?? testFile), {
          duration: 25,
          difficulty: "intermediate",
          kind: "practice",
          quiz: {
            question: "Choose a small improvement that does not change the public API. Which test would prove that it is safe?",
            hint: "Consider error messages, boundary conditions, or an existing TODO.",
          },
        }),
      ],
    },
  ].filter((module) => module.lessons.length);

  const digest = createHash("sha256")
    .update(`${repo.id}:${repo.head}:${modules.flatMap((module) => module.lessons.map((item) => item.id)).join(":")}`)
    .digest("hex")
    .slice(0, 12);

  return {
    id: `course-${digest}`,
    repositoryId: repo.id,
    sourceCommit: repo.head,
    sourceVersion: repo.versionId,
    title: `${repo.name} Deep Dive`,
    subtitle: {
      architecture: "From system map to your first confident change",
      critical_path: "Understand system behavior through critical call paths",
      contribute: "A focused path toward your first contribution",
      review: "From design constraints to high-quality code review",
    }[profile.goal] ?? "From system map to your first confident change",
    level: profile.level,
    profile,
    generatedBy: "local-indexer",
    generatedAt: new Date().toISOString(),
    modules,
  };
}

function safeText(value, fallback, maximum = 240) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : fallback;
}

function safeId(value, fallback) {
  const normalized = typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48)
    : "";
  return normalized || fallback;
}

export function normalizeAgentCourse(repo, starterCourse, draft, provider) {
  if (!draft || !Array.isArray(draft.modules)) throw new Error("Agent returned an invalid curriculum.");
  const validPaths = new Set(repo.files.map((file) => file.path));
  const starterLessons = starterCourse.modules.flatMap((module) => module.lessons);
  const lessonIds = new Set();

  const modules = draft.modules.slice(0, 8).map((candidateModule, moduleIndex) => {
    const rawLessons = Array.isArray(candidateModule?.lessons) ? candidateModule.lessons : [];
    const lessons = rawLessons.slice(0, 10).map((candidate, lessonIndex) => {
      const fallback = starterLessons[(moduleIndex + lessonIndex) % starterLessons.length];
      const rawAnchor = candidate?.anchor ?? candidate?.anchors?.[0];
      const anchor = rawAnchor && validPaths.has(rawAnchor.path)
        ? {
            path: rawAnchor.path,
            line: Number.isFinite(rawAnchor.line) ? Math.max(1, Math.floor(rawAnchor.line)) : 1,
            symbol: typeof rawAnchor.symbol === "string" ? rawAnchor.symbol.slice(0, 120) : null,
          }
        : fallback?.anchors?.[0] ?? null;
      const baseId = safeId(candidate?.id, `lesson-${moduleIndex + 1}-${lessonIndex + 1}`);
      let id = baseId;
      let suffix = 2;
      while (lessonIds.has(id)) id = `${baseId}-${suffix++}`;
      lessonIds.add(id);
      const difficulty = ["foundation", "intermediate", "advanced"].includes(candidate?.difficulty)
        ? candidate.difficulty
        : fallback?.difficulty ?? "foundation";
      const kind = ["lesson", "quiz", "practice", "project"].includes(candidate?.kind)
        ? candidate.kind
        : "lesson";
      return {
        id,
        title: safeText(candidate?.title, fallback?.title ?? `Lesson ${lessonIndex + 1}`, 100),
        objective: safeText(candidate?.objective, fallback?.objective ?? "Understand the responsibilities and data flow of the relevant code."),
        summary: safeText(candidate?.summary, fallback?.summary ?? "Read and explain the relevant implementation."),
        duration: Number.isFinite(candidate?.duration) ? Math.min(90, Math.max(5, Math.round(candidate.duration))) : 15,
        difficulty,
        kind,
        status: "ready",
        anchors: anchor ? [anchor] : [],
        quiz: {
          question: safeText(candidate?.quiz?.question, fallback?.quiz?.question ?? "What is the most important responsibility of this code?"),
          hint: safeText(candidate?.quiz?.hint, fallback?.quiz?.hint ?? "Think in terms of inputs, processing, and outputs."),
        },
        content: fallback?.content ?? defaultContent(id, candidate?.title ?? fallback?.title ?? `Lesson ${lessonIndex + 1}`, candidate?.objective ?? fallback?.objective ?? "Understand this implementation.", anchor),
      };
    });
    return {
      id: safeId(candidateModule?.id, `module-${moduleIndex + 1}`),
      number: String(moduleIndex + 1).padStart(2, "0"),
      title: safeText(candidateModule?.title, `Module ${moduleIndex + 1}`, 100),
      summary: safeText(candidateModule?.summary, "Understand the shared responsibilities of this group of code."),
      lessons,
    };
  }).filter((module) => module.lessons.length);

  if (!modules.length) throw new Error("Agent curriculum did not contain usable lessons.");
  const digest = createHash("sha256").update(`${repo.id}:${repo.head}:${provider}:${Date.now()}`).digest("hex").slice(0, 12);
  return {
    ...starterCourse,
    id: `course-${digest}`,
    title: safeText(draft.title, starterCourse.title, 120),
    subtitle: safeText(draft.subtitle, starterCourse.subtitle, 180),
    generatedBy: provider,
    generatedAt: new Date().toISOString(),
    modules,
  };
}
