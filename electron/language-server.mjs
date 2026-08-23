import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/**
 * Optional Language Server Protocol client.
 *
 * Language servers are never required. When a server for the active language is
 * not installed, `resolveSymbol` reports `available: false` and callers fall back
 * to the deterministic tree-sitter index. Servers are spawned lazily per
 * (repository root, server) pair, reused across requests, and always shut down
 * through `shutdown` + `exit` so no long-lived process leaks.
 */

export const LANGUAGE_SERVERS = [
  {
    id: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    languages: ["typescript", "javascript"],
    languageIds: { typescript: "typescript", javascript: "javascript" },
  },
  {
    id: "pyright",
    command: "pyright-langserver",
    args: ["--stdio"],
    languages: ["python"],
    languageIds: { python: "python" },
  },
  {
    id: "pylsp",
    command: "pylsp",
    args: [],
    languages: ["python"],
    languageIds: { python: "python" },
  },
  {
    id: "gopls",
    command: "gopls",
    args: ["serve"],
    languages: ["go"],
    languageIds: { go: "go" },
  },
  {
    id: "rust-analyzer",
    command: "rust-analyzer",
    args: [],
    languages: ["rust"],
    languageIds: { rust: "rust" },
  },
  {
    id: "clangd",
    command: "clangd",
    args: ["--background-index=false", "--log=error"],
    languages: ["c", "cpp", "cuda"],
    languageIds: { c: "c", cpp: "cpp", cuda: "cuda" },
  },
];

const detectionCache = new Map();
const pool = new Map();

function which(command) {
  return new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "where" : "which", [command], { stdio: ["ignore", "pipe", "ignore"] });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? Buffer.concat(output).toString("utf8").trim().split("\n")[0] : null));
  });
}

export async function detectLanguageServers({ refresh = false } = {}) {
  const detected = {};
  for (const server of LANGUAGE_SERVERS) {
    if (!refresh && detectionCache.has(server.id)) {
      detected[server.id] = detectionCache.get(server.id);
      continue;
    }
    const binary = await which(server.command);
    const record = { id: server.id, command: server.command, available: Boolean(binary), binary, languages: server.languages };
    detectionCache.set(server.id, record);
    detected[server.id] = record;
  }
  return detected;
}

export function serverForLanguage(language, detected) {
  return LANGUAGE_SERVERS.find((server) => server.languages.includes(language) && detected[server.id]?.available) ?? null;
}

class LanguageServerConnection {
  constructor(server, rootPath) {
    this.server = server;
    this.rootPath = rootPath;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.openDocuments = new Set();
    this.closed = false;
    this.child = spawn(server.command, server.args, {
      cwd: rootPath,
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.child.on("close", () => this.#failAll(new Error(`${server.command} exited.`)));
    this.child.on("error", (error) => this.#failAll(error));
  }

  #failAll(error) {
    this.closed = true;
    for (const [, entry] of this.pending) entry.reject(error);
    this.pending.clear();
  }

  #consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1] ?? 0);
      if (!length || this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      const entry = message.id !== undefined ? this.pending.get(message.id) : null;
      if (!entry) continue;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message ?? "Language server error."));
      else entry.resolve(message.result ?? null);
    }
  }

  #write(payload) {
    if (this.closed || !this.child.stdin.writable) throw new Error("Language server connection is closed.");
    const body = JSON.stringify(payload);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  request(method, params, timeoutMs = 20_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.server.command} did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async initialize(timeoutMs) {
    const capabilities = await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.rootPath).href,
      workspaceFolders: [{ uri: pathToFileURL(this.rootPath).href, name: path.basename(this.rootPath) }],
      capabilities: {
        textDocument: {
          definition: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          implementation: { linkSupport: true },
          hover: { contentFormat: ["plaintext", "markdown"] },
          signatureHelp: { signatureInformation: { documentationFormat: ["plaintext"] } },
          synchronization: { didSave: false },
        },
        workspace: { workspaceFolders: true },
      },
    }, timeoutMs);
    this.notify("initialized", {});
    this.capabilities = capabilities?.capabilities ?? {};
    return this.capabilities;
  }

  async openDocument(relativePath, languageId, text) {
    const uri = pathToFileURL(path.join(this.rootPath, relativePath)).href;
    if (this.openDocuments.has(uri)) return uri;
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
    this.openDocuments.add(uri);
    return uri;
  }

  async dispose() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.request("shutdown", null, 3_000);
      this.notify("exit", null);
    } catch {
      // The server is already gone; fall through to the kill below.
    }
    setTimeout(() => this.child.kill("SIGTERM"), 250).unref?.();
  }
}

function locationsFrom(result) {
  if (!result) return [];
  const items = Array.isArray(result) ? result : [result];
  return items
    .map((item) => {
      const uri = item.uri ?? item.targetUri;
      const range = item.range ?? item.targetSelectionRange ?? item.targetRange;
      if (!uri || !range) return null;
      let filePath;
      try {
        filePath = fileURLToPath(uri);
      } catch {
        return null;
      }
      return { filePath, line: (range.start?.line ?? 0) + 1, column: (range.start?.character ?? 0) + 1 };
    })
    .filter(Boolean);
}

function hoverText(result) {
  const contents = result?.contents;
  if (!contents) return null;
  if (typeof contents === "string") return contents.slice(0, 800);
  if (Array.isArray(contents)) {
    return contents.map((item) => (typeof item === "string" ? item : item?.value ?? "")).join("\n").slice(0, 800) || null;
  }
  return (contents.value ?? "").slice(0, 800) || null;
}

function relativize(rootPath, filePath) {
  // Language servers canonicalize URIs (for example `/tmp` -> `/private/tmp` on macOS),
  // so compare against the resolved root as well as the requested one.
  for (const base of new Set([rootPath, `/private${rootPath}`, rootPath.replace(/^\/private/, "")])) {
    const relative = path.relative(base, filePath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative.split(path.sep).join("/");
  }
  return null;
}

async function connectionFor(server, rootPath, timeoutMs) {
  const key = `${server.id}:${rootPath}`;
  const existing = pool.get(key);
  if (existing && !existing.closed) return existing;
  const connection = new LanguageServerConnection(server, rootPath);
  await connection.initialize(timeoutMs);
  pool.set(key, connection);
  return connection;
}

/**
 * Resolve a source position through a language server.
 *
 * Returns `{ available: false, reason }` whenever no server is installed for the
 * language or the server fails, so the caller can degrade to the static index.
 */
export async function resolveSymbol(rootPath, request, options = {}) {
  const { timeoutMs = 20_000, detected } = options;
  const servers = detected ?? (await detectLanguageServers());
  const server = serverForLanguage(request.language, servers);
  if (!server) {
    return { available: false, reason: `No language server is installed for ${request.language}.`, server: null };
  }
  let connection;
  try {
    const root = await realpath(rootPath).catch(() => rootPath);
    connection = await connectionFor(server, root, timeoutMs);
    const text = request.text ?? (await readFile(path.join(root, request.path), "utf8"));
    const uri = await connection.openDocument(request.path, server.languageIds[request.language] ?? request.language, text);
    const position = { line: Math.max(0, (request.line ?? 1) - 1), character: Math.max(0, (request.column ?? 1) - 1) };
    const params = { textDocument: { uri }, position };
    const ask = (method) => connection.request(method, params, timeoutMs).catch(() => null);
    let [definition, typeDefinition, implementation, hover] = await Promise.all([
      ask("textDocument/definition"),
      ask("textDocument/typeDefinition"),
      ask("textDocument/implementation"),
      ask("textDocument/hover"),
    ]);
    // Servers such as clangd build the AST asynchronously after didOpen, so an empty
    // first answer is retried once before falling back to the static index.
    if (!locationsFrom(definition).length) {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      definition = await ask("textDocument/definition");
      if (!hover) hover = await ask("textDocument/hover");
    }
    const toAnchors = (result) => locationsFrom(result)
      .map((location) => ({ ...location, path: relativize(root, location.filePath) }))
      .filter((location) => location.path);
    const definitions = toAnchors(definition);
    const implementations = toAnchors(implementation);
    return {
      available: true,
      server: server.id,
      definitions,
      // Multiple definition results for one position are overloads or partial declarations.
      overloads: definitions.length > 1 ? definitions : [],
      typeDefinitions: toAnchors(typeDefinition),
      // Multiple implementations for one position mean the call site is dynamically dispatched.
      implementations,
      dynamicDispatch: implementations.length > 1,
      type: hoverText(hover),
    };
  } catch (cause) {
    return { available: false, reason: cause instanceof Error ? cause.message : String(cause), server: server.id };
  }
}

/**
 * Static import resolution used when no language server is available.
 * Maps tree-sitter import specifiers onto repository-relative file paths.
 */
export function resolveImportsStatically(repository, imports) {
  const paths = new Set(repository.files.map((file) => file.path));
  const byStem = new Map();
  for (const file of repository.files) {
    const stem = file.path.replace(/\.[^./]+$/, "");
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(file.path);
  }
  const candidatesFor = (specifier, directory) => {
    const cleaned = specifier.trim();
    if (!cleaned) return [];
    if (cleaned.startsWith(".") && /[\\/]/.test(cleaned)) {
      return [path.posix.normalize(path.posix.join(directory, cleaned))].flatMap((joined) => [joined, `${joined}/index`, `${joined}/__init__`]);
    }
    if (cleaned.startsWith(".")) {
      // Python relative package import: `.engine` / `..models`.
      const levels = cleaned.match(/^\.+/)[0].length;
      const base = directory.split("/").slice(0, Math.max(0, directory.split("/").length - (levels - 1))).join("/");
      const tail = cleaned.slice(levels).replace(/\./g, "/");
      const joined = path.posix.normalize(`${base}/${tail}`.replace(/\/+$/, ""));
      return [joined, `${joined}/index`, `${joined}/__init__`];
    }
    const dotted = cleaned.replace(/\./g, "/");
    return [dotted, `${dotted}/index`, `${dotted}/__init__`, `${directory}/${dotted}`, `${directory}/${dotted}/__init__`];
  };
  return imports.map((item) => {
    const directory = item.path?.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "";
    let target = null;
    for (const candidate of candidatesFor(item.specifier, directory)) {
      const normalized = candidate.replace(/^\.\//, "");
      if (paths.has(normalized)) { target = normalized; break; }
      const stemMatch = byStem.get(normalized);
      if (stemMatch?.length) { target = stemMatch[0]; break; }
    }
    return { ...item, targetPath: target, resolved: Boolean(target), resolvedBy: target ? "static-index" : null };
  });
}

export async function shutdownLanguageServers() {
  const connections = [...pool.values()];
  pool.clear();
  await Promise.all(connections.map((connection) => connection.dispose().catch(() => undefined)));
}
