import { createHash } from "node:crypto";
import { open, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Persistence that survives being interrupted.
 *
 * Every store in this app already wrote to a temporary file and renamed it,
 * which is the right shape and only half the job. Three things were missing,
 * and each of them loses a learner's work in a different way:
 *
 *   - **Nothing was flushed.** `rename` is atomic with respect to *readers*,
 *     but on a crash or a power cut the operating system may have the rename
 *     durable and the file's contents still in a write-back cache, leaving a
 *     correctly named empty file. The data is only safe once the file is
 *     fsynced before the rename and the *directory* is fsynced after it.
 *   - **Nothing was verified.** A truncated or garbled file parsed as JSON is
 *     indistinguishable from a real one until something downstream behaves
 *     strangely. A checksum over the payload turns that into a loud failure at
 *     read time.
 *   - **There was nothing to fall back to.** One bad file was the end of the
 *     learner's mastery history. Each write now keeps the previous generation,
 *     so a corrupt current file costs the last save rather than everything.
 *
 * The read path never throws. A store that cannot be read must degrade to
 * "start again" rather than prevent the app from opening — losing progress is
 * bad, and being unable to launch because progress was lost is worse — but what
 * happened is reported rather than swallowed, so the renderer can say so.
 */

export const DURABLE_FORMAT = "trace-durable-v1";
export const DURABLE_VERSION = 1;

const TEMP_SUFFIX = ".tmp";
const BACKUP_SUFFIX = ".bak";

function checksumOf(payload) {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex").slice(0, 32);
}

function envelope(payload, options = {}) {
  return {
    format: DURABLE_FORMAT,
    version: DURABLE_VERSION,
    savedAt: options.now ?? new Date().toISOString(),
    checksum: checksumOf(payload),
    payload,
  };
}

/** Flush a path's own bytes, or a directory's entries, to the device. */
async function fsyncPath(target, { directory = false } = {}) {
  let handle = null;
  try {
    handle = await open(target, directory ? "r" : "r+");
    await handle.sync();
    return true;
  } catch {
    // Some platforms refuse to open a directory for fsync. The rename is still
    // atomic for readers; only the durability guarantee is weaker, and saying so
    // is better than pretending.
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Write a value so that a crash leaves either the previous value or the new
 * one, and never a half of either.
 *
 * The order matters and is the whole of the guarantee: write the temp file,
 * flush it, keep the current file as the backup, rename the temp over the
 * current, then flush the directory so the rename itself is durable.
 */
export async function writeDurable(filePath, payload, options = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}${TEMP_SUFFIX}`;
  const backup = `${filePath}${BACKUP_SUFFIX}`;
  const body = JSON.stringify(envelope(payload, options), null, 2);

  await writeFile(temporary, body);
  const flushed = await fsyncPath(temporary);
  // The previous generation is preserved *before* it is overwritten, so there is
  // always something to fall back to.
  let backedUp = false;
  try {
    await rename(filePath, backup);
    backedUp = true;
  } catch {
    // No current file yet: the first write has nothing to back up.
  }
  await rename(temporary, filePath);
  const directoryFlushed = await fsyncPath(path.dirname(filePath), { directory: true });
  return { path: filePath, bytes: Buffer.byteLength(body), flushed, directoryFlushed, backedUp };
}

async function readEnvelope(filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return { ok: false, reason: "missing" };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The single most likely on-disk corruption: a write that stopped halfway.
    return { ok: false, reason: "unparsable" };
  }
  if (parsed?.format !== DURABLE_FORMAT) return { ok: false, reason: "foreign", parsed };
  if (Number(parsed.version) > DURABLE_VERSION) return { ok: false, reason: "future-version", parsed };
  if (parsed.checksum !== checksumOf(parsed.payload)) return { ok: false, reason: "checksum-mismatch", parsed };
  return { ok: true, envelope: parsed };
}

/**
 * Read a value, falling back to the previous generation when the current one
 * cannot be trusted.
 *
 * Returns what it did as well as what it read: a caller that silently recovers
 * from a backup has quietly discarded the learner's most recent session, and
 * they are entitled to be told.
 */
export async function readDurable(filePath, options = {}) {
  const problems = [];
  const current = await readEnvelope(filePath);
  if (current.ok) {
    return { value: current.envelope.payload, source: "current", recovered: false, savedAt: current.envelope.savedAt, problems };
  }
  if (current.reason !== "missing") problems.push(`The saved file was unusable (${current.reason}).`);

  const backup = await readEnvelope(`${filePath}${BACKUP_SUFFIX}`);
  if (backup.ok) {
    problems.push("Recovered the previous save; anything from the last session was lost.");
    return { value: backup.envelope.payload, source: "backup", recovered: true, savedAt: backup.envelope.savedAt, problems };
  }
  if (backup.reason !== "missing") problems.push(`The backup was unusable too (${backup.reason}).`);

  // Legacy files predate the envelope; adopting them is what stops an upgrade
  // from looking exactly like a corruption.
  if (options.acceptLegacy && current.reason === "foreign" && current.parsed && typeof current.parsed === "object") {
    problems.push("Adopted a file written before durable saves were introduced.");
    return { value: current.parsed, source: "legacy", recovered: false, savedAt: null, problems };
  }

  return { value: options.fallback ?? null, source: "none", recovered: false, savedAt: null, problems };
}

/**
 * Temporary files left behind by an interrupted write.
 *
 * They are never read — a temp file is by definition a write that did not
 * finish — but they are evidence that the app stopped mid-save, which is worth
 * reporting once and then clearing.
 */
export async function sweepInterruptedWrites(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return { swept: [], bytes: 0 };
  }
  const swept = [];
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.endsWith(TEMP_SUFFIX)) continue;
    const target = path.join(directory, entry);
    try {
      bytes += (await stat(target)).size;
      await rm(target, { force: true });
      swept.push(entry);
    } catch {
      // A temp file that cannot be removed is not worth failing a launch over.
    }
  }
  return { swept, bytes };
}

/** What a store can say about itself: is there a current file, a backup, both, neither. */
export async function inspectDurable(filePath) {
  const current = await readEnvelope(filePath);
  const backup = await readEnvelope(`${filePath}${BACKUP_SUFFIX}`);
  return {
    current: current.ok ? { savedAt: current.envelope.savedAt, checksum: current.envelope.checksum } : null,
    currentProblem: current.ok ? null : current.reason,
    backup: backup.ok ? { savedAt: backup.envelope.savedAt, checksum: backup.envelope.checksum } : null,
    backupProblem: backup.ok ? null : backup.reason,
    recoverable: current.ok || backup.ok,
  };
}
