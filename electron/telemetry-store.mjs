import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { readDurable, writeDurable } from "./durable-store.mjs";
import { createTelemetryState, forget, pruneRetention, recordEvent, setConsent } from "./telemetry.mjs";

/**
 * Where the local telemetry counters live (item 60).
 *
 * One file, written atomically through the durable store so a crash mid-write
 * cannot lose the counters *and* their backup — item 51's machinery, reused
 * because a second implementation of atomic writing is a second implementation
 * to get wrong.
 *
 * Two behaviours are deliberate and worth stating:
 *
 *   - **Retention is applied on load.** A file left behind by a version that is
 *     no longer running must expire because time passed, not because something
 *     happened to write to it. Loading a stale file and immediately dropping
 *     what is past the window is the only way that holds.
 *   - **Deleting means deleting the file.** `forgetEverything` unlinks rather
 *     than writing an empty object, so "delete my data" leaves nothing on disk
 *     to be recovered — the same rule the experiment store follows.
 */

export const TELEMETRY_STORE_VERSION = 1;

function storePath(directory) {
  return path.join(directory, "telemetry.json");
}

export async function loadTelemetry(directory, now = new Date()) {
  // `readDurable` returns an envelope-shaped result whose `value` is the
  // payload; reading `.payload` off the result instead silently produced an
  // empty state, which looked exactly like "consent was never granted".
  const stored = await readDurable(storePath(directory));
  if (!stored?.value) return createTelemetryState();
  // Retention on read, not only on write.
  return pruneRetention({ ...createTelemetryState(), ...stored.value }, now);
}

async function save(directory, state) {
  await writeDurable(storePath(directory), state);
  return state;
}

export async function setTelemetryConsent(directory, granted, now = new Date()) {
  const existing = await loadTelemetry(directory, now);
  const next = setConsent(existing, granted, now);
  if (!granted) {
    // Withdrawal removes the file rather than writing an emptied one.
    await rm(storePath(directory), { force: true });
    await rm(`${storePath(directory)}.bak`, { force: true });
    return next;
  }
  return save(directory, next);
}

/** Record one event, or refuse and say why. Never throws at a caller. */
export async function record(directory, name, payload, now = new Date()) {
  const existing = await loadTelemetry(directory, now);
  const outcome = recordEvent(existing, name, payload, now);
  if (!outcome.recorded) return { recorded: false, reason: outcome.reason, detail: outcome.detail };
  await save(directory, outcome.state);
  return { recorded: true, reason: null, detail: null, totalSeries: outcome.state.series.length };
}

export async function forgetTelemetry(directory, { event = null } = {}, now = new Date()) {
  const existing = await loadTelemetry(directory, now);
  const outcome = forget(existing, { event });
  if (!event) {
    await rm(storePath(directory), { force: true });
    await rm(`${storePath(directory)}.bak`, { force: true });
  } else {
    await save(directory, outcome.state);
  }
  return { deletedSeries: outcome.deletedSeries, deletedEvents: outcome.deletedEvents, consent: outcome.state.consent };
}

/** Whether anything is on disk at all, for a report that must not guess. */
export async function telemetryFileExists(directory) {
  try {
    await readFile(storePath(directory), "utf8");
    return true;
  } catch {
    return false;
  }
}
