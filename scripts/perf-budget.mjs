import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compareToBaseline, describeBudgets, evaluateAll } from "../electron/performance.mjs";
import { inspectRepository } from "../electron/repository.mjs";
import { buildSearchIndex, search } from "../electron/search.mjs";
import { createFixtureRepository } from "./preflight.mjs";

/**
 * Measure the budgets that can be measured without a window (item 57).
 *
 * Startup and rendering need a real Electron process and a real browser, so
 * they are measured by the smoke tests; indexing, memory, and search are
 * measured here, where they can be run on any machine against a repository
 * generated from scratch. That split is deliberate: a performance check that
 * only runs on one laptop is the defect item 54 spent its time removing.
 *
 * The entry-bundle budget is read from `dist` when it exists and reported as
 * unmeasured when it does not, rather than being skipped silently.
 */

const QUERIES = [
  "scheduler", "engine step", "allocate block", "postprocess tokens", "round up",
  "kernel launch", "runner", "capacity", "sequence", "design",
  "generate", "waiting queue",
];

function argumentValue(name, fallback = null) {
  const prefixed = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return prefixed ? prefixed.slice(name.length + 3) : fallback;
}

/** Bytes the browser downloads before anything can be clicked. */
export async function entryBundleBytes(distDirectory) {
  const html = await readFile(path.join(distDirectory, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script[^>]+src="\.\/assets\/([^"]+)"/g)].map((match) => match[1]);
  const preloads = [...html.matchAll(/rel="modulepreload"[^>]+href="\.\/assets\/([^"]+)"/g)].map((match) => match[1]);
  let bytes = 0;
  for (const asset of [...new Set([...scripts, ...preloads])]) {
    bytes += Buffer.byteLength(await readFile(path.join(distDirectory, "assets", asset)));
  }
  return bytes;
}

/**
 * Index a repository and search it, recording what each step cost.
 *
 * Every query is run twice and only the second timing is kept for the
 * percentile: the first touches cold caches and would drag a p95 upwards for a
 * reason that has nothing to do with steady-state query cost. The genuinely
 * cold first query is recorded separately, under its own budget, because it is
 * the one a learner judges the feature by.
 */
export async function measureWorkspace(rootPath, { repositoriesDirectory } = {}) {
  const repository = await inspectRepository(rootPath, repositoriesDirectory ?? path.join(os.tmpdir(), "trace-perf-repos"));
  const searchIndexStarted = performance.now();
  const index = await buildSearchIndex(repository, { read: (filePath) => readFile(path.join(rootPath, filePath), "utf8") });
  const searchIndexMs = performance.now() - searchIndexStarted;

  const coldStarted = performance.now();
  search(index, QUERIES[0], { limit: 10 });
  const coldMs = performance.now() - coldStarted;

  const samples = [];
  for (const query of QUERIES) {
    search(index, query, { limit: 10 });
    const started = performance.now();
    search(index, query, { limit: 10 });
    samples.push(performance.now() - started);
  }

  return {
    repository: { rootPath, files: repository.stats.fileCount, analyzed: repository.stats.timing.analyzedFiles, bytes: repository.stats.totalBytes },
    timing: repository.stats.timing,
    memory: repository.stats.memory,
    searchIndexMs,
    coldMs,
    samples,
    indexedFiles: index.stats?.indexedFiles ?? repository.stats.fileCount,
  };
}

/** Turn a measurement into the shape `evaluateAll` judges. */
export function measurementsFrom(measured, { entryBytes = null } = {}) {
  // Totals, not rates: the budget carries the rate and scales it by `size`.
  const files = measured.repository.files || 1;
  const indexed = measured.indexedFiles || 1;
  const measurements = {
    "index.totalMs": measured.timing.totalMs,
    "index.peakRssBytes": measured.memory.peakRss,
    "index.peakHeapBytes": measured.memory.peakHeap,
    "search.coldMs": measured.coldMs,
    "search.p95Ms": { samples: measured.samples },
    "search.indexBuildMs": measured.searchIndexMs,
  };
  if (entryBytes !== null) measurements["render.entryBundleBytes"] = entryBytes;
  const sizes = {
    "index.totalMs": { size: files },
    "index.peakRssBytes": { size: files },
    "index.peakHeapBytes": { size: files },
    "search.indexBuildMs": { size: indexed },
  };
  return { measurements, sizes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const requested = argumentValue("repo", null);
  const outputPath = argumentValue("out", null);
  const baselinePath = argumentValue("baseline", null);
  let rootPath = requested;
  let temporary = null;
  if (!rootPath) {
    // No repository given: build one, so this runs the same everywhere.
    temporary = await createFixtureRepository();
    rootPath = temporary;
  }

  try {
    const measured = await measureWorkspace(rootPath);
    let entryBytes = null;
    try {
      await readdir(path.resolve("dist", "assets"));
      entryBytes = await entryBundleBytes(path.resolve("dist"));
    } catch {
      entryBytes = null;
    }
    const { measurements, sizes } = measurementsFrom(measured, { entryBytes });
    const report = evaluateAll(measurements, sizes);
    const output = {
      version: report.version,
      machine: { platform: `${os.platform()}-${os.arch()}`, cpus: os.cpus().length, node: process.version },
      repository: measured.repository,
      phases: measured.timing.phases,
      memoryActions: measured.memory.actions,
      ...report,
    };
    if (baselinePath) {
      try {
        output.regression = compareToBaseline(report, JSON.parse(await readFile(baselinePath, "utf8")));
      } catch (cause) {
        output.regression = { unavailable: true, reason: cause?.message ?? "The baseline could not be read." };
      }
    }
    if (outputPath) {
      await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
      await writeFile(path.resolve(outputPath), `${JSON.stringify(output, null, 2)}\n`);
    }
    console.log(JSON.stringify(output, null, 2));
    console.log(describeBudgets(report));
    if (entryBytes === null) console.error("dist is absent, so the entry-bundle budget was not measured. Run `npm run build` first.");
    if (!report.passed) {
      console.error(report.summary);
      process.exitCode = 1;
    }
    if (output.regression && output.regression.clean === false) {
      console.error(output.regression.summary);
      process.exitCode = 1;
    }
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
