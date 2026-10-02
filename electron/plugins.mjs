import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IpcValidationError, s, validatePayload } from "./ipc-schema.mjs";
import { redactValue } from "./secret-scanner.mjs";
import { signPayload, verifyPayload } from "./signing.mjs";

/**
 * Plugin APIs for indexers, agents, course generators, graders, and
 * visualizations (item 58).
 *
 * The obvious way to build this is `await import(pluginPath)` in the main
 * process. That would undo the previous forty items in one line. `main.mjs` can
 * read any file the learner can read, spawn processes, open windows, and reach
 * the network; a plugin imported into it inherits every one of those, and the
 * careful work on path validation, link policy, prompt isolation, and answer
 * leakage would protect the application from the repository while leaving it
 * wide open to an extension somebody installed because it made nicer diagrams.
 *
 * So the design question is not "how do plugins run" but **"what is a plugin
 * not allowed to do, and what enforces it"**. Five things do:
 *
 *   - **A separate process.** Plugin code never executes in the main process.
 *     It runs in a child with `ELECTRON_RUN_AS_NODE`, talking newline-delimited
 *     JSON over stdio, the same shape as the language-server client. A plugin
 *     that hangs, allocates without limit, or crashes takes down a process
 *     nobody was using.
 *
 *   - **Capabilities, granted rather than assumed.** A manifest *declares* what
 *     it needs; the host *grants* a subset; the plugin's host object contains
 *     only what was granted. Crucially the check is repeated in the parent when
 *     the call arrives, because a compromised child can ask for anything and
 *     enforcement inside the sandbox is enforcement by the thing being
 *     restrained.
 *
 *   - **Signatures.** A plugin is code that will execute, so the rule is the
 *     updater's rather than the course package's: an intact signature from an
 *     unknown key is a *refusal*, not a warning.
 *
 *   - **Schemas on the way back.** Every result is validated against the schema
 *     for its kind before it touches anything. A plugin cannot invent structure
 *     inside the application's data model, and a field it was never meant to
 *     set is rejected rather than merged.
 *
 *   - **Bounds and fallbacks.** Wall-clock timeout, result size ceiling, and a
 *     cap on host calls. A plugin failing must never break the feature it
 *     extends: every entry point falls back to the built-in behaviour and
 *     reports which plugin failed and why.
 *
 * Stated limitation, because it is the one that matters: a child process is a
 * *fault* boundary and a capability boundary, not a full security sandbox. The
 * plugin process runs as the same user and can read what that user can read.
 * What it cannot do is act *through this application* — no host call it was not
 * granted, no result that does not fit the schema, no unbounded run. Genuine
 * OS-level confinement needs a sandbox this project cannot portably assume, and
 * pretending otherwise would be worse than saying so.
 */

export const PLUGIN_API_VERSION = 1;

export const PLUGIN_KINDS = ["indexer", "agent", "course-generator", "grader", "visualization"];

/**
 * What a plugin may ask the host to do.
 *
 * Each one is narrow on purpose. `read-file` is not "read a file", it is "read
 * a file inside the repository the host is currently working on", resolved by
 * the host through the same validation `repository:read-file` uses.
 */
export const PLUGIN_CAPABILITIES = {
  "read-file": "Read one file from inside the repository being indexed, through the host's path validation.",
  "list-files": "List the paths the host has already indexed. No sizes, no contents, no absolute paths.",
  "symbols": "Read the definitions the built-in indexers already found.",
  "log": "Write a line to the host's plugin log, redacted before it is stored.",
};

/** Absolute ceilings, whatever a manifest asks for. */
export const PLUGIN_LIMITS = {
  timeoutMs: 15_000,
  maxResultBytes: 2_000_000,
  maxHostCalls: 2_000,
  maxLogChars: 500,
};

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

const manifestSchema = s.object({
  id: s.string({ maxLength: 64, minLength: 3, pattern: /^[a-z0-9][a-z0-9-]*$/ }),
  name: s.string({ maxLength: 120 }),
  version: s.string({ maxLength: 32, pattern: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/ }),
  kind: s.literal(PLUGIN_KINDS),
  apiVersion: s.number({ integer: true, min: 1, max: 1_000 }),
  entry: s.string({ maxLength: 200, pattern: /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/ }),
  // Required, not optional: an optional code digest is a code digest nobody
  // sets, and a signature over a filename certifies nothing.
  entryDigest: s.string({ maxLength: 64, minLength: 64, pattern: /^[0-9a-f]{64}$/ }),
  capabilities: s.array(s.literal(Object.keys(PLUGIN_CAPABILITIES)), { maxItems: 8 }),
  description: s.string({ maxLength: 500, optional: true }),
  // An indexer says what it claims, so the host can decide whether to call it
  // at all rather than handing everything to everything. `extensions` matters
  // more than `languages`: the interesting case is a language this build does
  // not recognise, and for those `languageFor` returns "plaintext", so matching
  // on language alone would never select the files the plugin exists for.
  languages: s.array(s.string({ maxLength: 40 }), { maxItems: 40, optional: true }),
  extensions: s.array(s.string({ maxLength: 16, pattern: /^\.[A-Za-z0-9_.-]+$/ }), { maxItems: 40, optional: true }),
  timeoutMs: s.number({ integer: true, min: 100, max: PLUGIN_LIMITS.timeoutMs, optional: true }),
});

/**
 * The bytes a plugin manifest is signed over.
 *
 * The entry file's digest is inside it, so signing the manifest signs the code:
 * a signature over a manifest whose `entry` could be swapped would certify
 * nothing at all.
 */
export function manifestPayload(manifest) {
  const { signature: _signature, ...rest } = manifest ?? {};
  return rest;
}

export function signPluginManifest(manifest, keyPair) {
  return { ...manifest, signature: signPayload("plugin", manifestPayload(manifest), keyPair) };
}

function refuse(id, reason, detail) {
  return { id: id ?? null, loaded: false, reason, detail };
}

/**
 * Read and check one plugin directory.
 *
 * Every refusal names the check that failed. "Plugin failed to load" is a
 * message that teaches people to delete the plugin and try another one.
 */
export async function inspectPlugin(directory, options = {}) {
  const trustedKeyIds = options.trustedKeyIds ?? [];
  let raw;
  try {
    raw = JSON.parse(await readFile(path.join(directory, "plugin.json"), "utf8"));
  } catch (cause) {
    return refuse(path.basename(directory), "unreadable-manifest", `plugin.json could not be read or parsed (${cause?.message ?? "unknown"}).`);
  }

  const { signature = null, ...declared } = raw;
  let manifest;
  try {
    manifest = validatePayload("plugin.json", manifestSchema, declared);
  } catch (cause) {
    return refuse(declared.id ?? path.basename(directory), "invalid-manifest", cause instanceof IpcValidationError ? cause.message : String(cause?.message ?? cause));
  }
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    return refuse(manifest.id, "api-version", `Targets plugin API ${manifest.apiVersion}; this build speaks ${PLUGIN_API_VERSION}.`);
  }

  const entryPath = path.resolve(directory, manifest.entry);
  // `entry` is pattern-restricted, but resolving and re-checking is what stops
  // a manifest from reaching outside its own directory by any route.
  if (!entryPath.startsWith(path.resolve(directory) + path.sep)) {
    return refuse(manifest.id, "entry-escape", `The entry ${manifest.entry} resolves outside the plugin directory.`);
  }
  let entrySource;
  try {
    entrySource = await readFile(entryPath, "utf8");
  } catch {
    return refuse(manifest.id, "missing-entry", `The entry file ${manifest.entry} is not in the plugin directory.`);
  }

  // Code that will execute: an intact signature from an unknown key is a
  // refusal, not a warning. That is the updater's rule, not the course
  // package's, and for the same reason.
  const seal = verifyPayload("plugin", manifestPayload(raw), signature, { trustedKeyIds });
  if (!seal.verified) {
    return { ...refuse(manifest.id, "unsigned-or-tampered", `The manifest's signature did not verify (${seal.reason}).`), seal };
  }
  if (seal.trust !== "trusted") {
    return { ...refuse(manifest.id, "untrusted-key", `Signed by ${seal.keyId}, which this installation does not trust.`), seal };
  }
  // The signature covers the manifest; the manifest pins the code. Without
  // `entryDigest` a signature would certify a filename, and the file behind it
  // could be replaced by anybody who could write to the directory.
  if (manifest.entryDigest !== entryDigest(entrySource)) {
    return { ...refuse(manifest.id, "entry-changed", "The entry file is not the one the manifest was signed over."), seal };
  }

  const granted = (manifest.capabilities ?? []).filter((capability) => (options.grant ?? Object.keys(PLUGIN_CAPABILITIES)).includes(capability));
  const withheld = (manifest.capabilities ?? []).filter((capability) => !granted.includes(capability));
  return {
    id: manifest.id,
    loaded: true,
    reason: null,
    detail: null,
    manifest,
    directory: path.resolve(directory),
    entryPath,
    seal,
    granted,
    // Reported, not silently dropped: a plugin running with less than it asked
    // for may behave differently, and the learner is entitled to know which.
    withheld,
    timeoutMs: Math.min(manifest.timeoutMs ?? PLUGIN_LIMITS.timeoutMs, PLUGIN_LIMITS.timeoutMs),
  };
}

/** The digest a manifest pins its entry file to. */
export function entryDigest(source) {
  return createHash("sha256").update(source).digest("hex");
}

/** Load every plugin in a directory, keeping the refusals. */
export async function loadPlugins(directory, options = {}) {
  let entries = [];
  try {
    entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch {
    return { directory, plugins: [], refused: [], available: false };
  }
  const plugins = [];
  const refused = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const inspected = await inspectPlugin(path.join(directory, entry.name), options);
    if (inspected.loaded) plugins.push(inspected);
    else refused.push({ directory: entry.name, ...inspected });
  }
  return { directory, plugins, refused, available: true };
}

// ---------------------------------------------------------------------------
// Result schemas, one per kind
// ---------------------------------------------------------------------------

const definition = s.object({
  name: s.string({ maxLength: 200, minLength: 1 }),
  path: s.string({ maxLength: 1_024 }),
  line: s.number({ integer: true, min: 1, max: 10_000_000 }),
  kind: s.string({ maxLength: 40, optional: true }),
  container: s.string({ maxLength: 200, optional: true, nullable: true }),
});

/**
 * What each kind of plugin is allowed to return.
 *
 * Unknown fields are rejected rather than ignored, so a plugin cannot smuggle
 * structure into the application's data model and have it survive by accident.
 */
export const PLUGIN_RESULT_SCHEMAS = {
  indexer: s.object({
    definitions: s.array(definition, { maxItems: 5_000 }),
    // A plugin may say it did not understand a file. Returning nothing and
    // returning "I have nothing to say about this" are different answers.
    skipped: s.array(s.string({ maxLength: 1_024 }), { maxItems: 5_000, optional: true }),
  }),
  agent: s.object({
    text: s.string({ maxLength: 20_000 }),
    citations: s.array(s.object({ path: s.string({ maxLength: 1_024 }), line: s.number({ integer: true, min: 1, max: 10_000_000 }) }), { maxItems: 50, optional: true }),
  }),
  "course-generator": s.object({
    lessons: s.array(s.object({
      id: s.string({ maxLength: 128 }),
      title: s.string({ maxLength: 300 }),
      objective: s.string({ maxLength: 2_000 }),
      anchors: s.array(s.object({ path: s.string({ maxLength: 1_024 }), line: s.number({ integer: true, min: 1, max: 10_000_000 }) }), { maxItems: 40 }),
    }), { maxItems: 60 }),
  }),
  grader: s.object({
    // A plugin grader contributes *feedback*, never a score the host stores as
    // truth: the built-in graders own the number, and an extension that could
    // set it could also set it to full marks.
    notes: s.array(s.object({
      id: s.string({ maxLength: 128 }),
      message: s.string({ maxLength: 2_000 }),
      severity: s.literal(["info", "suggestion", "warning"]),
    }), { maxItems: 40 }),
  }),
  visualization: s.object({
    format: s.literal(["mermaid", "dot"]),
    source: s.string({ maxLength: 40_000 }),
    title: s.string({ maxLength: 200, optional: true }),
  }),
};

// ---------------------------------------------------------------------------
// Running one
// ---------------------------------------------------------------------------

function failure(plugin, reason, detail) {
  return { ok: false, pluginId: plugin?.id ?? null, reason, detail, result: null, hostCalls: 0, durationMs: 0 };
}

/**
 * Run one plugin in its own process and return a validated result.
 *
 * `host` is a map of capability -> async handler. It is called *only* for
 * capabilities the plugin was granted, checked here rather than in the child,
 * because a check inside the sandbox is a check performed by the thing being
 * restrained.
 */
export async function runPlugin(plugin, input, options = {}) {
  if (!plugin?.loaded) return failure(plugin, "not-loaded", "This plugin was refused at load time and cannot be run.");
  const schema = PLUGIN_RESULT_SCHEMAS[plugin.manifest.kind];
  if (!schema) return failure(plugin, "unknown-kind", `No result schema for ${plugin.manifest.kind}.`);

  const timeoutMs = Math.min(options.timeoutMs ?? plugin.timeoutMs, PLUGIN_LIMITS.timeoutMs);
  const host = options.host ?? {};
  const logs = [];
  const started = Date.now();
  let hostCalls = 0;

  const child = spawn(options.execPath ?? process.execPath, [path.join(currentDirectory, "plugin-host.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      // `ELECTRON_RUN_AS_NODE` makes the Electron binary behave as Node, so a
      // packaged application does not need a Node installation beside it.
      ELECTRON_RUN_AS_NODE: "1",
      // A deliberately bare environment: the plugin gets no tokens, no proxy
      // settings, and no path into the learner's shell configuration.
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
      resolve({ ...outcome, pluginId: plugin.id, hostCalls, durationMs: Date.now() - started, logs });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, reason: "timeout", detail: `The plugin did not answer within ${timeoutMs} ms.`, result: null });
    }, timeoutMs);

    const send = (message) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    child.stdout.on("data", async (chunk) => {
      bytes += chunk.length;
      if (bytes > PLUGIN_LIMITS.maxResultBytes) {
        finish({ ok: false, reason: "oversized", detail: `The plugin wrote more than ${PLUGIN_LIMITS.maxResultBytes} bytes.`, result: null });
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
          finish({ ok: false, reason: "protocol", detail: "The plugin wrote something that is not a protocol message.", result: null });
          return;
        }
        if (message.type === "host") {
          hostCalls += 1;
          if (hostCalls > PLUGIN_LIMITS.maxHostCalls) {
            finish({ ok: false, reason: "too-many-host-calls", detail: `More than ${PLUGIN_LIMITS.maxHostCalls} host calls; a plugin doing that is doing something other than what it declared.`, result: null });
            return;
          }
          // The capability check, in the parent, on every call.
          if (!plugin.granted.includes(message.capability)) {
            send({ type: "host-result", id: message.id, ok: false, error: `The capability “${message.capability}” was not granted to ${plugin.id}.` });
            continue;
          }
          if (message.capability === "log") {
            // Redacted before it is kept: a plugin log is a file on disk.
            logs.push(redactValue(String(message.args?.[0] ?? "")).slice(0, PLUGIN_LIMITS.maxLogChars));
            send({ type: "host-result", id: message.id, ok: true, value: true });
            continue;
          }
          const handler = host[message.capability];
          if (typeof handler !== "function") {
            send({ type: "host-result", id: message.id, ok: false, error: `The host offers no “${message.capability}” in this context.` });
            continue;
          }
          try {
            send({ type: "host-result", id: message.id, ok: true, value: await handler(...(message.args ?? [])) });
          } catch (cause) {
            send({ type: "host-result", id: message.id, ok: false, error: String(cause?.message ?? cause) });
          }
          continue;
        }
        if (message.type === "result") {
          let validated;
          try {
            validated = validatePayload(`plugin:${plugin.id}`, schema, message.value);
          } catch (cause) {
            finish({ ok: false, reason: "invalid-result", detail: cause instanceof IpcValidationError ? cause.message : String(cause?.message ?? cause), result: null });
            return;
          }
          finish({ ok: true, reason: null, detail: null, result: validated });
          return;
        }
        if (message.type === "error") {
          finish({ ok: false, reason: "plugin-error", detail: String(message.message ?? "The plugin threw.").slice(0, 1_000), result: null });
          return;
        }
      }
    });

    child.stderr.on("data", (chunk) => { stderrBuffer = `${stderrBuffer}${chunk}`.slice(-2_000); });
    child.on("error", (cause) => finish({ ok: false, reason: "spawn-failed", detail: String(cause?.message ?? cause), result: null }));
    child.on("close", (code) => {
      finish({
        ok: false,
        reason: code === 0 ? "no-result" : "crashed",
        detail: code === 0 ? "The plugin exited without returning a result." : `The plugin exited with code ${code}. ${stderrBuffer.trim().split("\n").at(-1) ?? ""}`.trim(),
        result: null,
      });
    });

    send({ type: "invoke", entry: plugin.entryPath, kind: plugin.manifest.kind, capabilities: plugin.granted, input });
  });
}

// ---------------------------------------------------------------------------
// The indexer extension point
// ---------------------------------------------------------------------------

/**
 * Ask indexer plugins about files the built-in indexers could not read.
 *
 * The order is deliberate: plugins are asked *last*, about files where
 * tree-sitter has no grammar and the regex patterns found nothing. An extension
 * that could override the built-in index could also quietly replace what a
 * learner is told the repository contains.
 */
export function filesClaimedBy(plugin, files) {
  const languages = plugin.manifest.languages ?? [];
  const extensions = plugin.manifest.extensions ?? [];
  // A plugin that claims nothing claims nothing. An unrestricted indexer would
  // be handed every unreadable file in the repository, which is neither what
  // anybody writes nor something the host should offer by default.
  if (!languages.length && !extensions.length) return [];
  return files.filter((file) => languages.includes(file.language)
    || extensions.some((extension) => file.path.toLowerCase().endsWith(extension.toLowerCase())));
}

export async function runIndexerPlugins(plugins, { files, host, hostFor = null } = {}) {
  const contributions = [];
  const problems = [];
  for (const plugin of plugins ?? []) {
    if (plugin.manifest.kind !== "indexer") continue;
    const claimed = filesClaimedBy(plugin, files);
    if (!claimed.length) continue;
    const outcome = await runPlugin(plugin, { files: claimed.map((file) => ({ path: file.path, language: file.language })) }, {
      host: hostFor ? hostFor(plugin) : host,
    });
    if (!outcome.ok) {
      // A failing plugin must never break indexing; it is dropped and named.
      problems.push({ pluginId: plugin.id, reason: outcome.reason, detail: outcome.detail });
      continue;
    }
    const claimedPaths = new Set(claimed.map((file) => file.path));
    // A definition for a file the plugin was not asked about is discarded: the
    // plugin was given a list, and answering about anything else is answering a
    // question nobody asked.
    const kept = outcome.result.definitions.filter((item) => claimedPaths.has(item.path));
    contributions.push({
      pluginId: plugin.id,
      definitions: kept,
      discarded: outcome.result.definitions.length - kept.length,
      durationMs: outcome.durationMs,
      hostCalls: outcome.hostCalls,
      logs: outcome.logs,
    });
  }
  return { contributions, problems };
}

/** What a renderer may see about the installed plugins. */
export function publicPluginReport(loaded) {
  return {
    version: PLUGIN_API_VERSION,
    available: loaded.available,
    kinds: PLUGIN_KINDS,
    capabilities: PLUGIN_CAPABILITIES,
    limits: PLUGIN_LIMITS,
    plugins: loaded.plugins.map((plugin) => ({
      id: plugin.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      kind: plugin.manifest.kind,
      description: plugin.manifest.description ?? null,
      granted: plugin.granted,
      withheld: plugin.withheld,
      keyId: plugin.seal.keyId,
      timeoutMs: plugin.timeoutMs,
    })),
    // Refusals are part of the report. A plugin the learner installed and that
    // is silently not running is the worst of the three possible outcomes.
    refused: loaded.refused.map((entry) => ({ id: entry.id, directory: entry.directory, reason: entry.reason, detail: entry.detail })),
  };
}
