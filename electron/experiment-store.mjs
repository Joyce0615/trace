import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sanitizeObservation } from "./experiments.mjs";

/**
 * Consent and observation storage for item 42.
 *
 * One file, atomically replaced, holding a consent record and a bounded list of
 * observations. Two properties matter more than anything else here:
 *
 *   - `recordObservation` refuses when consent is absent, so a caller that
 *     forgets to check cannot record anything anyway;
 *   - `forgetEverything` deletes the file rather than blanking fields, so
 *     "delete my data" leaves nothing behind to be recovered.
 */

export const EXPERIMENT_STORE_VERSION = 1;
export const MAX_OBSERVATIONS = 2_000;

function storePath(directory) {
  return path.join(directory, "experiments.json");
}

export async function loadExperimentState(directory) {
  try {
    const parsed = JSON.parse(await readFile(storePath(directory), "utf8"));
    return {
      version: EXPERIMENT_STORE_VERSION,
      consent: parsed?.consent ?? null,
      observations: Array.isArray(parsed?.observations) ? parsed.observations : [],
    };
  } catch {
    return { version: EXPERIMENT_STORE_VERSION, consent: null, observations: [] };
  }
}

async function save(directory, state) {
  await mkdir(directory, { recursive: true });
  const destination = storePath(directory);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: EXPERIMENT_STORE_VERSION, ...state }, null, 2));
  await rename(temporary, destination);
  return state;
}

/**
 * Grant or revoke consent.
 *
 * Granting mints a fresh random participant id — it is not derived from the
 * machine, the user, or the repository, and re-granting after a revocation
 * produces a new one, so two consent periods cannot be linked together.
 * Revoking deletes the observations immediately rather than merely stopping
 * collection.
 */
export async function setConsent(directory, granted) {
  const existing = await loadExperimentState(directory);
  if (!granted) {
    return save(directory, {
      consent: { granted: false, grantedAt: existing.consent?.grantedAt ?? null, revokedAt: new Date().toISOString(), participantId: null },
      observations: [],
    });
  }
  return save(directory, {
    consent: { granted: true, grantedAt: new Date().toISOString(), revokedAt: null, participantId: randomUUID() },
    observations: existing.consent?.granted ? existing.observations : [],
  });
}

/** Record one observation, or refuse and say why. */
export async function recordObservation(directory, candidate) {
  const existing = await loadExperimentState(directory);
  if (!existing.consent?.granted) return { recorded: false, reason: "no-consent" };
  const sanitized = sanitizeObservation(candidate);
  if (!sanitized.ok) return { recorded: false, reason: sanitized.reason };
  const observations = [...existing.observations, sanitized.observation].slice(-MAX_OBSERVATIONS);
  await save(directory, { consent: existing.consent, observations });
  return { recorded: true, reason: null, observation: sanitized.observation, total: observations.length };
}

/** Delete everything: the file itself, not just its contents. */
export async function forgetEverything(directory) {
  const existing = await loadExperimentState(directory);
  await rm(storePath(directory), { force: true });
  return { deletedObservations: existing.observations.length, hadConsent: Boolean(existing.consent?.granted) };
}
