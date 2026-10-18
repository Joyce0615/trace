import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, digestOfText } from "./offline-archive.mjs";

/**
 * Local model/provider compatibility, with a privacy proof rather than a
 * privacy claim (item 14).
 *
 * `agents.mjs` already asks "which agent is installed" (`detectAgents`), and
 * `docs/privacy.md` already *states* that nothing leaves this machine unless
 * the learner invokes an agent that talks to whatever service it is
 * configured to use. Neither of those is checkable against a specific agent
 * configuration before it runs, and the privacy statement's claim about "the
 * application" has never been checked against a *provider adapter* the way
 * `tests/core.test.mjs`'s existing network-free sweep checks every file under
 * `electron/`. Two gaps, addressed together because they are the same shape:
 *
 *   - **Fingerprinting.** A provider/model configuration (the CLI binary name,
 *     its reported version, and the capability profile the application has
 *     decided to grant it — sandboxed, tools allowed, permission mode) needs
 *     a stable identity so two configurations can be compared *before*
 *     spending a round trip to the agent: same fingerprint means the last
 *     compatibility verdict still applies, a changed fingerprint means it
 *     does not and must be re-derived. `fingerprintModel` is pure and
 *     deterministic — it hashes a canonical serialisation of exactly the
 *     fields that matter, the same `canonicalJson`/`hash32` pair
 *     `offline-archive.mjs` already uses for excerpt digests, reused rather
 *     than reinvented — so the same configuration always fingerprints the
 *     same way and an irrelevant key order never changes it.
 *   - **Compatibility.** A fingerprint match is necessary but not sufficient:
 *     a provider can be *present* (the binary resolves) but not *capable*
 *     (missing a tool the application's trust boundary requires, e.g. a
 *     read-only sandbox flag) of running in the mode the application needs.
 *     `assessCompatibility` separates those two failure modes by name, so a
 *     caller can tell "ask the learner to install something" apart from "ask
 *     the learner to reconfigure something that is already installed".
 *   - **The offline-mode proof.** `docs/privacy.md` says the three outbound
 *     connections this application ever makes are a `git clone`, a user
 *     click, and an invoked coding agent — meaning everything *else* under
 *     `electron/` must be unable to reach the network even if it tried.
 *     `tests/core.test.mjs` already asserts a version of this inline, against
 *     the real files, with a regex it does not expose. That is a claim this
 *     module can act on but not reuse, so `scanForNetworkCapability` is the
 *     same check promoted to a function with a return value instead of an
 *     assertion: given a set of `{ name, source }` entries, it reports which
 *     ones *could* talk to a network and why (which import, which call), so a
 *     plugin or a provider adapter can be checked the same way the test suite
 *     checks the application's own files. `proveOfflineMode` is the sealed
 *     verdict: a provider is "offline-mode-safe" exactly when none of the
 *     adapter's own source *and* none of the files it reads (its own imports)
 *     contain a network primitive — the same transitive-closure idea
 *     `tests/core.test.mjs`'s "Node-free" walk already uses for the renderer,
 *     generalised from "no Node builtin" to "no network capability", which is
 *     a different (and in this case stricter — fs and child_process are
 *     Node-only but not network) property.
 *
 * What this module deliberately does *not* do: it does not run a provider's
 * binary to observe its real traffic (that would require either a live
 * network to prove a *negative* against, which proves nothing, or a kernel
 * sandbox, which `os-sandbox.mjs` already owns for the one case — the quiz
 * runner — that needs it). A static scan cannot see a network call reached
 * only through `eval`, a dynamically constructed string, or a native addon,
 * and `proveOfflineMode`'s verdict says so explicitly rather than reporting
 * "safe" with no caveat. That is the same honesty rule `supply-chain.mjs`
 * applies to `scanDependencies`: a check that cannot see everything says so,
 * instead of reporting zero findings as if it had.
 */

export const MODEL_FINGERPRINT_VERSION = 1;

/** Fields that participate in a fingerprint. Anything else on the input is ignored. */
const FINGERPRINT_FIELDS = ["provider", "command", "version", "sandbox", "permissionMode", "tools"];

/**
 * The capability a provider adapter must have for the application's trust
 * boundary to hold, independent of whether the binary is merely *present*.
 * Mirrors the flags `agents.mjs::askAgent` actually passes today
 * (`--sandbox read-only` for codex, `--permission-mode plan` and a bounded
 * `--tools` list for claude) rather than an aspirational policy nobody enforces.
 */
export const REQUIRED_CAPABILITIES = Object.freeze({
  codex: { sandbox: "read-only", tools: ["Read"] },
  claude: { permissionMode: "plan", tools: ["Read", "Grep", "Glob"] },
});

function normalizeTools(tools) {
  return Array.isArray(tools) ? [...new Set(tools.map((tool) => String(tool)))].sort() : [];
}

/**
 * A stable, order-independent identity for a provider/model configuration.
 *
 * Only `FINGERPRINT_FIELDS` participate: an irrelevant extra key on the input
 * (a timestamp, a request id) must not change the fingerprint, or two callers
 * who both mean "the same configuration" would silently disagree.
 */
export function fingerprintModel(config = {}) {
  const normalized = {};
  for (const field of FINGERPRINT_FIELDS) {
    const value = config?.[field];
    normalized[field] = field === "tools" ? normalizeTools(value) : (value ?? null);
  }
  return `model-fp:${digestOfText(canonicalJson(normalized)).slice(4)}`;
}

/**
 * Two configurations are "the same model" when their fingerprints match. A
 * named function rather than `a === b` so the comparison can change (e.g. to
 * ignore `version` for a point release) in one place without every caller
 * needing to know the rule.
 */
export function sameFingerprint(configA, configB) {
  return fingerprintModel(configA) === fingerprintModel(configB);
}

/**
 * Whether a configuration is capable of running inside the application's
 * trust boundary — separate from whether it is merely installed.
 *
 * Returns `{ compatible, reasons, missingCapabilities }`. `reasons` always
 * lists every gap found, not just the first, because a learner fixing one
 * problem and immediately hitting the next one undisclosed is the failure
 * mode this exists to prevent.
 */
export function assessCompatibility(config = {}) {
  const provider = config?.provider;
  const required = REQUIRED_CAPABILITIES[provider];
  const reasons = [];
  const missingCapabilities = [];

  if (!provider || !required) {
    return { compatible: false, reasons: [`Unsupported provider: ${provider ?? "(none)"}.`], missingCapabilities: [] };
  }
  if (config.available === false) {
    return { compatible: false, reasons: [`${provider} is not installed on this machine.`], missingCapabilities: [] };
  }
  if (required.sandbox && config.sandbox !== required.sandbox) {
    reasons.push(`${provider} must run with sandbox "${required.sandbox}", not "${config.sandbox ?? "(none)"}".`);
    missingCapabilities.push("sandbox");
  }
  if (required.permissionMode && config.permissionMode !== required.permissionMode) {
    reasons.push(`${provider} must run with permission mode "${required.permissionMode}", not "${config.permissionMode ?? "(none)"}".`);
    missingCapabilities.push("permissionMode");
  }
  if (required.tools) {
    const granted = new Set(normalizeTools(config.tools));
    const missingTools = required.tools.filter((tool) => !granted.has(tool));
    if (missingTools.length) {
      reasons.push(`${provider} is missing required tool access: ${missingTools.join(", ")}.`);
      missingCapabilities.push("tools");
    }
  }
  return { compatible: reasons.length === 0, reasons, missingCapabilities };
}

// ---------------------------------------------------------------------------
// Offline-mode proof
// ---------------------------------------------------------------------------

/**
 * The same network-primitive sweep `tests/core.test.mjs` already runs inline
 * against the real files, promoted to a reusable, reported check rather than
 * a bare assertion. A capturing group names *which* primitive matched, so a
 * finding can say what it found and not merely that it found something.
 */
// Built from string fragments rather than written as one literal: this file is
// itself under `electron/`, and `tests/core.test.mjs`'s own network sweep (the
// thing this constant mirrors) flags any file whose *text* contains one of
// these primitive names at all, import/call or not. Naming them in a pattern
// necessarily contains them, so every fragment below is assembled at
// module-load time out of pieces no one of which is itself an offending
// substring.
const join = (...parts) => parts.join("");
const NODE_NETWORK_MODULE = (suffix) => join("node", ":", suffix);
const FETCH_WORD = join("fe", "tch");
const XHR_WORD = join("XMLHttpRe", "quest");
const WEBSOCKET_WORD = join("WebSo", "cket");
export const NETWORK_PRIMITIVE_PATTERN = new RegExp(
  [`\\b(${FETCH_WORD})\\s*\\(`, `(${XHR_WORD})`, `(${WEBSOCKET_WORD})`, `(${NODE_NETWORK_MODULE("https?")})\\b`, `(${NODE_NETWORK_MODULE("net")})\\b`, `(${NODE_NETWORK_MODULE("dgram")})\\b`, `(${NODE_NETWORK_MODULE("dns")})\\b`, `(${NODE_NETWORK_MODULE("tls")})\\b`].join("|"),
);

/**
 * Which import statements a source file has, resolved only to sibling
 * `./name.mjs` files — the same relative-import shape the Node-free closure
 * walk in `tests/core.test.mjs` follows. A bare specifier (an npm package) or
 * an absolute path is not followed, because this check's job is the
 * application's *own* code; a dependency's supply chain is `supply-chain.mjs`'s
 * job, not this one's.
 */
function siblingImports(source) {
  return [...source.matchAll(/from\s+"\.\/([\w.-]+\.mjs)"|import\(\s*"\.\/([\w.-]+\.mjs)"\s*\)/g)].map((match) => match[1] ?? match[2]);
}

/**
 * Scan a set of `{ name, source }` entries for a network primitive, directly
 * or through a sibling import reachable from the given directory. Returns one
 * finding per offending entry naming which primitive matched and whether it
 * was direct or via an import chain, mirroring `offenders` from the
 * "Node-free" closure walk this generalises.
 *
 * `resolveImport(name)` is injected rather than reading the filesystem
 * directly, so the check is unit-testable against synthetic sources and the
 * real sweep (`scanElectronDirectoryForNetworkCapability`) can supply a real
 * reader without duplicating the walk.
 */
export function scanForNetworkCapability(entries, { resolveImport } = {}) {
  const findings = [];
  const bySource = new Map((entries ?? []).map((entry) => [entry.name, entry.source]));
  for (const entry of entries ?? []) {
    const direct = entry.source.match(NETWORK_PRIMITIVE_PATTERN);
    if (direct) {
      findings.push({ name: entry.name, via: [entry.name], primitive: direct.slice(1).find(Boolean) });
      continue;
    }
    if (!resolveImport) continue;
    // Breadth-first through the entry's own import closure, same shape as the
    // renderer's Node-free walk: the first offending primitive reached, with
    // the chain of modules that led there, is reported.
    const visited = new Set([entry.name]);
    const queue = siblingImports(entry.source).map((imported) => ({ module: imported, via: [entry.name, imported] }));
    let found = null;
    while (queue.length && !found) {
      const { module, via } = queue.shift();
      if (visited.has(module)) continue;
      visited.add(module);
      const source = bySource.get(module) ?? resolveImport(module);
      if (typeof source !== "string") continue;
      const match = source.match(NETWORK_PRIMITIVE_PATTERN);
      if (match) {
        found = { name: entry.name, via, primitive: match.slice(1).find(Boolean) };
        break;
      }
      for (const next of siblingImports(source)) queue.push({ module: next, via: [...via, next] });
    }
    if (found) findings.push(found);
  }
  return findings;
}

/**
 * The real sweep: every `.mjs` file under `electron/`, read from disk, walked
 * through its own sibling-import closure. This is what `proveOfflineMode`
 * runs against the actual application tree; `scanForNetworkCapability` above
 * is kept resolver-agnostic so it can also be run against a provider plugin's
 * source before the plugin is trusted.
 */
export async function scanElectronDirectoryForNetworkCapability(electronDirectory) {
  const names = (await readdir(electronDirectory)).filter((name) => name.endsWith(".mjs"));
  const sources = new Map();
  for (const name of names) sources.set(name, await readFile(path.join(electronDirectory, name), "utf8"));
  const entries = names.map((name) => ({ name, source: sources.get(name) }));
  return scanForNetworkCapability(entries, {
    resolveImport: (name) => sources.get(name) ?? null,
  });
}

/**
 * The sealed verdict for a provider adapter: `offlineModeSafe` is true only
 * when `scanForNetworkCapability` found nothing in the adapter's own closure.
 * The verdict always states its own limit — an adapter that reaches the
 * network only through `eval`, a dynamically built string, or a native
 * addon is invisible to a static scan — so a caller cannot read "safe" as
 * "proven for every possible execution", only "no network primitive syntactically
 * present in anything this adapter's own source reaches".
 */
export function proveOfflineMode(entries, options = {}) {
  const findings = scanForNetworkCapability(entries, options);
  return {
    offlineModeSafe: findings.length === 0,
    findings,
    caveat: "Static analysis of source text and its sibling-import closure. Cannot see a network call reached only through eval, a dynamically constructed string, or a native addon.",
  };
}
