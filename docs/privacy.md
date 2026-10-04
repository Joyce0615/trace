# Privacy

This document is checked. `npm run docs:check` fails when the application writes
to a directory under its user-data path that is not inventoried below, so the
table cannot quietly go out of date.

## The short version

Nothing leaves this machine unless you ask for it.

There is no account, no server, no analytics endpoint, and no crash reporter.
The application makes exactly three kinds of outbound connection, all of them
initiated by you: `git clone` of a repository you named, a click on a link the
origin policy allowed, and a locally installed coding agent that you invoked and
that talks to whatever service *it* is configured to use.

## What is stored, where, and why

Everything lives under the platform's user-data directory for this application —
`~/Library/Application Support/…` on macOS, `%APPDATA%\…` on Windows,
`~/.config/…` on Linux.

| Directory | Contents | Contains personal data? |
| --- | --- | --- |
| `repositories` | Clones of remote repositories you asked for | Only what the repository contains |
| `courses` | Generated courses, keyed by repository version and learner profile | No |
| `knowledge-graphs` | The versioned symbol and file graph for each repository | No |
| `learning` | Mastery per skill, review schedule, and diagnostic state | Yes — it is a record of what you found hard |
| `notes` | Notes you wrote, with their source anchors | Yes — free text you wrote |
| `practice` | Isolated git worktrees for exercises, and their session records | Yes — code you wrote |
| `activity-log` | Timestamped events used for retention and hint analytics | Yes — timing of your study sessions |
| `experiments` | Consent state and numeric observations for A/B comparisons | Only after you consent |
| `signing` | This machine's Ed25519 key pair and the key ids you trust | The private key never leaves the machine and never crosses IPC |
| `agent-responses` | Cached answers from a coding agent, so the same question is not paid for twice | Whatever was in the answer |
| `plugins` | Extensions you installed | Whatever they contain |
| `telemetry` | Daily counters for the application's own behaviour, only after you opt in | No free text can reach it; see below |

## What is redacted, and when

`electron/secret-scanner.mjs` runs on anything that is written to disk, sent to
an agent, or exported. It looks for credential shapes — API keys, tokens,
private key blocks, connection strings — using both explicit patterns and an
entropy test, and for personal data such as email addresses and absolute home
directory paths. Findings are replaced, not merely flagged.

This applies to context packs, cached agent responses, activity logs, exported
archives, course packages, and plugin logs. It is applied at the point of
writing rather than at the point of display, because a redaction that happens
only in the UI is a redaction that did not happen.

## What is deliberately never collected

- Repository contents are never uploaded. Excerpts appear in a context pack only
  when you ask a question, and only from the repository you have open.
- Keystrokes, mouse movement, screen contents, and clipboard are never recorded.
- The application does not read `~/.ssh`, `~/.aws`, `~/.npmrc`, environment
  variables, or the git credential helper. Cloning is done with credential
  helpers explicitly disabled.

## Consent

Experiments (item 42) are **opt-in and off by default**. Without consent the
application uses the control arm and records nothing at all — not "records
anonymously", records nothing. With consent it records numbers only: arm
assignment, a bounded set of counters, and no free text.

Consent is withdrawable, and withdrawal is retroactive: `experiment:forget`
deletes every stored observation and reports how many it deleted. The next
plan reverts to the control arm immediately.

## Deletion

| To delete | Do this |
| --- | --- |
| One repository's progress | Close it; delete its file under `learning` |
| Experiment observations | Withdraw consent — deletion is immediate and counted |
| Notes | Save an empty note; an empty note is a delete |
| A practice worktree | Remove it from the practice panel; you are asked to confirm before changes are discarded |
| Everything | Delete the user-data directory. There is nothing anywhere else |

The application never deletes an orphaned practice worktree on your behalf, even
when it is certain the worktree is orphaned, because it may hold the only copy
of something you wrote. It reports it and leaves it alone.

## Telemetry

**Nothing is transmitted.** There is no endpoint, no queue, no identifier, and
no code that could send one — the test suite scans every main-process module and
fails the build if any of them calls `fetch` or imports a network module.

What exists is *local* telemetry: counters describing the application's own
behaviour, stored on your machine, shown to you, deletable by you. It is **off
by default**, and off means nothing is recorded — not "recorded anonymously".
`telemetry:record` returns `no-consent` and stores nothing.

Four properties make it safe to leave on:

1. **Free text cannot get in.** There is no string field. Every dimension is an
   enum with a declared value set, and an unlisted value becomes the four
   letters `other`. Every measure is a number that is bucketed immediately —
   `4,271 ms` is stored as `2500-5000`. There is no field a file path, a symbol
   name, a search query, or an answer could occupy. That is stronger than
   redacting them afterwards, because redaction is something you can forget to
   call.
2. **Cardinality is bounded twice.** Once per dimension, by its value set; and
   once per event, by a ceiling of 64 distinct dimension combinations. Beyond
   it, new combinations fold into one `overflow` series and the fold is
   *counted*, so the report says how much it is not showing.
3. **Counters, not a stream.** Nothing records one event at one moment. The
   store holds daily counts and bucket histograms. A stream of individually
   timestamped events is a trace of your working day; a day's counters are not,
   and cannot be turned back into one.
4. **Retention is 30 days, enforced on read.** A file left behind by a version
   that no longer runs expires because time passed, not because something
   happened to write to it.

Every event that can be recorded is declared in `electron/telemetry.mjs` with a
sentence saying what it is for, and `telemetry:state` returns that schema, so
"what could this possibly know about me" is answerable without reading the
source.

Withdrawal deletes the file — both generations — rather than blanking fields,
and `telemetry:forget` reports how many counters and events it removed.

Local analytics (item 41) are a separate thing: they read the local activity
log and are displayed to you. They are not transmitted either.

## Residual risks

1. A coding agent you invoke sends what it is given to whatever service it is
   configured for. Prompt isolation and redaction limit *what* it is given; they
   cannot change where the agent sends it.
2. Redaction is pattern-based plus entropy-based. A credential shaped like
   ordinary prose will not be caught.
3. The user-data directory is protected by the operating system's file
   permissions and nothing else. It is not encrypted at rest by this
   application.
4. A repository you clone can contain anything, including personal data
   belonging to somebody else. The application indexes what it is given.
