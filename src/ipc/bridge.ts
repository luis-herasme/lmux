// tsc refuses if preload.cts and the renderer disagree about this
// shape. The shell protocol carries bytes/sizes/tab ids; the command
// bus is the one structured channel.
import type {
  Command,
  LmuxEvent,
  ScreenRequest,
  ScreenResult,
} from "../api.ts";
import type { Session } from "../session.ts";

export type ShellSizeMessage = {
  id: number;
  cols: number;
  rows: number;
};

export type ShellDataMessage = {
  id: number;
  data: string;
};

// Relative path resolves against the shell cwd of `baseTabId`.
export type ReadFileRequest = {
  path: string;
  baseTabId?: number;
};

export type ReadFileResult =
  // mtimeMs is the file's modification time at read, so a save can refuse to
  // overwrite a file that changed on disk in between.
  | { resolvedPath: string; content: string; mtimeMs: number }
  | { error: string };

// expectedMtimeMs is what read reported; a write whose file no longer has it
// is refused, because it would bury a change someone else made.
export type WriteFileRequest = {
  path: string;
  baseTabId?: number;
  expectedMtimeMs: number;
  content: string;
};

export type WriteFileResult =
  // the file's mtime after the write, which a subsequent save guards against
  | { mtimeMs: number }
  | { error: string };

// A live open names the terminal whose cwd defines the project. A restored
// tree already knows its root, so it asks for that path directly.
export type ReadProjectTreeRequest = {
  baseTabId?: number;
  rootPath?: string;
};

export type ProjectTreeEntry =
  | { kind: "directory"; path: string }
  | { kind: "file"; path: string; absolutePath: string };

export type ReadProjectTreeResult =
  | {
      rootPath: string;
      name: string;
      entries: ProjectTreeEntry[];
    }
  | { error: string };

// Electron has no invoke in this direction, so main asks with an id and the
// page answers with it: the only question main ever puts to the page.
export type ScreenReadMessage = {
  readId: number;
  request: ScreenRequest;
};

export type ScreenAnswerMessage = {
  readId: number;
  result: ScreenResult;
};

export type Bridge = {
  spawnShell: (size: ShellSizeMessage) => void;
  writeToShell: (message: ShellDataMessage) => void;
  resizeShell: (size: ShellSizeMessage) => void;
  killShell: (id: number) => void;
  onShellData: (callback: (message: ShellDataMessage) => void) => void;
  onShellExit: (callback: (id: number) => void) => void;
  onCommand: (callback: (command: Command) => void) => void;
  emitEvent: (event: LmuxEvent) => void;
  onScreenRead: (callback: (message: ScreenReadMessage) => void) => void;
  answerScreenRead: (message: ScreenAnswerMessage) => void;
  showTabMenu: (id: number) => void;
  onRenameRequest: (callback: (id: number) => void) => void;
  showWorkspaceMenu: (id: number) => void;
  onWorkspaceRenameRequest: (callback: (id: number) => void) => void;
  // a person's workspace ×: routed to main so the shells it would kill are
  // asked about, then dispatched
  closeWorkspace: (id: number) => void;
  // a person's tab ×: routed to main, so a dirty code tab is asked about
  // before it goes
  closeTab: (id: number) => void;
  // request/response pairs on the cable (ipcRenderer.invoke)
  readFile: (request: ReadFileRequest) => Promise<ReadFileResult>;
  writeFile: (request: WriteFileRequest) => Promise<WriteFileResult>;
  readProjectTree: (
    request: ReadProjectTreeRequest,
  ) => Promise<ReadProjectTreeResult>;
  // the session the last run left behind, if there is one to rebuild
  readSession: () => Promise<Session | null>;
};
