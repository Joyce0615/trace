import { existsSync } from "node:fs";

/**
 * OS-enforced confinement for the executable-quiz Python sandbox (item 5).
 *
 * `executable-quiz.mjs`'s sandbox used to be *entirely* Python-level: a static
 * regex screen on the submission's source text, plus a few builtins/modules
 * monkey-patched out of the interpreter's own namespace before the submission
 * runs. Both layers are bypassable from pure, undisguised Python with no
 * import at all: `type(1).__base__.__subclasses__()` walks every live class —
 * including `importlib._bootstrap_external.FileLoader`, found that way and
 * never imported — and `FileLoader(name, path).get_data(path)` reads an
 * arbitrary file (`~/.ssh/id_rsa`, in a reproduction kept in the test
 * alongside this module) without ever calling the `open` builtin the sandbox
 * removed, and without matching any of `FORBIDDEN_PATTERNS`'s source-text
 * regexes (there is no `open(`, `exec(`, `eval(`, or dunder *name* anywhere in
 * that chain — just attribute access and calls, which nothing on that list
 * forbids). No amount of blocklisting at the Python level can close this: the
 * interpreter's live object graph is reachable from pure arithmetic and
 * `getattr`, and the sandbox never removes `getattr`, `type`, or integers.
 *
 * The item's own name is the fix: isolation has to be enforced by something
 * *outside* the interpreter whose rules a submission cannot read a way
 * around, because it never gets to see them. This module wraps the sandbox's
 * Python invocation in the same host confinement agent-bridge-rs's process
 * provider uses — macOS `sandbox-exec` (Seatbelt) or Linux `bubblewrap`
 * (`bwrap`) — which denies the filesystem *operation itself* at the kernel
 * boundary, regardless of which language-level mechanism a submission used to
 * reach it.
 */

/** Which host confinement backend this process can use. */
export const Backend = Object.freeze({
  SandboxExec: "sandbox-exec",
  Bubblewrap: "bubblewrap",
  None: "none",
});

const PATH_CANDIDATES = ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"];

function binaryExists(name) {
  for (const dir of PATH_CANDIDATES) {
    if (existsSync(`${dir}/${name}`)) return true;
  }
  const pathEnv = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  return pathEnv.split(sep).some((dir) => dir && existsSync(`${dir}/${name}`));
}

/** Detect the confinement backend available on this host. */
export function detectBackend() {
  if (process.platform === "darwin" && binaryExists("sandbox-exec")) return Backend.SandboxExec;
  if (process.platform === "linux" && binaryExists("bwrap")) return Backend.Bubblewrap;
  return Backend.None;
}

/**
 * Build the confined `(command, args)` that runs `innerCommand` (already a
 * full argv array, e.g. `["python3", "-I", "-S", "-B", "-c", source]`) under
 * `backend`. Deny-by-default:
 *
 *   - network is always denied — the quiz sandbox has no legitimate reason to
 *     reach it (`ALLOWED_MODULES` excludes `socket`/`urllib`/etc. too, but
 *     this is enforced independently of that list, which a submission can
 *     route around);
 *   - reads of `homeDirectory` are denied, so the one place real secrets live
 *     on a developer's machine (`~/.ssh`, `~/.aws`, shell history, …) is
 *     unreachable no matter which Python-level mechanism a submission uses to
 *     try — including the `__subclasses__`/`FileLoader` path this item exists
 *     to close, which bypasses every Python-level control by construction;
 *   - writes are confined to `writableRoot` (the sandbox's own scratch temp
 *     directory).
 *
 * Pure — no process spawned — so the policy itself is unit-testable without a
 * real sandbox binary on the test machine, matching the convention
 * `agent-bridge-rs::providers::process::build_sandbox_command` already
 * established for the same two backends.
 */
export function buildConfinedCommand(backend, { homeDirectory, writableRoot, innerCommand }) {
  switch (backend) {
    case Backend.SandboxExec: {
      const home = homeDirectory ?? "/nonexistent-home";
      // Broad read access first (the dynamic linker and the Python framework
      // need to resolve arbitrary stdlib/site paths), then an explicit *deny*
      // of the home directory. The deny is evaluated after the allow and
      // wins — that ordering is what actually blocks `~/.ssh/id_rsa` even
      // though the unqualified `allow file-read*` above would otherwise cover
      // it; verified live against this exact profile shape.
      const profile = [
        "(version 1)",
        "(deny default)",
        "(allow process*)",
        "(allow sysctl-read)",
        // Needed for the interpreter to even start on current macOS: Python's
        // startup path (and the system `env`/`sh` wrapper around it) resolves
        // a few things — notably Xcode's command-line-tools lookup used to
        // locate the active `python3` — through Mach services, not plain
        // file I/O. Without this, `sandbox-exec` denies the Mach lookup
        // itself and the interpreter never reaches the submission's code at
        // all (reproduced live: exit code 72, "couldn't create cache file",
        // before this was added) — a failure that looked identical to "the
        // sandbox is working" only because nothing ran, not because anything
        // was actually confined. `mach-lookup` grants IPC to system services,
        // not filesystem or network access, so it does not reopen either of
        // the two denials this profile exists to enforce (verified below).
        "(allow mach-lookup)",
        "(allow file-read*)",
        `(deny file-read* (subpath "${home}"))`,
        `(allow file-write* (subpath "${writableRoot}"))`,
        "(deny network*)",
      ].join("\n");
      return { command: "sandbox-exec", args: ["-p", profile, ...innerCommand] };
    }
    case Backend.Bubblewrap: {
      const home = homeDirectory ?? "/nonexistent-home";
      const args = [
        "--ro-bind", "/", "/",
        // An empty tmpfs shadows the real home directory for the lifetime of
        // the child, the same denial `sandbox-exec`'s profile expresses as a
        // rule rather than a mount.
        "--tmpfs", home,
        "--bind", writableRoot, writableRoot,
        "--proc", "/proc",
        "--dev", "/dev",
        "--unshare-net",
        "--die-with-parent",
        ...innerCommand,
      ];
      return { command: "bwrap", args };
    }
    default:
      return null;
  }
}
