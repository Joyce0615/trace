import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Versioned repository knowledge graph.
 *
 * Nodes: repository, directory, file, symbol.
 * Edges: contains, defines, imports, calls.
 *
 * The graph is keyed by `repository.versionId`. Rebuilds are incremental: every
 * file partition carries the git blob id it was derived from, so a rebuild reuses
 * partitions whose blob id is unchanged and only recomputes invalidated files.
 * Cross-file edges that point at a removed or changed file are re-resolved rather
 * than silently kept, which keeps call and import targets truthful.
 */

const GRAPH_FORMAT = "kg-v1";

function nodeId(kind, key) {
  return `${kind}:${key}`;
}

function directoryChain(filePath) {
  const parts = filePath.split("/");
  const directories = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    directories.push(parts.slice(0, index + 1).join("/"));
  }
  return directories;
}

function partitionForFile(repository, file) {
  const nodes = [];
  const edges = [];
  const fileNode = nodeId("file", file.path);
  nodes.push({
    id: fileNode,
    kind: "file",
    key: file.path,
    label: file.name,
    language: file.language,
    importance: file.importance ?? 0,
    size: file.size,
  });

  const directories = directoryChain(file.path);
  let parent = nodeId("repository", repository.id);
  for (const directory of directories) {
    const directoryNode = nodeId("directory", directory);
    nodes.push({ id: directoryNode, kind: "directory", key: directory, label: directory.split("/").at(-1) ?? directory });
    edges.push({ from: parent, to: directoryNode, kind: "contains" });
    parent = directoryNode;
  }
  edges.push({ from: parent, to: fileNode, kind: "contains" });

  for (const symbol of repository.symbols.filter((candidate) => candidate.path === file.path)) {
    const symbolNode = nodeId("symbol", `${file.path}#${symbol.name}@${symbol.line}`);
    nodes.push({
      id: symbolNode,
      kind: "symbol",
      key: `${file.path}#${symbol.name}`,
      label: symbol.name,
      symbolKind: symbol.kind,
      path: file.path,
      line: symbol.line,
      container: symbol.container ?? null,
    });
    edges.push({ from: fileNode, to: symbolNode, kind: "defines" });
  }

  for (const item of (repository.imports ?? []).filter((candidate) => candidate.path === file.path)) {
    edges.push({
      from: fileNode,
      to: item.targetPath ? nodeId("file", item.targetPath) : nodeId("external", item.specifier),
      kind: "imports",
      specifier: item.specifier,
      line: item.line,
      resolved: Boolean(item.targetPath),
    });
    if (!item.targetPath) {
      nodes.push({ id: nodeId("external", item.specifier), kind: "external", key: item.specifier, label: item.specifier });
    }
  }

  for (const edge of (repository.callEdges ?? []).filter((candidate) => candidate.path === file.path)) {
    edges.push({
      from: edge.caller ? nodeId("symbol", `${file.path}#${edge.caller}`) : fileNode,
      to: edge.resolved && edge.targetPath
        ? nodeId("symbol", `${edge.targetPath}#${edge.callee}@${edge.targetLine}`)
        : nodeId("unresolved", edge.callee),
      kind: "calls",
      callee: edge.callee,
      line: edge.line,
      resolved: Boolean(edge.resolved),
    });
    if (!edge.resolved) {
      nodes.push({ id: nodeId("unresolved", edge.callee), kind: "unresolved", key: edge.callee, label: edge.callee });
    }
  }

  return {
    path: file.path,
    blobId: file.blobId ?? `size-${file.size}`,
    nodes,
    edges,
    digest: createHash("sha256").update(JSON.stringify({ nodes, edges })).digest("hex").slice(0, 16),
  };
}

/**
 * Build (or incrementally rebuild) the knowledge graph for a repository index.
 * Pass `previous` to reuse unchanged file partitions.
 */
export function buildKnowledgeGraph(repository, options = {}) {
  const previous = options.previous?.format === GRAPH_FORMAT ? options.previous : null;
  const previousPartitions = new Map((previous?.partitions ?? []).map((partition) => [partition.path, partition]));
  const currentPaths = new Set(repository.files.map((file) => file.path));

  // Cross-file targets that changed invalidate the files that point at them, so
  // resolved call and import edges never outlive their target.
  const changedTargets = new Set();
  for (const file of repository.files) {
    const before = previousPartitions.get(file.path);
    if (!before || before.blobId !== (file.blobId ?? `size-${file.size}`)) changedTargets.add(file.path);
  }
  for (const removed of previousPartitions.keys()) {
    if (!currentPaths.has(removed)) changedTargets.add(removed);
  }

  const partitions = [];
  let reused = 0;
  let rebuilt = 0;
  let invalidatedByDependency = 0;
  for (const file of repository.files) {
    const before = previousPartitions.get(file.path);
    const blobId = file.blobId ?? `size-${file.size}`;
    const dependsOnChanged = Boolean(before) && before.dependencies?.some((dependency) => changedTargets.has(dependency));
    if (before && before.blobId === blobId && !dependsOnChanged) {
      partitions.push(before);
      reused += 1;
      continue;
    }
    if (before && before.blobId === blobId && dependsOnChanged) invalidatedByDependency += 1;
    const partition = partitionForFile(repository, file);
    partition.dependencies = [
      ...new Set(
        partition.edges
          .filter((edge) => edge.kind === "imports" || edge.kind === "calls")
          .map((edge) => (edge.to.startsWith("file:") ? edge.to.slice(5) : edge.to.startsWith("symbol:") ? edge.to.slice(7).split("#")[0] : null))
          .filter(Boolean),
      ),
    ];
    partitions.push(partition);
    rebuilt += 1;
  }

  const nodes = new Map();
  nodes.set(nodeId("repository", repository.id), {
    id: nodeId("repository", repository.id),
    kind: "repository",
    key: repository.id,
    label: repository.name,
  });
  const edges = [];
  for (const partition of partitions) {
    for (const node of partition.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
    edges.push(...partition.edges);
  }

  const nodeList = [...nodes.values()];
  const danglingEdges = edges.filter((edge) => !nodes.has(edge.to)).length;
  return {
    format: GRAPH_FORMAT,
    repositoryId: repository.id,
    version: repository.versionId,
    previousVersion: previous?.version ?? null,
    generatedAt: new Date().toISOString(),
    partitions,
    nodes: nodeList,
    edges,
    stats: {
      nodeCount: nodeList.length,
      edgeCount: edges.length,
      fileCount: partitions.length,
      reusedPartitions: reused,
      rebuiltPartitions: rebuilt,
      invalidatedByDependency,
      removedPartitions: [...previousPartitions.keys()].filter((candidate) => !currentPaths.has(candidate)).length,
      danglingEdges,
      resolvedCallEdges: edges.filter((edge) => edge.kind === "calls" && edge.resolved).length,
      resolvedImportEdges: edges.filter((edge) => edge.kind === "imports" && edge.resolved).length,
      byKind: nodeList.reduce((counts, node) => ({ ...counts, [node.kind]: (counts[node.kind] ?? 0) + 1 }), {}),
    },
  };
}

/** Nodes reachable from a starting node within `depth` hops, used by lessons and search. */
export function neighborhood(graph, startId, depth = 1, edgeKinds = null) {
  const adjacency = new Map();
  for (const edge of graph.edges) {
    if (edgeKinds && !edgeKinds.includes(edge.kind)) continue;
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.to).push(edge);
  }
  const seen = new Set([startId]);
  let frontier = [startId];
  const collected = [];
  for (let hop = 0; hop < Math.max(0, depth); hop += 1) {
    const next = [];
    for (const id of frontier) {
      for (const edge of adjacency.get(id) ?? []) {
        collected.push(edge);
        for (const candidate of [edge.from, edge.to]) {
          if (!seen.has(candidate)) { seen.add(candidate); next.push(candidate); }
        }
      }
    }
    frontier = next;
  }
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return {
    nodes: [...seen].map((id) => byId.get(id)).filter(Boolean),
    edges: [...new Map(collected.map((edge) => [`${edge.from}->${edge.to}:${edge.kind}:${edge.line ?? ""}`, edge])).values()],
  };
}

function graphPath(directory, repositoryId) {
  return path.join(directory, `${createHash("sha256").update(repositoryId).digest("hex").slice(0, 24)}.json`);
}

export async function saveKnowledgeGraph(directory, graph) {
  await mkdir(directory, { recursive: true });
  const destination = graphPath(directory, graph.repositoryId);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(graph));
  await rename(temporary, destination);
  return destination;
}

export async function loadKnowledgeGraph(directory, repositoryId) {
  try {
    const graph = JSON.parse(await readFile(graphPath(directory, repositoryId), "utf8"));
    return graph?.format === GRAPH_FORMAT && graph.repositoryId === repositoryId ? graph : null;
  } catch {
    return null;
  }
}

export async function pruneKnowledgeGraphs(directory, keepRepositoryIds) {
  try {
    const keep = new Set([...keepRepositoryIds].map((id) => path.basename(graphPath(directory, id))));
    const entries = await readdir(directory);
    await Promise.all(entries.filter((entry) => !keep.has(entry)).map((entry) => rm(path.join(directory, entry), { force: true })));
    return entries.length - keep.size;
  } catch {
    return 0;
  }
}
