# Trace — Codebase Learning Studio

Trace is an English-language, desktop-first learning environment that turns a local or remote Git repository into an adaptive course. It combines a game-like skill tree, an illustrated lesson canvas, a Monaco code reader, and a local Codex or Claude tutor.

New here? Follow the [complete illustrated tutorial](tutorial/README.md).

## Run locally

```bash
npm install
npm run dev
```

The app detects locally installed `codex` and `claude` CLIs. Repository indexing, the starter curriculum, diagnostics, local lookup, and the featured nano-vllm course work without either agent and spend zero agent credits. Agent calls are explicit and run read-only. Validated courses, source excerpts, and exact tutor answers are cached by repository version and learner profile.

## Product features

- Open a local repository or clone a remote Git URL.
- Choose a learning goal (architecture, critical path, contribution, or review) and difficulty.
- Build a deterministic multilingual file and symbol index, including CUDA/C/C++.
- Run a zero-credit knowledge diagnostic before learning, then adapt the route to existing mastery.
- Adjust all UI and Monaco code text with persistent Compact, Comfortable, and Large text controls; Comfortable is the default.
- Explore prerequisites, branches, recommended skills, mastered skills, and stale skills in a game-like skill tree.
- Follow an always-visible next-move guide through Read → Trace → Explain → Quiz → Practice → Complete, then continue to the newly unlocked skill.
- Generate a starter curriculum or let the selected local agent compile a personalized skill tree linked to validated source anchors.
- Read illustrated lessons containing narratives, callouts, system diagrams, execution timelines, and comparisons; every relevant visual can jump to source.
- Navigate lesson-focused files, symbols, and source code in a locally bundled Monaco editor.
- Build mastery from diagnostic, lesson, quiz, practice, self-report, note, and side-chat evidence.
- Ask questions at any point in a separate side chat without disrupting the guided lesson conversation.
- Choose Lean, Balanced, or Deep context; include only the current selection, file, lesson, or dependencies that the question needs.
- Inspect every context pack, including why each section was included, estimated tokens, omitted material, cache hits, and estimated credits saved.
- Answer definition, location, file-count, and entry-point questions from the local index without an agent call.
- Save useful tutor answers as persistent learning memory, and request a deeper answer only when needed.
- Create an isolated Git worktree for explicit practice tasks, inspect its diff, and discard it only with confirmation when dirty.
- Persist progress per repository. Source fingerprints preserve mastery after unrelated changes and mark only affected skills stale when referenced files change.

## Featured nano-vllm course

The welcome screen includes a zero-setup course based on [GeeeekExplorer/nano-vllm](https://github.com/GeeeekExplorer/nano-vllm). It teaches the generation loop, scheduler state, prefill versus decode, paged KV cache, prefix caching, the GPU model runner, and a scheduling project through a branching skill tree and source-linked visuals.

The featured course is the fastest way to demo Trace: choose **Explore nano-vllm**, complete the short diagnostic, then follow the recommended glowing node.

## FlashInfer dogfood

Trace is also exercised against the local FlashInfer repository as a large mixed Python/CUDA codebase. It recognizes Python and native symbols, prioritizes package entries and active lesson anchors, and produces lessons that trace real Python → JIT → CUDA paths.

Enter the repository path in the start screen:

```text
/Users/user/GitHub/flashinfer
```

## Verify

```bash
npm run build
npm test
npm run test:ui
npm run test:electron
npm audit
```

## Architecture

- `electron/`: trusted local host, repository access, Git integration, context packing and caches, learning-state storage, skill graph construction, practice worktrees, and agent adapters.
- `src/`: sandboxed React renderer, adaptive learning model, featured course, and three-pane learning UI.
- `tests/`: repository/course security tests and browser UI smoke tests.

Agent adapters are isolated behind Electron IPC so the renderer never receives shell or filesystem privileges. IPC accepts only repositories previously opened through the trusted host, validates repository-relative paths and symlink targets, and does not use a runtime Monaco CDN.
