# Pedagogy

Why this application is shaped the way it is, what evidence each mechanism
rests on, and where it stops being able to help.

## The problem it is trying to solve

Reading an unfamiliar codebase is not a reading problem. The difficulty is not
that the lines are hard to parse; it is that a competent programmer can read
every line of a repository and still be unable to answer "what happens when a
request arrives", "where would I change this", or "why is it done this way".
Those are questions about structure, control flow, history, and intent — none of
which are local to a line.

So the application does not summarise code. It builds exercises that require the
learner to *do* the thing they are trying to get better at, against the real
repository, and grades the attempt against what the repository actually
contains.

## The mechanisms, and why each is here

### Ground truth comes from the repository, not from a model

Every lesson, exercise, and grade is anchored to a `path:line` in the tree the
learner has open, with the blob id recorded. When the repository moves, anchors
are migrated or retired rather than left pointing at whatever is now on that
line. An agent may *enhance* a course; it may not invent an anchor, and a
generated anchor that does not resolve is dropped.

The reason is not purity. A tutor that is confidently wrong about a codebase is
worse than no tutor, because the learner has no way to tell — they are here
precisely because they do not know yet.

### Retrieval practice, not recognition

Exercises ask for a produced answer — predict the output of a call chain, name
the file to change, explain what a function does — before anything is revealed.
Prediction-before-reveal is the single most reliable finding in the learning
literature and the easiest to lose: showing the answer beside the question turns
retrieval into recognition, which feels better and teaches less.

This is why `answer-guard.mjs` exists as an enforced egress check rather than a
convention. One spread operator is the difference between an exercise and a
quiz with the answers printed underneath, and the learner cannot tell which one
they are looking at.

### Hints have a price, and the price is recorded

A stuck learner needs somewhere to go, so every graded task has a hint ladder.
Rungs are served one at a time, derived from the real task, and a rung whose
text would contain the answer is *dropped at construction time* rather than
shown. Each rung carries a penalty, and the main process — not the renderer —
owns the count, because a learner who could report their own hint usage could
report none.

The point of pricing hints is not to punish. It is that "solved it with four
hints" and "solved it unaided" are different states of knowledge, and a mastery
number that cannot tell them apart will schedule review wrongly.

### Spaced repetition against decay, not against a calendar

Mastery decays on a forgetting curve, and review is scheduled to catch a skill
just before it is predicted to fall below a retention threshold. Two things make
this specific to code: mastery is per repository, and a skill is invalidated
when *its source* changes, not when time passes. Having learned how the
scheduler works in a version that no longer exists is not knowledge.

### Misconceptions are named, and confidence is calibrated

A wrong answer is graded for *which* wrong model produced it. Distractors are
generated from real, plausible confusions in the repository — the wrong overload,
the shadowed name, the call that looks recursive and is not — so that a wrong
choice is diagnostic rather than merely wrong.

Confidence is collected before the reveal and scored with a Brier score, because
the failure mode that matters in onboarding is not ignorance but unwarranted
certainty. A learner who is wrong and knows it will look it up.

### Transfer is measured near and far

Analytics separate work done in files the learner has already opened from work
in files they have not. A learner who is excellent within one module and lost
outside it has not learned the architecture, and an aggregate score will say
they have.

### Explanations are graded against what the code did

A teach-back is compared with an execution trace of the real function, not with
a reference paragraph. Claims that contradict what the run actually did are
named as contradictions. This is the only grading in the application that can
say "you said it returns early, and it did not", which is worth more than a
similarity score against somebody else's wording.

## Research basis

- [RepoReasoner](https://arxiv.org/abs/2607.25996) — structured cross-file
  call-chain and execution reasoning beats simply supplying longer raw context.
  This motivates the call-chain prediction exercises and the knowledge graph.
- [SWE-Explore](https://arxiv.org/abs/2606.07297) — coverage, ranking, and
  context-efficiency metrics for repository navigation. This motivates the
  localization exercises being scored on precision, coverage, *and* how much of
  the repository had to be opened to get there.
- [RACE-bench](https://arxiv.org/abs/2603.26337) — grading intermediate
  understanding, localization, and implementation planning separately from final
  correctness. This motivates the three-stage RACE grader.
- [GitHub code navigation](https://docs.github.com/en/repositories/working-with-files/using-files/navigating-code-on-github)
  — tree-sitter-backed definition and reference navigation as the baseline a
  learner already expects.

## Limits, stated plainly

1. **Everything here measures performance on tasks this application generated.**
   That is a proxy for understanding, and a good one, but it is a proxy. The
   evaluation harness (item 34) scores retrieval quality separately from tutor
   answers separately from lesson quality precisely so that a single number
   cannot hide which part is working.
2. **No claim is made about learning outcomes.** The experiment framework
   (item 42) can compare two tutor configurations on this application's own
   measures, with consent, and it refuses to call a winner without enough
   evidence. It has not been used to run a study, and nothing here has been
   validated against an external measure of programmer competence.
3. **Difficulty is estimated from structure, not from people.** File importance,
   symbol centrality, and chain length are proxies for how hard something is.
   A real difficulty estimate needs response data from many learners, which a
   local-only application deliberately does not collect.
4. **Execution traces need a runtime.** Where a repository's language cannot be
   run here, explanation grading falls back to static evidence and says so.
5. **Generated distractors are only as good as the index.** In a language with
   no grammar available, the index is regex-based, and the exercises built on it
   are correspondingly shallower.
