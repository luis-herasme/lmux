import { execFile } from "child_process";
import { ipcMain } from "electron";
import type { Dirent } from "fs";
import { readdir, realpath, stat } from "fs/promises";
import * as path from "path";
import { getShellCwd } from "./shells.ts";
import type {
  ProjectTreeEntry,
  ReadProjectTreeRequest,
  ReadProjectTreeResult,
} from "../ipc/bridge.ts";

type ResolveProjectRootResult =
  | { rootPath: string }
  | { error: string };

// Git failure leaves the shell directory as the project root.
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
        const rootPath = stdout.trim();
        if (!rootPath) {
          resolve(undefined);
          return;
        }
        resolve(rootPath);
      },
    );
  });
}

async function resolveProjectRoot(
  request: ReadProjectTreeRequest,
): Promise<ResolveProjectRootResult> {
  let rootPath = request.rootPath;
  if (rootPath === undefined) {
    if (request.baseTabId === undefined) {
      return { error: "Can't find a project without a terminal tab" };
    }
    const shellDirectory = await getShellCwd(request.baseTabId);
    if (shellDirectory === undefined) {
      return { error: "Can't find the terminal's shell directory" };
    }
    rootPath = shellDirectory;
    const gitRoot = await gitRootForDirectory(shellDirectory);
    if (gitRoot !== undefined) {
      rootPath = gitRoot;
    }
  }
  if (rootPath.length === 0) {
    return { error: "Can't open an empty project path" };
  }
  try {
    const canonicalRootPath = await realpath(rootPath);
    const rootStatistics = await stat(canonicalRootPath);
    if (!rootStatistics.isDirectory()) {
      return { error: `${canonicalRootPath} is not a directory` };
    }
    return { rootPath: canonicalRootPath };
  } catch (error) {
    return { error: String(error) };
  }
}

type WalkProjectDirectoryOptions = {
  rootPath: string;
  directoryPath: string;
  entries: ProjectTreeEntry[];
};

async function walkProjectDirectory({
  rootPath,
  directoryPath,
  entries,
}: WalkProjectDirectoryOptions): Promise<void> {
  let directoryEntries: Dirent[];
  try {
    directoryEntries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (directoryPath === rootPath) {
      throw error;
    }
    // One protected child should not hide the rest of a readable project.
    return;
  }
  for (const directoryEntry of directoryEntries) {
    if (directoryEntry.name === ".git" || directoryEntry.isSymbolicLink()) {
      continue;
    }
    const entryPath = path.join(directoryPath, directoryEntry.name);
    let relativePath = path.relative(rootPath, entryPath);
    relativePath = relativePath.split(path.sep).join("/");
    if (directoryEntry.isDirectory()) {
      entries.push({
        kind: "directory",
        path: relativePath,
      });
      await walkProjectDirectory({
        rootPath,
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
    const resolvedRoot = await resolveProjectRoot(request);
    if ("error" in resolvedRoot) {
      return resolvedRoot;
    }
    const entries: ProjectTreeEntry[] = [];
    try {
      await walkProjectDirectory({
        rootPath: resolvedRoot.rootPath,
        directoryPath: resolvedRoot.rootPath,
        entries,
      });
      let name = path.basename(resolvedRoot.rootPath);
      if (name.length === 0) {
        name = resolvedRoot.rootPath;
      }
      return {
        rootPath: resolvedRoot.rootPath,
        name,
        entries,
      };
    } catch (error) {
      return { error: String(error) };
    }
  },
);
