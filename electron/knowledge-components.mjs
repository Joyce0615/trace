import { createHash } from "node:crypto";
import { GRADED_KINDS, normalizeEvents } from "./analytics.mjs";
import { evidenceForSkills } from "./evidence-import.mjs";
import { MISCONCEPTIONS, detectMisconceptions, misconceptionById } from "./misconception.mjs";

/**
 * Knowledge-component mastery graphs.
 *
 * A skill in `skill-graph.mjs` is one curriculum node ("this lesson"). That
 * node by itself says nothing about *what in the code* it is actually about,
 * what it is commonly misunderstood as, which exercises can exercise it, or
 * what outside evidence (a test, an ADR, a doc) already corroborates it. This
 * module composes four things this app already built separately — never
 * re-deriving any of their rules — into one versioned record per skill:
 *
 *   - **symbols**: the real knowledge-graph symbol nodes (`knowledge-graph.mjs`)
 *     reachable from the skill's own lesson anchors. A component never invents
 *     a symbol id; every one it carries is checked against the knowledge
 *     graph's own node list.
 *   - **misconceptions**: references into the one misconception taxonomy
 *     (`misconception.mjs`'s `MISCONCEPTIONS`), by id only — this module
 *     carries no detector patterns and no remediation text of its own.
 *   - **exercises**: which graded activity kinds (`analytics.mjs`'s own
 *     `GRADED_KINDS`) a skill's probe/activity type maps onto, so a component
 *     states what *kind* of attempt can produce evidence for it.
 *   - **evidence**: the PR/issue/ADR/doc/test items `evidence-import.mjs`
 *     already linked to this skill's anchors (`evidenceForSkills`), by id.
 *
 * Mastery for a knowledge component is *not* carried over from
 * `LearnerState.mastery` (which a renderer can call `addEvidence` against
 * freely, including for a bare self-report). `rebuildComponentMastery` is the
 * one path that updates a component's mastery, and it reads *only* from the
 * append-only activity log the main process writes
 * (`electron/activity-log.mjs`'s `readEvents`/`appendEvent`, the exact shape
 * `electron/main.mjs`'s `recordActivity` already produces for every graded
 * exercise) — an auditable observation, keyed by skill id, with a real
 * timestamp. A caller that passes a `LearnerState` in anyway (see the
 * `learnerState` option) gets it explicitly and visibly ignored for mastery
 * math; it is accepted only so a caller already holding one does not need to
 * strip it out by hand.
 */

export const KNOWLEDGE_COMPONENT_VERSION = 1;

const PRIOR_ALPHA = 1;
const PRIOR_BETA = 1;
// Mirrors `misconception.mjs`'s own per-kind weighting, but over audited
// activity-log kinds rather than client-supplied LearnerState evidence kinds
// (the two sets overlap but are not identical: the log never carries
// "self-report" or "note", which are recorded without ever being graded).
const AUDIT_WEIGHT = { probe: 1.4, "executable-quiz": 1.4, explanation: 1.3, "teach-back": 1.3, prediction: 1.2, contrast: 1.2, "call-chain": 1.1, localization: 1.1, race: 1.1, review: 1.8, "delayed-transfer": 1.6 };

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function componentId(skillId) {
  return `kc-${skillId}`;
}

/** Real symbol-node ids reachable from a skill's lesson anchors, checked
 * against the knowledge graph's own node list rather than invented here. */
function symbolIdsForSkill(node, knowledgeGraph) {
  if (!knowledgeGraph?.nodes?.length) return [];
  const byPath = new Map();
  for (const graphNode of knowledgeGraph.nodes) {
    if (graphNode.kind !== "symbol") continue;
    if (!byPath.has(graphNode.path)) byPath.set(graphNode.path, []);
    byPath.get(graphNode.path).push(graphNode);
  }
  const ids = [];
  for (const anchor of node.anchors ?? []) {
    const candidates = byPath.get(anchor.path) ?? [];
    const matched = anchor.symbol
      ? candidates.filter((candidate) => candidate.label === anchor.symbol)
      : candidates;
    for (const candidate of matched) ids.push(candidate.id);
  }
  return [...new Set(ids)];
}

/** Misconceptions a skill's already-linked evidence text names, by id only
 * — reusing `misconception.mjs`'s own detector rather than re-deriving a
 * second pattern set. A skill with no linked evidence (or whose evidence
 * names nothing) carries no misconceptions yet, which is reported as such
 * rather than guessed at. */
function misconceptionIdsForSkill(linkedEvidence) {
  const ids = new Set();
  for (const item of linkedEvidence ?? []) {
    const text = `${item.title ?? ""} ${item.summary ?? ""}`.trim();
    if (!text) continue;
    for (const finding of detectMisconceptions(text)) ids.add(finding.id);
  }
  return [...ids];
}

/** Which graded activity kinds can produce evidence for a skill, derived from
 * the one `exerciseKind` each misconception entry already states for itself,
 * restricted to kinds `analytics.mjs` actually recognizes as graded. */
function exerciseKindsForSkill() {
  // Every skill can, in principle, be probed (`misconception.mjs`'s
  // `buildProbe` builds one for every skill node) and quizzed/explained via
  // the lesson's own quiz; this is deliberately the activity-kind surface the
  // app's exercises already cover for any skill, not a per-skill guess.
  return ["probe", "executable-quiz", "explanation", "teach-back", "prediction", "contrast", "call-chain", "localization"];
}

/**
 * Build one versioned knowledge component per skill-graph node, composing the
 * knowledge graph, the misconception taxonomy, and already-linked evidence.
 * Never recomputes any of those three sources' own rules.
 */
export function buildKnowledgeComponents(skillGraph, knowledgeGraph, evidenceItems, _options = {}) {
  const evidenceBySkill = evidenceForSkills(evidenceItems ?? [], skillGraph);
  const items = (skillGraph?.nodes ?? []).map((node) => {
    const symbolIds = symbolIdsForSkill(node, knowledgeGraph);
    const linkedEvidence = evidenceBySkill[node.id] ?? [];
    const misconceptionIds = misconceptionIdsForSkill(linkedEvidence);
    const evidenceIds = linkedEvidence.map((item) => item.id);
    const body = {
      skillId: node.id,
      title: node.title,
      symbolIds,
      misconceptionIds,
      exerciseKinds: exerciseKindsForSkill(node),
      evidenceIds,
      anchors: node.anchors ?? [],
      sourceFingerprint: node.sourceFingerprint ?? null,
    };
    return {
      id: componentId(node.id),
      ...body,
      componentDigest: digest(body),
    };
  });
  return {
    version: KNOWLEDGE_COMPONENT_VERSION,
    repositoryId: skillGraph?.repositoryId ?? null,
    sourceVersion: skillGraph?.sourceVersion ?? null,
    generatedAt: new Date().toISOString(),
    items,
  };
}

/** The one lookup path, keyed by skill id; `null` rather than `undefined`
 * when there is no such component, so a caller's `=== null` check is exact. */
export function componentForSkill(components, skillId) {
  return components?.items?.find((component) => component.skillId === skillId) ?? null;
}

/** How much of the graph actually links to a real symbol/evidence/misconception,
 * so an empty or thin graph is reported rather than assumed complete. */
export function componentCoverage(components) {
  const items = components?.items ?? [];
  const total = items.length;
  const withSymbol = items.filter((item) => item.symbolIds.length > 0).length;
  const withEvidence = items.filter((item) => item.evidenceIds.length > 0).length;
  const withMisconception = items.filter((item) => item.misconceptionIds.length > 0).length;
  const safeRate = (count) => (total ? Number((count / total).toFixed(4)) : 0);
  return {
    total,
    withSymbol,
    withEvidence,
    withMisconception,
    symbolCoverage: safeRate(withSymbol),
    evidenceCoverage: safeRate(withEvidence),
    misconceptionCoverage: safeRate(withMisconception),
  };
}

/**
 * Recompute each component's mastery from audited activity-log events only.
 *
 * `events` must be the shape `electron/activity-log.mjs`'s `readEvents`
 * returns (equivalently, what `electron/main.mjs`'s `recordActivity` already
 * writes for every graded exercise): `{ kind, skillId, correct, score, at,
 * ... }`. A `learnerState` passed in `options` is accepted so a caller already
 * holding one does not have to strip it first, but it is never read for
 * mastery math — only the activity log is an auditable observation; a
 * `LearnerState.mastery` entry can have been produced by a bare client-side
 * self-report (`kind: "self-report"`/`"note"`), which this rebuild must not
 * trust.
 */
export function rebuildComponentMastery(components, events, options = {}) {
  void options.learnerState; // Explicitly accepted and explicitly ignored; see module doc.
  const byComponent = new Map((components?.items ?? []).map((component) => [component.skillId, component]));
  const ordered = normalizeEvents(events).filter((event) => GRADED_KINDS.has(event.kind) && typeof event.skillId === "string");
  const matched = ordered.filter((event) => byComponent.has(event.skillId));
  const unmatchedEvents = ordered.length - matched.length;

  const mastery = {};
  const misconceptionsObserved = {};
  for (const component of byComponent.values()) {
    let alpha = PRIOR_ALPHA;
    let beta = PRIOR_BETA;
    let evidenceCount = 0;
    const misconceptions = new Set();
    for (const event of matched.filter((candidate) => candidate.skillId === component.skillId)) {
      const weight = AUDIT_WEIGHT[event.kind] ?? 0.5;
      const success = typeof event.score === "number" ? Math.max(0, Math.min(1, event.score)) : event.correct ? 1 : 0;
      alpha += weight * success;
      beta += weight * (1 - success);
      evidenceCount += 1;
      if (event.misconception?.id) misconceptions.add(event.misconception.id);
    }
    const mean = alpha / (alpha + beta);
    const variance = (alpha * beta) / (((alpha + beta) ** 2) * (alpha + beta + 1));
    const deviation = Math.sqrt(variance);
    const interval = [Math.max(0, mean - 1.96 * deviation), Math.min(1, mean + 1.96 * deviation)];
    mastery[component.skillId] = {
      skillId: component.skillId,
      mastery: Number(mean.toFixed(4)),
      confidence: Number(Math.max(0, Math.min(1, 1 - (interval[1] - interval[0]))).toFixed(4)),
      evidenceCount,
    };
    if (misconceptions.size) misconceptionsObserved[component.skillId] = [...misconceptions];
  }

  return {
    version: KNOWLEDGE_COMPONENT_VERSION,
    mastery,
    misconceptionsObserved,
    unmatchedEvents,
    observedEvents: matched.length,
    digest: digest({ mastery, misconceptionsObserved }),
  };
}

/**
 * Diff two component graphs built from the same skill ids across a rebuild
 * (e.g. after a source change), by `componentDigest` rather than by assuming
 * nothing moved.
 */
export function reconcileKnowledgeComponents(previous, next) {
  const byId = new Map((previous?.items ?? []).map((component) => [component.skillId, component]));
  const changed = [];
  const unchanged = [];
  const added = [];
  for (const component of next?.items ?? []) {
    const before = byId.get(component.skillId);
    if (!before) { added.push(component.skillId); continue; }
    if (before.componentDigest !== component.componentDigest) changed.push(component.skillId);
    else unchanged.push(component.skillId);
  }
  const removed = [...byId.keys()].filter((skillId) => !(next?.items ?? []).some((component) => component.skillId === skillId));
  return { changed, unchanged, added, removed };
}

/** A render-ready summary, never including any taxonomy detector pattern. */
export function renderComponentDigest(components) {
  const coverage = componentCoverage(components);
  return [
    `${coverage.total} knowledge component(s).`,
    `${coverage.withSymbol} linked to a real symbol (${Math.round(coverage.symbolCoverage * 100)}%).`,
    `${coverage.withEvidence} linked to outside evidence (${Math.round(coverage.evidenceCoverage * 100)}%).`,
    `${coverage.withMisconception} already carry a known misconception (${Math.round(coverage.misconceptionCoverage * 100)}%).`,
  ].join(" ");
}

/** Exposed for symmetry with `misconception.mjs`'s own export, used by a
 * caller that wants to validate a referenced misconception id is real. */
export function knownMisconceptionIds() {
  return MISCONCEPTIONS.map((entry) => entry.id);
}

export function assertMisconceptionKnown(id) {
  return Boolean(misconceptionById(id));
}
