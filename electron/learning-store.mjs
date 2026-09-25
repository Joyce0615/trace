import { createHash } from "node:crypto";
import path from "node:path";
import { readDurable, writeDurable } from "./durable-store.mjs";
import { redactValue } from "./secret-scanner.mjs";

function statePath(directory, repositoryId) {
  const key = createHash("sha256").update(repositoryId).digest("hex").slice(0, 24);
  return path.join(directory, `${key}.json`);
}

/**
 * Read the learner's state, recovering the previous generation if the current
 * file cannot be trusted (item 51). Returns the state; `loadLearnerStateReport`
 * is for callers that need to tell the learner what happened.
 */
export async function loadLearnerState(directory, repositoryId) {
  return (await loadLearnerStateReport(directory, repositoryId)).value;
}

export async function loadLearnerStateReport(directory, repositoryId) {
  // `acceptLegacy` matters once: a state file written before durable saves is a
  // valid file, and treating an upgrade as a corruption would throw away
  // everyone's mastery on the day they updated.
  return readDurable(statePath(directory, repositoryId), { acceptLegacy: true });
}

export async function saveLearnerState(directory, state) {
  if (!state?.repositoryId || !state?.mastery) throw new Error("Invalid learner state.");
  // Learner notes and saved agent answers can quote source, so persisted state is redacted.
  await writeDurable(statePath(directory, state.repositoryId), redactValue({ ...state, updatedAt: new Date().toISOString() }));
  return true;
}
