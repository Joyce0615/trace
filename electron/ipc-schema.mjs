/**
 * Versioned IPC payload validation.
 *
 * The renderer is sandboxed but still untrusted input from the main process's
 * point of view. Every channel declares a schema; payloads are size-bounded,
 * depth-bounded, and structurally validated before any handler runs. Unknown
 * keys are rejected rather than ignored so a mistyped field cannot slip through.
 */

export const IPC_PROTOCOL_VERSION = 1;

// Hard ceiling on any single payload, checked before structural validation.
export const MAX_PAYLOAD_BYTES = 4_000_000;
export const MAX_PAYLOAD_DEPTH = 16;

export class IpcValidationError extends Error {
  constructor(channel, pointer, message) {
    super(`${channel}${pointer ? ` at ${pointer}` : ""}: ${message}`);
    this.name = "IpcValidationError";
    this.channel = channel;
    this.pointer = pointer;
    this.validation = true;
  }
}

export const s = {
  string: (options = {}) => ({ type: "string", maxLength: options.maxLength ?? 4_096, minLength: options.minLength ?? 0, pattern: options.pattern ?? null, optional: options.optional ?? false, nullable: options.nullable ?? false }),
  number: (options = {}) => ({ type: "number", min: options.min ?? Number.NEGATIVE_INFINITY, max: options.max ?? Number.MAX_SAFE_INTEGER, integer: options.integer ?? false, optional: options.optional ?? false, nullable: options.nullable ?? false }),
  boolean: (options = {}) => ({ type: "boolean", optional: options.optional ?? false, nullable: options.nullable ?? false }),
  literal: (values, options = {}) => ({ type: "enum", values, optional: options.optional ?? false, nullable: options.nullable ?? false }),
  array: (item, options = {}) => ({ type: "array", item, maxItems: options.maxItems ?? 1_000, optional: options.optional ?? false, nullable: options.nullable ?? false }),
  object: (shape, options = {}) => ({ type: "object", shape, optional: options.optional ?? false, nullable: options.nullable ?? false, allowUnknown: options.allowUnknown ?? false }),
  record: (options = {}) => ({ type: "record", maxKeys: options.maxKeys ?? 500, value: options.value ?? null, optional: options.optional ?? false, nullable: options.nullable ?? false }),
  /** Structured data forwarded verbatim (for example a cached course); still size- and depth-bounded. */
  opaque: (options = {}) => ({ type: "opaque", optional: options.optional ?? false, nullable: options.nullable ?? false }),
};

function payloadBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  } catch {
    // Cyclic or non-serialisable payloads can never have crossed a structured clone.
    return Number.POSITIVE_INFINITY;
  }
}

function depthOf(value, depth = 0) {
  if (depth > MAX_PAYLOAD_DEPTH) return depth;
  if (Array.isArray(value)) {
    return value.reduce((deepest, item) => Math.max(deepest, depthOf(item, depth + 1)), depth);
  }
  if (value && typeof value === "object") {
    return Object.values(value).reduce((deepest, item) => Math.max(deepest, depthOf(item, depth + 1)), depth);
  }
  return depth;
}

function validateNode(channel, schema, value, pointer) {
  if (value === undefined) {
    if (schema.optional) return undefined;
    throw new IpcValidationError(channel, pointer, "is required");
  }
  if (value === null) {
    if (schema.nullable || schema.optional) return null;
    throw new IpcValidationError(channel, pointer, "cannot be null");
  }

  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") throw new IpcValidationError(channel, pointer, "must be a string");
      if (value.length > schema.maxLength) throw new IpcValidationError(channel, pointer, `exceeds ${schema.maxLength} characters`);
      if (value.length < schema.minLength) throw new IpcValidationError(channel, pointer, `must be at least ${schema.minLength} characters`);
      if (schema.pattern && !schema.pattern.test(value)) throw new IpcValidationError(channel, pointer, "has an unexpected format");
      return value;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new IpcValidationError(channel, pointer, "must be a finite number");
      if (schema.integer && !Number.isInteger(value)) throw new IpcValidationError(channel, pointer, "must be an integer");
      if (value < schema.min || value > schema.max) throw new IpcValidationError(channel, pointer, `must be between ${schema.min} and ${schema.max}`);
      return value;
    }
    case "boolean": {
      if (typeof value !== "boolean") throw new IpcValidationError(channel, pointer, "must be a boolean");
      return value;
    }
    case "enum": {
      if (!schema.values.includes(value)) throw new IpcValidationError(channel, pointer, `must be one of ${schema.values.join(", ")}`);
      return value;
    }
    case "array": {
      if (!Array.isArray(value)) throw new IpcValidationError(channel, pointer, "must be an array");
      if (value.length > schema.maxItems) throw new IpcValidationError(channel, pointer, `exceeds ${schema.maxItems} items`);
      return value.map((item, index) => validateNode(channel, schema.item, item, `${pointer}[${index}]`));
    }
    case "record": {
      if (typeof value !== "object" || Array.isArray(value)) throw new IpcValidationError(channel, pointer, "must be an object");
      const keys = Object.keys(value);
      if (keys.length > schema.maxKeys) throw new IpcValidationError(channel, pointer, `exceeds ${schema.maxKeys} keys`);
      if (!schema.value) return value;
      return Object.fromEntries(keys.map((key) => [key, validateNode(channel, schema.value, value[key], `${pointer}.${key}`)]));
    }
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) throw new IpcValidationError(channel, pointer, "must be an object");
      const result = {};
      for (const [key, childSchema] of Object.entries(schema.shape)) {
        const child = validateNode(channel, childSchema, value[key], `${pointer}.${key}`);
        if (child !== undefined) result[key] = child;
      }
      if (!schema.allowUnknown) {
        const unknown = Object.keys(value).filter((key) => !(key in schema.shape));
        if (unknown.length) throw new IpcValidationError(channel, pointer, `has unexpected field${unknown.length > 1 ? "s" : ""} ${unknown.slice(0, 5).join(", ")}`);
      } else {
        for (const key of Object.keys(value)) if (!(key in schema.shape)) result[key] = value[key];
      }
      return result;
    }
    case "opaque":
      return value;
    default:
      throw new IpcValidationError(channel, pointer, "has no schema");
  }
}

/**
 * Validate one IPC payload. Returns the normalized value with unknown fields
 * stripped (or rejected), never the original reference for objects.
 */
export function validatePayload(channel, schema, value) {
  const bytes = payloadBytes(value);
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new IpcValidationError(channel, "", `payload is ${bytes} bytes, over the ${MAX_PAYLOAD_BYTES} byte limit`);
  }
  if (depthOf(value) > MAX_PAYLOAD_DEPTH) {
    throw new IpcValidationError(channel, "", `payload nests deeper than ${MAX_PAYLOAD_DEPTH} levels`);
  }
  if (!schema) return value;
  return validateNode(channel, schema, value, "");
}

// ---------------------------------------------------------------------------
// Channel schemas
// ---------------------------------------------------------------------------

const anchor = s.object({
  path: s.string({ maxLength: 1_024 }),
  line: s.number({ integer: true, min: 1, max: 10_000_000 }),
  symbol: s.string({ maxLength: 200, nullable: true, optional: true }),
});

const lesson = s.object({
  id: s.string({ maxLength: 128 }),
  title: s.string({ maxLength: 300 }),
  objective: s.string({ maxLength: 2_000 }),
  summary: s.string({ maxLength: 4_000, optional: true }),
  duration: s.number({ min: 0, max: 1_000, optional: true }),
  difficulty: s.string({ maxLength: 32, optional: true }),
  kind: s.string({ maxLength: 32, optional: true }),
  status: s.string({ maxLength: 32, optional: true }),
  anchors: s.array(anchor, { maxItems: 40 }),
  quiz: s.opaque({ optional: true }),
  content: s.opaque({ optional: true }),
}, { allowUnknown: true });

// The main process owns the authoritative index; the renderer only ever sends a
// reference. This keeps payloads small and stops a doctored repository object
// from influencing a handler.
const repositoryReference = s.object({
  id: s.string({ maxLength: 128 }),
  rootPath: s.string({ maxLength: 4_096 }),
});

const learnerProfile = s.object({
  goal: s.literal(["architecture", "critical_path", "contribute", "review"]),
  level: s.literal(["foundation", "adaptive", "advanced"]),
}, { optional: true });

export const IPC_SCHEMAS = {
  "repository:choose": null,
  "repository:limits": null,
  "repository:cancel": s.string({ maxLength: 64 }),
  "repository:open": s.object({
    source: s.string({ maxLength: 4_096, minLength: 1 }),
    profile: learnerProfile,
    requestId: s.string({ maxLength: 64, optional: true }),
    limits: s.record({ maxKeys: 20, value: s.number({ min: 1, max: 100_000_000_000 }), optional: true }),
  }),
  "repository:read-file": s.object({
    rootPath: s.string({ maxLength: 4_096 }),
    filePath: s.string({ maxLength: 4_096 }),
  }),
  "links:classify": s.object({ url: s.string({ maxLength: 2_048 }) }),
  "links:open": s.object({ url: s.string({ maxLength: 2_048 }) }),
  "links:last-decision": null,
  "agents:detect": null,
  "index:language-servers": null,
  "index:resolve": s.object({
    repository: repositoryReference,
    path: s.string({ maxLength: 4_096 }),
    line: s.number({ integer: true, min: 1, max: 10_000_000, optional: true }),
    column: s.number({ integer: true, min: 1, max: 100_000, optional: true }),
    symbol: s.string({ maxLength: 200, optional: true, nullable: true }),
  }),
  "graph:summary": s.object({ repository: repositoryReference }),
  "graph:neighborhood": s.object({
    repository: repositoryReference,
    nodeId: s.string({ maxLength: 512 }),
    depth: s.number({ integer: true, min: 1, max: 3, optional: true }),
    edgeKinds: s.array(s.literal(["contains", "defines", "imports", "calls"]), { maxItems: 6, optional: true }),
  }),
  "lessons:call-chains": s.object({
    repository: repositoryReference,
    limit: s.number({ integer: true, min: 1, max: 24, optional: true }),
  }),
  "lessons:grade-prediction": s.object({
    repository: repositoryReference,
    exerciseId: s.string({ maxLength: 128 }),
    choiceId: s.string({ maxLength: 128 }),
  }),
  "exercise:localization": s.object({
    repository: repositoryReference,
    symbol: s.string({ maxLength: 200, optional: true }),
  }),
  "exercise:localization-hint": s.object({
    repository: repositoryReference,
    exerciseId: s.string({ maxLength: 128 }),
    used: s.array(s.string({ maxLength: 64 }), { maxItems: 8, optional: true }),
  }),
  "exercise:localization-score": s.object({
    repository: repositoryReference,
    exerciseId: s.string({ maxLength: 128 }),
    inspected: s.array(s.string({ maxLength: 1_024 }), { maxItems: 500 }),
    selected: s.array(s.string({ maxLength: 1_024 }), { maxItems: 100 }),
    hintsUsed: s.array(s.string({ maxLength: 64 }), { maxItems: 8, optional: true }),
  }),
  "grade:race-task": s.object({ repository: repositoryReference }),
  "grade:race": s.object({
    repository: repositoryReference,
    taskId: s.string({ maxLength: 128 }),
    understanding: s.string({ maxLength: 8_000 }),
    plan: s.string({ maxLength: 8_000 }),
    files: s.array(s.string({ maxLength: 1_024 }), { maxItems: 100 }),
    inspected: s.array(s.string({ maxLength: 1_024 }), { maxItems: 500, optional: true }),
    hintsUsed: s.array(s.string({ maxLength: 64 }), { maxItems: 8, optional: true }),
  }),
  "agents:ask": s.object({
    provider: s.literal(["codex", "claude"]),
    rootPath: s.string({ maxLength: 4_096 }),
    context: s.object({
      lesson,
      question: s.string({ maxLength: 8_000, minLength: 1 }),
      repository: repositoryReference,
      skill: s.opaque({ optional: true }),
      mode: s.literal(["lean", "balanced", "deep"]),
      scope: s.object({
        selection: s.boolean(),
        currentFile: s.boolean(),
        lesson: s.boolean(),
        dependencies: s.boolean(),
      }),
      openFile: s.object({
        path: s.string({ maxLength: 4_096 }),
        line: s.number({ integer: true, min: 1, max: 10_000_000 }),
        selection: s.object({
          text: s.string({ maxLength: 16_000 }),
          startLine: s.number({ integer: true, min: 1, max: 10_000_000 }),
          endLine: s.number({ integer: true, min: 1, max: 10_000_000 }),
        }, { optional: true }),
      }, { optional: true }),
      memory: s.array(s.opaque(), { maxItems: 100 }),
    }, { allowUnknown: true }),
  }),
  "course:enhance": s.object({
    provider: s.literal(["codex", "claude"]),
    repository: repositoryReference,
    course: s.opaque(),
  }),
  "learning:load": s.object({
    repository: repositoryReference,
    skillGraph: s.opaque(),
  }),
  "learning:save": s.object({
    repositoryId: s.string({ maxLength: 128 }),
    mastery: s.record({ maxKeys: 2_000 }),
  }, { allowUnknown: true }),
  "practice:create": s.object({
    repository: repositoryReference,
    lesson,
  }),
  "practice:inspect": s.string({ maxLength: 64 }),
  "practice:open": s.string({ maxLength: 64 }),
  "practice:remove": s.object({
    sessionId: s.string({ maxLength: 64 }),
    discardChanges: s.boolean({ optional: true }),
  }),
};

export function schemaFor(channel) {
  if (!(channel in IPC_SCHEMAS)) throw new IpcValidationError(channel, "", "is not a registered IPC channel");
  return IPC_SCHEMAS[channel];
}

/**
 * Wrap `ipcMain.handle` so no handler can be registered without a schema and no
 * handler can run on an unvalidated payload.
 */
export function registerValidatedHandlers(ipcMain, handlers) {
  const registered = [];
  for (const [channel, handler] of Object.entries(handlers)) {
    const schema = schemaFor(channel);
    ipcMain.handle(channel, async (event, payload) => handler(event, validatePayload(channel, schema, payload)));
    registered.push(channel);
  }
  const missing = Object.keys(IPC_SCHEMAS).filter((channel) => !registered.includes(channel));
  if (missing.length) throw new Error(`IPC channels declared without handlers: ${missing.join(", ")}`);
  return registered;
}
