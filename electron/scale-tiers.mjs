import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { buildKnowledgeGraph } from "./knowledge-graph.mjs";
import { generateStarterCourse } from "./course.mjs";
import { inspectRepository, resetAnalysisCache } from "./repository.mjs";
import { buildSearchIndex, search } from "./search.mjs";
import { cullGraph } from "./virtualization.mjs";
import { effectiveCeiling } from "./performance.mjs";

const run = promisify(execFile);

/**
 * Repository-scale performance tiers (item 13).
 *
 * Every budget declared in `performance.mjs` was validated against one shape
 * of repository: whatever the author's laptop happened to have checked out,
 * or the nine-file fixture `scripts/preflight.mjs` builds for CI. That proves
 * the arithmetic is right. It does not prove the *pipeline* holds up as a
 * repository grows from a weekend project to a monorepo — cold indexing could
 * be linear at 100 files and quadratic at 10,000 and the existing suite would
 * never notice, because it never ran at 10,000.
 *
 * So this module defines named tiers by file count, builds a synthetic git
 * repository at each tier (parameterised, not hand-authored, so "monorepo
 * scale" is reachable in a test's lifetime rather than requiring a real one
 * to be vendored in), and runs the five stages this item names — cold
 * indexing, incremental indexing, memory, search, graph construction, and
 * course generation — through every tier, reporting whether each one held
 * its *rate*, not merely its absolute time.
 *
 * Two decisions carry the value:
 *
 *   - **Rate, not time.** A tier-scaled budget asks "does the millisecond
 *     cost per file stay roughly flat as the repository grows ten times
 *     over", which is the actual claim a cold-indexing budget is making.
 *     `performance.mjs`'s `per`/`floor` machinery already expresses exactly
 *     that, so tier evaluation reuses it rather than inventing a parallel
 *     notion of "scaling" with different arithmetic.
 *
 *   - **A tier that cannot run says so.** Graph rendering (`virtualization.mjs`'s
 *     `cullGraph`) and course generation are pure functions this process can
 *     call directly; cold/incremental indexing, memory, and search need a real
 *     repository on disk. Building a monorepo-scale fixture is deliberately
 *     slower than a unit test should be, so `runTierSuite` accepts a `tiers`
 *     filter and reports `skipped` tiers explicitly rather than silently
 *     omitting them — the same discipline `preflight.mjs` applies to missing
 *     capabilities.
 */

export const SCALE_TIERS_VERSION = 1;

/**
 * Named tiers by file count, from a weekend project through a monorepo.
 *
 * `filesPerDirectory` controls fan-out: a monorepo is not one directory with
 * ten thousand files in it, it is many packages, which is also what makes its
 * import graph wide rather than deep. `graphNodes` is independent of file
 * count — rendering performance is governed by what is on screen, not by how
 * the repository was indexed, so the knowledge-graph tier for the virtualized
 * canvas is declared separately.
 */
export const SCALE_TIERS = [
  { id: "small", label: "Small (a weekend project)", files: 25, filesPerDirectory: 25, graphNodes: 400 },
  { id: "medium", label: "Medium (a real application)", files: 400, filesPerDirectory: 40, graphNodes: 4_000 },
  { id: "large", label: "Large (a mature product)", files: 2_500, filesPerDirectory: 60, graphNodes: 25_000 },
  { id: "monorepo", label: "Monorepo (many packages, one history)", files: 8_000, filesPerDirectory: 80, graphNodes: 80_000 },
];

export function tierIds() {
  return SCALE_TIERS.map((tier) => tier.id);
}

export function tierFor(id) {
  const tier = SCALE_TIERS.find((candidate) => candidate.id === id);
  if (!tier) throw new Error(`Unknown scale tier: ${id}`);
  return tier;
}

/**
 * Build a synthetic git repository with roughly `tier.files` Python files,
 * fanned out across `tier.filesPerDirectory`-sized packages, each importing
 * and calling into the previous module in its own package. That gives the
 * indexer real imports to resolve and real call edges to follow — the two
 * things that turn "files on disk" into the work `inspectRepository` and
 * `buildKnowledgeGraph` actually do — without requiring a real repository of
 * that size to exist anywhere.
 */
export async function buildScaleFixture(tier, { destination = null } = {}) {
  const rootPath = destination ?? (await mkdtemp(path.join(os.tmpdir(), `scale-fixture-${tier.id}-`)));
  const git = (...args) => run("git", ["-C", rootPath, ...args]);
  const perDirectory = Math.max(1, tier.filesPerDirectory ?? tier.files);
  const directoryCount = Math.max(1, Math.ceil(tier.files / perDirectory));
  let written = 0;
  for (let directoryIndex = 0; directoryIndex < directoryCount && written < tier.files; directoryIndex += 1) {
    const directory = path.join(rootPath, `pkg${directoryIndex}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "__init__.py"), "");
    for (let fileIndex = 0; fileIndex < perDirectory && written < tier.files; fileIndex += 1, written += 1) {
      const lines = [];
      if (fileIndex > 0) {
        lines.push(`from pkg${directoryIndex}.mod${fileIndex - 1} import helper${fileIndex - 1}`, "");
      }
      lines.push(
        `def helper${fileIndex}(x):`,
        fileIndex > 0 ? `    return helper${fileIndex - 1}(x) + ${fileIndex}` : `    return x + ${fileIndex}`,
        "",
        `class Service${fileIndex}:`,
        "    def run(self, x):",
        `        return helper${fileIndex}(x)`,
        "",
      );
      await writeFile(path.join(directory, `mod${fileIndex}.py`), lines.join("\n"));
    }
  }
  await writeFile(path.join(rootPath, "README.md"), `# ${tier.label}\n\nSynthetic fixture, ${tier.files} files.\n`);
  await git("init", "-q");
  await git("config", "user.email", "scale-tiers@example.com");
  await git("config", "user.name", "Scale Tiers");
  await git("add", "-A");
  await git("commit", "-qm", "initial");
  return rootPath;
}

/** A deterministic graph of the requested size, for the rendering tier. */
function buildSyntheticGraph(nodeCount) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodeCount)));
  const nodes = Array.from({ length: nodeCount }, (unused, index) => ({
    id: `n${index}`,
    x: (index % columns) * 12,
    y: Math.floor(index / columns) * 12,
    width: 10,
    height: 10,
    importance: index % 100,
  }));
  const edges = Array.from({ length: nodeCount }, (unused, index) => ({ from: `n${index}`, to: `n${(index + 1) % nodeCount}` }));
  return { nodes, edges };
}

/**
 * Run the five named stages for one tier.
 *
 * Cold indexing is measured first; incremental indexing changes exactly one
 * file and re-indexes, the way a save in an editor does, so the two numbers
 * answer different questions — "how long until I can use this" versus "how
 * long after I touch one thing" — rather than one standing in for the other.
 */
export async function measureTier(tier, { repositoriesDirectory = null, cleanup = true, destination = null } = {}) {
  const rootPath = await buildScaleFixture(tier, { destination });
  const reposDirectory = repositoriesDirectory ?? path.join(os.tmpdir(), "scale-tiers-repos");
  try {
    resetAnalysisCache();

    const coldStarted = performance.now();
    const coldRepository = await inspectRepository(rootPath, reposDirectory);
    const coldMs = performance.now() - coldStarted;

    await writeFile(path.join(rootPath, "pkg0", "mod0.py"), "def helper0(x):\n    return x + 999\n");

    const incrementalStarted = performance.now();
    const incrementalRepository = await inspectRepository(rootPath, reposDirectory);
    const incrementalMs = performance.now() - incrementalStarted;

    const coldGraphStarted = performance.now();
    const coldGraph = buildKnowledgeGraph(coldRepository);
    const coldGraphMs = performance.now() - coldGraphStarted;

    const incrementalGraphStarted = performance.now();
    const incrementalGraph = buildKnowledgeGraph(incrementalRepository, { previous: coldGraph });
    const incrementalGraphMs = performance.now() - incrementalGraphStarted;

    const searchIndexStarted = performance.now();
    const index = await buildSearchIndex(coldRepository, { read: (filePath) => readFile(path.join(rootPath, filePath), "utf8") });
    const searchIndexMs = performance.now() - searchIndexStarted;

    const coldSearchStarted = performance.now();
    search(index, "helper", { limit: 10 });
    const coldSearchMs = performance.now() - coldSearchStarted;

    const courseStarted = performance.now();
    generateStarterCourse(coldRepository);
    const courseMs = performance.now() - courseStarted;

    const renderGraph = buildSyntheticGraph(tier.graphNodes ?? tier.files);
    const renderStarted = performance.now();
    const culled = cullGraph({ ...renderGraph, viewport: { left: 0, top: 0, right: 400, bottom: 400 }, budget: 300 });
    const renderMs = performance.now() - renderStarted;

    return {
      tier: tier.id,
      files: coldRepository.stats.fileCount,
      analyzedFiles: coldRepository.stats.timing.analyzedFiles,
      truncated: coldRepository.stats.truncated,
      index: { coldMs, incrementalMs, speedup: incrementalMs > 0 ? coldMs / incrementalMs : null, peakRssBytes: coldRepository.stats.memory.peakRss, peakHeapBytes: coldRepository.stats.memory.peakHeap },
      graph: {
        coldMs: coldGraphMs,
        incrementalMs: incrementalGraphMs,
        nodeCount: coldGraph.stats.nodeCount,
        reusedPartitions: incrementalGraph.stats.reusedPartitions,
        rebuiltPartitions: incrementalGraph.stats.rebuiltPartitions,
      },
      search: { indexBuildMs: searchIndexMs, coldMs: coldSearchMs, indexedFiles: index.stats.indexedFiles },
      course: { buildMs: courseMs },
      render: { cullMs: renderMs, nodeCount: renderGraph.nodes.length, shown: culled.nodes.length, complete: culled.complete },
    };
  } finally {
    if (cleanup) await rm(rootPath, { recursive: true, force: true });
  }
}

/**
 * Tier-scoped budgets, expressed the same way `performance.mjs` expresses a
 * per-file budget: a rate with a floor, so the smallest tier is not held to
 * the steady-state cost it cannot amortise and the largest tier cannot hide a
 * super-linear regression inside a generous flat number.
 *
 * These are declared here, not merged into `BUDGETS`, because they judge a
 * synthetic fixture's *rate* across tiers rather than one real repository's
 * absolute measurement — a different question with a different unit of
 * comparison, and merging the two would make `budgetIds()` (relied on by
 * `docs-check.mjs` and the telemetry schema) report tier-fixture budgets as
 * though they were ceilings on the application a user runs.
 */
export const TIER_BUDGETS = {
  "index.coldMsPerFile": { label: "Cold indexing time", unit: "ms", limit: 15, warnAt: 8, per: "files", floor: 400, why: "Cold indexing must not grow worse than linearly with file count, or the largest repositories become unusable rather than merely slow." },
  // Measured floor: `inspectRepository` pays several fixed-cost `git`
  // subprocess round trips (status, blob ids, history) on every call, cold or
  // incremental, which dominates the real cost on small repositories — around
  // 220-320ms observed from 27 to 4,000 files. The floor is set above that
  // fixed cost so a tiny fixture is not failed for the one-time price of
  // starting `git`, while the per-file rate still catches a cache that stops
  // doing its job as the repository grows.
  "index.incrementalMsPerFile": { label: "Incremental indexing time", unit: "ms", limit: 6, warnAt: 3, per: "files", floor: 350, why: "An incremental re-index after one file changes should cost close to a constant, not scale with the whole repository, or the analysis cache is not doing its job at scale." },
  "graph.coldMsPerFile": { label: "Knowledge-graph construction", unit: "ms", limit: 1.5, warnAt: 0.8, per: "files", floor: 20, why: "The graph is rebuilt from the indexed files on every full index; a super-linear builder makes the largest repositories pay a second, hidden indexing cost." },
  "graph.incrementalMsPerFile": { label: "Knowledge-graph incremental rebuild", unit: "ms", limit: 0.3, warnAt: 0.15, per: "files", floor: 5, why: "Partition reuse (item 46) exists precisely so one changed file does not force rebuilding the whole graph; a tier where it stops holding is a regression in that guarantee, not merely a slow run." },
  "search.indexBuildMsPerFile": { label: "Search index construction", unit: "ms", limit: 1, warnAt: 0.5, per: "indexedFiles", floor: 50, why: "Built once per repository version; a super-linear cost here is paid by every learner opening a large repository for the first time." },
  "search.coldQueryMs": { label: "First query after indexing", unit: "ms", limit: 50, warnAt: 20, why: "The query vocabulary and candidate set both scale with the repository, but the structures involved (inverted index, hashed embedding) are designed for sublinear lookup; a tier where the first query grows with file count means that design assumption broke." },
  "course.buildMs": { label: "Starter course generation", unit: "ms", limit: 300, warnAt: 150, why: "Course generation ranks directories and files by importance; it must stay well under what a learner would notice as a wait, even at the largest tier, because it runs once per repository open rather than being cached ahead of time." },
  "render.cullMs": { label: "Graph viewport culling", unit: "ms", limit: 40, warnAt: 20, why: "Virtualization (item 50) exists so render cost depends on viewport density, not total graph size; a tier where culling itself grows with the full node count means the guard is doing the work it was meant to avoid." },
};

export function tierBudgetIds() {
  return Object.keys(TIER_BUDGETS).sort();
}

function judge(id, value, size) {
  const budget = TIER_BUDGETS[id];
  if (!budget) throw new Error(`Unknown tier budget: ${id}`);
  const ceiling = effectiveCeiling(budget, size);
  const warnCeiling = effectiveCeiling(budget, size, "warnAt");
  const verdict = !Number.isFinite(value) ? "insufficient-data" : value > ceiling ? "fail" : value > warnCeiling ? "warn" : "pass";
  return { id, label: budget.label, unit: budget.unit, value: Number.isFinite(value) ? Number(value.toFixed(3)) : null, ceiling: Number(ceiling.toFixed(3)), size, verdict, why: budget.why };
}

/** Judge one tier's measurement against the tier budgets declared above. */
export function evaluateTierMeasurement(measurement) {
  const files = measurement.files || 1;
  const indexedFiles = measurement.search.indexedFiles || 1;
  const results = [
    judge("index.coldMsPerFile", measurement.index.coldMs, files),
    judge("index.incrementalMsPerFile", measurement.index.incrementalMs, files),
    judge("graph.coldMsPerFile", measurement.graph.coldMs, files),
    judge("graph.incrementalMsPerFile", measurement.graph.incrementalMs, files),
    judge("search.indexBuildMsPerFile", measurement.search.indexBuildMs, indexedFiles),
    judge("search.coldQueryMs", measurement.search.coldMs, null),
    judge("course.buildMs", measurement.course.buildMs, null),
    judge("render.cullMs", measurement.render.cullMs, null),
  ];
  const failures = results.filter((result) => result.verdict === "fail");
  const warnings = results.filter((result) => result.verdict === "warn");
  return {
    tier: measurement.tier,
    results,
    passed: failures.length === 0,
    failures: failures.map((result) => result.id),
    warnings: warnings.map((result) => result.id),
    summary: failures.length
      ? `${failures.length} tier budget(s) exceeded at tier ${measurement.tier}: ${failures.map((result) => `${result.id} at ${result.value} ${result.unit} against ${result.ceiling}`).join("; ")}`
      : `All tier budgets held at tier ${measurement.tier}${warnings.length ? ` (${warnings.length} in the warning band)` : ""}.`,
  };
}

/**
 * Measure and judge every requested tier (or every declared tier, by
 * default), reporting any tier that could not be measured rather than
 * omitting it — the same "unmeasured is a fact, not a gap" rule
 * `evaluateAll` already applies to the per-repository budgets.
 */
export async function runTierSuite({ tiers = tierIds(), repositoriesDirectory = null } = {}) {
  const requested = tiers.map((id) => tierFor(id));
  const measurements = [];
  const skipped = [];
  for (const tier of requested) {
    try {
      measurements.push(await measureTier(tier, { repositoriesDirectory }));
    } catch (cause) {
      skipped.push({ tier: tier.id, reason: cause?.message ?? String(cause) });
    }
  }
  const evaluations = measurements.map((measurement) => evaluateTierMeasurement(measurement));
  const failing = evaluations.filter((evaluation) => !evaluation.passed);
  return {
    version: SCALE_TIERS_VERSION,
    tiers: requested.map((tier) => tier.id),
    measurements,
    evaluations,
    skipped,
    passed: failing.length === 0 && skipped.length === 0,
    summary: skipped.length
      ? `${skipped.length} tier(s) could not be measured: ${skipped.map((entry) => `${entry.tier} (${entry.reason})`).join("; ")}`
      : failing.length
        ? `${failing.length} tier(s) exceeded a budget: ${failing.map((evaluation) => evaluation.tier).join(", ")}`
        : `All ${evaluations.length} tier(s) held every budget.`,
  };
}

/**
 * Describe how a measurement scaled across tiers, so a regression that is
 * invisible within one tier (because it is still under that tier's absolute
 * ceiling) is visible as a trend across several — the earlier warning sign a
 * single-tier check structurally cannot give.
 */
export function describeTierScaling(measurements, field, { minimumMs = 2 } = {}) {
  const read = (measurement) => field.split(".").reduce((value, key) => value?.[key], measurement);
  const points = measurements
    .map((measurement) => ({ tier: measurement.tier, files: measurement.files, value: read(measurement) }))
    .filter((point) => Number.isFinite(point.value) && point.files > 0);
  if (points.length < 2) return { points, ratePerFile: [], superlinear: false, reliable: false, detail: "Fewer than two tiers were measured; a scaling trend needs at least two points." };
  const ratePerFile = points.map((point) => ({ tier: point.tier, files: point.files, value: point.value, msPerFile: Number((point.value / point.files).toFixed(5)) }));
  const first = ratePerFile[0];
  const last = ratePerFile.at(-1);
  // Below `minimumMs` the measurement is dominated by timer resolution and
  // scheduler noise rather than by the work itself -- the smallest tier's
  // graph build, for instance, can finish in a single digit of milliseconds,
  // where a 1ms jitter is a 50% "regression" that has nothing to do with the
  // algorithm. The same discipline `performance.mjs`'s `summarize` applies to
  // too few samples applies here to too little absolute time: not reliable is
  // reported rather than a confident-looking ratio computed from noise.
  const reliable = first.value >= minimumMs && last.value >= minimumMs;
  // A rate that more than doubles from the smallest to the largest tier is the
  // signature of super-linear growth; linear work has a roughly flat rate.
  const superlinear = reliable && first.msPerFile > 0 && last.msPerFile / first.msPerFile > 2;
  return {
    points,
    ratePerFile,
    reliable,
    superlinear,
    detail: !reliable
      ? `The smallest measured value for ${field} (${Math.min(first.value, last.value)} ms) is below the ${minimumMs} ms floor needed before a per-file rate means anything; not evaluated for scaling.`
      : superlinear
        ? `The per-file rate for ${field} grew from ${first.msPerFile} to ${last.msPerFile} ms/file (${(last.msPerFile / first.msPerFile).toFixed(1)}x) between the smallest and largest measured tier, which is faster than the file count itself grew.`
        : `The per-file rate for ${field} stayed within 2x across measured tiers (${first.msPerFile} to ${last.msPerFile} ms/file).`,
  };
}
