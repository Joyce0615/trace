# Extension contracts

Four contracts are public, in the sense that something outside this repository
can depend on them: the **IPC channels** between the renderer and the main
process, the **signing subjects**, the **plugin API**, and the **performance
budgets**. This document is the contract, and `npm run docs:check` fails the
build if the code and this file disagree — a new channel added without a line
here is a build failure, and a line here for a channel that no longer exists is
also a build failure.

## Contract 1 — IPC channels

Every channel is declared in `electron/ipc-schema.mjs` with a schema, exposed in
`electron/preload.cjs`, and handled in `electron/main.mjs`.
`registerValidatedHandlers` refuses to start if a declared channel has no
handler. Payloads are size-bounded (4 MB), depth-bounded (16), and structurally
validated; unknown fields are rejected rather than ignored. Responses pass
through the answer-leak guard before the renderer sees them.

### Repository and index

- `repository:choose` — open the system directory picker.
- `repository:open` — index a local path or clone a remote URL.
- `repository:cancel` — abort an in-flight index by request id.
- `repository:limits` — the ceilings indexing enforces.
- `repository:read-file` — read one repository-relative file.
- `index:language-servers` — which optional language servers are installed.
- `index:resolve` — resolve a symbol, degrading from LSP to the static index.
- `graph:summary` — the knowledge graph's shape and version.
- `graph:neighborhood` — bounded neighbourhood around one node.
- `graph:architecture` — modules, layers, boundaries, and cycles.
- `graph:symbol-flow` — callers, callees, and data flow for one symbol.
- `history:summary` — ownership, evolution, and regression signals from git.
- `evidence:import` — issues, pull requests, ADRs, docs, and tests as evidence.
- `search:query` — hybrid lexical, symbol, graph, and embedding retrieval.

### Lessons, exercises, and grading

- `lessons:call-chains` — cross-file call chains with prediction exercises.
- `lessons:grade-prediction` — grade one call-chain prediction.
- `exercise:localization` — build a localization drill.
- `exercise:localization-hint` — serve the next hint rung.
- `exercise:localization-score` — score coverage, precision, and efficiency.
- `grade:race-task` — build a RACE-style issue task.
- `grade:race` — grade understanding, localization, and plan separately.
- `quiz:build` — build an executable quiz with hidden tests.
- `quiz:grade` — run a submission in the sandbox and grade it.
- `explain:task` — build an explanation task from a real execution trace.
- `explain:grade` — grade an explanation against what the run did.
- `activity:build` — teach-back, prediction, and contrast activities.
- `activity:grade` — grade one activity.
- `hint:next` — the next rung of any task's hint ladder.
- `trace:runtimes` — which language runtimes are available for tracing.
- `trace:run` — run a bounded execution trace and map events to source.
- `eval:run` — evaluate retrieval, tutor answers, and lessons separately.

### Learner state

- `learning:diagnose` — diagnose skills, misconceptions, and calibration.
- `learning:probe` — answer one diagnostic probe.
- `learning:schedule` — the spaced-repetition review plan.
- `learning:review` — record a review and reschedule.
- `learning:load` — load saved mastery for a repository.
- `learning:save` — persist mastery atomically.
- `analytics:report` — retention, transfer, time-on-task, and hint dependence.
- `goals:plan` — rank targets for one of the named learner goals.
- `notes:list` — the learner's notes for this repository.
- `notes:save` — save or delete one note (an empty note is a delete).
- `experiment:state` — consent state and current arm assignments.
- `experiment:consent` — grant or withdraw consent.
- `experiment:forget` — delete every stored observation, and count them.

### Courses, packaging, and signing

- `course:enhance` — ask a local agent to enrich a course.
- `course:package` — package a course with provenance and license policy.
- `course:import` — import a package, reporting anchor drift.
- `course:verify-signature` — check a package's seals without importing.
- `course:migrate` — plan or apply a migration when symbols move.
- `course:revert-migration` — undo an applied migration exactly.
- `archive:export` — offline archive of course, progress, notes, and excerpts.
- `archive:import` — merge or replace from an archive without losing work.
- `signing:identity` — this machine's public signing identity.
- `signing:trust` — trust or untrust a key id.

### Agents and links

- `agents:detect` — which local coding agents are installed.
- `agents:ask` — ask one, read-only, with an isolated prompt.
- `links:classify` — classify an outbound URL against the origin policy.
- `links:open` — open it, after confirmation where the policy requires one.
- `links:last-decision` — the most recent link decision, for display.

### Practice and lifecycle

- `practice:create` — create an isolated git worktree for a lesson.
- `practice:inspect` — the state of one practice session.
- `practice:open` — reveal a worktree in the system file manager.
- `practice:remove` — remove a session, confirming before discarding changes.
- `practice:release` — release bookkeeping for an orphaned worktree, leaving its
  contents alone.
- `recovery:report` — what the last launch found and swept.
- `window:new` — open a second window.
- `window:state` — which windows hold which repositories, and cache sizes.
- `deep-link:open` — route a `trace://` link, parsed as untrusted input.
- `deep-link:last` — the last routed link.

### Build and extension surfaces

- `supply-chain:report` — the bill of materials and dependency scan for this
  build, with the advisory feed's availability stated.
- `perf:report` — the performance budgets and this session's measurements.
- `plugins:list` — installed plugins, refused plugins, and the reason for each.
- `telemetry:state` — consent, the declared event schema, and what has been
  counted. Readable without consent, because that is how somebody decides.
- `telemetry:consent` — grant or withdraw. Withdrawal deletes the file.
- `telemetry:record` — record one declared event. Refused without consent, and
  the refusal says so rather than succeeding quietly.
- `telemetry:forget` — delete everything, or one event's counters, and say how
  many were deleted.
- `telemetry:export` — exactly what a learner could hand to somebody else.

## Contract 2 — Signing subjects

`electron/signing.mjs` signs Ed25519 over a canonical serialisation, with the
subject inside the hash so a signature can never be lifted from one kind of
artifact to another.

- `course-package` — a shareable course with its provenance.
- `source-anchors` — a lesson's ground truth, checkable without the rest.
- `assessment` — who scored what, on which source version.
- `agent-response` — a cached answer, so a rewritten cache is detectable.
- `offline-archive` — an export of progress, notes, and verified excerpts.
- `update-manifest` — a release the updater may install.
- `provenance` — an in-toto attestation binding artifacts to their materials.
- `plugin` — a plugin manifest, which pins its entry file's digest.

Validity and trust are separate. An intact signature from an unknown key is
`untrusted`, which is a warning for a course package and a **refusal** for
anything that will execute.

## Contract 3 — The plugin API

Full detail in [`plugins/README.md`](../plugins/README.md). The contract:

**Kinds.** `indexer`, `agent`, `course-generator`, `grader`, `visualization`.

**Capabilities.** A manifest declares them; the host grants a subset; the check
is repeated host-side on every call.

- `read-file` — one file from inside the repository being indexed, through the
  host's path validation.
- `list-files` — the paths the host has already indexed. No sizes, no contents,
  no absolute paths.
- `symbols` — the definitions the built-in indexers already found.
- `log` — one line to the host's plugin log, redacted before it is stored.

**Manifest.** `id`, `name`, `version`, `kind`, `apiVersion`, `entry`,
`entryDigest`, `capabilities`, optionally `languages`, `extensions`, and
`timeoutMs`. Signed under the `plugin` subject. `entryDigest` is required, not
optional: a signature over a filename certifies nothing.

**Execution.** A separate process with a bare environment, newline-delimited
JSON over stdio, a wall-clock timeout, an output ceiling, and a host-call cap.
The result is validated against the schema for the kind, rejecting unknown
fields.

**Entry point.** `export default async function (input, host)`, or a named
export matching the kind, or `run`.

**Ordering.** Indexer plugins are asked *last*, and only about files the
built-in indexers could not read at all. A plugin cannot overwrite a definition
tree-sitter or the regex indexer already produced.

## Contract 4 — Performance budgets

Declared in `electron/performance.mjs`, enforced by `npm run perf`, the core
test suite, and both smoke suites. Budgets marked *per file* are rates: the
ceiling is `rate × files`, never below the budget's floor.

- `startup.firstWindowMs`
- `startup.interactiveMs`
- `index.totalMs` (per file)
- `index.peakRssBytes` (per file)
- `index.peakHeapBytes` (per file)
- `search.coldMs`
- `search.p95Ms`
- `search.indexBuildMs` (per file)
- `render.entryBundleBytes`
- `render.domNodes`
- `render.viewSwitchMs`
- `render.longTaskMs`

Each budget carries the reason its ceiling exists. A percentile budget with
fewer than eight samples returns `insufficient-data`, never `pass`.

## Stability

The IPC protocol version is 1 and the plugin API version is 1. A plugin
targeting a different API version is refused with `api-version` rather than
being run and hoped for. Neither surface is frozen; both are versioned so that
breaking them is visible.
