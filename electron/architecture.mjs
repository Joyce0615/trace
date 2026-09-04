import { symbolBodyRange } from "./call-chain.mjs";

/**
 * Architecture views: module boundaries, layers, callers/callees, and data flow.
 *
 * The knowledge graph knows individual files; a learner needs the shape above
 * them. This module aggregates resolved imports into module nodes, condenses
 * cycles with Tarjan's algorithm, and assigns each module an architectural layer
 * by longest path through the resulting DAG, so "what depends on what" becomes a
 * picture instead of an edge list.
 *
 * Import cycles are reported rather than hidden: they are the one structure that
 * makes layering impossible, and they are exactly what a learner should see.
 */

export const ARCHITECTURE_VERSION = 1;

/** Module key for a file: the first `depth` path segments of its directory. */
export function moduleFor(filePath, depth = 2) {
  const parts = filePath.split("/");
  if (parts.length === 1) return "<root>";
  return parts.slice(0, Math.min(depth, parts.length - 1)).join("/");
}

function tarjanComponents(nodes, outgoing) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;

  // Iterative Tarjan: repositories can nest deeply enough to blow a recursive stack.
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work = [{ node: root, edge: 0 }];
    while (work.length) {
      const frame = work.at(-1);
      const { node } = frame;
      if (frame.edge === 0) {
        index.set(node, counter);
        low.set(node, counter);
        counter += 1;
        stack.push(node);
        onStack.add(node);
      }
      const neighbours = outgoing.get(node) ?? [];
      if (frame.edge < neighbours.length) {
        const next = neighbours[frame.edge];
        frame.edge += 1;
        if (!index.has(next)) work.push({ node: next, edge: 0 });
        else if (onStack.has(next)) low.set(node, Math.min(low.get(node), index.get(next)));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work.at(-1).node;
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
      if (low.get(node) === index.get(node)) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          component.push(member);
        } while (member !== node);
        components.push(component);
      }
    }
  }
  return components;
}

/**
 * Aggregate resolved file imports into a module graph with fan-in/fan-out,
 * cycles, and architectural layers.
 */
export function buildArchitecture(repository, options = {}) {
  const depth = options.moduleDepth ?? 2;
  const files = repository.files ?? [];
  const modules = new Map();
  for (const file of files) {
    const key = moduleFor(file.path, depth);
    const entry = modules.get(key) ?? { id: key, files: 0, bytes: 0, languages: {}, symbols: 0, importance: 0 };
    entry.files += 1;
    entry.bytes += file.size ?? 0;
    entry.languages[file.language] = (entry.languages[file.language] ?? 0) + 1;
    entry.importance = Math.max(entry.importance, file.importance ?? 0);
    modules.set(key, entry);
  }
  for (const symbol of repository.symbols ?? []) {
    const entry = modules.get(moduleFor(symbol.path, depth));
    if (entry) entry.symbols += 1;
  }

  const edgeWeights = new Map();
  const externalDependencies = new Map();
  for (const item of repository.imports ?? []) {
    const from = moduleFor(item.path, depth);
    if (!item.targetPath) {
      const external = externalDependencies.get(from) ?? new Set();
      external.add(item.specifier.split(/[./]/)[0]);
      externalDependencies.set(from, external);
      continue;
    }
    const to = moduleFor(item.targetPath, depth);
    if (from === to || !modules.has(from) || !modules.has(to)) continue;
    const key = `${from}->${to}`;
    const edge = edgeWeights.get(key) ?? { from, to, weight: 0, examples: [] };
    edge.weight += 1;
    if (edge.examples.length < 3) edge.examples.push({ path: item.path, line: item.line, specifier: item.specifier, targetPath: item.targetPath });
    edgeWeights.set(key, edge);
  }

  const edges = [...edgeWeights.values()];
  const outgoing = new Map([...modules.keys()].map((key) => [key, []]));
  for (const edge of edges) outgoing.get(edge.from).push(edge.to);

  const components = tarjanComponents([...modules.keys()], outgoing);
  const componentOf = new Map();
  components.forEach((component, position) => component.forEach((member) => componentOf.set(member, position)));
  const cycles = components
    .map((component, position) => ({ id: `cycle-${position}`, modules: [...component].sort(), size: component.length }))
    .filter((component) => component.size > 1);

  // Layer = longest path from a module nothing imports, over the acyclic
  // condensation, so a cycle cannot inflate or break the layering.
  const condensationOut = new Map(components.map((_, position) => [position, new Set()]));
  const condensationIn = new Map(components.map((_, position) => [position, new Set()]));
  for (const edge of edges) {
    const from = componentOf.get(edge.from);
    const to = componentOf.get(edge.to);
    if (from === to) continue;
    condensationOut.get(from).add(to);
    condensationIn.get(to).add(from);
  }
  const layerOf = new Map();
  const queue = [...condensationIn.entries()].filter(([, incoming]) => incoming.size === 0).map(([position]) => position);
  for (const position of queue) layerOf.set(position, 0);
  const remainingIncoming = new Map([...condensationIn.entries()].map(([position, incoming]) => [position, incoming.size]));
  while (queue.length) {
    const position = queue.shift();
    for (const next of condensationOut.get(position)) {
      layerOf.set(next, Math.max(layerOf.get(next) ?? 0, (layerOf.get(position) ?? 0) + 1));
      remainingIncoming.set(next, remainingIncoming.get(next) - 1);
      if (remainingIncoming.get(next) === 0) queue.push(next);
    }
  }

  const moduleList = [...modules.values()].map((entry) => {
    const component = componentOf.get(entry.id);
    return {
      ...entry,
      fanOut: edges.filter((edge) => edge.from === entry.id).length,
      fanIn: edges.filter((edge) => edge.to === entry.id).length,
      external: [...(externalDependencies.get(entry.id) ?? [])].slice(0, 8),
      layer: layerOf.get(component) ?? 0,
      cycleId: components[component].length > 1 ? `cycle-${component}` : null,
    };
  }).sort((left, right) => left.layer - right.layer || right.importance - left.importance || left.id.localeCompare(right.id));

  const layerOfModule = new Map(moduleList.map((entry) => [entry.id, entry.layer]));
  const violations = edges
    .map((edge) => {
      const from = layerOfModule.get(edge.from);
      const to = layerOfModule.get(edge.to);
      if (componentOf.get(edge.from) === componentOf.get(edge.to)) {
        return { ...edge, kind: "cycle", detail: `${edge.from} and ${edge.to} import each other, directly or transitively.` };
      }
      if (to < from) return { ...edge, kind: "upward", detail: `${edge.from} (layer ${from}) imports ${edge.to} (layer ${to}), against the dependency direction.` };
      if (to - from > 1) return { ...edge, kind: "skip", detail: `${edge.from} reaches past layer ${from + 1} straight into ${edge.to} (layer ${to}).` };
      return null;
    })
    .filter(Boolean)
    .sort((left, right) => right.weight - left.weight);

  const layers = [];
  for (const entry of moduleList) {
    layers[entry.layer] = layers[entry.layer] ?? { layer: entry.layer, modules: [] };
    layers[entry.layer].modules.push(entry.id);
  }

  return {
    version: ARCHITECTURE_VERSION,
    moduleDepth: depth,
    modules: moduleList,
    edges: edges.sort((left, right) => right.weight - left.weight),
    layers: layers.filter(Boolean),
    cycles,
    violations,
    stats: {
      moduleCount: moduleList.length,
      edgeCount: edges.length,
      layerCount: layers.filter(Boolean).length,
      cycleCount: cycles.length,
      violationCount: violations.length,
      acyclic: cycles.length === 0,
    },
  };
}

/** Direct callers and callees of one symbol, taken from resolved call edges. */
export function symbolNeighborhood(repository, target, options = {}) {
  const limit = options.limit ?? 12;
  const edges = (repository.callEdges ?? []).filter((edge) => edge.resolved && edge.targetPath);
  const callers = edges
    .filter((edge) => edge.targetPath === target.path && edge.callee === target.symbol && edge.caller)
    .map((edge) => ({ path: edge.path, symbol: edge.caller, line: edge.line, crossFile: edge.path !== target.path }));
  const callees = edges
    .filter((edge) => edge.path === target.path && edge.caller === target.symbol)
    .map((edge) => ({ path: edge.targetPath, symbol: edge.callee, line: edge.targetLine, callLine: edge.line, crossFile: edge.targetPath !== target.path }));
  const unique = (items, key) => [...new Map(items.map((item) => [key(item), item])).values()];
  return {
    target,
    callers: unique(callers, (item) => `${item.path}#${item.symbol}@${item.line}`).slice(0, limit),
    callees: unique(callees, (item) => `${item.path}#${item.symbol}`).slice(0, limit),
    fanIn: unique(callers, (item) => `${item.path}#${item.symbol}`).length,
    fanOut: unique(callees, (item) => `${item.path}#${item.symbol}`).length,
  };
}

const IDENTIFIER = /[A-Za-z_]\w*/g;

/**
 * Lexical intra-procedural data flow: which parameters reach which assignments,
 * and which of them reach the return. It is deliberately conservative — it
 * reports the flow it can prove from assignments and call arguments, and marks
 * parameters it cannot connect as `unused` rather than guessing.
 */
export function dataFlow(source, definition, language = "python") {
  const { start, end } = symbolBodyRange(source, definition.line, language);
  const lines = source.split(/\r?\n/);
  const header = lines[start - 1] ?? "";
  const open = header.indexOf("(");
  const parameters = open < 0
    ? []
    : header.slice(open + 1, header.indexOf(")", open) < 0 ? undefined : header.indexOf(")", open))
      .split(",")
      .map((part) => part.trim().split(/[:=\s]/)[0].replace(/[*&]/g, ""))
      .filter((name) => /^[A-Za-z_]\w*$/.test(name) && !["self", "cls"].includes(name));

  const tainted = new Map(parameters.map((name) => [name, [name]]));
  const steps = [];
  const returns = [];
  for (let cursor = start; cursor < end; cursor += 1) {
    const line = lines[cursor] ?? "";
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const returnMatch = text.match(/^return\s+(.+?)\s*;?$/);
    const assignMatch = text.match(/^([A-Za-z_]\w*)\s*=\s*(.+?)\s*;?$/);
    const expression = returnMatch?.[1] ?? assignMatch?.[2] ?? null;
    if (!expression) continue;
    const identifiers = [...new Set(expression.match(IDENTIFIER) ?? [])];
    const sources = identifiers.filter((name) => tainted.has(name));
    const origins = [...new Set(sources.flatMap((name) => tainted.get(name)))];
    if (returnMatch) {
      returns.push({ line: cursor + 1, expression, dependsOn: sources, parameters: origins });
      continue;
    }
    if (sources.length) tainted.set(assignMatch[1], origins);
    steps.push({
      line: cursor + 1,
      target: assignMatch[1],
      expression,
      dependsOn: sources,
      parameters: origins,
      calls: identifiers.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(expression)),
    });
  }

  const reaching = new Set(returns.flatMap((item) => item.parameters));
  return {
    path: definition.path,
    symbol: definition.symbol ?? definition.name,
    line: definition.line,
    parameters: parameters.map((name) => ({ name, reachesReturn: reaching.has(name) })),
    steps,
    returns,
    unusedParameters: parameters.filter((name) => !reaching.has(name) && !steps.some((step) => step.parameters.includes(name))),
  };
}

/** A module graph rendered as a source-anchored lesson diagram block. */
export function architectureDiagramBlock(architecture, blockId = "architecture-map") {
  const top = architecture.modules.slice(0, 6);
  return {
    id: blockId,
    type: "diagram",
    title: "Module boundaries and layers",
    caption: `${architecture.stats.moduleCount} modules across ${architecture.stats.layerCount} layers; ${architecture.stats.cycleCount} import cycle${architecture.stats.cycleCount === 1 ? "" : "s"}.`,
    nodes: top.map((entry) => ({
      id: entry.id,
      label: entry.id,
      detail: `layer ${entry.layer} · ${entry.files} files · in ${entry.fanIn} / out ${entry.fanOut}`,
    })),
    edges: architecture.edges
      .filter((edge) => top.some((entry) => entry.id === edge.from) && top.some((entry) => entry.id === edge.to))
      .slice(0, 10)
      .map((edge) => ({ from: edge.from, to: edge.to, label: `${edge.weight} imports` })),
  };
}
