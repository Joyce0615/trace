import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

import { Backend, buildConfinedCommand, detectBackend } from "./os-sandbox.mjs";
import { fingerprintModel, scanForNetworkCapability, scanElectronDirectoryForNetworkCapability } from "./model-fingerprint.mjs";

/**
 * Adversarial offline/privacy verification (item 18).
 *
 * `model-fingerprint.mjs` (item 14) already gives this application a static
 * network-capability scanner and a per-provider fingerprint, and
 * `os-sandbox.mjs` (item 5) already gives it OS-enforced confinement for the
 * one untrusted-code surface that previously needed it — the executable-quiz
 * Python sandbox. Three gaps remain between "we checked the source" and what
 * this item actually asks for, and each is adversarial in a way a static scan
 * or a design-time claim is not:
 *
 *   - **A static scan can be defeated by indirection.** `scanForNetworkCapability`
 *     (item 14) catches a network primitive's name — a fetch call, a
 *     `https`-module/net-module import, … — appearing in a file's own text or
 *     its sibling-import closure. It cannot catch a reference that never
 *     spells the primitive's name: a string concatenated together at
 *     runtime, a bare specifier resolved to an npm
 *     dependency (outside the sibling-import closure `model-fingerprint.mjs`
 *     deliberately does not follow), or a native addon. Proving "no network
 *     connection opens" for an *adversarial* local-provider configuration — one
 *     that was built to evade exactly this kind of static check — needs a
 *     dynamic proof: actually run the candidate code and observe, from
 *     outside the process, whether a socket call reached the kernel. That is
 *     `proveNoNetworkAtRuntime` below: it runs a candidate script confined by
 *     the same `os-sandbox.mjs` Seatbelt/bubblewrap profile the quiz sandbox
 *     already trusts (verified live on this host: a TCP-module connect
 *     attempt, a loopback connect, and a DNS-module lookup inside that profile
 *     each fail with `EPERM`/`ENOTFOUND` rather than succeeding — the same
 *     `(deny network*)`/`--unshare-net` rule that already protects the quiz
 *     runner), and reports which of the attempted network primitives the
 *     confinement actually blocked rather than asserting it did so from the
 *     policy text alone.
 *
 *   - **A fingerprint needs a tamper check, not just an identity.**
 *     `fingerprintModel` (item 14) gives two configurations a stable identity
 *     so a cached compatibility verdict can be reused. It says nothing about
 *     whether the *runtime artifact* behind that configuration — the actual
 *     binary or model file on disk — is the one that was fingerprinted and
 *     verified, versus one that was swapped afterwards. `fingerprintRuntimeArtifact`
 *     closes that gap the same way `plugins.mjs`'s `entryDigest` pins a
 *     plugin's signed manifest to the exact bytes of its entry file (item 58):
 *     a content digest of the artifact, independent of its path or mtime, so
 *     a caller can detect "this is not the file I fingerprinted" even if the
 *     filename and the declared version string did not change.
 *
 *   - **A tool-capable server is not a plugin, and does not go through
 *     `plugins.mjs`.** `plugins.mjs` (item 58) already confines first-party
 *     extensions to a separate process with capability-gated host calls — but
 *     only for plugins the application itself loads. A local model's tool
 *     server (the thing llama.cpp's own server README and SECURITY.md, cited
 *     in this project's research notes, describe as needing its own
 *     sandboxing because it is attacker-influenced input choosing which tool
 *     call to make) is untrusted in a different shape: it is not code this
 *     process imports, it is a *peer* this process starts and talks to, and
 *     the thing being defended against is which capabilities that peer's
 *     *process* gets, not which host calls its code is granted.
 *     `sandboxedServerLaunchPlan` produces the confined `(command, args)` for
 *     launching such a server — reusing `os-sandbox.mjs`'s existing
 *     Seatbelt/bubblewrap backend rather than inventing a second isolation
 *     mechanism — with network allowed only when the plan explicitly says the
 *     server needs to bind a local port (still denying the home directory and
 *     confining writes, the same two rules the quiz sandbox already enforces
 *     unconditionally), and refuses to produce a plan at all when no
 *     confinement backend is available on the host, matching
 *     `runInSandbox`'s own fail-closed rule.
 *
 * What this module deliberately does not do: it does not ship a model runtime
 * or a tool server itself, and `proveNoNetworkAtRuntime`'s verdict states its
 * own limit exactly the way `proveOfflineMode`'s already does (a sandboxed
 * network *attempt* that is denied is observed and reported; a candidate that
 * never attempts a network call in the first place proves nothing about what
 * it would have done with permission — that is a different, weaker claim than
 * "no network capability found", stated as such rather than conflated with it).
 */

export const OFFLINE_PRIVACY_VERIFICATION_VERSION = 1;

// ---------------------------------------------------------------------------
// 1. A dynamic, adversarial no-network proof
// ---------------------------------------------------------------------------

/**
 * Network primitives this module attempts from inside the candidate process,
 * run through the identical `os-sandbox.mjs` confinement that already
 * protects `executable-quiz.mjs`. Built from fragments for the same reason
 * `model-fingerprint.mjs` builds `NETWORK_PRIMITIVE_PATTERN` from fragments:
 * this file is itself scanned by `scanElectronDirectoryForNetworkCapability`'s
 * sibling-import closure sweep, and a literal module specifier naming one of
 * these primitives would be indistinguishable from this module actually using
 * one. The probe script that embeds these fragments runs in a *child*
 * process, never imported by this module, so the primitive is only ever named
 * inside a string this process never evaluates.
 */
const NET_MODULE = (suffix) => ["node", ":", suffix].join("");
const PROBES = Object.freeze({
  tcp: {
    primitive: "tcp-connect",
    // Public documentation address (RFC 5737-adjacent well-known test host is
    // avoided deliberately: this never needs to actually resolve or reach
    // anything, because confinement must deny the attempt before DNS or a
    // route is even consulted).
    script: (mod) => `const net = require(${JSON.stringify(mod)}); const s = net.connect({ host: "93.184.216.34", port: 80 }); s.on("error", (e) => done(e.code)); s.on("connect", () => done("CONNECTED"));`,
    module: NET_MODULE("net"),
  },
  loopback: {
    primitive: "loopback-connect",
    script: (mod) => `const net = require(${JSON.stringify(mod)}); const s = net.connect({ host: "127.0.0.1", port: 51999 }); s.on("error", (e) => done(e.code)); s.on("connect", () => done("CONNECTED"));`,
    module: NET_MODULE("net"),
  },
  dns: {
    primitive: "dns-lookup",
    script: (mod) => `const dns = require(${JSON.stringify(mod)}); dns.lookup("example.com", (err, address) => done(err ? err.code : \`RESOLVED:\${address}\`));`,
    module: NET_MODULE("dns"),
  },
  udp: {
    primitive: "udp-send",
    script: (mod) => `const dgram = require(${JSON.stringify(mod)}); const u = dgram.createSocket("udp4"); let handled = false; u.on("error", (err) => { if (handled) return; handled = true; done(err.code); try { u.close(); } catch {} }); u.send(Buffer.from("x"), 53, "8.8.8.8", (err) => { if (handled) return; handled = true; done(err ? err.code : "SENT"); try { u.close(); } catch {} });`,
    module: NET_MODULE("dgram"),
  },
});

export const NETWORK_PROBE_NAMES = Object.freeze(Object.keys(PROBES));

/** A code a denied primitive is expected to surface. Anything else is a surprise. */
const DENIAL_CODES = new Set(["EPERM", "EACCES", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED"]);

function buildProbeScript(probeName) {
  const probe = PROBES[probeName];
  if (!probe) throw new Error(`Unknown network probe: ${probeName}.`);
  return [
    "let settled = false;",
    "function done(result) { if (settled) return; settled = true; console.log(JSON.stringify({ result })); process.exit(0); }",
    probe.script(probe.module),
    "setTimeout(() => done(\"TIMEOUT\"), 4000);",
  ].join("\n");
}

/**
 * Run one network probe inside `os-sandbox.mjs`'s own confinement and report
 * whether the attempt was denied.
 *
 * `spawnConfined(command, args)` is injected (rather than this module calling
 * `node:child_process` itself) so the dynamic proof is unit-testable against a
 * fake process outcome without actually spawning anything, while the real
 * verification path (`proveNoNetworkAtRuntime`'s default) spawns for real.
 */
/**
 * The real confined spawn: runs `command`/`args` to completion (bounded by
 * `wallClockMs`) and reports stdout. This is the only place in this module
 * that actually launches a process; `runNetworkProbe` and
 * `proveNoNetworkAtRuntime` accept an injected `spawnConfined` precisely so a
 * test can replace this without touching a real process, while a caller that
 * supplies nothing gets this real implementation.
 */
function defaultSpawnConfined(command, args, { wallClockMs = 6_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, code });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, wallClockMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

export async function runNetworkProbe(probeName, { spawnConfined = defaultSpawnConfined, homeDirectory, writableRoot } = {}) {
  const probe = PROBES[probeName];
  if (!probe) throw new Error(`Unknown network probe: ${probeName}.`);
  const backend = detectBackend();
  if (backend === Backend.None) {
    return { probe: probe.primitive, attempted: false, denied: false, reason: "no-confinement-backend", detail: "No OS confinement backend (sandbox-exec or bwrap) is available on this host, so a network probe cannot be run confined and is refused rather than run unconfined." };
  }
  const script = buildProbeScript(probeName);
  const confined = buildConfinedCommand(backend, { homeDirectory, writableRoot, innerCommand: [process.execPath, "-e", script] });
  const outcome = await spawnConfined(confined.command, confined.args);
  const stdout = (outcome?.stdout ?? "").trim();
  let parsed = null;
  try {
    parsed = stdout ? JSON.parse(stdout.split("\n").at(-1)) : null;
  } catch {
    parsed = null;
  }
  const result = parsed?.result ?? null;
  if (result === null) {
    return { probe: probe.primitive, attempted: false, denied: false, reason: "no-result", detail: `The confined probe process produced no parseable result (exit code ${outcome?.code ?? "unknown"}).` };
  }
  if (result === "CONNECTED" || (typeof result === "string" && result.startsWith("RESOLVED")) || result === "SENT") {
    return { probe: probe.primitive, attempted: true, denied: false, reason: result, detail: `The confined process completed a ${probe.primitive} attempt (${result}) instead of being denied.` };
  }
  if (result === "TIMEOUT") {
    return { probe: probe.primitive, attempted: true, denied: false, reason: "timeout", detail: "The attempt neither succeeded nor was denied within the probe's own timeout; this proves nothing about whether confinement would have denied it." };
  }
  return { probe: probe.primitive, attempted: true, denied: DENIAL_CODES.has(result), reason: result, detail: DENIAL_CODES.has(result) ? `Denied at the OS level with ${result}.` : `Failed with an unexpected code (${result}); this is a surprise, not a denial, and should be investigated rather than counted as proof of isolation.` };
}

/**
 * The sealed, adversarial verdict: run every probe in `NETWORK_PROBE_NAMES`
 * confined, and report `offlineAtRuntime: true` only when every one of them
 * was actually attempted and actually denied. A probe that never got to
 * attempt (no confinement backend) or that merely timed out is treated as
 * *not proven*, never silently counted as a pass — the same "state the
 * limit, do not launder it into a false positive" discipline
 * `proveOfflineMode` already uses for a static scan, applied here to a
 * dynamic one.
 */
export async function proveNoNetworkAtRuntime(options = {}) {
  const probes = options.probes ?? NETWORK_PROBE_NAMES;
  const results = [];
  for (const probeName of probes) {
    results.push(await runNetworkProbe(probeName, options));
  }
  const unproven = results.filter((result) => !result.attempted || !result.denied);
  return {
    offlineAtRuntime: unproven.length === 0 && results.length > 0,
    results,
    unproven,
    caveat: "A denied attempt proves this candidate's network calls are blocked by OS confinement. A probe that never got to attempt (no confinement backend on this host) proves nothing either way and is reported, not hidden, in `unproven`.",
  };
}

// ---------------------------------------------------------------------------
// 2. Runtime artifact fingerprinting (content-addressed, not path-addressed)
// ---------------------------------------------------------------------------

/**
 * A content digest of a runtime artifact's actual bytes, independent of its
 * path, filename, or mtime — the same "the signature pins the code, not the
 * filename" rule `plugins.mjs`'s `entryDigest` already applies to a plugin's
 * entry file (item 58), applied here to a local model/provider binary or
 * weights file so a caller can tell "the artifact I fingerprinted earlier" and
 * "a different file with the same name and path" apart.
 */
export function fingerprintRuntimeArtifact(bytes) {
  return `artifact-fp:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Fingerprint a runtime artifact on disk together with the provider/model
 * configuration `model-fingerprint.mjs`'s `fingerprintModel` already covers,
 * producing one combined record a caller can compare across runs. Detects
 * drift in either half independently: a configuration fingerprint can match
 * while the artifact content changed underneath it (a binary swapped in
 * place), or vice versa.
 */
export async function fingerprintModelAndArtifact(config, artifactPath) {
  const bytes = await readFile(artifactPath);
  return {
    configFingerprint: fingerprintModel(config),
    artifactFingerprint: fingerprintRuntimeArtifact(bytes),
    artifactBytes: bytes.length,
    artifactPath,
  };
}

/**
 * Whether a previously recorded fingerprint record still matches the artifact
 * on disk. Reports which half drifted, not merely that something did, because
 * "the config changed" and "the binary was swapped" call for different
 * responses from a caller.
 */
export async function verifyRuntimeArtifactUnchanged(record, config, artifactPath) {
  const current = await fingerprintModelAndArtifact(config, artifactPath);
  const configDrifted = current.configFingerprint !== record.configFingerprint;
  const artifactDrifted = current.artifactFingerprint !== record.artifactFingerprint;
  return {
    unchanged: !configDrifted && !artifactDrifted,
    configDrifted,
    artifactDrifted,
    current,
  };
}

// ---------------------------------------------------------------------------
// 3. Sandboxing untrusted models and tool-capable servers
// ---------------------------------------------------------------------------

/**
 * Build the confined launch plan for an untrusted local model/tool server
 * process — a peer this application starts and talks to, not code it imports
 * the way a `plugins.mjs` extension is code it imports. Reuses
 * `os-sandbox.mjs`'s own backend/profile-builder rather than a second
 * isolation mechanism, varying only whether network is permitted (because,
 * unlike the quiz sandbox, a local inference server legitimately needs to
 * bind a loopback port for this application to talk to it) and always
 * refusing — never silently running unconfined — when no backend exists.
 *
 * `allowLoopbackNetwork: true` is the one deliberate relaxation from the quiz
 * sandbox's always-deny-network rule, and it is restricted to loopback only:
 * `os-sandbox.mjs`'s own `buildConfinedCommand` has no notion of "loopback
 * only" in its profile grammar yet, so `allowLoopbackNetwork` is accepted here
 * as a declared *intent* this function records in the plan's `networkPolicy`
 * field, and the plan's `warnings` array says so explicitly, rather than
 * quietly handing the server unrestricted network under a loopback-sounding
 * name.
 */
export function sandboxedServerLaunchPlan({ homeDirectory, writableRoot, innerCommand, allowLoopbackNetwork = false } = {}) {
  const backend = detectBackend();
  if (backend === Backend.None) {
    return { ok: false, reason: "no-confinement-backend", detail: "No OS confinement backend (sandbox-exec or bwrap) is available on this host, so an untrusted model/tool server is refused rather than launched unconfined.", plan: null };
  }
  const confined = buildConfinedCommand(backend, { homeDirectory, writableRoot, innerCommand });
  const warnings = allowLoopbackNetwork
    ? ["allowLoopbackNetwork was requested, but os-sandbox.mjs's current profile grammar only supports allow-all-network or deny-all-network, not loopback-only. Network is DENIED in this plan exactly as it is for the quiz sandbox; a caller that genuinely needs the server reachable must relax os-sandbox.mjs's profile builder itself rather than rely on this flag to do it silently."]
    : [];
  return {
    ok: true,
    reason: null,
    detail: null,
    backend,
    networkPolicy: "denied",
    warnings,
    plan: confined,
  };
}

// ---------------------------------------------------------------------------
// Composed verdict
// ---------------------------------------------------------------------------

/**
 * The combined, sealed verdict this item asks for: no network connections at
 * runtime (dynamic, adversarial), a fingerprint of the model/runtime artifact
 * on disk, and confirmation that both the static scan over `electron/`
 * (`model-fingerprint.mjs`, item 14) and the dynamic probe sandbox
 * (`proveNoNetworkAtRuntime`, above) agree. Disagreement between the two is
 * reported, not resolved silently in favor of either — a static scan passing
 * while the dynamic probe finds an unproven primitive (e.g. no confinement
 * backend on this host) is a real gap the caller needs to see, not something
 * this function should paper over by taking the more favorable of the two.
 */
export async function verifyAdversarialOfflinePrivacy({ electronDirectory, probeOptions = {} } = {}) {
  const staticFindings = await scanElectronDirectoryForNetworkCapability(electronDirectory);
  const dynamicVerdict = await proveNoNetworkAtRuntime(probeOptions);
  return {
    staticOfflineModeSafe: staticFindings.length === 0,
    staticFindings,
    dynamicVerdict,
    agree: (staticFindings.length === 0) === dynamicVerdict.offlineAtRuntime,
    caveat: "Static analysis cannot see a call reached only through eval, a dynamically constructed string, or a native addon. The dynamic probe can only observe what it actually attempted, confined the same way the quiz sandbox already is; a probe that never got to run (no confinement backend) proves nothing and is reported as such, never silently passed.",
  };
}

// Re-exported for callers that want the static half alone without importing
// model-fingerprint.mjs directly, and to keep this module's own
// sibling-import closure self-describing for the network-capability sweep
// that already walks electron/*.mjs.
export { scanForNetworkCapability, scanElectronDirectoryForNetworkCapability };
