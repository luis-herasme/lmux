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
