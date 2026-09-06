import { loader } from "@monaco-editor/react";

/**
 * Monaco is loaded lazily.
 *
 * The editor core (~2.6 MB) is only fetched when the learner actually opens the
 * Code view, and each language grammar is fetched separately for the file being
 * read. Nothing here is imported eagerly by the application entry, so the initial
 * download stays at the application bundle.
 */

type MonacoModule = typeof import("monaco-editor/editor/editor.api");

const languageLoaders: Record<string, () => Promise<unknown>> = {
  cpp: () => import("monaco-editor/languages/definitions/cpp/register"),
  csharp: () => import("monaco-editor/languages/definitions/csharp/register"),
  dockerfile: () => import("monaco-editor/languages/definitions/dockerfile/register"),
  go: () => import("monaco-editor/languages/definitions/go/register"),
  html: () => import("monaco-editor/languages/definitions/html/register"),
  java: () => import("monaco-editor/languages/definitions/java/register"),
  javascript: () => import("monaco-editor/languages/definitions/javascript/register"),
  kotlin: () => import("monaco-editor/languages/definitions/kotlin/register"),
  markdown: () => import("monaco-editor/languages/definitions/markdown/register"),
  php: () => import("monaco-editor/languages/definitions/php/register"),
  python: () => import("monaco-editor/languages/definitions/python/register"),
  restructuredtext: () => import("monaco-editor/languages/definitions/restructuredtext/register"),
  ruby: () => import("monaco-editor/languages/definitions/ruby/register"),
  rust: () => import("monaco-editor/languages/definitions/rust/register"),
  shell: () => import("monaco-editor/languages/definitions/shell/register"),
  sql: () => import("monaco-editor/languages/definitions/sql/register"),
  swift: () => import("monaco-editor/languages/definitions/swift/register"),
  typescript: () => import("monaco-editor/languages/definitions/typescript/register"),
  xml: () => import("monaco-editor/languages/definitions/xml/register"),
  yaml: () => import("monaco-editor/languages/definitions/yaml/register"),
};

export const lazyLanguages = Object.keys(languageLoaders);

const requestedLanguages = new Map<string, Promise<unknown>>();
let corePromise: Promise<MonacoModule> | null = null;

function registerJsonHighlighting(monaco: MonacoModule) {
  monaco.languages.register({ id: "json" });
  monaco.languages.setMonarchTokensProvider("json", {
    tokenizer: {
      root: [
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "key"],
        [/"(?:[^"\\]|\\.)*"/, "string"],
        [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
        [/\b(?:true|false|null)\b/, "keyword"],
        [/[{}[\],:]/, "delimiter"],
      ],
    },
  });
}

/** Load the Monaco core and its editor worker. Safe to call repeatedly. */
export function ensureMonaco(): Promise<MonacoModule> {
  if (!corePromise) {
    corePromise = (async () => {
      const [monaco, workerModule] = await Promise.all([
        import("monaco-editor/editor/editor.api"),
        import("monaco-editor/editor/editor.worker?worker"),
      ]);
      const EditorWorker = workerModule.default;
      self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
      registerJsonHighlighting(monaco);
      loader.config({ monaco });
      return monaco;
    })();
  }
  return corePromise;
}

/**
 * Load one language grammar on demand. Unknown languages resolve without a
 * fetch. A grammar that fails to load must never block the editor: the file is
 * still readable without highlighting, and the failure is not cached, so the
 * next attempt can succeed.
 */
export function ensureLanguage(languageId: string | undefined): Promise<unknown> {
  if (!languageId) return Promise.resolve(null);
  const load = languageLoaders[languageId];
  if (!load) return Promise.resolve(null);
  if (!requestedLanguages.has(languageId)) {
    requestedLanguages.set(languageId, load().catch(() => {
      requestedLanguages.delete(languageId);
      return null;
    }));
  }
  return requestedLanguages.get(languageId)!;
}

export function loadedLanguages() {
  return [...requestedLanguages.keys()];
}

export function monacoLoadState() {
  return { coreRequested: corePromise !== null, languages: loadedLanguages() };
}
