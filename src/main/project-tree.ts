import { execFile } from "child_process";
import { ipcMain } from "electron";
import { opendir, realpath } from "fs/promises";
import * as path from "path";
import { resolveFilePath } from "./files.ts";
import { getShellCwd } from "./shells.ts";
import type {
  ProjectTreeEntry,
  ReadProjectTreeRequest,
  ReadProjectTreeResult,
} from "../ipc/bridge.ts";

const MAX_DIRECTORY_ENTRY_COUNT = 10_000;

type ResolveWorkspaceRootResult =
  | { workspaceRootPath: string }
  | { error: string };

type ResolveWorkspaceDirectoryResult =
  | { directoryPath: string }
  | { error: string };

type ReadWorkspaceDirectoryOptions = {
  workspaceRootPath: string;
  directoryPath: string;
};

type ReadWorkspaceDirectoryResult =
  | { entries: ProjectTreeEntry[] }
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
      if ("error" in fromFile) {
        return fromFile;
      }
      workspaceRootPath = fromFile.workspaceRootPath;
    }
  }
  if (workspaceRootPath === undefined) {
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

async function resolveWorkspaceDirectory(
  request: ReadProjectTreeRequest,
  workspaceRootPath: string,
): Promise<ResolveWorkspaceDirectoryResult> {
  let requestedDirectoryPath = workspaceRootPath;
  if (request.workspaceRelativeDirectoryPath !== undefined) {
    requestedDirectoryPath = path.resolve(
      workspaceRootPath,
      request.workspaceRelativeDirectoryPath,
    );
    const relativePath = path.relative(
      workspaceRootPath,
      requestedDirectoryPath,
    );
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      return { error: "Can't read outside the workspace root" };
    }
  }

  try {
    const canonicalDirectoryPath = await realpath(requestedDirectoryPath);
    if (canonicalDirectoryPath !== requestedDirectoryPath) {
      return { error: "Can't read a directory through a symbolic link" };
    }
    const relativePath = path.relative(
      workspaceRootPath,
      canonicalDirectoryPath,
    );
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      return { error: "Can't read outside the workspace root" };
    }
    return { directoryPath: canonicalDirectoryPath };
  } catch (error) {
    return { error: String(error) };
  }
}

async function readWorkspaceDirectory({
  workspaceRootPath,
  directoryPath,
}: ReadWorkspaceDirectoryOptions): Promise<ReadWorkspaceDirectoryResult> {
  const entries: ProjectTreeEntry[] = [];
  let entryCount = 0;

  try {
    const directory = await opendir(directoryPath);
    for await (const directoryEntry of directory) {
      entryCount += 1;
      if (entryCount > MAX_DIRECTORY_ENTRY_COUNT) {
        return {
          error: `Directory contains more than ${MAX_DIRECTORY_ENTRY_COUNT.toLocaleString()} entries`,
        };
      }
      if (directoryEntry.name === ".git" || directoryEntry.isSymbolicLink()) {
        continue;
      }
      if (!directoryEntry.isDirectory() && !directoryEntry.isFile()) {
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
        continue;
      }
      entries.push({
        kind: "file",
        path: relativePath,
        absolutePath: entryPath,
      });
    }
  } catch (error) {
    return { error: String(error) };
  }

  entries.sort((leftEntry, rightEntry) => {
    if (leftEntry.kind !== rightEntry.kind) {
      if (leftEntry.kind === "directory") {
        return -1;
      }
      return 1;
    }
    return leftEntry.path.localeCompare(rightEntry.path);
  });
  return { entries };
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
    const resolvedDirectory = await resolveWorkspaceDirectory(
      request,
      resolvedRoot.workspaceRootPath,
    );
    if ("error" in resolvedDirectory) {
      return resolvedDirectory;
    }
    const directoryResult = await readWorkspaceDirectory({
      workspaceRootPath: resolvedRoot.workspaceRootPath,
      directoryPath: resolvedDirectory.directoryPath,
    });
    if ("error" in directoryResult) {
      return directoryResult;
    }

    let name = path.basename(resolvedRoot.workspaceRootPath);
    if (name.length === 0) {
      name = resolvedRoot.workspaceRootPath;
    }
    return {
      workspaceRootPath: resolvedRoot.workspaceRootPath,
      name,
      entries: directoryResult.entries,
    };
  },
);
