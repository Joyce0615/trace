import { spawn } from "node:child_process";
import { redactValue } from "./secret-scanner.mjs";

/**
 * Dynamic execution traces.
 *
 * A static index says what *could* call what; only running the code says what
 * actually ran. This module executes a learner-supplied snippet under a real
 * interpreter, records call/return/exception events, and maps every event back
 * to a repository-relative `path:line`.
 *
 * Two properties make the trace useful for learning rather than just noisy:
 *
 *   - events outside the repository (stdlib, site-packages) are dropped at the
 *     tracer, so the timeline is the learner's own code;
 *   - every observed transition is compared against the static call graph, so
 *     the trace can confirm a static edge *or* reveal a dynamic-only edge that
 *     name-based indexing can never find.
 *
 * Running repository code is a consequential action, so it is always explicitly
 * initiated by the learner, bounded by a timeout and an event cap, and the
 * captured output is redacted before it is returned.
 */

export const EXECUTION_TRACE_VERSION = 1;
const MARKER = "##TRACE-RESULT##";

export const DEFAULT_TRACE_LIMITS = {
  timeoutMs: 15_000,
  maxEvents: 4_000,
  maxOutputBytes: 200_000,
  maxSnippetBytes: 8_000,
};

// One tracer per supported language. Adding a language means adding a harness
// here; everything downstream is language-neutral.
const RUNTIMES = {
  python: { id: "python", commands: ["python3", "python"], versionArgs: ["--version"] },
};

const detected = new Map();

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve({ code: 127, stdout: "", stderr: "spawn failed", timedOut: false });
      return;
    }
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs ?? 10_000);
    child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes <= (options.maxOutputBytes ?? 1_000_000)) stdout.push(chunk); });
    child.stderr.on("data", (chunk) => { if (stderr.reduce((sum, item) => sum + item.length, 0) < 100_000) stderr.push(chunk); });
    child.on("error", () => { clearTimeout(timer); resolve({ code: 127, stdout: "", stderr: "spawn failed", timedOut }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), timedOut });
    });
    if (options.input !== undefined) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

/** Which tracer runtimes exist on this machine. Tracing is optional, never required. */
export async function detectRuntimes({ refresh = false } = {}) {
  if (!refresh && detected.size) return Object.fromEntries(detected);
  detected.clear();
  for (const runtime of Object.values(RUNTIMES)) {
    let record = { id: runtime.id, command: null, available: false, version: null };
    for (const command of runtime.commands) {
      const result = await runCommand(command, runtime.versionArgs, { timeoutMs: 5_000 });
      if (result.code === 0) {
        record = { id: runtime.id, command, available: true, version: `${result.stdout}${result.stderr}`.trim().slice(0, 60) };
        break;
      }
    }
    detected.set(runtime.id, record);
  }
  return Object.fromEntries(detected);
}

export function traceSupported(language) {
  return Object.keys(RUNTIMES).includes(language);
}

// The harness runs inside the target interpreter. It filters every frame by
// repository membership so stdlib and site-packages never enter the timeline.
const PYTHON_HARNESS = `
import json, os, sys, time, traceback

config = json.loads(sys.stdin.read())
root = os.path.realpath(config["root"])
maximum = int(config["maxEvents"])
include_lines = bool(config.get("includeLines"))
sys.path.insert(0, root)

events = []
truncated = [False]
depth = [0]
started = time.perf_counter()

def relative(filename):
    if not filename or filename.startswith("<"):
        return None
    try:
        resolved = os.path.realpath(filename)
    except Exception:
        return None
    if resolved == root or resolved.startswith(root + os.sep):
        return os.path.relpath(resolved, root).replace(os.sep, "/")
    return None

def brief(value):
    try:
        text = repr(value)
    except Exception:
        text = "<unrepresentable>"
    return text[:120]

# An empty module frame reports line 0, which is not an openable anchor, so
# every recorded line is clamped to a real source line.
def record(kind, frame, arg):
    if len(events) >= maximum:
        truncated[0] = True
        return False
    caller = frame.f_back
    caller_path = relative(caller.f_code.co_filename) if caller is not None else None
    events.append({
        "kind": kind,
        "path": relative(frame.f_code.co_filename),
        "line": max(1, frame.f_lineno or 0),
        "function": frame.f_code.co_name,
        "definitionLine": frame.f_code.co_firstlineno,
        "depth": depth[0],
        "callerPath": caller_path,
        "callerLine": max(1, caller.f_lineno or 0) if caller is not None else None,
        "callerFunction": caller.f_code.co_name if caller is not None else None,
        "at": round((time.perf_counter() - started) * 1000, 3),
        "value": brief(arg) if kind == "return" else (type(arg[1]).__name__ if kind == "exception" and arg else None),
    })
    return True

def tracer(frame, event, arg):
    if relative(frame.f_code.co_filename) is None:
        return None
    if event == "call":
        if not record("call", frame, None):
            return None
        depth[0] += 1
        return tracer
    if event == "return":
        depth[0] = max(0, depth[0] - 1)
        record("return", frame, arg)
        return tracer
    if event == "exception":
        record("exception", frame, arg)
        return tracer
    if event == "line" and include_lines:
        record("line", frame, None)
    return tracer

status = "ok"
error = None
sys.settrace(tracer)
try:
    exec(compile(config["snippet"], "<trace-snippet>", "exec"), {"__name__": "__trace__"})
except BaseException:
    status = "error"
    error = traceback.format_exc(limit=6)[-4000:]
finally:
    sys.settrace(None)

print("${MARKER}" + json.dumps({
    "status": status,
    "error": error,
    "events": events,
    "truncated": truncated[0],
    "durationMs": round((time.perf_counter() - started) * 1000, 3),
}))
`;

/**
 * Execute a snippet under the tracer and return the recorded run.
 * Never throws for a failing snippet: a failed run is a result, not an error.
 */
export async function runExecutionTrace(repository, request, options = {}) {
  const limits = { ...DEFAULT_TRACE_LIMITS, ...(options.limits ?? {}) };
  const language = request.language ?? "python";
  if (!traceSupported(language)) {
    return { supported: false, language, reason: `Trace has no execution tracer for ${language}.`, events: [], status: "unsupported" };
  }
  const snippet = String(request.snippet ?? "");
  if (!snippet.trim()) {
    return { supported: true, language, status: "invalid", reason: "Provide a snippet to run.", events: [] };
  }
  if (Buffer.byteLength(snippet, "utf8") > limits.maxSnippetBytes) {
    return { supported: true, language, status: "invalid", reason: `Snippets are limited to ${limits.maxSnippetBytes} bytes.`, events: [] };
  }

  const runtimes = await detectRuntimes();
  const runtime = runtimes[language];
  if (!runtime?.available) {
    return { supported: true, language, status: "unavailable", reason: `No ${language} runtime is installed, so this repository cannot be traced here.`, events: [] };
  }

  const result = await runCommand(runtime.command, ["-c", PYTHON_HARNESS], {
    cwd: repository.rootPath,
    timeoutMs: request.timeoutMs ?? limits.timeoutMs,
    maxOutputBytes: limits.maxOutputBytes,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1" },
    input: JSON.stringify({
      root: repository.rootPath,
      snippet,
      maxEvents: Math.min(request.maxEvents ?? limits.maxEvents, limits.maxEvents),
      includeLines: Boolean(request.includeLines),
    }),
  });

  if (result.timedOut) {
    return { supported: true, language, status: "timeout", reason: `The run exceeded ${request.timeoutMs ?? limits.timeoutMs} ms and was stopped.`, events: [], stderr: result.stderr.slice(-2_000) };
  }

  const markerLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith(MARKER));
  if (!markerLine) {
    return { supported: true, language, status: "failed", reason: "The tracer produced no result.", events: [], exitCode: result.code, stderr: redactValue(result.stderr.slice(-2_000)) };
  }
  let payload;
  try {
    payload = JSON.parse(markerLine.slice(MARKER.length));
  } catch {
    return { supported: true, language, status: "failed", reason: "The tracer result could not be parsed.", events: [], exitCode: result.code };
  }

  // Program output and captured values can contain secrets; redact before return.
  return redactValue({
    supported: true,
    language,
    version: EXECUTION_TRACE_VERSION,
    runtime: runtime.command,
    status: payload.status,
    error: payload.error,
    truncated: payload.truncated,
    durationMs: payload.durationMs,
    exitCode: result.code,
    stdout: result.stdout.split(/\r?\n/).filter((line) => !line.startsWith(MARKER)).join("\n").slice(-4_000),
    stderr: result.stderr.slice(-2_000),
    events: payload.events,
  });
}

/**
 * Connect a recorded run back to the static index: which functions ran, which
 * transitions the static call graph already knew, and which are dynamic-only.
 */
export function summarizeTrace(trace, repository) {
  const events = trace.events ?? [];
  const calls = events.filter((event) => event.kind === "call");
  const returns = events.filter((event) => event.kind === "return");
  const symbols = repository.symbols ?? [];
  const staticEdges = new Set(
    (repository.callEdges ?? [])
      .filter((edge) => edge.resolved && edge.targetPath)
      .map((edge) => `${edge.path}#${edge.caller}->${edge.targetPath}#${edge.callee}`),
  );

  const functions = new Map();
  for (const event of calls) {
    const key = `${event.path}#${event.function}`;
    const existing = functions.get(key) ?? {
      path: event.path,
      name: event.function,
      line: event.definitionLine ?? event.line,
      calls: 0,
      indexed: symbols.some((symbol) => symbol.path === event.path && symbol.name === event.function),
    };
    existing.calls += 1;
    functions.set(key, existing);
  }

  const transitions = new Map();
  for (const event of calls) {
    if (!event.callerPath || !event.callerFunction) continue;
    const key = `${event.callerPath}#${event.callerFunction}->${event.path}#${event.function}`;
    const existing = transitions.get(key) ?? {
      from: { path: event.callerPath, name: event.callerFunction, line: event.callerLine },
      to: { path: event.path, name: event.function, line: event.definitionLine ?? event.line },
      count: 0,
      crossFile: event.callerPath !== event.path,
      inStaticGraph: staticEdges.has(key),
    };
    existing.count += 1;
    transitions.set(key, existing);
  }

  const transitionList = [...transitions.values()];
  const returnValues = returns
    .filter((event) => event.value)
    .slice(-20)
    .map((event) => ({ path: event.path, line: event.line, function: event.function, value: event.value }));

  return {
    version: EXECUTION_TRACE_VERSION,
    status: trace.status,
    eventCount: events.length,
    callCount: calls.length,
    returnCount: returns.length,
    exceptionCount: events.filter((event) => event.kind === "exception").length,
    maxDepth: events.reduce((deepest, event) => Math.max(deepest, event.depth ?? 0), 0),
    durationMs: trace.durationMs ?? 0,
    truncated: Boolean(trace.truncated),
    files: [...new Set(calls.map((event) => event.path))],
    functions: [...functions.values()].sort((left, right) => right.calls - left.calls || left.path.localeCompare(right.path)),
    transitions: transitionList.sort((left, right) => right.count - left.count),
    // The two numbers that make a dynamic trace worth running.
    confirmedStaticEdges: transitionList.filter((transition) => transition.inStaticGraph).length,
    dynamicOnlyEdges: transitionList.filter((transition) => !transition.inStaticGraph).length,
    unindexedFunctions: [...functions.values()].filter((entry) => !entry.indexed).length,
    returnValues,
  };
}

/** A recorded run rendered as a source-anchored lesson timeline. */
export function traceTimelineBlock(summary, blockId = "execution-trace") {
  return {
    id: blockId,
    type: "timeline",
    title: "What actually ran",
    steps: summary.transitions.slice(0, 8).map((transition) => ({
      label: `${transition.from.name} → ${transition.to.name}`,
      detail: `${transition.count} call${transition.count === 1 ? "" : "s"} · ${transition.inStaticGraph ? "predicted by the static index" : "dynamic-only edge"}`,
      anchor: { path: transition.to.path, line: transition.to.line, symbol: transition.to.name },
    })),
  };
}

/** Repository-relative entry suggestions the learner can run without writing code. */
export function suggestTraceSnippets(repository, limit = 5) {
  const byPath = new Map();
  for (const symbol of repository.symbols ?? []) {
    if (symbol.kind !== "function") continue;
    if (!/\.py$/.test(symbol.path)) continue;
    if (symbol.container) continue;
    if (!byPath.has(symbol.path)) byPath.set(symbol.path, []);
    byPath.get(symbol.path).push(symbol);
  }
  const suggestions = [];
  for (const [filePath, symbols] of byPath) {
    const moduleName = filePath.replace(/\.py$/, "").split("/").filter((part) => part !== "__init__").join(".");
    if (!moduleName) continue;
    suggestions.push({
      path: filePath,
      module: moduleName,
      symbol: symbols[0].name,
      snippet: `import ${moduleName}\nprint(${moduleName}.${symbols[0].name})`,
    });
    if (suggestions.length >= limit) break;
  }
  return suggestions;
}
