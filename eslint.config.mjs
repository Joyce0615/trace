import js from "@eslint/js";
import typescript from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Lint rules, chosen for the defects this project has actually shipped.
 *
 * A rule set copied from a starter template mostly enforces taste and produces
 * a wall of noise that gets switched off. The rules below are here because
 * every one of them corresponds to something that went wrong, or to an
 * invariant the architecture depends on:
 *
 *   - `no-floating-promises` and `require-await`: an unawaited `save` is how
 *     learner state goes missing, and it is invisible in review.
 *   - `react-hooks/exhaustive-deps` as a *warning*, not an error: item 49's
 *     deliberate one-shot effects violate it on purpose and say so, and turning
 *     a considered exception into a build failure teaches people to disable the
 *     rule file-wide.
 *   - `no-restricted-imports` on `node:` builtins inside `src/`: the renderer is
 *     sandboxed, and a Node import there fails at run time in the browser demo
 *     only — which is exactly how item 47's note-saving broke silently.
 *   - `no-console`: the main process has no console a learner can see, so a
 *     `console.log` is either debugging left behind or a leak of repository
 *     content into a log.
 *   - `eqeqeq`, `no-param-reassign`, `prefer-const`: ordinary, and cheap.
 */
export default typescript.config(
  {
    ignores: ["dist/**", "node_modules/**", "artifacts/**", "tutorial/**", "tokenize.cjs", "src/styles.css", "vite.config.ts", "eslint.config.mjs"],
  },
  js.configs.recommended,
  // The TypeScript rules are scoped to TypeScript. Applied globally they run a
  // second, differently configured `no-unused-vars` over every `.mjs` file and
  // report each finding twice.
  ...typescript.configs.recommended.map((entry) => ({ ...entry, files: ["**/*.{ts,tsx,mts,d.mts}"] })),
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-param-reassign": "error",
    },
  },
  {
    // The renderer runs sandboxed in a browser context. A Node builtin here
    // resolves at build time and throws on first use, in one target only.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["node:*"], message: "The renderer is sandboxed; Node builtins are not available there." }] }],
    },
  },
  {
    files: ["electron/**/*.mjs", "scripts/**/*.mjs", "*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { process: "readonly", console: "readonly", Buffer: "readonly", URL: "readonly", URLSearchParams: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", structuredClone: "readonly", TextDecoder: "readonly", TextEncoder: "readonly", AbortController: "readonly", fetch: "readonly", performance: "readonly", document: "readonly", location: "readonly", getComputedStyle: "readonly" },
    },
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // The preflight is a command-line tool; printing its report is its job.
    files: ["scripts/**/*.mjs"],
    rules: { "no-console": "off" },
  },
  {
    // Tests print their evidence and reach into internals on purpose.
    files: ["tests/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { process: "readonly", console: "readonly", Buffer: "readonly", URL: "readonly", setTimeout: "readonly", structuredClone: "readonly", fetch: "readonly", performance: "readonly", AbortController: "readonly", document: "readonly", window: "readonly", location: "readonly", getComputedStyle: "readonly", localStorage: "readonly", matchMedia: "readonly" },
    },
    rules: {
      "no-console": "off",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // A `.only` left in a test file silently stops every other test running.
      "no-restricted-syntax": ["error", { selector: "MemberExpression[object.name='test'][property.name='only']", message: "test.only silently skips every other test." }],
    },
  },
  {
    // Declaration files describe shapes; unused type parameters are the point.
    files: ["**/*.d.mts"],
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
  {
    files: ["electron/preload.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { require: "readonly", module: "readonly" } },
  },
);
