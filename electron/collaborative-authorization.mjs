import { consentState } from "./project-continuity.mjs";
import { appendEvent } from "./activity-log.mjs";

/**
 * Authorization-aware collaborative learning (item 45, this cycle).
 *
 * Four roles now read or write sensitive artifacts in this app —
 * **learner** (the person studying), **tutor-agent** (the primary
 * `agents.mjs` call that answers a question or drafts a course),
 * **sub-agent** (any further delegated/automated step run on that
 * tutor-agent's behalf — a verifier, a cohort-evaluator, a nested tool
 * call), and **instructor** (the human who adjudicates
 * `curriculum-review.mjs`'s queue) — and until this module, which of them
 * may touch which *kind* of sensitive thing was never written down as a
 * single, checkable rule. It existed only as scattered, resource-specific
 * enforcement: `answer-guard.mjs`'s own `ALWAYS_FORBIDDEN`/egress guard
 * decides, per IPC *channel*, whether an answer key leaked in a response;
 * `tutor-generation-verification.mjs`'s own `blindGenerationRequest`
 * decides, per generation *request*, whether a hidden-solution field
 * reaches a generator; `project-continuity.mjs`'s own consent gate decides
 * whether cross-session learner facts are kept at all. None of those asks
 * the prior, role-level question this item names: *is this role even
 * supposed to be asking for this kind of thing, in this workflow, right
 * now* — before any channel, request, or generation step is reached.
 *
 * Grep confirmed before writing a line here: zero prior matches for
 * `authorizeRetrieval`/`authorizeExport`/`authorizeWorkflowChain`/
 * `reanchorConsent`/`collaborative-authorization` anywhere in
 * `electron/*.mjs`/`tests/*.mjs`.
 *
 * Design, reusing rather than reinventing:
 *
 *   - **The permission matrix is the one new fact this module states.**
 *     [`PERMISSIONS`] names exactly four resource kinds the item's own text
 *     names — `repository`, `solution`, `assessment`, `learner-data` — and
 *     is deliberately a flat, auditable table rather than a function with
 *     branches, so the actual rule is visible by reading the table, not by
 *     tracing control flow. One row is a structural invariant, not a
 *     policy choice: **no role ever maps to `solution: "read"`, including
 *     `learner`** — restating, at the role level, what
 *     `answer-guard.mjs`'s own docstring already says ("the value of an
 *     exercise is entirely in not being able to read the answer"; a
 *     learner is shown feedback *after* answering, which is a different,
 *     already-handled concept, not a `solution` read). [`authorizePermission`]
 *     is the only place that table is read; nothing here re-derives it.
 *   - **Delegation cannot acquire access an earlier link in the chain
 *     lacked.** [`authorizeWorkflowChain`] checks every role named in an
 *     ordered delegation chain against the same table and reports the
 *     *minimum* access level across the whole chain, never the last link's
 *     own ceiling alone — a `tutor-agent` that itself only has `read` on
 *     `learner-data` cannot hand a `sub-agent` `write`, and a `sub-agent`
 *     with `none` on `learner-data` grounds the whole chain to `none` even
 *     if the role that spawned it had `read`.
 *   - **Consent is re-anchored, not merely checked, on every sensitive
 *     retrieval or export.** [`reanchorConsent`] reuses
 *     `project-continuity.mjs`'s own `consentState` (unmodified, same
 *     `{granted, grantedAt, revokedAt}` shape that module's own
 *     `setContinuityConsent` already produces) to refuse outright once
 *     consent is revoked — but also refuses when the consent the resource
 *     was *captured* under (`resource.consentGrantedAt`, the `grantedAt`
 *     recorded at the moment the data was first produced) no longer
 *     matches the consent *currently* in effect. Revoke-then-regrant
 *     produces a new `grantedAt` under `project-continuity.mjs`'s own
 *     `setContinuityConsent`, so a resource captured under the old grant is
 *     never silently carried forward under the learner's *new* decision to
 *     consent again — it must be re-authorized, the same "re-anchor" word
 *     this item's own text uses, not reused on the strength of a stale
 *     grant that happens to currently read `granted: true`.
 *   - **Export always re-anchors, regardless of resource kind.**
 *     [`authorizeExport`] re-anchors consent unconditionally, even for a
 *     `repository`/`assessment` resource this module's own table would
 *     otherwise treat as not requiring one for a same-process *retrieval* —
 *     `docs/threat-model.md`'s own "Received file → application state" row
 *     already treats a file crossing the process boundary as the sensitive
 *     moment regardless of what is inside it; exporting *from* this app is
 *     the same boundary viewed from the other side, and gets the same
 *     discipline every time.
 *   - **Decisions are logged like every other graded/decided event.**
 *     [`recordAuthorizationDecision`] preserves a denial or a grant through
 *     `activity-log.mjs`'s own `appendEvent` (unmodified) — the same
 *     append-only, main-process-owned log every other decision in this app
 *     (adjudications, graded attempts) already writes to.
 *
 * Pure and Node-free except [`recordAuthorizationDecision`], whose only I/O
 * is the same `appendEvent` every other recorder in this app already calls.
 */

export const COLLABORATIVE_AUTHORIZATION_VERSION = 1;

/** Every role this app's learning workflows can be acting as. */
export const ROLES = ["learner", "tutor-agent", "sub-agent", "instructor"];

/** Every sensitive resource kind this item names. */
export const RESOURCE_KINDS = ["repository", "solution", "assessment", "learner-data"];

const LEVEL_RANK = { none: 0, read: 1, write: 2 };

/**
 * The permission table. `"none"` means no action at all; `"read"` permits
 * read only; `"write"` permits read and write.
 *
 * `solution` is `"none"` for every role on purpose: no workflow in this app
 * ever needs a role-level grant to read a hidden answer key, because the
 * only legitimate path to "the learner sees their own result" is a grade
 * (feedback after answering), never a `solution` resource read.
 */
export const PERMISSIONS = Object.freeze({
  learner: Object.freeze({ repository: "read", solution: "none", assessment: "read", "learner-data": "write" }),
  "tutor-agent": Object.freeze({ repository: "read", solution: "none", assessment: "none", "learner-data": "read" }),
  "sub-agent": Object.freeze({ repository: "read", solution: "none", assessment: "none", "learner-data": "none" }),
  instructor: Object.freeze({ repository: "read", solution: "none", assessment: "write", "learner-data": "read" }),
});

function levelFor(role, resourceKind) {
  return PERMISSIONS[role]?.[resourceKind] ?? "none";
}

/**
 * Check one role's own permission for one action on one resource kind,
 * against the table above only — no inference, no exception.
 */
export function authorizePermission(role, resourceKind, action = "read") {
  if (!ROLES.includes(role)) return { ok: false, reason: `unknown-role:${role}` };
  if (!RESOURCE_KINDS.includes(resourceKind)) return { ok: false, reason: `unknown-resource-kind:${resourceKind}` };
  const level = levelFor(role, resourceKind);
  if (level === "none") return { ok: false, reason: `${role} has no ${action} permission on ${resourceKind}` };
  if (action === "write" && level !== "write") return { ok: false, reason: `${role} may only read ${resourceKind}, not write it` };
  return { ok: true, reason: null, level };
}

/**
 * Check an ordered delegation chain (originator first). Every link must
 * individually be permitted, and the access reported for the *whole* chain
 * is the most restrictive link's own level, not the last link's — so a
 * chain can never acquire more access than its weakest link by routing
 * through a role with a higher ceiling.
 */
export function authorizeWorkflowChain(chain, resourceKind, action = "read") {
  const roles = Array.isArray(chain) ? chain : [chain];
  if (!roles.length) return { ok: false, reason: "empty-chain", deniedAtIndex: null };
  for (let index = 0; index < roles.length; index += 1) {
    const result = authorizePermission(roles[index], resourceKind, action);
    if (!result.ok) return { ok: false, reason: result.reason, deniedAtIndex: index };
  }
  const effectiveRank = Math.min(...roles.map((role) => LEVEL_RANK[levelFor(role, resourceKind)]));
  const effectiveLevel = Object.keys(LEVEL_RANK).find((key) => LEVEL_RANK[key] === effectiveRank);
  return { ok: true, reason: null, deniedAtIndex: null, effectiveLevel };
}

/**
 * Re-anchor a resource's access to the consent it was actually captured
 * under. `resource.consentGrantedAt` is the `grantedAt` recorded at capture
 * time (e.g. `project-continuity.mjs`'s own record `updatedAt`/`consent.
 * grantedAt` at the moment a hypothesis/evidence/thread turn was written);
 * `consent` is whatever consent record governs the resource now, in the
 * same `{granted, grantedAt, revokedAt}` shape `project-continuity.mjs`'s
 * own `consentState` already normalizes.
 *
 * A resource with no recorded anchor (`consentGrantedAt` absent) is only
 * checked against current consent being granted at all — there is nothing
 * to re-anchor against yet, which is the normal state for a resource this
 * module has not been told to track an anchor for.
 */
export function reanchorConsent(resource, consent) {
  const state = consentState(consent);
  if (!state.granted) return { ok: false, reason: "consent-revoked", requiresReauthorization: true };
  const anchoredAt = resource?.consentGrantedAt ?? null;
  if (anchoredAt && anchoredAt !== state.grantedAt) {
    return { ok: false, reason: "consent-regranted-since-capture", requiresReauthorization: true };
  }
  return { ok: true, reason: null, requiresReauthorization: false };
}

function requiresConsentAnchor(resourceKind, resource) {
  return resourceKind === "learner-data" || Boolean(resource?.sensitive);
}

/**
 * Authorize one retrieval: the workflow chain's own permission, then —
 * only for `learner-data` or a resource the caller explicitly marks
 * `sensitive` — a re-anchor against the consent governing it right now.
 */
export function authorizeRetrieval({ chain, resourceKind, action = "read", consent = null, resource = null } = {}) {
  const permission = authorizeWorkflowChain(chain, resourceKind, action);
  if (!permission.ok) return { ok: false, reason: permission.reason, stage: "permission", deniedAtIndex: permission.deniedAtIndex };
  if (requiresConsentAnchor(resourceKind, resource)) {
    const anchor = reanchorConsent(resource, consent);
    if (!anchor.ok) return { ok: false, reason: anchor.reason, stage: "consent", requiresReauthorization: anchor.requiresReauthorization };
  }
  return { ok: true, reason: null, stage: null, effectiveLevel: permission.effectiveLevel };
}

/**
 * Authorize one export. Identical to [`authorizeRetrieval`] except consent
 * is always re-anchored, for every resource kind, because leaving the
 * local process is the sensitive moment regardless of what the resource
 * contains — the same "received file" boundary `docs/threat-model.md`
 * already names, viewed from the side producing the file instead of the
 * side receiving it.
 */
export function authorizeExport({ chain, resourceKind, action = "read", consent = null, resource = null } = {}) {
  const permission = authorizeWorkflowChain(chain, resourceKind, action);
  if (!permission.ok) return { ok: false, reason: permission.reason, stage: "permission", deniedAtIndex: permission.deniedAtIndex };
  const anchor = reanchorConsent(resource, consent);
  if (!anchor.ok) return { ok: false, reason: anchor.reason, stage: "consent", requiresReauthorization: anchor.requiresReauthorization };
  return { ok: true, reason: null, stage: null, effectiveLevel: permission.effectiveLevel };
}

/**
 * Persist one authorization decision (grant or denial) through
 * `activity-log.mjs`'s own `appendEvent`, unmodified — so an instructor or
 * a later audit can see exactly which role was denied which resource kind
 * and why, the same tamper-evident trail every other graded/decided event
 * in this app already gets.
 */
export async function recordAuthorizationDecision(directory, repositoryId, decision) {
  return appendEvent(directory, repositoryId, {
    kind: "collaborative-authorization",
    version: COLLABORATIVE_AUTHORIZATION_VERSION,
    chain: decision.chain ?? null,
    resourceKind: decision.resourceKind ?? null,
    action: decision.action ?? "read",
    ok: Boolean(decision.ok),
    reason: decision.reason ?? null,
    stage: decision.stage ?? null,
  });
}
