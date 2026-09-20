import type { Course } from "./types";

/**
 * An earlier version of the featured nano-vllm fixture, plus the course that
 * was written against it (item 46).
 *
 * The browser has no git object database, so the desktop path — reconstruct the
 * previous version of every anchored file with `git show` — cannot run here.
 * Rather than mock a migration, the demo ships a real second version of three
 * fixture files and a real course anchored into it, and then runs the *actual*
 * matcher over them. Everything the demo reports is therefore produced by the
 * same code the desktop app runs; only the source of the "previous version"
 * differs, and the panel says so.
 *
 * The four repairs the fixture exercises are deliberate, one of each kind:
 *
 *   - `LLMEngine.add_request` moved down a line when the file's leading comment
 *     was removed — the same definition, a different coordinate.
 *   - `LLMEngine.generate` was **split**: the inline step loop became
 *     `LLMEngine.step`, and `generate` now calls it.
 *   - `Scheduler.finish_batch` was **renamed** to `Scheduler.postprocess` with
 *     its body intact.
 *   - `nanovllm/engine/prefix_cache.py` was **deleted**, so the lesson built on
 *     it has nothing left to point at.
 */

export const NANO_PREVIOUS_COMMIT = "9f2c41d0e8ab5c7419d6fa32b0c8e15d4a77b903";

export const nanoPreviousSources: Record<string, string> = {
  "nanovllm/engine/llm_engine.py": `# entry point for the engine loop
class LLMEngine:
    def add_request(self, prompt, sampling_params):
        if isinstance(prompt, str):
            prompt = self.tokenizer.encode(prompt)
        seq = Sequence(prompt, sampling_params)
        self.scheduler.add(seq)

    def generate(self, prompts, sampling_params, use_tqdm=True):
        for prompt, sp in zip(prompts, sampling_params):
            self.add_request(prompt, sp)
        outputs = {}
        while not self.is_finished():
            seqs, is_prefill = self.scheduler.schedule()
            token_ids = self.model_runner.call("run", seqs, is_prefill)
            self.scheduler.finish_batch(seqs, token_ids, is_prefill)
            for seq in seqs:
                if seq.is_finished:
                    outputs[seq.seq_id] = seq.completion_token_ids
        return outputs
`,
  "nanovllm/engine/scheduler.py": `class Scheduler:
    def schedule(self):
        scheduled_seqs = []
        num_batched_tokens = 0

        # prefill waiting sequences
        while self.waiting and len(scheduled_seqs) < self.max_num_seqs:
            seq = self.waiting[0]
            num_cached_blocks = self.block_manager.can_allocate(seq)
            self.block_manager.allocate(seq, num_cached_blocks)
            seq.status = SequenceStatus.RUNNING
            scheduled_seqs.append(seq)

        if scheduled_seqs:
            return scheduled_seqs, True

        # decode running sequences
        while self.running and len(scheduled_seqs) < self.max_num_seqs:
            seq = self.running.popleft()
            seq.num_scheduled_tokens = 1
            seq.is_prefill = False
            self.block_manager.may_append(seq)
            scheduled_seqs.append(seq)
        return scheduled_seqs, False

    def finish_batch(self, seqs, token_ids, is_prefill):
        for seq, token_id in zip(seqs, token_ids):
            seq.append_token(token_id)
            if token_id == self.eos or seq.num_completion_tokens == seq.max_tokens:
                seq.status = SequenceStatus.FINISHED
                self.block_manager.deallocate(seq)
`,
  "nanovllm/engine/prefix_cache.py": `class PrefixCache:
    def lookup(self, token_ids):
        digest = self.hash(token_ids)
        entry = self.entries.get(digest)
        if entry is None:
            return None
        entry.hits += 1
        return entry.blocks
`,
};

/** Definition spans in the previous version, as an indexer would have recorded them. */
export const nanoPreviousSymbols = [
  { name: "LLMEngine", kind: "class", path: "nanovllm/engine/llm_engine.py", line: 2, endLine: 20 },
  { name: "add_request", kind: "function", path: "nanovllm/engine/llm_engine.py", line: 3, endLine: 7, container: "LLMEngine" },
  { name: "generate", kind: "function", path: "nanovllm/engine/llm_engine.py", line: 9, endLine: 20, container: "LLMEngine" },
  { name: "Scheduler", kind: "class", path: "nanovllm/engine/scheduler.py", line: 1, endLine: 31 },
  { name: "schedule", kind: "function", path: "nanovllm/engine/scheduler.py", line: 2, endLine: 24, container: "Scheduler" },
  { name: "finish_batch", kind: "function", path: "nanovllm/engine/scheduler.py", line: 26, endLine: 31, container: "Scheduler" },
  { name: "PrefixCache", kind: "class", path: "nanovllm/engine/prefix_cache.py", line: 1, endLine: 8 },
  { name: "lookup", kind: "function", path: "nanovllm/engine/prefix_cache.py", line: 2, endLine: 8, container: "PrefixCache" },
];

/** The same three files in the current fixture, with the spans the demo index reports. */
export const nanoCurrentSymbols = [
  { name: "LLMEngine", kind: "class", path: "nanovllm/engine/llm_engine.py", line: 1, endLine: 23 },
  { name: "add_request", kind: "function", path: "nanovllm/engine/llm_engine.py", line: 2, endLine: 6, container: "LLMEngine" },
  { name: "step", kind: "function", path: "nanovllm/engine/llm_engine.py", line: 8, endLine: 13, container: "LLMEngine" },
  { name: "generate", kind: "function", path: "nanovllm/engine/llm_engine.py", line: 15, endLine: 23, container: "LLMEngine" },
  { name: "Scheduler", kind: "class", path: "nanovllm/engine/scheduler.py", line: 1, endLine: 31 },
  { name: "schedule", kind: "function", path: "nanovllm/engine/scheduler.py", line: 2, endLine: 24, container: "Scheduler" },
  { name: "postprocess", kind: "function", path: "nanovllm/engine/scheduler.py", line: 26, endLine: 31, container: "Scheduler" },
];

const anchor = (path: string, line: number, symbol: string | null = null) => ({ path, line, symbol });

/** The course as it was written against `NANO_PREVIOUS_COMMIT`. */
export const nanoLegacyCourse: Course = {
  id: "nano-vllm-legacy-course",
  repositoryId: "nano-vllm-featured",
  sourceCommit: NANO_PREVIOUS_COMMIT,
  sourceVersion: "nano-vllm-featured-v0",
  title: "nano-vllm: Build an LLM Engine",
  subtitle: "Written against an earlier commit",
  level: "adaptive",
  generatedBy: "featured",
  generatedAt: "2026-01-01T00:00:00.000Z",
  modules: [
    {
      id: "legacy-loop", number: "01", title: "Follow the Generation Loop", summary: "How prompts become sequences and sequences become tokens.", lessons: [
        {
          id: "legacy-generate", title: "From generate() to One Engine Step", objective: "Trace how prompts become sequences.", summary: "The generate loop schedules work and collects finished sequences.",
          duration: 18, difficulty: "foundation", kind: "lesson", status: "ready",
          anchors: [anchor("nanovllm/engine/llm_engine.py", 3, "add_request"), anchor("nanovllm/engine/llm_engine.py", 9, "generate")],
          quiz: { question: "Why does generate() keep looping?", hint: "One decode token per active sequence per step." },
          content: [
            { id: "legacy-time", type: "timeline", title: "One iteration", steps: [
              { label: "Schedule", detail: "Choose waiting or running sequences", anchor: anchor("nanovllm/engine/scheduler.py", 2, "schedule") },
              { label: "Finish", detail: "Append tokens and release blocks", anchor: anchor("nanovllm/engine/scheduler.py", 26, "finish_batch") },
            ] },
          ],
        },
        {
          id: "legacy-prefix", title: "Prefix Cache Lookups", objective: "Understand how shared prompt prefixes are reused.", summary: "A cache keyed by a rolling hash of token ids.",
          duration: 12, difficulty: "intermediate", kind: "lesson", status: "ready",
          anchors: [anchor("nanovllm/engine/prefix_cache.py", 2, "lookup")],
          quiz: { question: "What makes a prefix reusable across requests?", hint: "Identical leading token ids." },
        },
      ],
    },
  ],
};
