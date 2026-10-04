# Threat model

This document is checked. `npm run docs:check` fails the build when a control
named here does not correspond to a module that exists, when an IPC channel is
added without appearing in [extending.md](extending.md), or when a signing
subject or plugin capability is introduced without being written down. A threat
model that drifts from the code is worse than none, because people believe it.

## What this application is

A desktop application that reads a codebase the learner already has, indexes it
locally, builds lessons from it, and optionally asks a locally installed coding
agent about it. It is not a service. It has no account, no server, and no
telemetry endpoint.

That shape decides most of the threat model. The application's job is to take
**untrusted input that looks like source code** and turn it into something a
person reads and acts on, without the input getting to act on their behalf.

## Assets

| Asset | Why it is worth something |
| --- | --- |
| The learner's filesystem | The application is given a path and reads it. Everything outside that path is off limits. |
| Credentials on the machine | SSH keys, `.npmrc` tokens, `.env` files, and git credential helpers all live near repositories. |
| The learner's own work | Practice worktrees may hold the only copy of something they wrote. |
| Progress, notes, and mastery | Small, personal, and irreplaceable; a corrupt save is a lost month. |
| Answer keys and rubrics | The value of an exercise is entirely in not being able to read the answer. |
| The application's own code | An auto-updater or a plugin loader is a code-execution path with the learner's privileges. |

## Adversaries and what they can do

1. **A hostile repository.** The most likely adversary by far, and the one that
   arrives through the front door: the learner clones something to study it.
   It controls every byte of every file, every filename, every symlink, every
   commit message, every submodule URL, and every `.gitattributes` and
   `.gitmodules` entry.
2. **A hostile course package or offline archive.** A file received from
   somebody else, opened deliberately.
3. **A hostile update or plugin.** Code that would execute with the learner's
   privileges, arriving from a network or a directory.
4. **Another process on the same machine.** Can rewrite anything the learner
   can rewrite, including caches and saved state.
5. **The renderer itself.** Sandboxed, but treated as untrusted input by the
   main process regardless, because a renderer compromise must not become a
   filesystem compromise.

Explicitly **out of scope**: an adversary who is already root, an adversary with
physical access, and a malicious build of the application itself. Nothing here
defends against those, and no software of this kind can.

## Trust boundaries and the controls on them

| Boundary | Control | Where it lives |
| --- | --- | --- |
| Repository content → filesystem | Repository-relative reads only; traversal and escaping symlinks refused after `realpath` | `electron/repository.mjs` |
| Remote URL → `git clone` | Protocol allow list, no embedded credentials, no credential helpers, no submodule checkout, no archive expansion | `electron/clone-guard.mjs` |
| Repository content → agent prompt | Content fenced as data with a per-call nonce; injection attempts detected and neutralized | `electron/prompt-isolation.mjs` |
| Repository content → anything persisted | Secrets and personal data detected and redacted before writing | `electron/secret-scanner.mjs` |
| Repository content → external navigation | Origin policy; hostile schemes blocked, unlisted origins gated behind an explicit confirmation showing the destination | `electron/link-policy.mjs` |
| Renderer → main process | Versioned schemas, size and depth ceilings, unknown fields rejected, no handler without a schema | `electron/ipc-schema.mjs` |
| Main process → renderer | Egress guard: per-channel forbidden keys at any depth, plus value scanning against registered answers | `electron/answer-guard.mjs` |
| Received file → application state | Ed25519 signatures over a canonical serialisation, bound to a subject | `electron/signing.mjs` |
| Network → executed code | Update refused unless signed by a trusted key, strictly newer, right platform/arch/channel, and the digest matches the bytes | `electron/updates.mjs` |
| Plugin directory → executed code | Separate process, granted capabilities re-checked host-side, signed manifest pinning the entry digest, result schemas, timeouts | `electron/plugins.mjs` |
| Learner submission → execution | Sandboxed runner with bounded time and memory, no network, no filesystem writes | `electron/executable-quiz.mjs` |
| Dependency tree → the build | Bill of materials derived from the lockfile and disk, scanned, and attested | `electron/supply-chain.mjs` |
| Repository size → the machine | File, byte, symbol, and edge ceilings; cancellation; a memory guard that degrades rather than exhausts | `electron/repository.mjs`, `electron/performance.mjs` |
| Crash → saved work | Atomic writes with a previous generation kept; orphaned worktrees found and left untouched | `electron/durable-store.mjs`, `electron/practice.mjs` |
| Deep link → application state | Parsed as untrusted input; can only ask for what is already open | `electron/deep-link.mjs` |
| Agent invocation → the repository | Adapters run explicitly read-only | `electron/agents.mjs` |

## Design rules that recur

- **Refusals name the check that failed.** "Update failed" teaches people to
  click through; "the digest does not match the bytes that were downloaded" does
  not. Every gate in this application returns a reason.
- **Not knowing is never reported as being fine.** A dependency scan with no
  advisory feed returns `null`, not an empty list. A percentile of five samples
  is `insufficient-data`, not `pass`. A degraded index says it degraded.
- **Trust is separate from validity.** An intact signature from an unknown key
  is `untrusted`, not `invalid` — a warning for a course package, and a refusal
  for anything that will execute.
- **Enforcement lives on the side being protected.** A plugin's capability check
  is repeated in the host process, because a check inside a sandbox is a check
  performed by the thing being restrained.

## Residual risks

These are real and are not fixed here.

1. **A plugin process is not an OS sandbox.** It is a fault boundary and a
   capability boundary. The plugin runs as the same user and can read what that
   user can read; what it cannot do is act *through* this application. Genuine
   confinement needs a sandbox this project cannot portably assume.
2. **The application binaries are unsigned and un-notarized.** There is no
   Apple Developer ID, no Authenticode certificate, and no notary access here.
   The release payload and its manifest *are* signed, which is the half that
   decides whether an update may be installed, but the installer is not.
3. **A local coding agent is trusted once invoked.** Prompt isolation reduces
   what a repository can persuade an agent to do; it cannot constrain what the
   agent binary itself does with the privileges it already has.
4. **Memory limits are advisory on macOS.** `RLIMIT_AS`/`RLIMIT_DATA` are
   refused by the platform, so the sandboxed quiz runner enforces memory with a
   watchdog instead — which observes rather than prevents.
5. **Peak memory during indexing is dominated by the parser.** The tree-sitter
   WebAssembly arena cannot be returned to the operating system. The guard in
   `performance.mjs` narrows concurrency and then stops using tree-sitter, which
   bounds the damage rather than removing the cause.
6. **The renderer's sandbox is Chromium's.** A Chromium sandbox escape would
   put an attacker in the main process. Nothing here is a second line of defence
   against that.
7. **No CI matrix has been observed green.** The workflows exist and are
   statically checked; there is no runner or remote here to execute them.
