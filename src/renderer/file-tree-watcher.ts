// Keeping one editor's tree honest while the files under it change: the
// watcher main opens for its root, the changes that come back, and the git
// decorations re-read alongside them. A watcher can stop on its own (main's
// watch limit, an unmounted disk), so the retries live here too.
import { bridge } from "./bridge.ts";
import {
  fileTreeChangeMessageSchema,
  readFileTreeGitDecorationsResultSchema,
  watchFileTreeResultSchema,
} from "../inter-process-communication/bridge.ts";
import type {
  ReadFileTreeGitDecorationsResult,
  WatchFileTreeResult,
} from "../inter-process-communication/bridge.ts";
import {
  refreshFileTreePaths,
  setFileTreeGitDecorations,
} from "./file-tree.tsx";
import type { FileTree } from "./file-tree.tsx";
import type { Editor } from "./editor.ts";

export type FileTreeWatcher = {
  id: number | undefined; // main's handle, while one is open
  retryCount: number;
  retryTimer: number | undefined;
};

const FILE_TREE_WATCH_RETRY_LIMIT = 3;
const FILE_TREE_WATCH_RETRY_DELAY_MS = 500;

// A change message names a watcher, not a editor; this is how it finds its way
// home.
const editorsByTreeWatcherId = new Map<number, Editor>();

type StartFileTreeWatcherOptions = {
  editor: Editor;
  treeRequest: number;
};

type HandleFileTreeChangeOptions = {
  editor: Editor;
  paths: string[] | null;
};

type ScheduleFileTreeWatcherRetryOptions = {
  editor: Editor;
  fileTree: FileTree;
};

export function stopFileTreeWatcher(editor: Editor): void {
  const watcher = editor.fileTreeWatcher;
  if (watcher.retryTimer !== undefined) {
    window.clearTimeout(watcher.retryTimer);
    watcher.retryTimer = undefined;
  }
  watcher.retryCount = 0;

  const watcherId = watcher.id;
  if (watcherId === undefined) {
    return;
  }
  watcher.id = undefined;
  editorsByTreeWatcherId.delete(watcherId);
  bridge.unwatchFileTree({ watcherId });
}

async function refreshFileTreeGitDecorations(
  editor: Editor,
): Promise<void> {
  const fileTree = editor.fileTree;
  if (fileTree === undefined) {
    return;
  }
  editor.latestGitRequest += 1;
  const gitRequest = editor.latestGitRequest;

  let result: ReadFileTreeGitDecorationsResult;
  try {
    result = readFileTreeGitDecorationsResultSchema.parse(
      await bridge.readFileTreeGitDecorations({
        workspaceRootPath: fileTree.workspaceRootPath,
      }),
    );
  } catch {
    return;
  }
  if (
    gitRequest !== editor.latestGitRequest ||
    editor.fileTree !== fileTree ||
    result.workspaceRootPath !== fileTree.workspaceRootPath
  ) {
    return;
  }
  setFileTreeGitDecorations({
    fileTree,
    decorations: result.decorations,
  });
}

export async function startFileTreeWatcher({
  editor,
  treeRequest,
}: StartFileTreeWatcherOptions): Promise<void> {
  const fileTree = editor.fileTree;
  if (fileTree === undefined) {
    return;
  }

  let result: WatchFileTreeResult;
  try {
    result = watchFileTreeResultSchema.parse(
      await bridge.watchFileTree({
        workspaceRootPath: fileTree.workspaceRootPath,
      }),
    );
  } catch {
    return;
  }
  if ("error" in result) {
    return;
  }
  if (
    treeRequest !== editor.latestTreeRequest ||
    editor.fileTree !== fileTree
  ) {
    bridge.unwatchFileTree({ watcherId: result.watcherId });
    return;
  }
  editor.fileTreeWatcher.id = result.watcherId;
  editorsByTreeWatcherId.set(result.watcherId, editor);
}

export async function handleFileTreeChange({
  editor,
  paths,
}: HandleFileTreeChangeOptions): Promise<void> {
  const fileTree = editor.fileTree;
  if (fileTree === undefined) {
    return;
  }
  await refreshFileTreePaths({
    fileTree,
    paths,
  });
  if (editor.fileTree !== fileTree) {
    return;
  }
  await refreshFileTreeGitDecorations(editor);
}

function scheduleFileTreeWatcherRetry({
  editor,
  fileTree,
}: ScheduleFileTreeWatcherRetryOptions): void {
  const watcher = editor.fileTreeWatcher;
  if (
    watcher.retryCount >= FILE_TREE_WATCH_RETRY_LIMIT ||
    watcher.retryTimer !== undefined
  ) {
    return;
  }
  watcher.retryCount += 1;
  const retryDelay = FILE_TREE_WATCH_RETRY_DELAY_MS * watcher.retryCount;
  watcher.retryTimer = window.setTimeout(async () => {
    watcher.retryTimer = undefined;
    if (editor.fileTree !== fileTree || watcher.id !== undefined) {
      return;
    }
    const treeRequest = editor.latestTreeRequest;
    await startFileTreeWatcher({
      editor,
      treeRequest,
    });
    if (
      editor.fileTree !== fileTree ||
      treeRequest !== editor.latestTreeRequest
    ) {
      return;
    }
    if (watcher.id === undefined) {
      scheduleFileTreeWatcherRetry({
        editor,
        fileTree,
      });
      return;
    }
    await handleFileTreeChange({
      editor,
      paths: null,
    });
  }, retryDelay);
}

bridge.onFileTreeChanged(async (unvalidatedMessage) => {
  const messageResult = fileTreeChangeMessageSchema.safeParse(
    unvalidatedMessage,
  );
  if (!messageResult.success) {
    return;
  }
  const editor = editorsByTreeWatcherId.get(messageResult.data.watcherId);
  if (
    editor === undefined ||
    editor.fileTreeWatcher.id !== messageResult.data.watcherId
  ) {
    return;
  }
  if (messageResult.data.stopped === true) {
    const fileTree = editor.fileTree;
    editorsByTreeWatcherId.delete(messageResult.data.watcherId);
    editor.fileTreeWatcher.id = undefined;
    await handleFileTreeChange({
      editor,
      paths: null,
    });
    if (fileTree !== undefined && editor.fileTree === fileTree) {
      scheduleFileTreeWatcherRetry({
        editor,
        fileTree,
      });
    }
    return;
  }
  await handleFileTreeChange({
    editor,
    paths: messageResult.data.paths,
  });
});
