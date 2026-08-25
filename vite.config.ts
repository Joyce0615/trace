import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
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
