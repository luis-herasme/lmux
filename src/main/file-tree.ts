import { execFile } from "child_process";
import { watch } from "fs";
import type { FSWatcher } from "fs";
import { ipcMain } from "electron";
import type { WebContents } from "electron";
import { opendir, realpath } from "fs/promises";
import * as path from "path";
import { resolveFilePath } from "./files.ts";
import {
  addSubmoduleDecorations,
  gitDecorationsFromStatusOutput,
  normalizedGitPath,
} from "./git-decorations.ts";
import { getShellCwd } from "./shells.ts";
import {
  readFileTreeGitDecorationsRequestSchema,
  unwatchFileTreeRequestSchema,
  watchFileTreeRequestSchema,
} from "../inter-process-communication/bridge.ts";
import type {
  FileTreeEntry,
  FileTreeGitDecoration,
  FileTreeChangeMessage,
  ReadFileTreeGitDecorationsResult,
  ReadFileTreeRequest,
  ReadFileTreeResult,
  WatchFileTreeResult,
} from "../inter-process-communication/bridge.ts";

const MAX_DIRECTORY_ENTRY_COUNT = 10_000;
const GIT_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const FILE_TREE_WATCH_DEBOUNCE_MS = 200;
const FILE_TREE_WATCH_PATH_LIMIT = 1_000;

type RunGitOptions = {
  directoryPath: string;
  arguments: string[];
};

type ActiveFileTreeWatcher = {
  watcherId: number;
  sender: WebContents;
  fileSystemWatchers: FSWatcher[];
  changedPaths: Set<string>;
  unknownPathChanged: boolean;
  debounceTimer: NodeJS.Timeout | undefined;
  senderDestroyedListener: () => void;
};

type ScheduleFileTreeChangeOptions = {
  watcherId: number;
  changedPath: string | undefined;
};

type AddFileSystemWatcherOptions = {
  activeWatcher: ActiveFileTreeWatcher;
  watchedPath: string;
  workspaceRootPath: string;
  gitMetadata: boolean;
};

type GitMetadataDirectoryOptions = {
  workspaceRootPath: string;
  argument: "--git-dir" | "--git-common-dir";
};

type PathIsInsideOptions = {
  parentPath: string;
  candidatePath: string;
};

const activeFileTreeWatchers = new Map<number, ActiveFileTreeWatcher>();
let nextFileTreeWatcherId = 1;

function runGit({
  directoryPath,
  arguments: gitArguments,
}: RunGitOptions): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", directoryPath, ...gitArguments],
      { maxBuffer: GIT_OUTPUT_MAX_BYTES },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function pathIsInside({
  parentPath,
  candidatePath,
}: PathIsInsideOptions): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`)) {
    return false;
  }
  return !path.isAbsolute(relativePath);
}

async function readGitDecorations(
  workspaceRootPath: string,
): Promise<FileTreeGitDecoration[]> {
  const gitRootPath = await gitRootForDirectory(workspaceRootPath);
  if (gitRootPath === undefined) {
    return [];
  }
  const [statusOutput, stagedFilesOutput] = await Promise.all([
    runGit({
      directoryPath: gitRootPath,
      arguments: [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
      ],
    }),
    runGit({
      directoryPath: gitRootPath,
      arguments: ["ls-files", "--stage", "-z"],
    }),
  ]);
  if (statusOutput === undefined) {
    return [];
  }

  const decorations = gitDecorationsFromStatusOutput(statusOutput);
  if (stagedFilesOutput !== undefined) {
    addSubmoduleDecorations({
      output: stagedFilesOutput,
      decorations,
    });
  }

  const result: FileTreeGitDecoration[] = [];
  for (const [decorationPath, status] of decorations) {
    const absoluteDecorationPath = path.resolve(
      gitRootPath,
      ...decorationPath.split("/"),
    );
    if (
      !pathIsInside({
        parentPath: workspaceRootPath,
        candidatePath: absoluteDecorationPath,
      })
    ) {
      continue;
    }
    result.push({
      path: normalizedGitPath(
        path.relative(workspaceRootPath, absoluteDecorationPath),
      ),
      status,
    });
  }
  result.sort((leftDecoration, rightDecoration) =>
    leftDecoration.path.localeCompare(rightDecoration.path),
  );
  return result;
}

function closeFileTreeWatcher(watcherId: number): void {
  const activeWatcher = activeFileTreeWatchers.get(watcherId);
  if (activeWatcher === undefined) {
    return;
  }
  activeFileTreeWatchers.delete(watcherId);
  if (activeWatcher.debounceTimer !== undefined) {
    clearTimeout(activeWatcher.debounceTimer);
  }
  activeWatcher.sender.removeListener(
    "destroyed",
    activeWatcher.senderDestroyedListener,
  );
  for (const fileSystemWatcher of activeWatcher.fileSystemWatchers) {
    fileSystemWatcher.close();
  }
}

function sendFileTreeChanges(watcherId: number): void {
  const activeWatcher = activeFileTreeWatchers.get(watcherId);
  if (activeWatcher === undefined) {
    return;
  }
  activeWatcher.debounceTimer = undefined;
  if (activeWatcher.sender.isDestroyed()) {
    closeFileTreeWatcher(watcherId);
    return;
  }
  let changedPaths: string[] | null = Array.from(activeWatcher.changedPaths);
  if (activeWatcher.unknownPathChanged) {
    changedPaths = null;
  }
  activeWatcher.changedPaths.clear();
  activeWatcher.unknownPathChanged = false;
  const message: FileTreeChangeMessage = {
    watcherId,
    paths: changedPaths,
  };
  activeWatcher.sender.send("file-tree:changed", message);
}

function scheduleFileTreeChange({
  watcherId,
  changedPath,
}: ScheduleFileTreeChangeOptions): void {
  const activeWatcher = activeFileTreeWatchers.get(watcherId);
  if (activeWatcher === undefined) {
    return;
  }
  if (changedPath === undefined) {
    activeWatcher.unknownPathChanged = true;
    activeWatcher.changedPaths.clear();
  } else if (!activeWatcher.unknownPathChanged) {
    const normalizedPath = normalizedGitPath(changedPath);
    if (
      normalizedPath === ".git/index.lock" ||
      normalizedPath.includes("/.git/index.lock") ||
      normalizedPath.includes("/.watchman-cookie-")
    ) {
      return;
    }
    activeWatcher.changedPaths.add(normalizedPath);
    if (
      activeWatcher.changedPaths.size > FILE_TREE_WATCH_PATH_LIMIT
    ) {
      activeWatcher.changedPaths.clear();
      activeWatcher.unknownPathChanged = true;
    }
  }
  if (activeWatcher.debounceTimer !== undefined) {
    return;
  }
  activeWatcher.debounceTimer = setTimeout(() => {
    sendFileTreeChanges(watcherId);
  }, FILE_TREE_WATCH_DEBOUNCE_MS);
}

function addFileSystemWatcher({
  activeWatcher,
  watchedPath,
  workspaceRootPath,
  gitMetadata,
}: AddFileSystemWatcherOptions): void {
  const fileSystemWatcher = watch(
    watchedPath,
    {
      recursive: true,
      encoding: "utf8",
    },
    (_eventType, fileName) => {
      let changedPath: string | undefined;
      if (fileName !== null && fileName.length > 0) {
        if (gitMetadata) {
          changedPath = `.git/${fileName}`;
        } else {
          changedPath = path.relative(
            workspaceRootPath,
            path.join(watchedPath, fileName),
          );
        }
      }
      scheduleFileTreeChange({
        watcherId: activeWatcher.watcherId,
        changedPath,
      });
    },
  );
  fileSystemWatcher.on("error", () => {
    if (!gitMetadata) {
      if (!activeWatcher.sender.isDestroyed()) {
        const message: FileTreeChangeMessage = {
          watcherId: activeWatcher.watcherId,
          paths: null,
          stopped: true,
        };
        activeWatcher.sender.send("file-tree:changed", message);
      }
      closeFileTreeWatcher(activeWatcher.watcherId);
      return;
    }
    const watcherPosition = activeWatcher.fileSystemWatchers.indexOf(
      fileSystemWatcher,
    );
    if (watcherPosition >= 0) {
      activeWatcher.fileSystemWatchers.splice(watcherPosition, 1);
    }
    fileSystemWatcher.close();
  });
  activeWatcher.fileSystemWatchers.push(fileSystemWatcher);
}

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
  | { entries: FileTreeEntry[] }
  | { error: string };

// Git failure leaves the candidate directory as the workspace root.
async function gitRootForDirectory(
  directoryPath: string,
): Promise<string | undefined> {
  const output = await runGit({
    directoryPath,
    arguments: ["rev-parse", "--show-toplevel"],
  });
  if (output === undefined) {
    return undefined;
  }
  const workspaceRootPath = output.trim();
  if (workspaceRootPath.length === 0) {
    return undefined;
  }
  return workspaceRootPath;
}

async function gitMetadataDirectory({
  workspaceRootPath,
  argument,
}: GitMetadataDirectoryOptions): Promise<string | undefined> {
  const output = await runGit({
    directoryPath: workspaceRootPath,
    arguments: ["rev-parse", "--path-format=absolute", argument],
  });
  if (output === undefined) {
    return undefined;
  }
  const gitMetadataPath = output.trim();
  if (gitMetadataPath.length === 0) {
    return undefined;
  }
  try {
    return await realpath(gitMetadataPath);
  } catch {
    return undefined;
  }
}

async function workspaceRootForFile(
  request: ReadFileTreeRequest,
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
  request: ReadFileTreeRequest,
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
  request: ReadFileTreeRequest,
  workspaceRootPath: string,
): Promise<ResolveWorkspaceDirectoryResult> {
  let requestedDirectoryPath = workspaceRootPath;
  if (request.workspaceRelativeDirectoryPath !== undefined) {
    requestedDirectoryPath = path.resolve(
      workspaceRootPath,
      request.workspaceRelativeDirectoryPath,
    );
  }
  if (
    !pathIsInside({
      parentPath: workspaceRootPath,
      candidatePath: requestedDirectoryPath,
    })
  ) {
    return { error: "Can't read outside the workspace root" };
  }

  try {
    const canonicalDirectoryPath = await realpath(requestedDirectoryPath);
    if (canonicalDirectoryPath !== requestedDirectoryPath) {
      return { error: "Can't read a directory through a symbolic link" };
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
  const entries: FileTreeEntry[] = [];
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
      const relativePath = normalizedGitPath(
        path.relative(workspaceRootPath, entryPath),
      );
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
  "file-tree:read",
  async (
    _event,
    request: ReadFileTreeRequest,
  ): Promise<ReadFileTreeResult> => {
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

ipcMain.handle(
  "file-tree:read-git-decorations",
  async (
    _event,
    unvalidatedRequest: unknown,
  ): Promise<ReadFileTreeGitDecorationsResult> => {
    const requestResult =
      readFileTreeGitDecorationsRequestSchema.safeParse(
        unvalidatedRequest,
      );
    if (!requestResult.success) {
      return {
        workspaceRootPath: "",
        decorations: [],
      };
    }
    let workspaceRootPath = requestResult.data.workspaceRootPath;
    try {
      workspaceRootPath = await realpath(workspaceRootPath);
    } catch {
      return {
        workspaceRootPath,
        decorations: [],
      };
    }
    return {
      workspaceRootPath,
      decorations: await readGitDecorations(workspaceRootPath),
    };
  },
);

ipcMain.handle(
  "file-tree:watch",
  async (
    event,
    unvalidatedRequest: unknown,
  ): Promise<WatchFileTreeResult> => {
    const requestResult = watchFileTreeRequestSchema.safeParse(
      unvalidatedRequest,
    );
    if (!requestResult.success) {
      return { error: "Invalid file-tree watch request" };
    }

    let workspaceRootPath: string;
    try {
      workspaceRootPath = await realpath(
        requestResult.data.workspaceRootPath,
      );
    } catch (error) {
      return { error: String(error) };
    }

    let watchedTreePath = workspaceRootPath;
    const discoveredGitRootPath = await gitRootForDirectory(
      workspaceRootPath,
    );
    if (discoveredGitRootPath !== undefined) {
      try {
        watchedTreePath = await realpath(discoveredGitRootPath);
      } catch {
        // realpath failing leaves the workspace root as the watched tree
      }
    }
    const [gitCommonDirectoryPath, gitDirectoryPath] = await Promise.all([
      gitMetadataDirectory({
        workspaceRootPath,
        argument: "--git-common-dir",
      }),
      gitMetadataDirectory({
        workspaceRootPath,
        argument: "--git-dir",
      }),
    ]);
    if (event.sender.isDestroyed()) {
      return { error: "Renderer closed before the watcher started" };
    }

    const watcherId = nextFileTreeWatcherId;
    nextFileTreeWatcherId += 1;
    const senderDestroyedListener = (): void => {
      closeFileTreeWatcher(watcherId);
    };
    const activeWatcher: ActiveFileTreeWatcher = {
      watcherId,
      sender: event.sender,
      fileSystemWatchers: [],
      changedPaths: new Set(),
      unknownPathChanged: false,
      debounceTimer: undefined,
      senderDestroyedListener,
    };
    activeFileTreeWatchers.set(watcherId, activeWatcher);
    event.sender.once("destroyed", senderDestroyedListener);

    try {
      addFileSystemWatcher({
        activeWatcher,
        watchedPath: watchedTreePath,
        workspaceRootPath,
        gitMetadata: false,
      });
    } catch (error) {
      closeFileTreeWatcher(watcherId);
      return { error: String(error) };
    }

    const watchedPaths = [watchedTreePath];
    const metadataPaths = [gitCommonDirectoryPath, gitDirectoryPath];
    for (const metadataPath of metadataPaths) {
      if (metadataPath === undefined) {
        continue;
      }
      let alreadyWatched = false;
      for (const watchedPath of watchedPaths) {
        if (
          pathIsInside({
            parentPath: watchedPath,
            candidatePath: metadataPath,
          })
        ) {
          alreadyWatched = true;
          break;
        }
      }
      if (alreadyWatched) {
        continue;
      }
      try {
        addFileSystemWatcher({
          activeWatcher,
          watchedPath: metadataPath,
          workspaceRootPath,
          gitMetadata: true,
        });
        watchedPaths.push(metadataPath);
      } catch {
        // Working-tree changes still refresh when Git metadata cannot.
      }
    }

    return { watcherId };
  },
);

ipcMain.on(
  "file-tree:unwatch",
  (event, unvalidatedRequest: unknown) => {
    const requestResult = unwatchFileTreeRequestSchema.safeParse(
      unvalidatedRequest,
    );
    if (!requestResult.success) {
      return;
    }
    const activeWatcher = activeFileTreeWatchers.get(
      requestResult.data.watcherId,
    );
    if (
      activeWatcher === undefined ||
      activeWatcher.sender.id !== event.sender.id
    ) {
      return;
    }
    closeFileTreeWatcher(requestResult.data.watcherId);
  },
);
