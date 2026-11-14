import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactValue } from "./secret-scanner.mjs";
import { readRepositoryFile } from "./repository.mjs";

/**
 * Sandboxed programmatic repository exercises (item 41).
 *
 * Every exercise so far has asked the learner to produce an *answer*:
 * reimplement a function (item 5), explain a trace (item 25), predict an
 * output (item 31). This one asks them to produce a *procedure* — a short
 * script that calls a small, named set of tools to find a fact about the
 * repository, the way a working engineer reaches for `grep`, a REPL, or a
 * debugger rather than deriving the answer in their head. It is the one
 * exercise in this application where the learner writes orchestration code
 * rather than domain code, which is a different and useful skill to assess.
 *
 * Three design decisions separate this from `executable-quiz.mjs`, on
 * purpose:
 *
 *   - **The oracle is not recorded by running the submission.** A quiz's
 *     hidden tests come from executing the *real* implementation once and
 *     keeping what it returned, because nobody else has the right answer in
 *     hand. Here the right answer is a fact already sitting in the index
 *     (`repository.symbols`, `repository.callEdges`, `repository.files`), so
 *     it is computed directly from that index and never by running anything.
 *     The learner's script and the host's oracle both read the *same*
 *     underlying data; the exercise is whether the learner's orchestration
 *     reaches the same conclusion the index already recorded.
 *
 *   - **The sandbox is a reachability boundary, not a removal boundary.** A
 *     Python function has no legitimate reason to touch the filesystem, so
 *     `executable-quiz.mjs` spends its effort *removing* access from a
 *     general-purpose interpreter. A repository-analysis script's entire
 *     point is to look things up, so this module spends its effort on
 *     *which* lookups exist rather than removing all of them: the submission
 *     runs inside a `node:vm` context (`repository-exercise-host.mjs`) whose
 *     global object carries nothing beyond the language's own intrinsics and
 *     the `tools` object this file hands it — no `process`, no `require`, no
 *     `fetch`, no ambient secret, because none of those names exist to find.
 *     Node's own documentation is explicit that `vm` is not a security
 *     boundary against a hostile V8; this is a correctness-by-construction
 *     boundary for ordinary JavaScript, which is why the submission still
 *     runs in a disposable child process with a bare environment — the same
 *     "fault boundary, not a sandbox" posture `plugins.mjs` states for signed
 *     plugin code, applied here to unsigned learner text.
 *
 *   - **Tools are granted per exercise, and re-checked host-side on every
 *     call.** A `list-files` task never receives a `read-file` tool to call,
 *     because the child process's own `tools` object has no such property —
 *     but the parent checks the capability again when the call arrives
 *     anyway, because (per `plugins.mjs`'s and the threat model's recurring
 *     rule) a check performed only inside the thing being restrained is not a
 *     check.
 *
 * The run produces a deterministic trace: the ordered list of tool calls the
 * submission actually made, each bounded in size and count. "Deterministic"
 * here means what `execution-trace.mjs` means by a recorded run — the same
 * submission against the same repository version produces the same sequence
 * of tool calls and tool answers — not that arbitrary learner code is somehow
 * made free of its own nondeterminism (a `Math.random()` is still the
 * learner's choice to make, and still visible in the trace as whatever they
 * did with it).
 *
 * Stated limitation: the host-computed answer is registered with the
 * answer-leak guard (`answer-guard.mjs`) like every other oracle, but it is
 * short by construction for several task kinds (a file count, a caller
 * count) — short answers are protected structurally, by never being a field
 * name in the response, rather than by the guard's value scan, exactly the
 * limitation `answer-guard.mjs` already states for itself.
 */

export const REPOSITORY_EXERCISE_VERSION = 1;

/**
 * What a repository-exercise script may ask the host to do. Distinct from
 * `PLUGIN_CAPABILITIES` in `plugins.mjs` — a different grant list for a
 * different trust boundary — even where the names read alike.
 */
export const EXERCISE_CAPABILITIES = {
  "list-files": "List the repository-relative paths the index tracked. No sizes, no contents.",
  "read-file": "Read one file from inside the repository being analyzed, through the host's path validation.",
  "symbols": "Read the definitions the built-in indexers found for one file.",
  "callers": "Read the resolved call edges whose callee is one named symbol.",
};

/** Kinds this module knows how to build, richest signal first. */
export const EXERCISE_KINDS = ["file-with-most-functions", "caller-count", "line-count", "repository-size"];

export const DEFAULT_EXERCISE_LIMITS = {
  timeoutMs: 8_000,
  maxHostCalls: 50,
  maxTraceEntries: 50,
  maxOutputBytes: 50_000,
  maxSubmissionBytes: 8_000,
  maxReadBytes: 200_000,
};

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

function digest(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function baseExercise(repository, parts) {
  return {
    available: true,
    version: REPOSITORY_EXERCISE_VERSION,
    id: `repo-exercise-${digest(`${repository.versionId ?? ""}:${parts.kind}:${JSON.stringify(parts.goldAnswer)}`)}`,
    kind: parts.kind,
    prompt: parts.prompt,
    starter: parts.starter,
    capabilities: parts.capabilities,
    anchor: parts.anchor ?? null,
    limits: {
      timeoutMs: DEFAULT_EXERCISE_LIMITS.timeoutMs,
      maxHostCalls: DEFAULT_EXERCISE_LIMITS.maxHostCalls,
      maxSubmissionBytes: DEFAULT_EXERCISE_LIMITS.maxSubmissionBytes,
    },
    // Never sent to the renderer: stripped by `publicRepositoryExercise`, and
    // `goldAnswer` is also a key `answer-guard.mjs` forbids on every channel,
    // so a future change that forgot to strip it would still be caught.
    goldAnswer: parts.goldAnswer,
  };
}

function buildRepositorySizeExercise(repository) {
  const files = repository.files ?? [];
  if (!files.length) return null;
  return baseExercise(repository, {
    kind: "repository-size",
    capabilities: ["list-files"],
    prompt: "Write a script that calls `await tools.listFiles()` and returns how many files the index tracked for this repository.",
    starter: "const files = await tools.listFiles();\n// return the count\nreturn null;\n",
    goldAnswer: files.length,
  });
}

function buildFileWithMostFunctionsExercise(repository) {
  const counts = new Map();
  for (const symbol of repository.symbols ?? []) {
    if (symbol.kind !== "function") continue;
    counts.set(symbol.path, (counts.get(symbol.path) ?? 0) + 1);
  }
  if (!counts.size) return null;
  let bestPath = null;
  let bestCount = -1;
  // Sorted ascending first, so the earliest replacement on a tie is the
  // alphabetically earliest path — matching the tie-break stated in the
  // prompt, rather than depending on `Map` insertion order.
  for (const [filePath, count] of [...counts.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    if (count > bestCount) { bestPath = filePath; bestCount = count; }
  }
  return baseExercise(repository, {
    kind: "file-with-most-functions",
    capabilities: ["list-files", "symbols"],
    prompt: "Write a script that uses `await tools.listFiles()` and `await tools.symbols(path)` to find the file with the greatest number of indexed functions. Return its repository-relative path. Break ties by the alphabetically earliest path.",
    starter: "const files = await tools.listFiles();\n// Use tools.symbols(path) for each file and keep the best path.\nreturn null;\n",
    goldAnswer: bestPath,
  });
}

function buildCallerCountExercise(repository) {
  const counts = new Map();
  for (const edge of repository.callEdges ?? []) {
    if (!edge.resolved || !edge.callee) continue;
    counts.set(edge.callee, (counts.get(edge.callee) ?? 0) + 1);
  }
  if (!counts.size) return null;
  let bestName = null;
  let bestCount = -1;
  for (const [name, count] of [...counts.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    if (count > bestCount) { bestName = name; bestCount = count; }
  }
  return baseExercise(repository, {
    kind: "caller-count",
    capabilities: ["callers"],
    prompt: `Write a script that uses \`await tools.callers(${JSON.stringify(bestName)})\` to count how many resolved call sites call \`${bestName}\`, and return that count as a number.`,
    starter: `const callers = await tools.callers(${JSON.stringify(bestName)});\n// return callers.length\nreturn null;\n`,
    goldAnswer: bestCount,
  });
}

async function buildLineCountExercise(repository, options) {
  const read = options?.read;
  if (typeof read !== "function") return null;
  const candidates = (repository.files ?? [])
    .filter((file) => (file.size ?? 0) > 0 && (file.size ?? 0) < 60_000)
    .sort((left, right) => (right.importance ?? 0) - (left.importance ?? 0) || left.path.localeCompare(right.path));
  for (const file of candidates.slice(0, 20)) {
    let content;
    try {
      content = await read(file.path);
    } catch {
      continue;
    }
    if (typeof content !== "string") continue;
    return baseExercise(repository, {
      kind: "line-count",
      capabilities: ["read-file"],
      prompt: `Write a script that uses \`await tools.readFile(${JSON.stringify(file.path)})\` to count how many lines are in it, and return that count as a number.`,
      starter: `const content = await tools.readFile(${JSON.stringify(file.path)});\n// return the line count\nreturn null;\n`,
      anchor: { path: file.path, line: 1, symbol: null },
      goldAnswer: content.split(/\r?\n/).length,
    });
  }
  return null;
}

const BUILDERS = {
  "repository-size": async (repository) => buildRepositorySizeExercise(repository),
  "file-with-most-functions": async (repository) => buildFileWithMostFunctionsExercise(repository),
  "caller-count": async (repository) => buildCallerCountExercise(repository),
  "line-count": buildLineCountExercise,
};

/**
 * Build one exercise, trying kinds in order of how much they exercise the
 * index until one has data to ask about. `options.kind` pins a specific kind
 * (used by the explicit "new exercise" control and by tests); without it the
 * richest kind the repository actually supports wins.
 */
export async function buildRepositoryExercise(repository, options = {}) {
  const order = options.kind ? [options.kind] : EXERCISE_KINDS;
  for (const kind of order) {
    const builder = BUILDERS[kind];
    if (!builder) continue;
    const built = await builder(repository, options);
    if (built) return built;
  }
  return {
    available: false,
    reason: "No repository-analysis exercise could be built: the index has no files, symbols, or resolved call edges to ask about.",
    version: REPOSITORY_EXERCISE_VERSION,
  };
}

/** The renderer's view: the oracle never leaves the main process. */
export function publicRepositoryExercise(exercise) {
  if (!exercise?.available) return exercise;
  const { goldAnswer: _goldAnswer, ...rest } = exercise;
  return rest;
}

/**
 * Screen a submission before any process is spawned. Deliberately small: the
 * `vm` sandbox is a reachability boundary (nothing dangerous is reachable),
 * not a removal boundary, so there is no forbidden-pattern list to maintain
 * here the way `executable-quiz.mjs`'s static screen maintains one for a
 * general-purpose Python interpreter.
 */
export function screenRepositoryExerciseSubmission(code, limits = DEFAULT_EXERCISE_LIMITS) {
  const text = String(code ?? "");
  const findings = [];
  if (!text.trim()) findings.push({ id: "empty", reason: "the submission is empty" });
  if (Buffer.byteLength(text, "utf8") > limits.maxSubmissionBytes) {
    findings.push({ id: "too-large", reason: `submissions are limited to ${limits.maxSubmissionBytes} bytes` });
  }
  return { allowed: findings.length === 0, findings };
}

function compareAnswer(goldAnswer, value) {
  if (typeof goldAnswer === "number") {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric === goldAnswer;
  }
  return String(value ?? "") === String(goldAnswer ?? "");
}

/** Capability -> async handler, built only for what this exercise granted. */
function buildHostHandlers(repository, granted) {
  const handlers = {};
  if (granted.includes("list-files")) {
    handlers["list-files"] = async () => (repository.files ?? []).slice(0, 5_000).map((file) => file.path);
  }
  if (granted.includes("read-file")) {
    handlers["read-file"] = async (filePath) => {
      // The same repository-relative path validation `repository:read-file`
      // uses: traversal and escaping symlinks are refused after `realpath`.
      const content = await readRepositoryFile(repository.rootPath, String(filePath ?? ""));
      return redactValue(content).slice(0, DEFAULT_EXERCISE_LIMITS.maxReadBytes);
    };
  }
  if (granted.includes("symbols")) {
    handlers.symbols = async (filePath) => (repository.symbols ?? [])
      .filter((symbol) => symbol.path === filePath)
      .slice(0, 2_000)
      .map((symbol) => ({ name: symbol.name, kind: symbol.kind ?? null, line: symbol.line }));
  }
  if (granted.includes("callers")) {
    handlers.callers = async (symbolName) => (repository.callEdges ?? [])
      .filter((edge) => edge.resolved && edge.callee === symbolName)
      .slice(0, 500)
      .map((edge) => ({ path: edge.path, caller: edge.caller ?? null, line: edge.line ?? null }));
  }
  return handlers;
}

/**
 * Run one submission against one exercise in its own process.
 *
 * Feedback is deliberately thin on failure: only `passed` (never the
 * learner's own returned value) crosses back out, the same discipline
 * `executable-quiz.mjs` applies to hidden cases — showing a wrong guess's
 * computed value would let repeated submission turn into reading the oracle
 * out through the feedback channel itself.
 */
export async function runRepositoryExercise(repository, exercise, submission, options = {}) {
  const limits = { ...DEFAULT_EXERCISE_LIMITS, ...(options.limits ?? {}) };
  const text = String(submission ?? "");
  const screen = screenRepositoryExerciseSubmission(text, limits);
  if (!screen.allowed) {
    return {
      version: REPOSITORY_EXERCISE_VERSION,
      exerciseId: exercise.id,
      status: "refused",
      passed: false,
      reason: `The submission was refused before it ran: ${screen.findings.map((finding) => finding.reason).join("; ")}.`,
      findings: screen.findings,
      trace: [],
      hostCalls: 0,
      durationMs: 0,
    };
  }

  const granted = exercise.capabilities ?? [];
  const host = buildHostHandlers(repository, granted);
  const timeoutMs = Math.min(options.timeoutMs ?? exercise.limits?.timeoutMs ?? limits.timeoutMs, limits.timeoutMs);
  const trace = [];
  const started = Date.now();
  let hostCalls = 0;

  const child = spawn(options.execPath ?? process.execPath, [path.join(currentDirectory, "repository-exercise-host.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      // The same bare environment `plugins.mjs`'s `runPlugin` spawns with: no
      // tokens, no proxy settings, no ambient secret of any kind (item 41's
      // own requirement), and `ELECTRON_RUN_AS_NODE` so a packaged build does
      // not need a separate Node install to run this.
      ELECTRON_RUN_AS_NODE: "1",
      PATH: process.env.PATH ?? "",
      NODE_OPTIONS: "",
    },
  });

  return await new Promise((resolve) => {
    let settled = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let bytes = 0;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve({
        version: REPOSITORY_EXERCISE_VERSION,
        exerciseId: exercise.id,
        durationMs: Date.now() - started,
        hostCalls,
        trace,
        ...outcome,
      });
    };

    const timer = setTimeout(() => {
      finish({ status: "timeout", passed: false, reason: `The run exceeded ${timeoutMs} ms of wall-clock time and was stopped.` });
    }, timeoutMs);

    const send = (message) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    child.stdout.on("data", async (chunk) => {
      bytes += chunk.length;
      if (bytes > limits.maxOutputBytes) {
        finish({ status: "oversized", passed: false, reason: `The run wrote more than ${limits.maxOutputBytes} bytes.` });
        return;
      }
      stdoutBuffer += chunk.toString("utf8");
      let newline = stdoutBuffer.indexOf("\n");
      while (newline !== -1) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf("\n");
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish({ status: "failed", passed: false, reason: "The run wrote something that is not a protocol message." });
          return;
        }
        if (message.type === "host") {
          hostCalls += 1;
          if (hostCalls > limits.maxHostCalls) {
            finish({ status: "too-many-host-calls", passed: false, reason: `More than ${limits.maxHostCalls} tool calls; a script doing that is doing something other than what the exercise asks.` });
            return;
          }
          // The capability check, again, in the parent: a compromised or
          // merely confused child can ask for anything, and the check that
          // matters is the one that cannot be bypassed by the thing being
          // restrained asking anyway.
          if (!granted.includes(message.capability)) {
            send({ type: "host-result", id: message.id, ok: false, error: `The tool “${message.capability}” was not made available for this exercise.` });
            continue;
          }
          const handler = host[message.capability];
          if (typeof handler !== "function") {
            send({ type: "host-result", id: message.id, ok: false, error: `No tool named “${message.capability}” exists.` });
            continue;
          }
          try {
            const value = await handler(...(message.args ?? []));
            if (trace.length < limits.maxTraceEntries) {
              trace.push({
                capability: message.capability,
                args: (message.args ?? []).map((arg) => String(arg).slice(0, 200)),
                at: Date.now() - started,
              });
            }
            send({ type: "host-result", id: message.id, ok: true, value });
          } catch (cause) {
            send({ type: "host-result", id: message.id, ok: false, error: String(cause?.message ?? cause) });
          }
          continue;
        }
        if (message.type === "result") {
          const passed = compareAnswer(exercise.goldAnswer, message.value);
          finish({ status: "ran", passed, logs: (message.logs ?? []).slice(0, 50) });
          return;
        }
        if (message.type === "error") {
          finish({ status: "error", passed: false, reason: String(message.message ?? "The run threw.").slice(0, 1_000), logs: (message.logs ?? []).slice(0, 50) });
          return;
        }
      }
    });

    child.stderr.on("data", (chunk) => { stderrBuffer = `${stderrBuffer}${chunk}`.slice(-2_000); });
    child.on("error", (cause) => finish({ status: "spawn-failed", passed: false, reason: String(cause?.message ?? cause) }));
    child.on("close", (code) => {
      finish({
        status: code === 0 ? "no-result" : "crashed",
        passed: false,
        reason: code === 0 ? "The run exited without returning a result." : `The run exited with code ${code}. ${stderrBuffer.trim().split("\n").at(-1) ?? ""}`.trim(),
      });
    });

    send({ type: "run", submission: text, capabilities: granted, timeoutMs });
  });
}
