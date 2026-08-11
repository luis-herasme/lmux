# Terminal URL Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ⌘-clicking an `http(s)` URL in terminal output opens it in the default browser, and a URL is never mistaken for a file path.

**Architecture:** All changes live in the renderer's terminal link provider. Link *matching* is extracted into a pure function (`matchTerminalLinks`) so the committed suite can test it directly — the suite runs in Electron's main process and can import any renderer module that only needs strings in, matches out. Link *opening* rides the existing main-process window-open handler (`setWindowOpenHandler` → `openExternally` → protocol allowlist), so `window.open(url)` from the renderer reaches the default browser with no new IPC.

**Tech Stack:** TypeScript (native ESM, run via tsc build), xterm.js `registerLinkProvider`, node:test inside the Electron test harness (`npm test`).

**Spec:** `docs/superpowers/specs/2026-08-11-terminal-url-links-design.md`

---

### Task 1: Extract a pure matcher; rename the module

No behavior change. `file-links.ts` becomes `links.ts`, the match loop becomes an exported pure function, the buffer-coordinate math becomes a helper, and the suite pins down existing file-path matching.

**Files:**
- Rename: `src/renderer/tabs/file-links.ts` → `src/renderer/tabs/links.ts`
- Modify: `src/renderer/tabs/terminal-tab.ts` (import at line 4, call at line 176)
- Test: `src/test/suite.ts`

- [ ] **Step 1: Write the characterization tests (they fail: the module doesn't exist yet)**

In `src/test/suite.ts`, add to the imports near the top:

```ts
import { matchTerminalLinks } from "../renderer/tabs/links.ts";
```

At the bottom of the file, the run currently ends with:

```ts
await suite;
endRun();
```

Insert a second describe between the closing `});` of `describe("the command bus", ...)` and that ending, and await it:

```ts
// Pure string-in, matches-out: the one part of the terminal link provider
// that does not need a mouse, so the one part the suite can pin down.
const linkMatching = describe("terminal link matching", () => {
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
});

await suite;
await linkMatching;
endRun();
```

(The existing `await suite;` / `endRun();` lines are replaced by the last three lines above.)

- [ ] **Step 2: Run the suite to verify it fails**

Run: `npm test`
Expected: FAIL during build — tsc cannot resolve `../renderer/tabs/links.ts`.

- [ ] **Step 3: Rename the module and extract the pure parts**

`git mv src/renderer/tabs/file-links.ts src/renderer/tabs/links.ts`

Then rewrite `src/renderer/tabs/links.ts` so the type import on line 1 (`import type { ILink, Terminal as XtermTerminal } from "@xterm/xterm";`) and the constants (`MARKDOWN_EXTENSIONS`, `CODE_EXTENSIONS`, `LINKED_EXTENSIONS`, `PATH_PATTERN`, `MAX_LINE_LENGTH`) with their comments stay exactly as they are, and everything after them becomes:

```ts
// Which kind of tab a path should open. Decided here, where the extensions
// are, rather than by the caller reading the path a second time.
export type LinkedFileKind = "markdown" | "code";

export type TerminalLinkMatch = {
  kind: "url" | "file";
  index: number;
  text: string;
};

export function matchTerminalLinks(text: string): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  for (const match of text.matchAll(PATH_PATTERN)) {
    matches.push({
      kind: "file",
      index: match.index,
      text: match[0],
    });
  }
  return matches;
}

type OpenLinkedPath = (options: {
  path: string;
  kind: LinkedFileKind;
}) => void;

type BufferRangeOptions = {
  match: TerminalLinkMatch;
  terminal: XtermTerminal;
  firstRow: number;
};

// buffer coords are 1-based; index math assumes single-width chars
function bufferRange({
  match,
  terminal,
  firstRow,
}: BufferRangeOptions): ILink["range"] {
  const lastIndex = match.index + match.text.length - 1;
  return {
    start: {
      x: (match.index % terminal.cols) + 1,
      y: firstRow + Math.floor(match.index / terminal.cols) + 1,
    },
    end: {
      x: (lastIndex % terminal.cols) + 1,
      y: firstRow + Math.floor(lastIndex / terminal.cols) + 1,
    },
  };
}

type RegisterTerminalLinksOptions = {
  terminal: XtermTerminal;
  openPath: OpenLinkedPath;
};

export function registerTerminalLinks({
  terminal,
  openPath,
}: RegisterTerminalLinksOptions): void {
  terminal.registerLinkProvider({
    provideLinks: (bufferLineNumber, callback) => {
      // a wrapped path spans multiple buffer rows; join them
      const buffer = terminal.buffer.active;
      let firstRow = bufferLineNumber - 1;
      while (firstRow > 0 && buffer.getLine(firstRow)?.isWrapped) {
        firstRow--;
      }
      let lastRow = bufferLineNumber - 1;
      while (buffer.getLine(lastRow + 1)?.isWrapped) {
        lastRow++;
      }
      let text = "";
      for (let row = firstRow; row <= lastRow; row++) {
        const line = buffer.getLine(row);
        if (!line) {
          callback(undefined);
          return;
        }
        text += line.translateToString(row === lastRow);
      }
      if (text.length > MAX_LINE_LENGTH) {
        callback(undefined);
        return;
      }
      const links: ILink[] = [];
      for (const match of matchTerminalLinks(text)) {
        links.push({
          range: bufferRange({ match, terminal, firstRow }),
          text: match.text,
          decorations: {
            pointerCursor: true,
            underline: true,
          },
          activate: (event, linkText) => {
            if (!event.metaKey) {
              return;
            }
            const extension = linkText
              .slice(linkText.lastIndexOf(".") + 1)
              .toLowerCase();
            let kind: LinkedFileKind = "code";
            if (MARKDOWN_EXTENSIONS.includes(extension)) {
              kind = "markdown";
            }
            openPath({
              path: linkText,
              kind,
            });
          },
        });
      }
      if (links.length === 0) {
        callback(undefined);
        return;
      }
      callback(links);
    },
  });
}
```

In `src/renderer/tabs/terminal-tab.ts`, change line 4:

```ts
import { registerTerminalLinks } from "./links.ts";
```

and the call at line 176 from `registerFileLinks({` to `registerTerminalLinks({` (the options object is unchanged).

- [ ] **Step 4: Run the suite to verify it passes**

Run: `npm test`
Expected: PASS — three new "terminal link matching" tests, all pre-existing tests green.

- [ ] **Step 5: Commit**

```bash
git add -A src/renderer/tabs/file-links.ts src/renderer/tabs/links.ts src/renderer/tabs/terminal-tab.ts src/test/suite.ts
git commit -m "Extract pure terminal link matcher

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

> **Review amendment (applied after Task 1's code review):** `bufferRange`
> takes `cols: number` instead of the whole terminal (call site passes
> `cols: terminal.cols`), and a fourth characterization test pins that two
> paths on one line come back in the order they appear.

---

### Task 2: Recognize URLs; open them externally

**Files:**
- Modify: `src/renderer/tabs/links.ts`
- Modify: `README.md:116`, `ARCHITECTURE.md:200` (link-provider descriptions)
- Test: `src/test/suite.ts`

- [ ] **Step 1: Write the failing URL tests**

Add inside the `describe("terminal link matching", ...)` block from Task 1:

```ts
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
```

- [ ] **Step 2: Run the suite to verify the new tests fail**

Run: `npm test`
Expected: FAIL — the six new tests report file matches (or no matches) where url matches are expected; everything else green.

- [ ] **Step 3: Implement URL matching and the url link branch**

In `src/renderer/tabs/links.ts`, add below `PATH_PATTERN`:

```ts
// A URL is recognized by its scheme alone, so it links no matter what it
// ends in; the same characters are excluded as for paths, so quoting and
// brackets end a URL the same way they end a path.
const URL_PATTERN = /https?:\/\/[^\s"'`()[\]{}<>]+/g;

// Punctuation that ends the sentence around a URL far more often than it
// ends the URL itself.
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
```

Replace `matchTerminalLinks` with:

```ts
export function matchTerminalLinks(text: string): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, "");
    if (!URL.canParse(url)) {
      continue;
    }
    matches.push({
      kind: "url",
      index: match.index,
      text: url,
    });
  }
  for (const match of text.matchAll(PATH_PATTERN)) {
    // a path overlapping a URL is part of that URL, not a file
    const claimedByUrl = matches.some(
      (urlMatch) =>
        match.index < urlMatch.index + urlMatch.text.length &&
        urlMatch.index < match.index + match[0].length,
    );
    if (claimedByUrl) {
      continue;
    }
    matches.push({
      kind: "file",
      index: match.index,
      text: match[0],
    });
  }
  // in the order they appear on the line, whatever their kind
  matches.sort((a, b) => a.index - b.index);
  return matches;
}
```

In `registerTerminalLinks`, the two kinds share everything but what a click
does, so the branch lives inside the one `activate` closure rather than in a
second link literal. Replace the existing `activate` with:

```ts
          activate: (event, linkText) => {
            if (!event.metaKey) {
              return;
            }
            if (match.kind === "url") {
              // main denies the popup this asks for and hands the URL to
              // the default browser instead, through its protocol allowlist
              window.open(linkText);
              return;
            }
            const extension = linkText
              .slice(linkText.lastIndexOf(".") + 1)
              .toLowerCase();
            let fileKind: LinkedFileKind = "code";
            if (MARKDOWN_EXTENSIONS.includes(extension)) {
              fileKind = "markdown";
            }
            openPath({
              path: linkText,
              kind: fileKind,
            });
          },
```

(The local `kind` is renamed `fileKind` here because `match.kind` now appears
in the same closure and names a different axis.)

Update the two doc lines:

`README.md:116`:

```
| `src/renderer/tabs/links.ts`      | Terminal link provider: Cmd+click opens a source path or URL |
```

`ARCHITECTURE.md:200`:

```
      links.ts         terminal link provider: Cmd+click a *.md or source path, or a URL
```

(Keep the README table's column alignment consistent after the shorter path,
and keep the ARCHITECTURE tree entry in a position that still reads naturally
under its new name.)

- [ ] **Step 4: Run the suite to verify it passes**

Run: `npm test`
Expected: PASS — all nine "terminal link matching" tests and every pre-existing test green.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/tabs/links.ts src/test/suite.ts README.md ARCHITECTURE.md
git commit -m "Open terminal URLs in the default browser

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

> **Review amendment (applied after Task 2's code review):** the
> `claimedByUrl` predicate is a range-overlap test, not a starts-inside test —
> `PATH_PATTERN` has no left boundary, so in `--docs=https://a.com/x.js` the
> path match starts before the URL and would otherwise win the click (xterm
> hands overlapping links to the first in array order). Two more tests pin
> this and the trailing-slash shape, bringing the describe to twelve.

---

### Task 3: Manual verification

⌘-click activation is a real-mouse behavior the harness cannot drive (see the project's verification notes), so the click path is checked by hand.

**Files:** none

- [ ] **Step 1: Run the app**

Run: `npm start`

- [ ] **Step 2: Walk the manual checklist in a terminal tab**

- `echo https://github.com/owner/repo` → underlined on hover, ⌘-click opens the default browser
- `echo https://example.com/app.js` → opens the browser, **not** a project tab with an error
- `echo "see https://example.com/."` → the link stops before the final dot
- `echo src/main/files.ts` (from the repo root) → still opens an editor tab
- plain click on a URL → nothing happens

- [ ] **Step 3: Report results**

All five pass → done. Any failure → back to the code with the failing case as the new test (add it to the matcher tests if it is a matching bug).
