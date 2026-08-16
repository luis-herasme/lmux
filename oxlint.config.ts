import { defineConfig } from "oxlint";

// anti-slop: a vendored Oxlint plugin (tools/oxlint/anti-slop) that rejects
// low-evidence TypeScript and JavaScript patterns. Copied from
// github.com/dmmulroy/anti-slop and trimmed to the twelve rules this repo
// enforces; the other three contradicted AGENTS.md conventions and were removed.
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
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
});
