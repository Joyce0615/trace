import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

/**
 * The bootstrap that runs *inside* a plugin's process (item 58).
 *
 * Nothing in this file is trusted by the parent. It exists to make writing a
 * plugin pleasant — an exported async function, an awaitable host object — and
 * to keep the protocol details out of every plugin. Every check that matters
 * happens on the other side of the pipe: capabilities are re-checked in the
 * parent when a host call arrives, results are validated against the schema for
 * the plugin's kind, and the whole process is killed on a timeout. A plugin
 * that deletes half of this file can misbehave only inside its own process.
 *
 * The protocol is newline-delimited JSON on stdio, which is why the first thing
 * this does is take `console.log` away: a plugin that prints a debugging line
 * would otherwise write into the middle of the protocol and be read as a
 * malformed message. `host.log` is the supported way to say something, and it
 * goes through the parent's redaction.
 */

const pending = new Map();
let nextId = 1;

/**
 * Write one protocol line and wait for it to reach the pipe.
 *
 * Awaiting the flush is not tidiness. A large result does not fit in the pipe
 * buffer, `write` returns false, and `process.exit` immediately afterwards
 * discards the rest — so the parent sees a truncated line, a clean exit code,
 * and concludes the plugin returned nothing. The failure looked like a plugin
 * bug and was a host bug.
 */
function send(message) {
  return new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(message)}\n`, resolve);
  });
}

/** Ask the parent for something. Rejects when the capability was not granted. */
function hostCall(capability, ...args) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    void send({ type: "host", id, capability, args });
  });
}

function buildHost(capabilities) {
  const host = {};
  for (const capability of capabilities) {
    switch (capability) {
      case "read-file":
        host.readFile = (filePath) => hostCall("read-file", filePath);
        break;
      case "list-files":
        host.listFiles = () => hostCall("list-files");
        break;
      case "symbols":
        host.symbols = (filePath) => hostCall("symbols", filePath);
        break;
      case "log":
        host.log = (message) => hostCall("log", String(message));
        break;
      default:
        break;
    }
  }
  // Frozen so a plugin cannot replace `readFile` with something that looks like
  // it for any other code sharing the process.
  return Object.freeze(host);
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

  if (message.type !== "invoke") return;

  // Taken away before the plugin is imported, so a `console.log` at module
  // scope cannot corrupt the protocol either.
  const write = process.stdout.write.bind(process.stdout);
  const swallow = (...parts) => { void parts; };
  for (const method of ["log", "info", "debug", "trace", "warn", "error", "dir", "table"]) {
    // Reached through `globalThis` so silencing the console is not itself read
    // as using it.
    globalThis.console[method] = swallow;
  }
  process.stdout.write = (chunk, ...rest) => {
    // Only protocol lines this file produced may reach the parent.
    if (typeof chunk === "string" && chunk.startsWith("{\"type\":")) return write(chunk, ...rest);
    return true;
  };

  try {
    const module = await import(pathToFileURL(message.entry).href);
    const entry = module.default ?? module[message.kind] ?? module.run;
    if (typeof entry !== "function") {
      await send({ type: "error", message: `The plugin exports no callable entry point (looked for default, ${message.kind}, run).` });
      process.exit(0);
      return;
    }
    const value = await entry(message.input, buildHost(message.capabilities ?? []));
    await send({ type: "result", value: value ?? null });
  } catch (cause) {
    await send({ type: "error", message: String(cause?.stack ?? cause?.message ?? cause) });
  }
  // The parent kills the process anyway; exiting cleanly keeps a successful run
  // distinguishable from a crash in the parent's `close` handler.
  process.exit(0);
});
