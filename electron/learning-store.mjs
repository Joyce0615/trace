import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function statePath(directory, repositoryId) {
  const key = createHash("sha256").update(repositoryId).digest("hex").slice(0, 24);
  return path.join(directory, `${key}.json`);
}

export async function loadLearnerState(directory, repositoryId) {
  try {
    return JSON.parse(await readFile(statePath(directory, repositoryId), "utf8"));
  } catch {
    return null;
  }
}

export async function saveLearnerState(directory, state) {
  if (!state?.repositoryId || !state?.mastery) throw new Error("Invalid learner state.");
  await mkdir(directory, { recursive: true });
  const destination = statePath(directory, state.repositoryId);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
  await rename(temporary, destination);
  return true;
}
