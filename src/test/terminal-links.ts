import { describe } from "node:test";
import assert from "node:assert/strict";
import { busTest } from "./harness.ts";
import { matchTerminalLinks } from "../renderer/tabs/terminal-links.ts";

// Pure string-in, matches-out: the one part of the terminal link provider
// that does not need a mouse, so the one part the suite can pin down.
export const linkMatching = describe("terminal link matching", () => {
  busTest({
    name: "a path ending in a linked extension is a file match",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("src/main/files.ts"), [
        { kind: "file", index: 0, text: "src/main/files.ts" },
      ]);
    },
  });

  busTest({
    name: "brackets around a path stay outside the match",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("(see docs/notes.md)"), [
        { kind: "file", index: 5, text: "docs/notes.md" },
      ]);
    },
  });

  busTest({
    name: "text without linkable paths matches nothing",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("ls -la && npm run build"), []);
    },
  });

  busTest({
    name: "two paths on one line match in the order they appear",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("diff src/a.ts src/b.ts"), [
        { kind: "file", index: 5, text: "src/a.ts" },
        { kind: "file", index: 14, text: "src/b.ts" },
      ]);
    },
  });

  busTest({
    name: "a URL is a url match",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("https://github.com/owner/repo"), [
        { kind: "url", index: 0, text: "https://github.com/owner/repo" },
      ]);
    },
  });

  busTest({
    name: "a URL ending in a linked extension is a url match, not a file match",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("https://example.com/app.js"), [
        { kind: "url", index: 0, text: "https://example.com/app.js" },
      ]);
    },
  });

  busTest({
    name: "a URL with a port links whole",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("http://localhost:3000/app.js"), [
        { kind: "url", index: 0, text: "http://localhost:3000/app.js" },
      ]);
    },
  });

  busTest({
    name: "sentence punctuation after a URL stays outside the match",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("visit https://example.com."), [
        { kind: "url", index: 6, text: "https://example.com" },
      ]);
    },
  });

  busTest({
    name: "a scheme with nothing usable behind it matches nothing",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("https://."), []);
    },
  });

  busTest({
    name: "URLs and file paths link side by side",
    body: async () => {
      assert.deepEqual(
        matchTerminalLinks("open https://a.com/x.ts or src/b.ts"),
        [
          { kind: "url", index: 5, text: "https://a.com/x.ts" },
          { kind: "file", index: 27, text: "src/b.ts" },
        ],
      );
    },
  });

  busTest({
    name: "a path match reaching back over a URL does not claim it",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("--docs=https://example.com/app.js"), [
        { kind: "url", index: 7, text: "https://example.com/app.js" },
      ]);
    },
  });

  busTest({
    name: "a trailing slash is part of the URL",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("Local: http://localhost:5173/"), [
        { kind: "url", index: 7, text: "http://localhost:5173/" },
      ]);
    },
  });

  busTest({
    name: "a malformed URL is neither a link nor a file",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("https://a.com:99999/app.ts"), []);
    },
  });
});
