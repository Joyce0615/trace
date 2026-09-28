import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * What this machine can actually test (item 54).
 *
 * The suite grew on one laptop, and by item 53 it quietly depended on that
 * laptop: a hard-coded repository path, a Python interpreter for the execution
 * tracer, a clangd binary for the language-server test, `git` everywhere. None
 * of that is wrong — testing against a *real* repository is why the earlier
 * items found real defects — but "works on the author's machine" is not a claim
 * a CI matrix can check.
 *
 * So capabilities are detected and *reported* rather than assumed. A run on a
 * machine without Python still tests everything else and says which parts it
 * could not reach; a run that silently skipped them would be worse than one
 * that failed. `--require` turns a missing capability into a failure, which is
 * what the CI matrix uses to guarantee the Linux job really did run the
 * sandboxed-quiz tests rather than skipping them.
 */

export const CAPABILITIES = [
  { id: "git", detect: () => run("git", ["--version"]), why: "cloning, worktrees, history, and blob reads" },
  { id: "python", detect: async () => run("python3", ["--version"]).catch(() => run("python", ["--version"])), why: "execution traces and the sandboxed quiz runner" },
  { id: "clangd", detect: () => run("clangd", ["--version"]), why: "the live language-server protocol test" },
  { id: "electron", detect: async () => run(process.execPath, ["-e", "process.stdout.write(require('electron/package.json').version)"]), why: "the desktop smoke test" },
];

async function detectAll() {
  const found = {};
  for (const capability of CAPABILITIES) {
    try {
      const result = await capability.detect();
      found[capability.id] = { available: true, version: String(result.stdout ?? result.stderr ?? "").trim().split("\n")[0] };
    } catch (cause) {
      found[capability.id] = { available: false, reason: cause?.message?.split("\n")[0] ?? "not found" };
    }
  }
  return found;
}

/**
 * Build a small but *real* git repository to test against.
 *
 * The desktop smoke test needs a repository with history, several languages, a
 * license, and enough files that the index is not trivial. On a developer
 * machine that is FlashInfer; on a CI runner there is no such thing, and
 * checking one out would make the job depend on somebody else's repository
 * staying where it is. This builds an equivalent locally, so the same
 * assertions run everywhere — the numbers are smaller, the properties are the
 * same.
 */
export async function createFixtureRepository(destination) {
  const rootPath = destination ?? await mkdtemp(path.join(os.tmpdir(), "trace-ci-repo-"));
  const git = (...args) => run("git", ["-C", rootPath, ...args]);
  await mkdir(path.join(rootPath, "engine"), { recursive: true });
  await mkdir(path.join(rootPath, "include"), { recursive: true });
  await mkdir(path.join(rootPath, "docs"), { recursive: true });

  await writeFile(path.join(rootPath, "LICENSE"), "Apache License, Version 2.0\n\nLicensed under the Apache License, Version 2.0 (the \"License\");\n");
  await writeFile(path.join(rootPath, "README.md"), "# fixture\n\nA small repository with real history, for testing on machines that have no repository of their own.\n");
  await writeFile(path.join(rootPath, "pyproject.toml"), "[project]\nname = \"fixture\"\nversion = \"0.1.0\"\n");
  await writeFile(path.join(rootPath, "engine", "__init__.py"), "");
  await writeFile(path.join(rootPath, "engine", "scheduler.py"), [
    "class Scheduler:",
    '    """Chooses which sequences run next."""',
    "",
    "    def schedule(self, waiting, running):",
    "        picked = []",
    "        while waiting and len(picked) < self.max_seqs:",
    "            seq = waiting.pop(0)",
    "            self.blocks.allocate(seq)",
    "            picked.append(seq)",
    "        return picked",
    "",
    "    def postprocess(self, seqs, tokens):",
    "        for seq, token in zip(seqs, tokens):",
    "            seq.append(token)",
    "            if token == self.eos:",
    "                self.blocks.release(seq)",
    "        return seqs",
    "",
  ].join("\n"));
  await writeFile(path.join(rootPath, "engine", "runner.py"), [
    "from engine.scheduler import Scheduler",
    "",
    "",
    "def round_up(value, multiple):",
    "    return ((value + multiple - 1) // multiple) * multiple",
    "",
    "",
    "class Runner:",
    "    def run(self, seqs):",
    "        scheduled = self.scheduler.schedule(seqs, [])",
    "        return [self.model(seq) for seq in scheduled]",
    "",
    "    def capacity(self, tokens):",
    "        return round_up(tokens, 16)",
    "",
  ].join("\n"));
  await writeFile(path.join(rootPath, "engine", "engine.py"), [
    "from engine.runner import Runner",
    "from engine.scheduler import Scheduler",
    "",
    "",
    "class Engine:",
    "    def add_request(self, prompt):",
    "        self.waiting.append(prompt)",
    "",
    "    def step(self):",
    "        seqs = self.scheduler.schedule(self.waiting, self.running)",
    "        tokens = self.runner.run(seqs)",
    "        return self.scheduler.postprocess(seqs, tokens)",
    "",
    "    def generate(self, prompts):",
    "        for prompt in prompts:",
    "            self.add_request(prompt)",
    "        outputs = []",
    "        while self.waiting:",
    "            outputs.extend(self.step())",
    "        return outputs",
    "",
  ].join("\n"));
  await writeFile(path.join(rootPath, "include", "kernels.cuh"), [
    "#pragma once",
    "",
    "template <typename T>",
    "__global__ void act_and_mul_kernel(T* out, const T* input, int d) {",
    "  out[0] = input[0];",
    "}",
    "",
    "struct LaunchConfig {",
    "  int blocks;",
    "  int threads;",
    "};",
    "",
  ].join("\n"));
  await writeFile(path.join(rootPath, "docs", "design.md"), "# Design\n\nThe scheduler owns admission; the runner owns execution.\n");

  await git("init", "-q");
  await git("config", "user.email", "ci@example.com");
  await git("config", "user.name", "CI");
  await git("add", "-A");
  await git("commit", "-qm", "initial");
  // A second commit, so history-based features have something to read.
  await writeFile(path.join(rootPath, "engine", "runner.py"), [
    "from engine.scheduler import Scheduler",
    "",
    "",
    "# A comment added in the second commit, which moves everything below it.",
    "def round_up(value, multiple):",
    "    return ((value + multiple - 1) // multiple) * multiple",
    "",
    "",
    "class Runner:",
    "    def run(self, seqs):",
    "        scheduled = self.scheduler.schedule(seqs, [])",
    "        return [self.model(seq) for seq in scheduled]",
    "",
    "    def capacity(self, tokens):",
    "        return round_up(tokens, 16)",
    "",
  ].join("\n"));
  await git("add", "-A");
  await git("commit", "-qm", "add a comment that moves a definition");
  return rootPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const required = process.argv.filter((argument) => argument.startsWith("--require=")).flatMap((argument) => argument.slice("--require=".length).split(","));
  const capabilities = await detectAll();
  const missing = required.filter((id) => !capabilities[id]?.available);
  const report = {
    platform: `${os.platform()}-${os.arch()}`,
    node: process.version,
    capabilities,
    required,
    missing,
    // Stated so a green run cannot be mistaken for a complete one.
    skipped: CAPABILITIES.filter((capability) => !capabilities[capability.id].available).map((capability) => `${capability.id}: ${capability.why}`),
  };
  if (process.argv.includes("--fixture")) {
    report.fixture = await createFixtureRepository();
    await access(report.fixture);
  }
  console.log(JSON.stringify(report, null, 2));
  if (missing.length) {
    console.error(`Missing required capabilities: ${missing.join(", ")}`);
    process.exitCode = 1;
  }
}
