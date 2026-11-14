import vm from "node:vm";
import { createInterface } from "node:readline";

/**
 * The bootstrap that runs *inside* a repository-exercise child process
 * (item 41).
 *
 * `executable-quiz.mjs` asks a learner to reimplement a function; this module
 * asks a different question: can the learner write code that *calls tools* to
 * find something out about the repository, the way they would reach for a
 * grep or a debugger while actually working in one? The two problems want
 * different sandboxes. A Python function is pure — it has no legitimate
 * reason to touch the filesystem — so that sandbox spends its effort removing
 * access. A repository-analysis script's entire point is to look things up,
 * so this sandbox spends its effort on *which* lookups are possible rather
 * than on removing all of them: nothing the submission runs can reach
 * anything except the `tools` object this file hands it, because nothing else
 * is there to reach.
 *
 * That property comes from `node:vm` rather than from deleting globals after
 * the fact. A fresh `vm.createContext` is a new V8 global object carrying only
 * the language's own intrinsics (`Object`, `Array`, `JSON`, `Math`,
 * `Promise`, ...); none of Node's additions — `process`, `require`, `Buffer`,
 * `fetch`, `global` — exist in it unless this file puts them there, and it
 * does not. A submission that writes `process.env` is not sandboxed from
 * `process`; it is reaching for a name that is simply undefined.
 *
 * Stated plainly, because the Node documentation says the same thing about
 * its own `vm` module: this is not a security boundary against a determined
 * V8 exploit. It is a *reachability* boundary — correct by construction for
 * ordinary JavaScript, not proof against an engine bug — which is why it runs
 * inside a disposable child process with no ambient secrets (item 41's own
 * requirement) rather than inside the main process: the same "fault boundary,
 * not a sandbox" posture `plugins.mjs` already states and accepts for
 * installed, signed plugins. This process holds nothing worth stealing even
 * if the reachability boundary failed.
 */

const pending = new Map();
let nextId = 1;

/** Mirrors `plugin-host.mjs`'s send: await the flush, not just the call. */
function send(message) {
  return new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(message)}\n`, resolve);
  });
}

function hostCall(capability, args) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    void send({ type: "host", id, capability, args });
  });
}

/** Only a function exists for a capability that was actually granted. */
function buildTools(capabilities) {
  const tools = {};
  for (const capability of capabilities ?? []) {
    switch (capability) {
      case "list-files":
        tools.listFiles = () => hostCall("list-files", []);
        break;
      case "read-file":
        tools.readFile = (filePath) => hostCall("read-file", [filePath]);
        break;
      case "symbols":
        tools.symbols = (filePath) => hostCall("symbols", [filePath]);
        break;
      case "callers":
        tools.callers = (symbolName) => hostCall("callers", [symbolName]);
        break;
      default:
        break;
    }
  }
  return Object.freeze(tools);
}

const reader = createInterface({ input: process.stdin });

reader.on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    await send({ type: "error", message: "The host sent something that is not a protocol message." });
    process.exit(1);
    return;
  }

  if (message.type === "host-result") {
    const waiting = pending.get(message.id);
    pending.delete(message.id);
    if (!waiting) return;
    if (message.ok) waiting.resolve(message.value);
    else waiting.reject(new Error(message.error ?? "The host refused."));
    return;
  }

  if (message.type !== "run") return;

  // The same discipline `plugin-host.mjs` uses: only a protocol line written
  // by this file may reach stdout, so a stray `console.log` cannot corrupt
  // the newline-delimited JSON the parent is reading.
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === "string" && chunk.startsWith("{\"type\":")) return write(chunk, ...rest);
    return true;
  };

  const logs = [];
  const capture = (...parts) => {
    const rendered = parts.map((part) => {
      if (typeof part === "string") return part;
      try { return JSON.stringify(part); } catch { return String(part); }
    }).join(" ");
    if (logs.length < 200) logs.push(rendered.slice(0, 2_000));
  };

  try {
    const tools = buildTools(message.capabilities);
    // The sandbox's entire global object. Nothing not listed here exists
    // inside the submission's execution context.
    const sandbox = { tools, console: { log: capture, error: capture, warn: capture, info: capture } };
    const context = vm.createContext(sandbox);
    const wrapped = `(async () => {\n${message.submission}\n})()`;
    const script = new vm.Script(wrapped, { filename: "<repository-exercise-submission>" });
    // `timeout` here bounds only the *synchronous* portion of the run (a
    // submission that busy-loops before its first `await`); it cannot bound
    // time spent awaiting a tool call that never answers. The parent's
    // process-level timeout is what actually guarantees the wall clock, the
    // same division of labor `plugins.mjs`'s `runPlugin` already uses.
    const resultPromise = script.runInContext(context, { timeout: message.timeoutMs ?? 10_000 });
    const value = await resultPromise;
    await send({ type: "result", value: value === undefined ? null : value, logs });
  } catch (cause) {
    await send({ type: "error", message: String(cause?.stack ?? cause?.message ?? cause), logs });
  }
  process.exit(0);
});
