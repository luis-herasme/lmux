# Terminal URL links

Fixes [#48](https://github.com/luis-herasme/lmux/issues/48): URLs in terminal
output are either not links at all, or — when they end in a linked file
extension — are offered as file links that fail to open.

## Design

All changes live in the terminal link provider (`src/renderer/tabs/links.ts`,
named `file-links.ts` before this work); nothing changes in the main process.

**Recognition.** A second pattern joins the existing file-path pattern:

```
/https?:\/\/[^\s"'`()[\]{}<>]+/g
```

Same character exclusions as the path pattern, anchored on an `http://` or
`https://` scheme. Each match is then cleaned up and validated:

- trailing punctuation (`.`, `,`, `;`, `:`, `!`, `?`) is trimmed, so a URL
  ending a sentence links without the period
- matches that `URL.canParse` rejects are dropped

**Precedence.** URL matches are collected first. A file-path match whose
range overlaps anything scheme-shaped is discarded — overlap in either
direction, since a path pattern with no left boundary can reach back over a
URL (`--docs=https://a.com/app.js`), and even a malformed URL that fails
validation must stay plain text rather than become a file link. So
`https://a.com/app.js` is one URL link and never a file link. File paths
outside URLs behave exactly as today.

**Opening.** ⌘-click on a URL calls `window.open(url)`. The main process
already intercepts every window-open request (`setWindowOpenHandler` in
`src/main/index.ts`), denies the popup, and passes the URL to
`openExternally`, which enforces the `http:`/`https:`/`mailto:` protocol
allowlist before handing it to `shell.openExternal`. The URL opens in the
default browser; no new window, IPC channel, or dependency is added. Plain
click does nothing, matching file links.

**Structure.** Matching is a pure function, `matchTerminalLinks(text)`, so
the committed suite can test it without a mouse; the buffer-coordinate math
(match index → 1-based x/y range) moves to a `bufferRange` helper to keep
`provideLinks` flat. Since the module now recognizes more than file paths,
it is renamed `file-links.ts` → `links.ts` and `registerFileLinks` →
`registerTerminalLinks`.

## Out of scope

- Schemes other than `http`/`https` (the terminal has no reason to link
  `mailto:`; the main-process allowlist stays as-is for page navigations)
- Wide-character (CJK/emoji) coordinate mapping — the existing file-link code
  already assumes single-width cells; URLs inherit that known limitation
- Detecting URLs by any means other than the scheme prefix (`example.com`
  without a scheme stays plain text)
- IPv6 literal hosts (`http://[::1]:5173/`), since `[` ends a URL the same
  way it ends a path
- Trimming `:line:col` suffixes off URLs in stack traces
  (`http://host/app.js:12:5` links whole; a rule that distinguishes them
  from `host:port` is more machinery than the link is worth)

## Verification

- `npm test` still passes (no existing behavior changes)
- Manual, per the project's verification notes (mouse-event behavior):
  - `echo https://github.com/owner/repo` → underlined, ⌘-click opens browser
  - `echo https://example.com/app.js` → opens browser, not a project tab
  - `echo "see https://example.com/."` → link excludes the trailing dot
  - `echo src/main/files.ts` → still opens an editor tab
  - plain click on a URL → nothing
