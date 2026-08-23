import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Repository language id -> tree-sitter grammar file shipped by tree-sitter-wasms.
const GRAMMAR_BY_LANGUAGE = {
  c: "c",
  cpp: "cpp",
  cuda: "cpp",
  csharp: "c_sharp",
  go: "go",
  java: "java",
  javascript: "javascript",
  kotlin: "kotlin",
  php: "php",
  python: "python",
  ruby: "ruby",
  rust: "rust",
  shell: "bash",
  swift: "swift",
  typescript: "typescript",
  vue: "vue",
};

// Grammars whose `.tsx`/`.jsx` dialects need a different parser.
const DIALECT_GRAMMARS = {
  ".tsx": "tsx",
  ".jsx": "javascript",
};

const DEFINITION_QUERIES = {
  python: `
    (class_definition name: (identifier) @class)
    (function_definition name: (identifier) @function)
  `,
  javascript: `
    (class_declaration name: (identifier) @class)
    (function_declaration name: (identifier) @function)
    (method_definition name: (property_identifier) @method)
    (variable_declarator name: (identifier) @function value: (arrow_function))
    (variable_declarator name: (identifier) @function value: (function_expression))
  `,
  tsx: `
    (class_declaration name: (type_identifier) @class)
    (interface_declaration name: (type_identifier) @interface)
    (type_alias_declaration name: (type_identifier) @type)
    (enum_declaration name: (identifier) @enum)
    (function_declaration name: (identifier) @function)
    (method_definition name: (property_identifier) @method)
    (variable_declarator name: (identifier) @function value: (arrow_function))
  `,
  typescript: `
    (class_declaration name: (type_identifier) @class)
    (interface_declaration name: (type_identifier) @interface)
    (type_alias_declaration name: (type_identifier) @type)
    (enum_declaration name: (identifier) @enum)
    (function_declaration name: (identifier) @function)
    (method_definition name: (property_identifier) @method)
    (variable_declarator name: (identifier) @function value: (arrow_function))
  `,
  go: `
    (function_declaration name: (identifier) @function)
    (method_declaration name: (field_identifier) @method)
    (type_declaration (type_spec name: (type_identifier) @type))
  `,
  rust: `
    (struct_item name: (type_identifier) @struct)
    (enum_item name: (type_identifier) @enum)
    (trait_item name: (type_identifier) @interface)
    (function_item name: (identifier) @function)
  `,
  c: `
    (function_definition declarator: (function_declarator declarator: (identifier) @function))
    (struct_specifier name: (type_identifier) @struct)
  `,
  cpp: `
    (function_definition declarator: (function_declarator declarator: (identifier) @function))
    (function_definition declarator: (function_declarator declarator: (field_identifier) @method))
    (class_specifier name: (type_identifier) @class)
    (struct_specifier name: (type_identifier) @struct)
  `,
  java: `
    (class_declaration name: (identifier) @class)
    (interface_declaration name: (identifier) @interface)
    (method_declaration name: (identifier) @method)
  `,
  c_sharp: `
    (class_declaration name: (identifier) @class)
    (interface_declaration name: (identifier) @interface)
    (method_declaration name: (identifier) @method)
  `,
  ruby: `
    (class name: (constant) @class)
    (module name: (constant) @module)
    (method name: (identifier) @method)
  `,
  php: `
    (class_declaration name: (name) @class)
    (interface_declaration name: (name) @interface)
    (function_definition name: (name) @function)
    (method_declaration name: (name) @method)
  `,
  kotlin: `
    (class_declaration (type_identifier) @class)
    (function_declaration (simple_identifier) @function)
  `,
  bash: `
    (function_definition name: (word) @function)
  `,
  swift: `
    (class_declaration name: (type_identifier) @class)
    (function_declaration name: (simple_identifier) @function)
  `,
  vue: "",
};

const CALL_QUERIES = {
  python: `
    (call function: (identifier) @callee)
    (call function: (attribute attribute: (identifier) @callee))
  `,
  javascript: `
    (call_expression function: (identifier) @callee)
    (call_expression function: (member_expression property: (property_identifier) @callee))
  `,
  typescript: `
    (call_expression function: (identifier) @callee)
    (call_expression function: (member_expression property: (property_identifier) @callee))
  `,
  tsx: `
    (call_expression function: (identifier) @callee)
    (call_expression function: (member_expression property: (property_identifier) @callee))
  `,
  go: `
    (call_expression function: (identifier) @callee)
    (call_expression function: (selector_expression field: (field_identifier) @callee))
  `,
  rust: `
    (call_expression function: (identifier) @callee)
    (call_expression function: (field_expression field: (field_identifier) @callee))
    (call_expression function: (scoped_identifier name: (identifier) @callee))
  `,
  c: `(call_expression function: (identifier) @callee)`,
  cpp: `
    (call_expression function: (identifier) @callee)
    (call_expression function: (field_expression field: (field_identifier) @callee))
  `,
  java: `
    (method_invocation name: (identifier) @callee)
  `,
  c_sharp: `
    (invocation_expression function: (identifier) @callee)
    (invocation_expression function: (member_access_expression name: (identifier) @callee))
  `,
  ruby: `(call method: (identifier) @callee)`,
  php: `
    (function_call_expression function: (name) @callee)
    (member_call_expression name: (name) @callee)
  `,
  kotlin: `(call_expression (simple_identifier) @callee)`,
  bash: `(command name: (command_name) @callee)`,
  swift: `(call_expression (simple_identifier) @callee)`,
  vue: "",
};

const IMPORT_QUERIES = {
  python: `
    (import_statement) @import
    (import_from_statement) @import
  `,
  javascript: `
    (import_statement source: (string) @module)
    (call_expression function: (identifier) @require (arguments (string) @module))
  `,
  typescript: `
    (import_statement source: (string) @module)
    (call_expression function: (identifier) @require (arguments (string) @module))
  `,
  tsx: `
    (import_statement source: (string) @module)
  `,
  go: `(import_spec path: (interpreted_string_literal) @module)`,
  rust: `(use_declaration) @import`,
  c: `(preproc_include path: (_) @module)`,
  cpp: `(preproc_include path: (_) @module)`,
  java: `(import_declaration) @import`,
  ruby: `(call method: (identifier) @require (argument_list (string) @module))`,
  php: `(namespace_use_declaration) @import`,
  c_sharp: `(using_directive) @import`,
  kotlin: `(import_header) @import`,
  swift: `(import_declaration) @import`,
  bash: `(command name: (command_name) @require) @import`,
  vue: "",
};

// Nodes that introduce a named scope, used to attribute call edges to a caller.
const SCOPE_NODE_TYPES = new Set([
  "function_definition",
  "function_declaration",
  "function_item",
  "function_expression",
  "arrow_function",
  "method_definition",
  "method_declaration",
  "method",
  "class_definition",
  "class_declaration",
  "class_specifier",
  "struct_item",
  "impl_item",
  "constructor_declaration",
]);

const state = {
  initialized: false,
  parserModule: null,
  languages: new Map(),
  queries: new Map(),
  unavailable: new Set(),
  disabled: false,
};

function grammarNameFor(language, filePath = "") {
  const lowered = filePath.toLowerCase();
  for (const [suffix, grammar] of Object.entries(DIALECT_GRAMMARS)) {
    if (lowered.endsWith(suffix) && GRAMMAR_BY_LANGUAGE[language]) return grammar;
  }
  return GRAMMAR_BY_LANGUAGE[language] ?? null;
}

export function treeSitterSupports(language, filePath = "") {
  const grammar = grammarNameFor(language, filePath);
  return Boolean(grammar) && Boolean(DEFINITION_QUERIES[grammar]);
}

async function ensureParser() {
  if (state.disabled) return null;
  if (state.initialized) return state.parserModule;
  try {
    const imported = await import("web-tree-sitter");
    const Parser = imported.default ?? imported;
    await Parser.init();
    state.parserModule = Parser;
    state.initialized = true;
    return Parser;
  } catch {
    state.disabled = true;
    return null;
  }
}

async function loadLanguage(grammar) {
  if (state.languages.has(grammar)) return state.languages.get(grammar);
  if (state.unavailable.has(grammar)) return null;
  const Parser = await ensureParser();
  if (!Parser) return null;
  try {
    const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
    const language = await Parser.Language.load(wasmPath);
    state.languages.set(grammar, language);
    return language;
  } catch {
    state.unavailable.add(grammar);
    return null;
  }
}

function compiledQuery(language, grammar, kind, source) {
  const key = `${grammar}:${kind}`;
  if (state.queries.has(key)) return state.queries.get(key);
  let query = null;
  if (source && source.trim()) {
    try {
      query = language.query(source);
    } catch {
      query = null;
    }
  }
  state.queries.set(key, query);
  return query;
}

function enclosingScope(node) {
  let current = node.parent;
  while (current) {
    if (SCOPE_NODE_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName?.("name");
      // A definition's own name identifier is not its own container.
      if (nameNode?.id === node.id) {
        current = current.parent;
        continue;
      }
      if (nameNode?.text) return nameNode.text;
      if (current.type === "arrow_function" || current.type === "function_expression") {
        const declarator = current.parent;
        const declaratorName = declarator?.childForFieldName?.("name");
        if (declaratorName?.text) return declaratorName.text;
      }
    }
    current = current.parent;
  }
  return null;
}

/**
 * Parse one source file with tree-sitter and return structural definitions,
 * identifier references, and caller -> callee edges.
 *
 * Returns null when no grammar is available so callers can fall back to the
 * deterministic regex indexer.
 */
export async function analyzeSource(filePath, language, source, options = {}) {
  const { maxDefinitions = 200, maxReferences = 400, maxCallEdges = 400 } = options;
  const grammar = grammarNameFor(language, filePath);
  if (!grammar) return null;
  const Parser = await ensureParser();
  if (!Parser) return null;
  const grammarLanguage = await loadLanguage(grammar);
  if (!grammarLanguage) return null;

  let tree;
  const parser = new Parser();
  try {
    parser.setLanguage(grammarLanguage);
    tree = parser.parse(source);
  } catch {
    parser.delete?.();
    return null;
  }
  if (!tree) {
    parser.delete?.();
    return null;
  }

  const definitions = [];
  const references = [];
  const callEdges = [];
  const imports = [];
  try {
    const definitionQuery = compiledQuery(grammarLanguage, grammar, "definitions", DEFINITION_QUERIES[grammar]);
    if (definitionQuery) {
      for (const capture of definitionQuery.captures(tree.rootNode)) {
        if (definitions.length >= maxDefinitions) break;
        const node = capture.node;
        if (!node?.text) continue;
        definitions.push({
          name: node.text,
          kind: capture.name,
          path: filePath,
          line: node.startPosition.row + 1,
          endLine: (node.parent ?? node).endPosition.row + 1,
          container: enclosingScope(node),
        });
      }
    }
    const callQuery = compiledQuery(grammarLanguage, grammar, "calls", CALL_QUERIES[grammar]);
    if (callQuery) {
      for (const capture of callQuery.captures(tree.rootNode)) {
        if (callEdges.length >= maxCallEdges) break;
        const node = capture.node;
        if (!node?.text) continue;
        const callee = node.text.trim();
        if (!callee || callee.length > 120) continue;
        const line = node.startPosition.row + 1;
        callEdges.push({ path: filePath, line, caller: enclosingScope(node), callee });
        if (references.length < maxReferences) {
          references.push({ name: callee, path: filePath, line, kind: "call" });
        }
      }
    }
    const importQuery = compiledQuery(grammarLanguage, grammar, "imports", IMPORT_QUERIES[grammar]);
    if (importQuery) {
      for (const capture of importQuery.captures(tree.rootNode)) {
        if (imports.length >= 200) break;
        const node = capture.node;
        if (!node?.text) continue;
        if (capture.name === "require") continue;
        const specifiers = capture.name === "module"
          ? [stripQuotes(node.text)]
          : moduleSpecifiersFrom(node.text);
        for (const specifier of specifiers) {
          if (!specifier || specifier.length > 200) continue;
          imports.push({ path: filePath, line: node.startPosition.row + 1, specifier, statement: node.text.slice(0, 200) });
        }
      }
    }
  } finally {
    tree.delete?.();
    parser.delete?.();
  }

  const definitionNames = new Set(definitions.map((definition) => definition.name));
  return {
    indexer: "tree-sitter",
    grammar,
    definitions,
    references,
    imports: dedupeImports(imports),
    callEdges: callEdges.filter((edge) => edge.callee),
    resolvedCallEdges: callEdges.filter((edge) => definitionNames.has(edge.callee)).length,
  };
}

function stripQuotes(value) {
  return value.trim().replace(/^[<"'`]/, "").replace(/[>"'`]$/, "").trim();
}

/** Extract module specifiers from a whole import statement when the grammar has no `source` field. */
function moduleSpecifiersFrom(statement) {
  const text = statement.trim();
  const quoted = text.match(/["'<]([^"'>]+)["'>]/);
  if (quoted) return [quoted[1]];
  const fromModule = text.match(/^from\s+([.\w]+)\s+import\b/);
  if (fromModule) return [fromModule[1]];
  const plainImport = text.match(/^(?:import|use|using)\s+([\w.:/*{}\s,]+)/);
  if (plainImport) {
    return plainImport[1]
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+/)[0].trim().replace(/[;{}]/g, ""))
      .filter(Boolean)
      .slice(0, 8);
  }
  return [];
}

function dedupeImports(imports) {
  const seen = new Set();
  return imports.filter((item) => {
    const key = `${item.line}:${item.specifier}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function resetTreeSitterCaches() {
  state.languages.clear();
  state.queries.clear();
  state.unavailable.clear();
}
