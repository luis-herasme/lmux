import type { ILink, Terminal as XtermTerminal } from "@xterm/xterm";

// A document opens rendered; everything else opens in the editor. The two
// lists live together because the pattern below is built from both, and
// because "which files are worth linking" is one question, not two.
const MARKDOWN_EXTENSIONS = ["md", "markdown"];

// Monaco has a grammar for far more than this, but a link is an offer to
// open something, and offering to open every file a path could name would
// underline half the output of `ls`. These are the ones worth a click.
const CODE_EXTENSIONS = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "jsonc",
  "css",
  "html",
  "py",
  "rs",
  "go",
  "rb",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "sh",
  "zsh",
  "bash",
  "sql",
  "toml",
  "yaml",
  "yml",
  "xml",
];

const LINKED_EXTENSIONS = [...MARKDOWN_EXTENSIONS, ...CODE_EXTENSIONS];

// path-ish runs ending in one of the extensions above; excludes brackets so
// "(see a.md)" matches
const PATH_PATTERN = new RegExp(
  `[^\\s"'\`()[\\]{}<>]+\\.(?:${LINKED_EXTENSIONS.join("|")})\\b`,
  "g",
);

// A URL is recognized by its scheme alone, so it links no matter what it
// ends in; the same characters are excluded as for paths, so quoting and
// brackets end a URL the same way they end a path.
const URL_PATTERN = /https?:\/\/[^\s"'`()[\]{}<>]+/g;

// Punctuation that ends the sentence around a URL far more often than it
// ends the URL itself.
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

const MAX_LINE_LENGTH = 4096;

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
  // scheme-shaped spans claim their range even when they fail to parse: a
  // malformed URL must stay plain text, never become a file link
  const urlSpans: { index: number; length: number }[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    urlSpans.push({ index: match.index, length: match[0].length });
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
    const claimedByUrl = urlSpans.some(
      (span) =>
        match.index < span.index + span.length &&
        span.index < match.index + match[0].length,
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

type OpenLinkedPath = (options: {
  path: string;
  kind: LinkedFileKind;
}) => void;

type BufferRangeOptions = {
  match: TerminalLinkMatch;
  cols: number;
  firstRow: number;
};

// buffer coords are 1-based; index math assumes single-width chars
function bufferRange({
  match,
  cols,
  firstRow,
}: BufferRangeOptions): ILink["range"] {
  const lastIndex = match.index + match.text.length - 1;
  return {
    start: {
      x: (match.index % cols) + 1,
      y: firstRow + Math.floor(match.index / cols) + 1,
    },
    end: {
      x: (lastIndex % cols) + 1,
      y: firstRow + Math.floor(lastIndex / cols) + 1,
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
          range: bufferRange({ match, cols: terminal.cols, firstRow }),
          text: match.text,
          decorations: {
            pointerCursor: true,
            underline: true,
          },
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
