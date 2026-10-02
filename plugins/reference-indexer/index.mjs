/**
 * A reference indexer plugin (item 58).
 *
 * It indexes Zig, which this build has neither a tree-sitter grammar nor a
 * regex pattern for, so a Zig file arrives at the plugin with `indexer: "none"`
 * and nothing to show for it. That is the shape every useful indexer plugin
 * has: the host handles what it can, and the extension covers a language the
 * host does not know about.
 *
 * Note what is *not* here. No `import` of anything from the host application,
 * no `fs`, no `process`. The only way to see a file is `host.readFile`, which
 * the host resolves through the same validation `repository:read-file` uses and
 * which fails for any path that is not part of the index. That is the contract:
 * a plugin receives a question and a narrow way to look things up, not a
 * foothold in the process that asked.
 */

const DEFINITION = /^\s*(?:pub\s+)?(?:fn\s+([A-Za-z_][A-Za-z0-9_]*)|const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:struct|enum|union|opaque)\b)/;

export default async function indexer(input, host) {
  const definitions = [];
  const skipped = [];
  for (const file of input.files ?? []) {
    let source;
    try {
      source = await host.readFile(file.path);
    } catch {
      skipped.push(file.path);
      continue;
    }
    let container = null;
    source.split("\n").forEach((line, index) => {
      const match = DEFINITION.exec(line);
      if (!match) return;
      const name = match[1] ?? match[2];
      if (!name) return;
      definitions.push({
        name,
        path: file.path,
        line: index + 1,
        kind: match[1] ? "function" : "type",
        container: match[1] ? container : null,
      });
      if (match[2]) container = name;
    });
  }
  await host.log?.(`indexed ${definitions.length} definition(s) across ${input.files?.length ?? 0} file(s)`);
  return { definitions, skipped };
}
