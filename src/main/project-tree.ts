import { execFile } from "child_process";
import { ipcMain } from "electron";
import type { Dirent } from "fs";
import { readdir, realpath } from "fs/promises";
import * as path from "path";
import { resolveFilePath } from "./files.ts";
import { getShellCwd } from "./shells.ts";
import type {
  ProjectTreeEntry,
  ReadProjectTreeRequest,
  ReadProjectTreeResult,
} from "../ipc/bridge.ts";

type ResolveWorkspaceRootResult =
  | { workspaceRootPath: string }
  | { error: string };

// Git failure leaves the candidate directory as the workspace root.
function gitRootForDirectory(
  directoryPath: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", directoryPath, "rev-parse", "--show-toplevel"],
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const workspaceRootPath = stdout.trim();
        if (!workspaceRootPath) {
          resolve(undefined);
          return;
        }
        resolve(workspaceRootPath);
      },
    );
  });
}

async function workspaceRootForFile(
  request: ReadProjectTreeRequest,
): Promise<ResolveWorkspaceRootResult | undefined> {
  if (request.filePath === undefined) {
    return undefined;
  }
  const resolvedFile = await resolveFilePath({
    filePath: request.filePath,
    baseTabId: request.baseTabId,
  });
  if ("error" in resolvedFile) {
    return resolvedFile;
  }
  const directoryPath = path.dirname(resolvedFile.path);
  let workspaceRootPath = directoryPath;
  const gitRoot = await gitRootForDirectory(directoryPath);
  if (gitRoot !== undefined) {
    workspaceRootPath = gitRoot;
  }
  return { workspaceRootPath };
}

async function resolveWorkspaceRoot(
  request: ReadProjectTreeRequest,
): Promise<ResolveWorkspaceRootResult> {
  let workspaceRootPath = request.workspaceRootPath;
  if (workspaceRootPath === undefined) {
    const fromFile = await workspaceRootForFile(request);
    if (fromFile !== undefined) {
      return fromFile;
    }
    if (request.baseTabId === undefined) {
      return { error: "Can't find a workspace root without a terminal tab" };
    }
    const shellDirectory = await getShellCwd(request.baseTabId);
    if (shellDirectory === undefined) {
      return { error: "Can't find the terminal's shell directory" };
    }
    workspaceRootPath = shellDirectory;
    const gitRoot = await gitRootForDirectory(shellDirectory);
    if (gitRoot !== undefined) {
      workspaceRootPath = gitRoot;
    }
  }
  if (workspaceRootPath.length === 0) {
    return { error: "Can't open an empty workspace root" };
  }
  try {
    const canonicalWorkspaceRootPath = await realpath(workspaceRootPath);
    return { workspaceRootPath: canonicalWorkspaceRootPath };
  } catch (error) {
    return { error: String(error) };
  }
}

type WalkWorkspaceDirectoryOptions = {
  workspaceRootPath: string;
  directoryPath: string;
  entries: ProjectTreeEntry[];
};

async function walkWorkspaceDirectory({
  workspaceRootPath,
  directoryPath,
  entries,
}: WalkWorkspaceDirectoryOptions): Promise<void> {
  let directoryEntries: Dirent[];
  try {
    directoryEntries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (directoryPath === workspaceRootPath) {
      throw error;
    }
    // One protected child should not hide the rest of a readable workspace.
    return;
  }
  for (const directoryEntry of directoryEntries) {
    if (directoryEntry.name === ".git" || directoryEntry.isSymbolicLink()) {
      continue;
    }
    const entryPath = path.join(directoryPath, directoryEntry.name);
    let relativePath = path.relative(workspaceRootPath, entryPath);
    relativePath = relativePath.split(path.sep).join("/");
    if (directoryEntry.isDirectory()) {
      entries.push({
        kind: "directory",
        path: relativePath,
      });
      await walkWorkspaceDirectory({
        workspaceRootPath,
        directoryPath: entryPath,
        entries,
      });
      continue;
    }
    if (!directoryEntry.isFile()) {
      continue;
    }
    entries.push({
      kind: "file",
      path: relativePath,
      absolutePath: entryPath,
    });
  }
}

ipcMain.handle(
  "project-tree:read",
  async (
    _event,
    request: ReadProjectTreeRequest,
  ): Promise<ReadProjectTreeResult> => {
    const resolvedRoot = await resolveWorkspaceRoot(request);
    if ("error" in resolvedRoot) {
      return resolvedRoot;
    }
    const entries: ProjectTreeEntry[] = [];
    try {
      await walkWorkspaceDirectory({
        workspaceRootPath: resolvedRoot.workspaceRootPath,
        directoryPath: resolvedRoot.workspaceRootPath,
        entries,
      });
      let name = path.basename(resolvedRoot.workspaceRootPath);
      if (name.length === 0) {
        name = resolvedRoot.workspaceRootPath;
      }
      return {
        workspaceRootPath: resolvedRoot.workspaceRootPath,
        name,
        entries,
      };
    } catch (error) {
      return { error: String(error) };
    }
  },
);
