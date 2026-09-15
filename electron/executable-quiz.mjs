import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { detectRuntimes } from "./execution-trace.mjs";
import { redactValue } from "./secret-scanner.mjs";

/**
 * Executable quizzes with hidden tests and a sandboxed runner.
 *
 * A multiple-choice quiz can be passed by recognition. This module asks the
 * learner to *write the function*, and grades it by running it.
 *
 * The hidden tests are not invented: a quiz is built by picking a real,
 * self-contained function out of the indexed repository, running the
 * *original* implementation in the sandbox against a pool of generated inputs,
 * and keeping the inputs it accepted together with what it returned. Those
 * recorded outputs are the oracle. So "hidden test 4 failed" means "your
 * function disagreed with this repository's own code", which is the only claim
 * worth making here.
 *
 * Nothing about the oracle ever reaches the renderer: `publicQuiz` ships the
 * signature, the docstring, the callers, and exactly one worked example, and
 * grading happens in the main process.
 *
 * Running learner-written code is the most dangerous thing this app does, so
 * the sandbox is layered rather than trusting any single mechanism:
 *
 *   1. a static deny-list rejects the submission before a process is spawned;
 *   2. the interpreter runs isolated (`-I -S -B`), in an empty temporary
 *      directory, with a scrubbed environment;
 *   3. `RLIMIT_CPU` bounds CPU time and `RLIMIT_FSIZE` = 0 makes every file
 *      write fail;
 *   4. a watchdog thread polls resident memory and hard-exits over the cap,
 *      because macOS refuses `RLIMIT_AS`/`RLIMIT_DATA` outright — the report
 *      says which mechanism actually enforced each limit rather than claiming
 *      a limit that silently did nothing;
 *   5. imports are allowlisted, `open`/`exec`/`eval`/`compile`/`input` are
 *      removed from the learner's builtins, and the process-spawning and
 *      socket entry points are replaced before the submission runs;
 *   6. the parent kills the process on a wall-clock timeout and caps output.
 */

export const EXECUTABLE_QUIZ_VERSION = 1;
const MARKER = "##QUIZ-RESULT##";

export const DEFAULT_SANDBOX_LIMITS = {
  wallClockMs: 10_000,
  cpuSeconds: 5,
  memoryBytes: 512 * 1024 * 1024,
  maxOutputBytes: 64_000,
  maxSubmissionBytes: 16_000,
  maxCases: 10,
  maxProbes: 36,
  maxBodyLines: 25,
  maxParameters: 3,
};

/** Modules a submission may import. Everything else is refused by the import hook. */
export const ALLOWED_MODULES = [
  "math", "cmath", "statistics", "decimal", "fractions", "random",
  "itertools", "functools", "operator", "collections", "heapq", "bisect", "array",
  "string", "re", "json", "textwrap", "unicodedata",
  "datetime", "copy", "enum", "dataclasses", "typing", "types", "numbers", "abc",
];

/**
 * Refusals that happen before a process exists. These are not the security
 * boundary — the sandbox is — but a submission that is obviously trying to
 * leave the box should be told so instead of being silently neutered.
 */
export const FORBIDDEN_PATTERNS = [
  { id: "process-spawn", pattern: /\b(?:subprocess|multiprocessing|pty|popen2)\b/, reason: "starting another process" },
  { id: "os-command", pattern: /\bos\s*\.\s*(?:system|popen|exec[lv]?[pe]*|spawn\w*|fork|kill|remove|unlink|rmdir|rename|chmod|chown)\b/, reason: "running an operating-system command" },
  { id: "network", pattern: /\b(?:socket|http\.client|urllib|requests|httpx|ftplib|smtplib|telnetlib|asyncio\s*\.\s*open_connection)\b/, reason: "opening a network connection" },
  { id: "filesystem", pattern: /\b(?:open|shutil|pathlib|tempfile|fileinput)\s*[.(]/, reason: "touching the filesystem" },
  { id: "dynamic-code", pattern: /\b(?:eval|exec|compile|__import__|globals|locals|vars|breakpoint)\s*\(/, reason: "evaluating code built at run time" },
  { id: "introspection-escape", pattern: /__(?:subclasses|bases|mro|globals|builtins|loader|spec|class)__/, reason: "escaping through object introspection" },
  { id: "native-code", pattern: /\b(?:ctypes|cffi|mmap|resource|signal|gc|sys\s*\.\s*(?:settrace|setprofile|_getframe))\b/, reason: "reaching into the interpreter or native memory" },
  { id: "interpreter-exit", pattern: /\b(?:sys\s*\.\s*exit|os\s*\.\s*_exit|quit\s*\(|exit\s*\()/, reason: "terminating the interpreter" },
];

const PYTHON_BUILTINS = new Set([
  "abs", "all", "any", "ascii", "bin", "bool", "bytearray", "bytes", "callable", "chr", "complex",
  "dict", "divmod", "enumerate", "filter", "float", "format", "frozenset", "getattr", "hasattr",
  "hash", "hex", "id", "int", "isinstance", "issubclass", "iter", "len", "list", "map", "max",
  "min", "next", "object", "oct", "ord", "pow", "print", "range", "repr", "reversed", "round",
  "set", "setattr", "slice", "sorted", "str", "sum", "tuple", "type", "zip",
  "True", "False", "None", "Exception", "ValueError", "TypeError", "KeyError", "IndexError",
  "ZeroDivisionError", "StopIteration", "RuntimeError", "NotImplementedError", "AssertionError",
  "ArithmeticError", "OverflowError", "AttributeError", "LookupError", "and", "or", "not", "in",
  "is", "if", "else", "elif", "for", "while", "return", "def", "pass", "break", "continue",
  "raise", "try", "except", "finally", "with", "as", "lambda", "yield", "assert", "del", "from",
  "import", "global", "nonlocal", "class", "async", "await", "self",
]);

// Deterministic candidate values, grouped so a parameter's annotation, default,
// or name can pick a plausible pool instead of guessing blindly.
const VALUE_POOL = {
  int: [0, 1, 2, 3, 5, 7, 10, -1, -4, 12, 100],
  float: [0.0, 1.5, 2.25, -3.5, 10.0],
  str: ["", "a", "abc", "trace", "Hello World", "aabbcc", "Repository"],
  bool: [true, false],
  list: [[], [1], [1, 2, 3], [3, 1, 2], [2, 2, 5], ["a", "b", "c"]],
  dict: [{}, { a: 1 }, { a: 1, b: 2 }],
  mixed: [1, 2, 0, "abc", [1, 2, 3], "", 5, [], true, 10, "trace", -1],
};

const ANNOTATION_POOL = {
  int: "int", float: "float", str: "str", bool: "bool",
  list: "list", "list[int]": "list", "list[str]": "list", "List[int]": "list", "List[str]": "list",
  dict: "dict", "dict[str, int]": "dict", "Dict[str, int]": "dict",
  tuple: "list", set: "list", bytes: "str", "Sequence[int]": "list", "Iterable[int]": "list",
};

const NAME_HINTS = [
  { pattern: /^(?:n|count|num|number|size|length|width|height|depth|index|idx|offset|limit|total|k|i|j)$|_(?:count|num|size|index|len|id)$/, pool: "int" },
  { pattern: /^(?:name|text|word|string|s|label|title|prefix|suffix|key|path|token|message)$|_(?:name|text|str|label|key)$/, pool: "str" },
  { pattern: /^(?:items|values|list|seq|sequence|array|arr|data|numbers|tokens|rows|elements)$|_(?:list|items|values)$/, pool: "list" },
  { pattern: /^(?:flag|enabled|verbose|strict|reverse|keep_case|debug)$|^(?:is|has|should|use|allow)_/, pool: "bool" },
  { pattern: /^(?:ratio|rate|scale|factor|weight|score|threshold|alpha|temperature)$/, pool: "float" },
  { pattern: /^(?:mapping|table|options|config|counts|lookup)$/, pool: "dict" },
];

function digest(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

/**
 * Screen a submission before any process is spawned. Returns every finding
 * rather than the first, so a learner fixes one submission instead of playing
 * whack-a-mole with the checker.
 */
export function screenSubmission(code, options = {}) {
  const limits = { ...DEFAULT_SANDBOX_LIMITS, ...(options.limits ?? {}) };
  const text = String(code ?? "");
  const findings = [];
  if (!text.trim()) findings.push({ id: "empty", reason: "the submission is empty" });
  if (Buffer.byteLength(text, "utf8") > limits.maxSubmissionBytes) {
    findings.push({ id: "too-large", reason: `submissions are limited to ${limits.maxSubmissionBytes} bytes` });
  }
  // Comments and string literals are stripped first so a docstring mentioning
  // `subprocess` is not treated as an attempt to start one.
  const stripped = text
    .replace(/(?:"""|''')[\s\S]*?(?:"""|''')/g, '""')
    .replace(/#[^\n]*/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(stripped)) findings.push({ id: rule.id, reason: rule.reason });
  }
  if (options.entry && !new RegExp(`\\bdef\\s+${options.entry}\\s*\\(`).test(stripped)) {
    findings.push({ id: "missing-entry", reason: `the submission must define \`${options.entry}\`` });
  }
  return { allowed: findings.length === 0, findings };
}

// The sandbox harness. Everything it does to itself happens *before* the
// submission is compiled, and the report says which mechanism enforced what.
const PYTHON_SANDBOX = `
import json, sys, time, builtins, threading, os, resource, traceback

config = json.loads(sys.stdin.read())
limits = config["limits"]
enforced = {}

try:
    resource.setrlimit(resource.RLIMIT_CPU, (int(limits["cpuSeconds"]), int(limits["cpuSeconds"]) + 1))
    enforced["cpu"] = "rlimit"
except Exception as error:
    enforced["cpu"] = "unavailable:" + type(error).__name__

try:
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    enforced["fileWrite"] = "rlimit"
except Exception as error:
    enforced["fileWrite"] = "unavailable:" + type(error).__name__

memory_cap = int(limits["memoryBytes"])
try:
    resource.setrlimit(resource.RLIMIT_AS, (memory_cap, memory_cap))
    enforced["memory"] = "rlimit"
except Exception:
    # macOS refuses RLIMIT_AS outright, so memory is enforced by a watchdog that
    # actually kills the process rather than by a limit that silently does not.
    enforced["memory"] = "watchdog"

# Resident set size is reported in bytes on macOS and kilobytes on Linux.
_rss_scale = 1 if sys.platform == "darwin" else 1024

def _watchdog():
    while True:
        used = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * _rss_scale
        if used > memory_cap:
            sys.stderr.write("SANDBOX_MEMORY_EXCEEDED " + str(used) + "\\n")
            sys.stderr.flush()
            os._exit(97)
        time.sleep(0.02)

if enforced["memory"] == "watchdog":
    thread = threading.Thread(target=_watchdog, daemon=True)
    thread.start()

allowed_modules = set(config["allowedModules"])
preloaded = {}
for name in sorted(allowed_modules):
    try:
        preloaded[name] = __import__(name)
    except Exception:
        pass

module_source = config["moduleSource"]
entry = config["entry"]
calls = config["calls"]

# Compiled before the sandbox closes, because compile() itself is removed below.
try:
    compiled = compile(module_source, "<submission>", "exec")
except SyntaxError as error:
    print("${MARKER}" + json.dumps({
        "status": "syntax-error",
        "error": (type(error).__name__ + ": " + str(error))[:600],
        "enforced": enforced,
        "results": [],
    }))
    sys.exit(0)

def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".")[0]
    if root not in allowed_modules:
        raise ImportError("Importing '" + root + "' is not allowed inside the quiz sandbox.")
    return preloaded.get(root) or __import__(name, globals, locals, fromlist, level)

def _blocked(*args, **kwargs):
    raise PermissionError("This operation is not allowed inside the quiz sandbox.")

safe_builtins = {}
for name in dir(builtins):
    if name in ("open", "exec", "eval", "compile", "input", "breakpoint", "help", "quit", "exit", "memoryview"):
        continue
    safe_builtins[name] = getattr(builtins, name)
safe_builtins["__import__"] = _guarded_import
safe_builtins["open"] = _blocked

# Close the interpreter's own escape hatches before the submission is defined.
os.system = _blocked
os.popen = _blocked
os.fork = _blocked
os.execv = _blocked
os._exit_original = os._exit
try:
    import socket
    socket.socket = _blocked
    socket.create_connection = _blocked
except Exception:
    pass

namespace = {"__name__": "__quiz__", "__builtins__": safe_builtins}
started = time.perf_counter()
status = "ok"
error = None
results = []
try:
    exec(compiled, namespace)
    function = namespace.get(entry)
    if not callable(function):
        status = "no-entry"
        error = "The submission does not define a callable named '" + entry + "'."
    else:
        for index, arguments in enumerate(calls):
            try:
                value = function(*arguments)
                results.append({"index": index, "ok": True, "value": repr(value)[:400]})
            except BaseException as call_error:
                results.append({
                    "index": index,
                    "ok": False,
                    "error": (type(call_error).__name__ + ": " + str(call_error))[:300],
                })
except BaseException:
    status = "error"
    error = traceback.format_exc(limit=4)[-2000:]

print("${MARKER}" + json.dumps({
    "status": status,
    "error": error,
    "enforced": enforced,
    "results": results,
    "durationMs": round((time.perf_counter() - started) * 1000, 3),
    "peakMemoryBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * _rss_scale,
}))
`;

function runSandboxProcess(command, args, options) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve({ code: 127, stdout: "", stderr: "spawn failed", timedOut: false });
      return;
    }
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.wallClockMs);
    child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes <= options.maxOutputBytes) stdout.push(chunk); else child.kill("SIGKILL"); });
    child.stderr.on("data", (chunk) => { if (stderr.reduce((sum, item) => sum + item.length, 0) < 40_000) stderr.push(chunk); });
    child.on("error", () => { clearTimeout(timer); resolve({ code: 127, stdout: "", stderr: "spawn failed", timedOut }); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        signal: signal ?? null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        outputTruncated: bytes > options.maxOutputBytes,
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  });
}

/**
 * Execute one module against a list of argument tuples inside the sandbox.
 * A submission that crashes, loops, or allocates is a *result*, never a throw.
 */
export async function runInSandbox(request, options = {}) {
  const limits = { ...DEFAULT_SANDBOX_LIMITS, ...(options.limits ?? {}) };
  const runtimes = await detectRuntimes();
  const runtime = runtimes.python;
  if (!runtime?.available) {
    return { supported: true, status: "unavailable", reason: "No Python runtime is installed, so executable quizzes cannot run here.", results: [] };
  }
  // An empty temporary directory, so relative paths cannot reach the repository.
  const sandboxDirectory = await mkdtemp(path.join(os.tmpdir(), "trace-quiz-sandbox-"));
  try {
    const result = await runSandboxProcess(runtime.command, ["-I", "-S", "-B", "-c", PYTHON_SANDBOX], {
      cwd: sandboxDirectory,
      wallClockMs: limits.wallClockMs,
      maxOutputBytes: limits.maxOutputBytes,
      // A scrubbed environment: no inherited PYTHONPATH, no credentials, no proxy.
      env: { PATH: "/usr/bin:/bin", HOME: sandboxDirectory, TMPDIR: sandboxDirectory, PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", LC_ALL: "C" },
      input: JSON.stringify({
        moduleSource: request.moduleSource,
        entry: request.entry,
        calls: request.calls,
        allowedModules: ALLOWED_MODULES,
        limits: { cpuSeconds: limits.cpuSeconds, memoryBytes: limits.memoryBytes },
      }),
    });

    if (result.timedOut) {
      return { supported: true, status: "timeout", reason: `The run exceeded ${limits.wallClockMs} ms of wall-clock time and was stopped.`, results: [], enforced: { wallClock: "parent-kill" } };
    }
    if (/SANDBOX_MEMORY_EXCEEDED/.test(result.stderr) || result.code === 97) {
      return { supported: true, status: "memory", reason: `The run exceeded the ${Math.round(limits.memoryBytes / 1_048_576)} MB memory cap and was stopped.`, results: [], enforced: { memory: "watchdog" } };
    }
    // SIGXCPU (24) and SIGKILL after it both mean the CPU limit fired.
    if (result.signal === "SIGXCPU" || result.code === 152 || result.code === 137) {
      return { supported: true, status: "cpu", reason: `The run exceeded ${limits.cpuSeconds} s of CPU time and was stopped.`, results: [], enforced: { cpu: "rlimit" } };
    }

    const markerLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith(MARKER));
    if (!markerLine) {
      return { supported: true, status: "failed", reason: "The sandbox produced no result.", results: [], exitCode: result.code, stderr: redactValue(result.stderr.slice(-1_000)) };
    }
    const payload = JSON.parse(markerLine.slice(MARKER.length));
    return redactValue({
      supported: true,
      ...payload,
      exitCode: result.code,
      stdout: result.stdout.split(/\r?\n/).filter((line) => !line.startsWith(MARKER)).join("\n").slice(-2_000),
      stderr: result.stderr.slice(-1_000),
      outputTruncated: Boolean(result.outputTruncated),
    });
  } finally {
    await rm(sandboxDirectory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Quiz construction from the real index
// ---------------------------------------------------------------------------

function bodyIdentifiers(body) {
  return (body
    // Drop comments, strings, and anything after a dot so attribute names are
    // not mistaken for free variables.
    .replace(/(?:"""|''')[\s\S]*?(?:"""|''')/g, " ")
    .replace(/#[^\n]*/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, " ")
    .replace(/\.\s*[A-Za-z_][A-Za-z0-9_]*/g, " ")
    .match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
}

/** Parse a `def` header into a name and simple parameters, or null if unusual. */
export function parseSignature(header) {
  const match = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/.exec(header);
  if (!match) return null;
  const [, name, rawParameters, returnAnnotation] = match;
  const parameters = [];
  for (const piece of rawParameters.split(",").map((item) => item.trim()).filter(Boolean)) {
    if (/^[*/]/.test(piece)) return null;
    const [declaration, ...defaultParts] = piece.split("=");
    const [parameterName, annotation] = declaration.split(":").map((item) => item.trim());
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameterName)) return null;
    parameters.push({
      name: parameterName,
      annotation: annotation ? annotation.trim() : null,
      defaultValue: defaultParts.length ? defaultParts.join("=").trim() : null,
    });
  }
  return { name, parameters, returnAnnotation: returnAnnotation ? returnAnnotation.trim() : null };
}

/** The candidate value list for one parameter, best available signal first. */
export function candidateValues(parameter) {
  const annotation = parameter.annotation ? ANNOTATION_POOL[parameter.annotation] : null;
  if (annotation) return VALUE_POOL[annotation];
  if (parameter.defaultValue !== null) {
    const value = parameter.defaultValue;
    if (/^(?:True|False)$/.test(value)) return VALUE_POOL.bool;
    if (/^-?\d+$/.test(value)) return VALUE_POOL.int;
    if (/^-?\d*\.\d+$/.test(value)) return VALUE_POOL.float;
    if (/^["']/.test(value)) return VALUE_POOL.str;
    if (/^\[/.test(value)) return VALUE_POOL.list;
    if (/^\{/.test(value)) return VALUE_POOL.dict;
  }
  const hint = NAME_HINTS.find((entry) => entry.pattern.test(parameter.name));
  if (hint) return VALUE_POOL[hint.pool];
  return VALUE_POOL.mixed;
}

/** Deterministic argument tuples for a signature, bounded by `maxProbes`. */
export function probeArguments(parameters, maxProbes) {
  if (parameters.length === 0) return [[]];
  const pools = parameters.map((parameter) => candidateValues(parameter));
  if (parameters.length === 1) return pools[0].slice(0, maxProbes).map((value) => [value]);
  const perPool = Math.max(2, Math.floor(Math.sqrt(maxProbes)));
  const trimmed = pools.map((pool) => pool.slice(0, perPool));
  let tuples = [[]];
  for (const pool of trimmed) {
    tuples = tuples.flatMap((prefix) => pool.map((value) => [...prefix, value]));
    if (tuples.length > maxProbes * 4) tuples = tuples.slice(0, maxProbes * 4);
  }
  return tuples.slice(0, maxProbes);
}

/**
 * Find self-contained Python functions: top level, no decorators, small, and
 * referring to nothing outside their own parameters, locals, and builtins.
 * Only such a function can be lifted out of the repository and still mean the
 * same thing on its own, which is what makes the oracle honest.
 */
export function selfContainedFunctions(repository, sources, options = {}) {
  const limits = { ...DEFAULT_SANDBOX_LIMITS, ...(options.limits ?? {}) };
  const candidates = [];
  for (const [filePath, source] of Object.entries(sources ?? {})) {
    if (!/\.py$/.test(filePath) || typeof source !== "string") continue;
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!/^def\s+[A-Za-z_]/.test(lines[index])) continue;
      if (index > 0 && /^\s*@/.test(lines[index - 1])) continue;
      const signature = parseSignature(lines[index]);
      if (!signature) continue;
      if (!signature.parameters.length || signature.parameters.length > limits.maxParameters) continue;
      let end = index + 1;
      while (end < lines.length && (lines[end].trim() === "" || /^\s/.test(lines[end]))) end += 1;
      const body = lines.slice(index + 1, end);
      while (body.length && body.at(-1).trim() === "") body.pop();
      if (!body.length || body.length > limits.maxBodyLines) continue;
      const bodyText = body.join("\n");
      if (!/\breturn\b/.test(bodyText)) continue;
      if (/\b(?:yield|await|async|global|nonlocal|import)\b/.test(bodyText)) continue;
      if (/^\s*(?:class|def)\s/m.test(bodyText)) continue;

      const declared = new Set([signature.name, ...signature.parameters.map((parameter) => parameter.name)]);
      for (const assignment of bodyText.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=[^=]/gm)) declared.add(assignment[1]);
      for (const loop of bodyText.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_,\s]*?)\s+in\b/g)) {
        for (const name of loop[1].split(",")) declared.add(name.trim());
      }
      for (const bound of bodyText.matchAll(/\bas\s+([A-Za-z_][A-Za-z0-9_]*)/g)) declared.add(bound[1]);
      const free = bodyIdentifiers(bodyText).filter((identifier) => !declared.has(identifier) && !PYTHON_BUILTINS.has(identifier));
      if (free.length) continue;
      // The quiz anchor has to be openable, so a candidate the index does not
      // know about is not a candidate: it would point the learner at nothing.
      if (repository?.symbols?.length && !repository.symbols.some((symbol) => symbol.path === filePath && symbol.name === signature.name)) continue;

      const docstring = /^\s*(?:"""|''')([\s\S]*?)(?:"""|''')/.exec(bodyText)?.[1]?.trim() ?? null;
      candidates.push({
        path: filePath,
        line: index + 1,
        name: signature.name,
        signature,
        header: lines[index],
        source: [lines[index], ...body].join("\n"),
        docstring: docstring ? docstring.slice(0, 400) : null,
        bodyLines: body.length,
        callers: new Set(
          (repository?.callEdges ?? [])
            .filter((edge) => edge.resolved && edge.callee === signature.name && edge.targetPath === filePath && edge.caller)
            .map((edge) => `${edge.path}#${edge.caller}`),
        ).size,
      });
    }
  }
  // Prefer functions the repository actually uses, then the meatiest bodies, so
  // the quiz is about code that matters rather than an unused helper.
  return candidates.sort((left, right) => right.callers - left.callers || right.bodyLines - left.bodyLines || left.path.localeCompare(right.path));
}

// A repr that says nothing about the implementation: an empty string, an empty
// container, zero, or None. Useful as a test, useless as the worked example.
const DEGENERATE = new Set(["''", '""', "[]", "{}", "()", "0", "0.0", "None", "False", "set()"]);

/**
 * Choose the cases to keep.
 *
 * Distinct outputs come first, so the suite discriminates between
 * implementations rather than restating one behavior ten times, and the worked
 * example is the first non-degenerate result so the learner sees the function
 * doing something.
 */
export function selectCases(accepted, calls, wanted) {
  const seen = new Map();
  const primary = [];
  const secondary = [];
  for (const result of accepted) {
    const count = seen.get(result.value) ?? 0;
    seen.set(result.value, count + 1);
    // The second occurrence of an output is still worth keeping as a regression
    // check; the third and beyond only pad the suite.
    (count === 0 ? primary : count === 1 ? secondary : []).push(result);
  }
  const ordered = [...primary, ...secondary];
  const exampleIndex = ordered.findIndex((result) => !DEGENERATE.has(result.value) && (calls[result.index] ?? []).some((argument) => argument !== "" && argument !== 0 && argument !== null));
  if (exampleIndex > 0) ordered.unshift(...ordered.splice(exampleIndex, 1));
  return ordered.slice(0, wanted);
}

/**
 * Build one executable quiz by capturing the real implementation's behavior.
 *
 * A candidate is rejected unless its recorded outputs actually *discriminate*:
 * at least four accepted inputs producing at least three distinct results.
 * Without that gate a constant function would make a quiz that `return 0`
 * passes, which teaches nothing.
 */
export async function buildExecutableQuiz(repository, options = {}) {
  const limits = { ...DEFAULT_SANDBOX_LIMITS, ...(options.limits ?? {}) };
  const runtimes = await detectRuntimes();
  if (!runtimes.python?.available) {
    return { available: false, reason: "Executable quizzes need a local Python runtime, which is not installed here.", version: EXECUTABLE_QUIZ_VERSION };
  }
  const candidates = selfContainedFunctions(repository, options.sources ?? {}, { limits })
    .filter((candidate) => !options.symbol || candidate.name === options.symbol);
  if (!candidates.length) {
    return { available: false, reason: "No self-contained function in this repository can be lifted into a sandbox.", version: EXECUTABLE_QUIZ_VERSION };
  }

  const rejected = [];
  for (const candidate of candidates.slice(0, options.maxCandidates ?? 12)) {
    const calls = probeArguments(candidate.signature.parameters, limits.maxProbes);
    const oracle = await runInSandbox({ moduleSource: candidate.source, entry: candidate.name, calls }, { limits });
    if (oracle.status !== "ok") { rejected.push({ name: candidate.name, reason: oracle.status }); continue; }
    const accepted = (oracle.results ?? []).filter((result) => result.ok);
    const distinct = new Set(accepted.map((result) => result.value));
    if (accepted.length < 4 || distinct.size < 3) {
      rejected.push({ name: candidate.name, reason: accepted.length < 4 ? "too-few-accepted-inputs" : "not-discriminating" });
      continue;
    }
    const cases = selectCases(accepted, calls, limits.maxCases + 1).map((result, index) => ({
      id: `case-${digest(`${candidate.path}:${candidate.name}:${index}`)}`,
      name: index === 0 ? "worked example" : `hidden test ${index}`,
      visible: index === 0,
      arguments: calls[result.index],
      expected: result.value,
    }));
    return {
      available: true,
      version: EXECUTABLE_QUIZ_VERSION,
      id: `quiz-${digest(`${repository?.versionId ?? ""}:${candidate.path}:${candidate.name}`)}`,
      language: "python",
      entry: candidate.name,
      path: candidate.path,
      line: candidate.line,
      anchor: { path: candidate.path, line: candidate.line, symbol: candidate.name },
      header: candidate.header,
      docstring: candidate.docstring,
      callers: candidate.callers,
      starter: `${candidate.header}\n    # Reimplement this function so it behaves exactly like the repository's.\n    ...\n`,
      prompt: `Reimplement \`${candidate.name}\` from ${candidate.path}:${candidate.line} so it behaves exactly like the version this repository ships. One worked example is shown; the remaining ${cases.length - 1} tests are hidden and were recorded by running the real implementation.`,
      cases,
      limits: { wallClockMs: limits.wallClockMs, cpuSeconds: limits.cpuSeconds, memoryBytes: limits.memoryBytes, maxSubmissionBytes: limits.maxSubmissionBytes },
      oracleEnforced: oracle.enforced ?? {},
      rejectedCandidates: rejected,
    };
  }
  return {
    available: false,
    reason: "No candidate function produced tests that discriminate between implementations.",
    version: EXECUTABLE_QUIZ_VERSION,
    rejectedCandidates: rejected,
  };
}

/**
 * The renderer's view of a quiz. Hidden cases keep their name and nothing else:
 * neither their inputs nor the expected outputs cross the IPC boundary, so the
 * oracle cannot be read out of the DOM.
 */
export function publicQuiz(quiz) {
  if (!quiz?.available) return quiz;
  const [example] = quiz.cases;
  return {
    available: true,
    version: quiz.version,
    id: quiz.id,
    language: quiz.language,
    entry: quiz.entry,
    anchor: quiz.anchor,
    header: quiz.header,
    docstring: quiz.docstring,
    callers: quiz.callers,
    prompt: quiz.prompt,
    starter: quiz.starter,
    limits: quiz.limits,
    allowedModules: ALLOWED_MODULES,
    // Named `result` rather than `expected` so item 40's egress guard can treat
    // *any* `expected` field on this channel as a leak without exception.
    example: { id: example.id, arguments: example.arguments, result: example.expected },
    hiddenCases: quiz.cases.slice(1).map((item) => ({ id: item.id, name: item.name })),
  };
}

/**
 * Run a submission against every case and report per-case outcomes.
 *
 * A failing hidden case reveals its *input* — which is a hint — but never its
 * expected output, which is the answer.
 */
export async function gradeSubmission(quiz, submission, options = {}) {
  const limits = { ...DEFAULT_SANDBOX_LIMITS, ...(options.limits ?? {}) };
  const screen = screenSubmission(submission, { limits, entry: quiz.entry });
  if (!screen.allowed) {
    return {
      version: EXECUTABLE_QUIZ_VERSION,
      quizId: quiz.id,
      status: "refused",
      passed: false,
      reason: `The submission was refused before it ran: ${screen.findings.map((finding) => finding.reason).join("; ")}.`,
      findings: screen.findings,
      cases: [],
      passedCases: 0,
      totalCases: quiz.cases.length,
    };
  }

  const run = await runInSandbox(
    { moduleSource: submission, entry: quiz.entry, calls: quiz.cases.map((item) => item.arguments) },
    { limits },
  );
  if (run.status !== "ok") {
    return {
      version: EXECUTABLE_QUIZ_VERSION,
      quizId: quiz.id,
      status: run.status,
      passed: false,
      reason: run.reason ?? run.error ?? `The submission did not run (${run.status}).`,
      enforced: run.enforced ?? {},
      cases: [],
      passedCases: 0,
      totalCases: quiz.cases.length,
      stderr: run.stderr,
    };
  }

  const byIndex = new Map((run.results ?? []).map((result) => [result.index, result]));
  const cases = quiz.cases.map((item, index) => {
    const result = byIndex.get(index);
    const passed = Boolean(result?.ok) && result.value === item.expected;
    return {
      id: item.id,
      name: item.name,
      visible: item.visible,
      passed,
      // The input is a legitimate hint; the expected value is the answer and
      // is only ever returned for the worked example.
      arguments: item.arguments,
      expected: item.visible ? item.expected : undefined,
      actual: item.visible ? result?.value : undefined,
      outcome: passed ? "passed" : result?.ok ? "wrong-value" : result ? "raised" : "no-result",
      error: result?.ok ? undefined : result?.error,
    };
  });
  const passedCases = cases.filter((item) => item.passed).length;
  return {
    version: EXECUTABLE_QUIZ_VERSION,
    quizId: quiz.id,
    status: "ran",
    passed: passedCases === cases.length,
    passedCases,
    totalCases: cases.length,
    hiddenPassed: cases.filter((item) => !item.visible && item.passed).length,
    hiddenTotal: cases.filter((item) => !item.visible).length,
    score: cases.length ? Number((passedCases / cases.length).toFixed(4)) : 0,
    durationMs: run.durationMs ?? 0,
    peakMemoryBytes: run.peakMemoryBytes ?? 0,
    enforced: run.enforced ?? {},
    stdout: run.stdout,
    cases,
  };
}
