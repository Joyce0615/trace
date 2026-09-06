import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Every grammar `src/monaco.ts` can lazily import. Pre-bundling them keeps the
// dev server from re-optimizing mid-session, which otherwise answers a grammar
// request with a 504 and leaves the editor without highlighting.
const lazyGrammars = [
  "cpp", "csharp", "dockerfile", "go", "html", "java", "javascript", "kotlin", "markdown", "php",
  "python", "restructuredtext", "ruby", "rust", "shell", "sql", "swift", "typescript", "xml", "yaml",
].map((language) => `monaco-editor/languages/definitions/${language}/register`);

export default defineConfig({
  plugins: [react()],
  base: "./",
  optimizeDeps: {
    include: ["monaco-editor/editor/editor.api", ...lazyGrammars],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Monaco is deliberately excluded from the entry graph and fetched only when the
    // Code view opens, so its size does not affect startup. `tests/core.test.mjs`
    // enforces the real budget: the entry chunk must stay under 320 kB and must not
    // reference the editor core.
    chunkSizeWarningLimit: 3_000,
  },
});
