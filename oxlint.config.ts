import { defineConfig } from "oxlint";

// anti-slop: a vendored Oxlint plugin (tools/oxlint/anti-slop) that rejects
// low-evidence TypeScript and JavaScript patterns. Copied from
// github.com/dmmulroy/anti-slop and adapted here: three of its rules
// contradict this repo's own conventions (AGENTS.md), so they are off.
export default defineConfig({
  ignorePatterns: [
    // Agent tooling directories and build output are not linted. Preserve
    // existing ignores; do not broadly ignore every dot-directory.
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".fallow/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".pi-subagents/**",
    ".roo/**",
    ".windsurf/**",
    "dist/**",
    "release/**",
    // The vendored plugin is upstream's code, checked in its own CI.
    "tools/oxlint/anti-slop/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
  ],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    // Off: AGENTS.md mandates Reflect.get for the one page-global read
    // (src/renderer/bridge.ts), so this rule contradicts the convention.
    "anti-slop/no-reflect-get": "off",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    // Off: AGENTS.md mandates unknown-returning data fetchers and
    // unknown-taking boundary callbacks, validated by the caller with Zod
    // (src/main/json-file.ts and the IPC bridge surface).
    "anti-slop/no-unknown-parameters": "off",
    "anti-slop/no-unknown-returns": "off",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
});
