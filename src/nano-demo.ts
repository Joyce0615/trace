import type { Course, LearnerState, Repository, SkillGraph } from "./types";
import { createClientLearnerState } from "./learning";

const files = [
  ["README.md", "markdown", 1_800],
  ["example.py", "python", 420],
  ["nanovllm/__init__.py", "python", 120],
  ["nanovllm/llm.py", "python", 86],
  ["nanovllm/config.py", "python", 2_200],
  ["nanovllm/sampling_params.py", "python", 480],
  ["nanovllm/engine/llm_engine.py", "python", 3_400],
  ["nanovllm/engine/scheduler.py", "python", 3_900],
  ["nanovllm/engine/sequence.py", "python", 2_500],
  ["nanovllm/engine/block_manager.py", "python", 4_100],
  ["nanovllm/engine/model_runner.py", "python", 9_800],
  ["nanovllm/layers/sampler.py", "python", 620],
  ["nanovllm/models/qwen3.py", "python", 6_500],
].map(([filePath, language, size], index) => ({
  path: String(filePath),
  name: String(filePath).split("/").at(-1)!,
  directory: String(filePath).split("/").slice(0, -1).join("/"),
  language: String(language),
  size: Number(size),
  importance: 200 - index * 5,
}));

const symbols = [
  ["LLM", "class", "nanovllm/llm.py", 4],
  ["LLMEngine", "class", "nanovllm/engine/llm_engine.py", 13],
  ["add_request", "function", "nanovllm/engine/llm_engine.py", 40],
  ["step", "function", "nanovllm/engine/llm_engine.py", 46],
  ["generate", "function", "nanovllm/engine/llm_engine.py", 58],
  ["Scheduler", "class", "nanovllm/engine/scheduler.py", 8],
  ["schedule", "function", "nanovllm/engine/scheduler.py", 22],
  ["postprocess", "function", "nanovllm/engine/scheduler.py", 72],
  ["Sequence", "class", "nanovllm/engine/sequence.py", 11],
  ["BlockManager", "class", "nanovllm/engine/block_manager.py", 24],
  ["allocate", "function", "nanovllm/engine/block_manager.py", 67],
  ["ModelRunner", "class", "nanovllm/engine/model_runner.py", 15],
  ["run", "function", "nanovllm/engine/model_runner.py", 178],
  ["capture_cudagraph", "function", "nanovllm/engine/model_runner.py", 190],
].map(([name, kind, filePath, line]) => ({ name: String(name), kind: String(kind), path: String(filePath), line: Number(line) }));

const definitionOf = (name: string) => symbols.find((symbol) => symbol.name === name);

const callEdges = [
  ["nanovllm/llm.py", 12, "LLM", "generate"],
  ["nanovllm/engine/llm_engine.py", 49, "step", "schedule"],
  ["nanovllm/engine/llm_engine.py", 51, "step", "run"],
  ["nanovllm/engine/llm_engine.py", 54, "step", "postprocess"],
  ["nanovllm/engine/llm_engine.py", 62, "generate", "step"],
  ["nanovllm/engine/scheduler.py", 34, "schedule", "allocate"],
  ["nanovllm/engine/model_runner.py", 184, "run", "capture_cudagraph"],
].map(([filePath, line, caller, callee]) => {
  const target = definitionOf(String(callee));
  return {
    path: String(filePath),
    line: Number(line),
    caller: String(caller),
    callee: String(callee),
    targetPath: target?.path ?? null,
    targetLine: target?.line ?? null,
    resolved: Boolean(target),
  };
});

const references = callEdges.map((edge) => ({ name: edge.callee, path: edge.path, line: edge.line, kind: "call" }));

export const nanoRepository: Repository = {
  id: "featured-nano-vllm",
  name: "nano-vllm",
  rootPath: "demo://nano-vllm",
  source: "demo",
  remoteUrl: "https://github.com/GeeeekExplorer/nano-vllm",
  head: "featured-main",
  versionId: "nano-vllm-featured-v1",
  branch: "main",
  isDirty: false,
  files,
  symbols,
  references,
  callEdges,
  entryFiles: ["example.py", "nanovllm/llm.py", "nanovllm/engine/llm_engine.py"],
  stats: {
    fileCount: files.length,
    symbolCount: symbols.length,
    referenceCount: references.length,
    callEdgeCount: callEdges.length,
    resolvedCallEdgeCount: callEdges.filter((edge) => edge.resolved).length,
    indexer: "tree-sitter",
    indexerCounts: { "tree-sitter": 12, regex: 0 },
    languages: { python: 12, markdown: 1 },
  },
  indexedAt: new Date().toISOString(),
};

const anchor = (path: string, line: number, symbol: string | null = null) => ({ path, line, symbol });

export const nanoCourse: Course = {
  id: "nano-vllm-featured-course",
  repositoryId: nanoRepository.id,
  sourceCommit: nanoRepository.head,
  sourceVersion: nanoRepository.versionId,
  title: "nano-vllm: Build an LLM Engine",
  subtitle: "From LLM.generate() to scheduling, KV cache, and GPU execution",
  level: "adaptive",
  profile: { goal: "architecture", level: "adaptive" },
  generatedBy: "featured",
  generatedAt: new Date().toISOString(),
  modules: [
    {
      id: "map", number: "01", title: "Map the Inference Engine", summary: "Start with the public API and build the complete execution map.", lessons: [
        {
          id: "engine-map", title: "A 1,200-line LLM Engine", objective: "Build a source-grounded map from the public LLM API to GPU execution.", summary: "See the whole system before diving into individual optimizations.", duration: 10, difficulty: "foundation", kind: "lesson", status: "ready",
          anchors: [anchor("example.py", 1), anchor("nanovllm/engine/llm_engine.py", 13, "LLMEngine")],
          quiz: { question: "Which component owns request lifecycle orchestration, and which component executes the model?", hint: "Separate control-plane scheduling from GPU execution." },
          content: [
            { id: "map-intro", type: "narrative", eyebrow: "SYSTEM MAP", title: "One call crosses four distinct responsibilities", body: "nano-vllm keeps its public API deliberately thin. The interesting work lives in the engine loop, scheduler, KV-cache manager, and model runner. Keeping these boundaries visible is the key to reading the repository efficiently." },
            { id: "map-diagram", type: "diagram", title: "Request-to-token architecture", caption: "Select a node to jump to its source anchor.", nodes: [
              { id: "api", label: "LLM.generate()", detail: "Public API", anchor: anchor("nanovllm/engine/llm_engine.py", 58, "generate") },
              { id: "engine", label: "LLMEngine.step()", detail: "Orchestration", anchor: anchor("nanovllm/engine/llm_engine.py", 46, "step") },
              { id: "scheduler", label: "Scheduler", detail: "Batch decisions", anchor: anchor("nanovllm/engine/scheduler.py", 8, "Scheduler") },
              { id: "runner", label: "ModelRunner", detail: "GPU execution", anchor: anchor("nanovllm/engine/model_runner.py", 15, "ModelRunner") },
            ], edges: [{ from: "api", to: "engine" }, { from: "engine", to: "scheduler", label: "schedule" }, { from: "scheduler", to: "runner", label: "run" }] },
            { id: "map-callout", type: "callout", tone: "insight", title: "Reading strategy", body: "Follow one request horizontally through the system before studying any class vertically." },
          ],
        },
      ],
    },
    {
      id: "loop", number: "02", title: "Follow the Generation Loop", summary: "Understand request state, engine steps, and the prefill/decode split.", lessons: [
        {
          id: "generation-loop", title: "From generate() to One Engine Step", objective: "Trace how prompts become sequences and how each engine step produces tokens.", summary: "The generate loop repeatedly schedules work, runs the model, and collects finished sequences.", duration: 18, difficulty: "foundation", kind: "lesson", status: "ready",
          anchors: [anchor("nanovllm/engine/llm_engine.py", 40, "add_request"), anchor("nanovllm/engine/llm_engine.py", 58, "generate")],
          quiz: { question: "Why does generate() keep looping instead of running each prompt once?", hint: "A causal model produces one decode token per active sequence per step." },
          content: [
            { id: "loop-story", type: "narrative", title: "Generation is a stateful loop", body: "Each prompt becomes a Sequence. The engine repeatedly asks the scheduler for the next batch, delegates GPU execution to ModelRunner, and records only sequences that have reached a stopping condition." },
            { id: "loop-time", type: "timeline", title: "One iteration of LLMEngine.step()", steps: [
              { label: "Schedule", detail: "Choose waiting or running sequences", anchor: anchor("nanovllm/engine/scheduler.py", 22, "schedule") },
              { label: "Run", detail: "Prepare tensors and execute the model", anchor: anchor("nanovllm/engine/model_runner.py", 178, "run") },
              { label: "Postprocess", detail: "Append tokens and finish sequences", anchor: anchor("nanovllm/engine/scheduler.py", 72, "postprocess") },
              { label: "Collect", detail: "Return newly finished outputs", anchor: anchor("nanovllm/engine/llm_engine.py", 46, "step") },
            ] },
          ],
        },
        {
          id: "sequence-state", title: "The Sequence State Machine", objective: "Understand how WAITING, RUNNING, and FINISHED encode request progress.", summary: "Sequence is the shared state object connecting scheduling, cache allocation, and output collection.", duration: 14, difficulty: "foundation", kind: "lesson", status: "ready",
          anchors: [anchor("nanovllm/engine/sequence.py", 5, "SequenceStatus"), anchor("nanovllm/engine/sequence.py", 11, "Sequence")],
          quiz: { question: "Which state transition releases KV-cache blocks?", hint: "Look at Scheduler.postprocess()." },
          content: [{ id: "state-diagram", type: "diagram", title: "Sequence lifecycle", caption: "Preemption can move a running sequence back to waiting.", nodes: [
            { id: "waiting", label: "WAITING", detail: "Queued or preempted", anchor: anchor("nanovllm/engine/sequence.py", 6, "WAITING") },
            { id: "running", label: "RUNNING", detail: "Eligible for decode", anchor: anchor("nanovllm/engine/scheduler.py", 44) },
            { id: "finished", label: "FINISHED", detail: "EOS or max tokens", anchor: anchor("nanovllm/engine/scheduler.py", 82) },
          ], edges: [{ from: "waiting", to: "running", label: "prefill complete" }, { from: "running", to: "finished", label: "stop" }, { from: "running", to: "waiting", label: "preempt" }] }],
        },
        {
          id: "prefill-decode", title: "Prefill vs. Decode", objective: "Explain why prefill batches tokens while decode schedules one token per sequence.", summary: "The scheduler treats prompt processing and autoregressive generation as different workloads.", duration: 20, difficulty: "intermediate", kind: "lesson", status: "ready",
          anchors: [anchor("nanovllm/engine/scheduler.py", 27, "schedule"), anchor("nanovllm/engine/model_runner.py", 101, "prepare_prefill")],
          quiz: { question: "Why does decode set num_scheduled_tokens to one?", hint: "Think about autoregressive dependencies." },
          content: [{ id: "phase-compare", type: "comparison", title: "Two phases, two batching shapes", columns: [
            { title: "Prefill", items: ["Processes many prompt tokens", "Can use chunked prefill", "Populates the KV cache"] },
            { title: "Decode", items: ["One new token per sequence", "Batches many active sequences", "Reuses cached keys and values"] },
          ] }],
        },
      ],
    },
    {
      id: "memory", number: "03", title: "Visualize KV-Cache Memory", summary: "Learn block allocation, reuse, and prefix caching.", lessons: [
        {
          id: "paged-cache", title: "Paged KV Cache", objective: "Trace how logical sequence blocks map onto reusable physical cache blocks.", summary: "Block tables decouple token order from physical GPU cache allocation.", duration: 22, difficulty: "intermediate", kind: "lesson", status: "ready",
          anchors: [anchor("nanovllm/engine/block_manager.py", 24, "BlockManager"), anchor("nanovllm/engine/model_runner.py", 77, "allocate_kv_cache")],
          quiz: { question: "What does a sequence's block_table represent?", hint: "Distinguish logical token blocks from physical cache block IDs." },
          content: [{ id: "cache-diagram", type: "diagram", title: "Logical tokens, physical blocks", caption: "The block table lets non-contiguous GPU blocks appear contiguous to a sequence.", nodes: [
            { id: "tokens", label: "Token blocks", detail: "Logical order", anchor: anchor("nanovllm/engine/sequence.py", 44, "block") },
            { id: "table", label: "block_table", detail: "Physical IDs", anchor: anchor("nanovllm/engine/block_manager.py", 67, "allocate") },
            { id: "kv", label: "GPU KV cache", detail: "Layer × block × token", anchor: anchor("nanovllm/engine/model_runner.py", 77, "allocate_kv_cache") },
          ], edges: [{ from: "tokens", to: "table", label: "map" }, { from: "table", to: "kv", label: "index" }] }],
        },
        {
          id: "prefix-cache", title: "Prefix Caching", objective: "Understand how hashed token blocks allow requests to reuse existing KV-cache work.", summary: "A chained hash identifies complete prefixes while reference counts keep shared blocks safe.", duration: 22, difficulty: "advanced", kind: "lesson", status: "ready",
          anchors: [anchor("nanovllm/engine/block_manager.py", 31, "compute_hash"), anchor("nanovllm/engine/block_manager.py", 50, "can_allocate")],
          quiz: { question: "Why is each block hash chained with the previous prefix hash?", hint: "The same token block can appear after different prefixes." },
          content: [{ id: "prefix-time", type: "timeline", title: "Reusing a cached prefix", steps: [
            { label: "Hash", detail: "Chain hashes across complete token blocks", anchor: anchor("nanovllm/engine/block_manager.py", 31, "compute_hash") },
            { label: "Match", detail: "Find reusable physical blocks", anchor: anchor("nanovllm/engine/block_manager.py", 50, "can_allocate") },
            { label: "Reference", detail: "Increment ref_count for shared blocks", anchor: anchor("nanovllm/engine/block_manager.py", 67, "allocate") },
            { label: "Skip", detail: "Schedule only uncached prompt tokens", anchor: anchor("nanovllm/engine/scheduler.py", 31) },
          ] }],
        },
      ],
    },
    {
      id: "gpu", number: "04", title: "Reach GPU Execution", summary: "Connect scheduling decisions to tensors, CUDA graphs, and parallel workers.", lessons: [
        {
          id: "model-runner", title: "Inside ModelRunner", objective: "Trace tensor preparation, model execution, sampling, and tensor-parallel coordination.", summary: "ModelRunner turns scheduled Sequence objects into GPU work.", duration: 26, difficulty: "advanced", kind: "lesson", status: "ready",
          anchors: [anchor("nanovllm/engine/model_runner.py", 15, "ModelRunner"), anchor("nanovllm/engine/model_runner.py", 178, "run")],
          quiz: { question: "Which data must be prepared differently for prefill and decode?", hint: "Compare prepare_prefill() and prepare_decode()." },
          content: [{ id: "runner-diagram", type: "diagram", title: "Scheduled sequences become sampled tokens", caption: "The rank-zero runner coordinates peers and returns sampled token IDs.", nodes: [
            { id: "seqs", label: "Sequences", detail: "Scheduler output" },
            { id: "tensors", label: "Input tensors", detail: "IDs, positions, cache mapping", anchor: anchor("nanovllm/engine/model_runner.py", 101, "prepare_prefill") },
            { id: "model", label: "Qwen3 model", detail: "Eager or CUDA Graph", anchor: anchor("nanovllm/engine/model_runner.py", 162, "run_model") },
            { id: "sample", label: "Sampler", detail: "Next token IDs", anchor: anchor("nanovllm/engine/model_runner.py", 178, "run") },
          ], edges: [{ from: "seqs", to: "tensors" }, { from: "tensors", to: "model" }, { from: "model", to: "sample" }] }],
        },
        {
          id: "scheduler-project", title: "Project · Explain One Scheduling Decision", objective: "Use an isolated worktree to instrument one scheduler branch and validate its behavior.", summary: "Turn the skill tree into evidence by observing a real decision.", duration: 40, difficulty: "advanced", kind: "project", status: "ready",
          anchors: [anchor("nanovllm/engine/scheduler.py", 22, "schedule")],
          quiz: { question: "Which scheduler branch will you instrument, and what evidence will prove your explanation?", hint: "Choose prefill admission, decode preemption, or completion cleanup." },
          content: [{ id: "project-callout", type: "callout", tone: "question", title: "Your mission", body: "Choose one scheduler decision, predict its behavior, add the smallest possible observation point, and compare the result with your prediction." }],
        },
      ],
    },
  ],
};

const nodes = [
  ["engine-map", "Inference Engine Map", "foundation", "System", [], 100],
  ["generation-loop", "Generation Loop", "foundation", "Engine", ["engine-map"], 96],
  ["sequence-state", "Sequence State Machine", "foundation", "Scheduling", ["generation-loop"], 86],
  ["prefill-decode", "Prefill vs. Decode", "working", "Scheduling", ["generation-loop"], 94],
  ["paged-cache", "Paged KV Cache", "working", "Memory", ["prefill-decode"], 92],
  ["prefix-cache", "Prefix Caching", "deep", "Memory", ["paged-cache"], 80],
  ["model-runner", "GPU Model Runner", "deep", "GPU", ["prefill-decode"], 88],
  ["scheduler-project", "Scheduling Project", "deep", "Practice", ["sequence-state", "prefix-cache", "model-runner"], 74],
] as const;

export const nanoSkillGraph: SkillGraph = {
  id: "nano-vllm-featured-skills",
  repositoryId: nanoRepository.id,
  sourceVersion: nanoRepository.versionId,
  generatedBy: "featured",
  nodes: nodes.map(([lessonId, title, depth, branch, prerequisites, importance]) => {
    const lesson = nanoCourse.modules.flatMap((module) => module.lessons).find((item) => item.id === lessonId)!;
    return {
      id: `skill-${lessonId}`,
      title,
      summary: lesson.objective,
      lessonId,
      prerequisites: prerequisites.map((id) => `skill-${id}`),
      anchors: lesson.anchors,
      depth,
      branch,
      importance,
      estimatedMinutes: lesson.duration,
      sourceFingerprint: `featured-${lessonId}-v1`,
    };
  }),
  diagnostic: [
    { id: "diag-autoregressive", skillId: "skill-generation-loop", prompt: "Why does autoregressive generation require an engine loop?", options: ["Each step depends on the token sampled by the previous step", "The tokenizer only accepts one token", "The model must reload weights each time"], correctIndex: 0, explanation: "Each decode step consumes the token produced by the previous step." },
    { id: "diag-prefill", skillId: "skill-prefill-decode", prompt: "What is the main difference between prefill and decode?", options: ["Prefill processes prompt tokens; decode advances active sequences one token", "Prefill uses CPU; decode uses GPU", "They use different model weights"], correctIndex: 0, explanation: "They share the model but have very different batching shapes." },
    { id: "diag-kv", skillId: "skill-paged-cache", prompt: "What does the KV cache avoid recomputing?", options: ["Keys and values for earlier tokens", "Tokenizer vocabulary", "Model parameters"], correctIndex: 0, explanation: "Cached keys and values let attention reuse prior-token state." },
    { id: "diag-scheduler", skillId: "skill-sequence-state", prompt: "What is the scheduler's central responsibility?", options: ["Choose which sequence tokens run next within resource limits", "Load model checkpoints", "Decode token IDs into text"], correctIndex: 0, explanation: "The scheduler decides admission and batch composition." },
  ],
};

export const nanoLearnerState: LearnerState = createClientLearnerState(nanoRepository.id, nanoRepository.versionId, nanoSkillGraph);

export const nanoSourceByPath: Record<string, string> = {
  "README.md": `# Nano-vLLM\n\nA lightweight vLLM implementation built from scratch.\n\n- Fast offline inference\n- Readable codebase in about 1,200 lines of Python\n- Prefix caching, Tensor Parallelism, Torch compilation, and CUDA graph\n`,
  "example.py": `from nanovllm import LLM, SamplingParams\n\nllm = LLM("/YOUR/MODEL/PATH", enforce_eager=True, tensor_parallel_size=1)\nsampling_params = SamplingParams(temperature=0.6, max_tokens=256)\nprompts = ["Hello, Nano-vLLM."]\noutputs = llm.generate(prompts, sampling_params)\n`,
  "nanovllm/llm.py": `from nanovllm.engine.llm_engine import LLMEngine\n\n\nclass LLM(LLMEngine):\n    pass\n`,
  "nanovllm/engine/llm_engine.py": `class LLMEngine:\n    def add_request(self, prompt, sampling_params):\n        if isinstance(prompt, str):\n            prompt = self.tokenizer.encode(prompt)\n        seq = Sequence(prompt, sampling_params)\n        self.scheduler.add(seq)\n\n    def step(self):\n        seqs, is_prefill = self.scheduler.schedule()\n        token_ids = self.model_runner.call("run", seqs, is_prefill)\n        self.scheduler.postprocess(seqs, token_ids, is_prefill)\n        outputs = [(seq.seq_id, seq.completion_token_ids) for seq in seqs if seq.is_finished]\n        return outputs\n\n    def generate(self, prompts, sampling_params, use_tqdm=True):\n        for prompt, sp in zip(prompts, sampling_params):\n            self.add_request(prompt, sp)\n        outputs = {}\n        while not self.is_finished():\n            output = self.step()\n            for seq_id, token_ids in output:\n                outputs[seq_id] = token_ids\n        return outputs\n`,
  "nanovllm/engine/scheduler.py": `class Scheduler:\n    def schedule(self):\n        scheduled_seqs = []\n        num_batched_tokens = 0\n\n        # prefill waiting sequences\n        while self.waiting and len(scheduled_seqs) < self.max_num_seqs:\n            seq = self.waiting[0]\n            num_cached_blocks = self.block_manager.can_allocate(seq)\n            self.block_manager.allocate(seq, num_cached_blocks)\n            seq.status = SequenceStatus.RUNNING\n            scheduled_seqs.append(seq)\n\n        if scheduled_seqs:\n            return scheduled_seqs, True\n\n        # decode running sequences\n        while self.running and len(scheduled_seqs) < self.max_num_seqs:\n            seq = self.running.popleft()\n            seq.num_scheduled_tokens = 1\n            seq.is_prefill = False\n            self.block_manager.may_append(seq)\n            scheduled_seqs.append(seq)\n        return scheduled_seqs, False\n\n    def postprocess(self, seqs, token_ids, is_prefill):\n        for seq, token_id in zip(seqs, token_ids):\n            seq.append_token(token_id)\n            if token_id == self.eos or seq.num_completion_tokens == seq.max_tokens:\n                seq.status = SequenceStatus.FINISHED\n                self.block_manager.deallocate(seq)\n`,
  "nanovllm/engine/sequence.py": `class SequenceStatus(Enum):\n    WAITING = auto()\n    RUNNING = auto()\n    FINISHED = auto()\n\nclass Sequence:\n    block_size = 256\n    def __init__(self, token_ids, sampling_params):\n        self.status = SequenceStatus.WAITING\n        self.token_ids = copy(token_ids)\n        self.num_cached_tokens = 0\n        self.num_scheduled_tokens = 0\n        self.is_prefill = True\n        self.block_table = []\n`,
  "nanovllm/engine/block_manager.py": `class BlockManager:\n    def compute_hash(self, token_ids, prefix=-1):\n        h = xxhash.xxh64()\n        if prefix != -1:\n            h.update(prefix.to_bytes(8, "little"))\n        h.update(np.array(token_ids).tobytes())\n        return h.intdigest()\n\n    def can_allocate(self, seq):\n        num_cached_blocks = 0\n        for i in range(seq.num_blocks - 1):\n            token_ids = seq.block(i)\n            block_id = self.hash_to_block_id.get(self.compute_hash(token_ids), -1)\n            if block_id == -1:\n                break\n            num_cached_blocks += 1\n        return num_cached_blocks\n\n    def allocate(self, seq, num_cached_blocks):\n        # Reuse cached blocks, then allocate the remaining physical blocks.\n        ...\n`,
  "nanovllm/engine/model_runner.py": `class ModelRunner:\n    def prepare_prefill(self, seqs):\n        # Flatten scheduled prompt tokens and build cache slot mappings.\n        ...\n\n    def prepare_decode(self, seqs):\n        # One last token per active sequence plus block tables.\n        ...\n\n    def run(self, seqs, is_prefill):\n        input_ids, positions = self.prepare_prefill(seqs) if is_prefill else self.prepare_decode(seqs)\n        logits = self.run_model(input_ids, positions, is_prefill)\n        token_ids = self.sampler(logits, temperatures).tolist()\n        return token_ids\n\n    def capture_cudagraph(self):\n        # Capture reusable decode graphs for common batch sizes.\n        ...\n`,
  "nanovllm/config.py": `@dataclass\nclass Config:\n    max_num_seqs: int = 512\n    max_num_batched_tokens: int = 16384\n    kvcache_block_size: int = 256\n`,
  "nanovllm/sampling_params.py": `@dataclass\nclass SamplingParams:\n    temperature: float = 1.0\n    max_tokens: int = 64\n    ignore_eos: bool = False\n`,
  "nanovllm/layers/sampler.py": `class Sampler(nn.Module):\n    def forward(self, logits, temperatures):\n        probs = torch.softmax(logits / temperatures.unsqueeze(-1), dim=-1)\n        return probs.div_(torch.empty_like(probs).exponential_(1)).argmax(dim=-1)\n`,
  "nanovllm/models/qwen3.py": `class Qwen3ForCausalLM(nn.Module):\n    def forward(self, input_ids, positions):\n        return self.model(input_ids, positions)\n`,
  "nanovllm/__init__.py": `from nanovllm.llm import LLM\nfrom nanovllm.sampling_params import SamplingParams\n`,
};
