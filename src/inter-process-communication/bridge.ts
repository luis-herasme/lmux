// tsc refuses if preload.cts and the renderer disagree about this
// shape. The shell protocol carries bytes/sizes/tab ids; the command
// bus is the one structured channel.
import type { Command, LmuxEvent } from "../api.ts";
import type { Session } from "../session.ts";
import { z } from "zod";

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
  | { resolvedPath: string; content: string }
  | { error: string };

// A live editor can derive its workspace root from a terminal or its first
// file. A restored editor already knows the root and asks for it directly.
export type ReadFileTreeRequest = {
  baseTabId?: number;
  workspaceRootPath?: string;
  filePath?: string;
  // Absent reads the root. Present reads only this directory's children.
  workspaceRelativeDirectoryPath?: string;
};

export type FileTreeEntry =
  | { kind: "directory"; path: string }
  | { kind: "file"; path: string; absolutePath: string };

export type ReadFileTreeResult =
  | {
      workspaceRootPath: string;
      name: string;
      entries: FileTreeEntry[];
    }
  | { error: string };

const gitDecorationStatusSchema = z.enum([
  "added",
  "conflicting",
  "copied",
  "deleted",
  "ignored",
  "intent-to-add",
  "intent-to-rename",
  "modified",
  "renamed",
  "staged-deleted",
  "staged-modified",
  "submodule",
  "type-changed",
  "untracked",
]);
export type GitDecorationStatus = z.infer<typeof gitDecorationStatusSchema>;

const fileTreeGitDecorationSchema = z.object({
  path: z.string(),
  status: gitDecorationStatusSchema,
});
export type FileTreeGitDecoration = z.infer<
  typeof fileTreeGitDecorationSchema
>;

export const readFileTreeGitDecorationsRequestSchema = z.object({
  workspaceRootPath: z.string(),
});
export type ReadFileTreeGitDecorationsRequest = z.infer<
  typeof readFileTreeGitDecorationsRequestSchema
>;

export const readFileTreeGitDecorationsResultSchema = z.object({
  workspaceRootPath: z.string(),
  decorations: z.array(fileTreeGitDecorationSchema),
});
export type ReadFileTreeGitDecorationsResult = z.infer<
  typeof readFileTreeGitDecorationsResultSchema
>;

export const watchFileTreeRequestSchema = z.object({
  workspaceRootPath: z.string(),
});
export type WatchFileTreeRequest = z.infer<
  typeof watchFileTreeRequestSchema
>;

export const watchFileTreeResultSchema = z.union([
  z.object({ watcherId: z.number().int() }),
  z.object({ error: z.string() }),
]);
export type WatchFileTreeResult = z.infer<
  typeof watchFileTreeResultSchema
>;

export const unwatchFileTreeRequestSchema = z.object({
  watcherId: z.number().int(),
});
export type UnwatchFileTreeRequest = z.infer<
  typeof unwatchFileTreeRequestSchema
>;

export const fileTreeChangeMessageSchema = z.object({
  watcherId: z.number().int(),
  paths: z.array(z.string()).nullable(),
  stopped: z.boolean().optional(),
});
export type FileTreeChangeMessage = z.infer<
  typeof fileTreeChangeMessageSchema
>;

export type Bridge = {
  spawnShell: (size: ShellSizeMessage) => void;
  writeToShell: (message: ShellDataMessage) => void;
  resizeShell: (size: ShellSizeMessage) => void;
  killShell: (id: number) => void;
  onShellData: (callback: (message: ShellDataMessage) => void) => void;
  onShellExit: (callback: (id: number) => void) => void;
  onCommand: (callback: (command: Command) => void) => void;
  emitEvent: (event: LmuxEvent) => void;
  showTabMenu: (id: number) => void;
  onRenameRequest: (callback: (id: number) => void) => void;
  showWorkspaceMenu: (id: number) => void;
  onWorkspaceRenameRequest: (callback: (id: number) => void) => void;
  // a person's workspace ×: routed to main so the shells it would kill are
  // asked about, then dispatched
  closeWorkspace: (id: number) => void;
  // request/response pairs on the cable (ipcRenderer.invoke)
  readFile: (request: ReadFileRequest) => Promise<ReadFileResult>;
  readFileTree: (
    request: ReadFileTreeRequest,
  ) => Promise<ReadFileTreeResult>;
  readFileTreeGitDecorations: (
    request: ReadFileTreeGitDecorationsRequest,
  ) => Promise<unknown>;
  watchFileTree: (request: WatchFileTreeRequest) => Promise<unknown>;
  unwatchFileTree: (request: UnwatchFileTreeRequest) => void;
  onFileTreeChanged: (callback: (message: unknown) => void) => void;
  // the session the last run left behind, if there is one to rebuild
  readSession: () => Promise<Session | null>;
};
