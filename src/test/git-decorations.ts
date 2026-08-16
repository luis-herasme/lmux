import { describe } from "node:test";
import assert from "node:assert/strict";
import { busTest } from "./harness.ts";
import {
  addSubmoduleDecorations,
  gitDecorationsFromStatusOutput,
} from "../main/git-decorations.ts";

// The fragile half of the tree's Git decorations is the porcelain -z
// grammar: two status bytes, a path, and for a rename or copy a second
// path. Pinned here as plain strings, which real git output only ever
// exercises through a full app boot.
export const gitStatusParsing = describe("git status parsing", () => {
  busTest({
    name: "a working-tree status beats a staged one for the same path",
    body: async () => {
      assert.deepEqual(
        Object.fromEntries(gitDecorationsFromStatusOutput("MM mixed.ts\u0000")),
        { "mixed.ts": "modified" },
      );
    },
  });

  busTest({
    name: "a rename record skips the original path and decorates the new one",
    body: async () => {
      assert.deepEqual(
        Object.fromEntries(
          gitDecorationsFromStatusOutput("R  new.ts\u0000old.ts\u0000"),
        ),
        { "new.ts": "renamed" },
      );
    },
  });

  busTest({
    name: "conflicting, untracked and ignored statuses map directly",
    body: async () => {
      assert.deepEqual(
        Object.fromEntries(
          gitDecorationsFromStatusOutput(
            "DD clash.ts\u0000?? fresh.ts\u0000!! skip.ts\u0000",
          ),
        ),
        {
          "clash.ts": "conflicting",
          "fresh.ts": "untracked",
          "skip.ts": "ignored",
        },
      );
    },
  });

  busTest({
    name: "a staged modification maps to the staged decoration",
    body: async () => {
      assert.deepEqual(
        Object.fromEntries(gitDecorationsFromStatusOutput("M  staged.ts\u0000")),
        { "staged.ts": "staged-modified" },
      );
    },
  });

  busTest({
    name: "a submodule record decorates its path, a plain blob does not",
    body: async () => {
      const decorations = new Map();
      addSubmoduleDecorations({
        output:
          "160000 abc123 0\tvendor/lib\u0000100644 def456 0\tsrc/a.ts\u0000",
        decorations,
      });
      assert.deepEqual(Object.fromEntries(decorations), {
        "vendor/lib": "submodule",
      });
    },
  });
});
