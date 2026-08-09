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

type ResolvedProjectRoot =
  | { path: string }
  | { error: string };

// Git failure means the shell directory is not inside a repository.
function findGitRoot(directoryPath: string): Promise<string | undefined> {
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
): Promise<ResolvedProjectRoot> {
  let requestedPath = request.rootPath;
  if (requestedPath === undefined) {
    if (request.baseTabId === undefined) {
      return { error: "Can't find a project without a terminal tab" };
    }
    const shellDirectory = await getShellCwd(request.baseTabId);
    if (shellDirectory === undefined) {
      return { error: "Can't find the terminal's shell directory" };
    }
    requestedPath = shellDirectory;
    const gitRoot = await findGitRoot(shellDirectory);
    if (gitRoot !== undefined) {
      requestedPath = gitRoot;
    }
  }
  if (!requestedPath) {
    return { error: "Can't open an empty project path" };
  }
  try {
    const resolvedPath = await realpath(requestedPath);
    const projectStats = await stat(resolvedPath);
    if (!projectStats.isDirectory()) {
      return { error: `${resolvedPath} is not a directory` };
    }
    return { path: resolvedPath };
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
  let children: Dirent[];
  try {
    children = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (directoryPath === rootPath) {
      throw error;
    }
    // One protected child should not hide the rest of a readable project.
    return;
  }
  for (const child of children) {
    if (child.name === ".git" || child.isSymbolicLink()) {
      continue;
    }
    const absolutePath = path.join(directoryPath, child.name);
    let relativePath = path.relative(rootPath, absolutePath);
    relativePath = relativePath.split(path.sep).join("/");
    if (child.isDirectory()) {
      entries.push({
        kind: "directory",
        path: relativePath,
      });
      await walkProjectDirectory({
        rootPath,
        directoryPath: absolutePath,
        entries,
      });
      continue;
    }
    if (!child.isFile()) {
      continue;
    }
    entries.push({
      kind: "file",
      path: relativePath,
      absolutePath,
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
        rootPath: resolvedRoot.path,
        directoryPath: resolvedRoot.path,
        entries,
      });
      let name = path.basename(resolvedRoot.path);
      if (!name) {
        name = resolvedRoot.path;
      }
      return {
        rootPath: resolvedRoot.path,
        name,
        entries,
      };
    } catch (error) {
      return { error: String(error) };
    }
  },
);
