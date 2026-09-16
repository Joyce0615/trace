import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactValue } from "./secret-scanner.mjs";

/**
 * The local activity log that item 41's analytics read.
 *
 * Events are appended by the *main process* as it grades, not by the renderer:
 * a learner should not be able to rewrite their own retention history by
 * calling an IPC channel, and analytics that can be edited are decoration.
 *
 * The log is local-only, bounded, redacted with the item-25 scanner before it
 * touches disk, and written atomically through a temporary file so a crash
 * mid-write cannot corrupt it.
 */

export const ACTIVITY_LOG_VERSION = 1;
export const MAX_EVENTS = 1_000;

function logPath(directory, repositoryId) {
  const key = createHash("sha256").update(String(repositoryId)).digest("hex").slice(0, 24);
  return path.join(directory, `${key}.json`);
}

export async function readEvents(directory, repositoryId) {
  try {
    const parsed = JSON.parse(await readFile(logPath(directory, repositoryId), "utf8"));
    return Array.isArray(parsed?.events) ? parsed.events : [];
  } catch {
    return [];
  }
}

// Appending is read-modify-write, so two grades finishing at the same time
// would each read the old log and the second would overwrite the first. Appends
// are therefore serialized per log file.
const writeQueues = new Map();

function enqueue(key, work) {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  writeQueues.set(key, next.catch(() => undefined));
  return next;
}

/**
 * Append one graded event. Never throws: analytics are a secondary concern and
 * must not be able to fail the activity the learner just completed.
 */
export function appendEvent(directory, repositoryId, event) {
  return enqueue(logPath(directory, repositoryId), () => appendEventNow(directory, repositoryId, event));
}

async function appendEventNow(directory, repositoryId, event) {
  try {
    const existing = await readEvents(directory, repositoryId);
    const entry = redactValue({
      id: randomUUID(),
      at: new Date().toISOString(),
      ...event,
    });
    // Oldest first, bounded: a long-running workspace keeps a recent window.
    const events = [...existing, entry].slice(-MAX_EVENTS);
    await mkdir(directory, { recursive: true });
    const destination = logPath(directory, repositoryId);
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: ACTIVITY_LOG_VERSION, repositoryId, events }, null, 2));
    await rename(temporary, destination);
    return entry;
  } catch {
    return null;
  }
}
