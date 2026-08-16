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

// A live project can derive its workspace root from a terminal or its first
// file. A restored project already knows the root and asks for it directly.
export type ReadProjectTreeRequest = {
  baseTabId?: number;
  workspaceRootPath?: string;
  filePath?: string;
  // Absent reads the root. Present reads only this directory's children.
  workspaceRelativeDirectoryPath?: string;
};

export type ProjectTreeEntry =
  | { kind: "directory"; path: string }
  | { kind: "file"; path: string; absolutePath: string };

export type ReadProjectTreeResult =
  | {
      workspaceRootPath: string;
      name: string;
      entries: ProjectTreeEntry[];
    }
  | { error: string };

export const gitDecorationStatusSchema = z.enum([
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

export const projectTreeGitDecorationSchema = z.object({
  path: z.string(),
  status: gitDecorationStatusSchema,
});
export type ProjectTreeGitDecoration = z.infer<
  typeof projectTreeGitDecorationSchema
>;

export const readProjectTreeGitDecorationsRequestSchema = z.object({
  workspaceRootPath: z.string(),
});
export type ReadProjectTreeGitDecorationsRequest = z.infer<
  typeof readProjectTreeGitDecorationsRequestSchema
>;

export const readProjectTreeGitDecorationsResultSchema = z.object({
  workspaceRootPath: z.string(),
  decorations: z.array(projectTreeGitDecorationSchema),
});
export type ReadProjectTreeGitDecorationsResult = z.infer<
  typeof readProjectTreeGitDecorationsResultSchema
>;

export const watchProjectTreeRequestSchema = z.object({
  workspaceRootPath: z.string(),
});
export type WatchProjectTreeRequest = z.infer<
  typeof watchProjectTreeRequestSchema
>;

export const watchProjectTreeResultSchema = z.union([
  z.object({ watcherId: z.number().int() }),
  z.object({ error: z.string() }),
]);
export type WatchProjectTreeResult = z.infer<
  typeof watchProjectTreeResultSchema
>;

export const unwatchProjectTreeRequestSchema = z.object({
  watcherId: z.number().int(),
});
export type UnwatchProjectTreeRequest = z.infer<
  typeof unwatchProjectTreeRequestSchema
>;

export const projectTreeChangeMessageSchema = z.object({
  watcherId: z.number().int(),
  paths: z.array(z.string()).nullable(),
  stopped: z.boolean().optional(),
});
export type ProjectTreeChangeMessage = z.infer<
  typeof projectTreeChangeMessageSchema
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
  readProjectTree: (
    request: ReadProjectTreeRequest,
  ) => Promise<ReadProjectTreeResult>;
  readProjectTreeGitDecorations: (
    request: ReadProjectTreeGitDecorationsRequest,
  ) => Promise<unknown>;
  watchProjectTree: (request: WatchProjectTreeRequest) => Promise<unknown>;
  unwatchProjectTree: (request: UnwatchProjectTreeRequest) => void;
  onProjectTreeChanged: (callback: (message: unknown) => void) => void;
  // the session the last run left behind, if there is one to rebuild
  readSession: () => Promise<Session | null>;
};
