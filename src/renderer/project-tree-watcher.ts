// Keeping one panel's tree honest while the files under it change: the
// watcher main opens for its root, the changes that come back, and the git
// decorations re-read alongside them. A watcher can stop on its own (main's
// watch limit, an unmounted disk), so the retries live here too.
import { bridge } from "./bridge.ts";
import {
  projectTreeChangeMessageSchema,
  readProjectTreeGitDecorationsResultSchema,
  watchProjectTreeResultSchema,
} from "../ipc/bridge.ts";
import type {
  ReadProjectTreeGitDecorationsResult,
  WatchProjectTreeResult,
} from "../ipc/bridge.ts";
import {
  refreshProjectTreePaths,
  setProjectTreeGitDecorations,
} from "./project-tree.tsx";
import type { ProjectTree } from "./project-tree.tsx";
import type { ProjectPanel } from "./project-panel.ts";

export type ProjectTreeWatcher = {
  id: number | undefined; // main's handle, while one is open
  retryCount: number;
  retryTimer: number | undefined;
};

const PROJECT_TREE_WATCH_RETRY_LIMIT = 3;
const PROJECT_TREE_WATCH_RETRY_DELAY_MS = 500;

// A change message names a watcher, not a panel; this is how it finds its way
// home.
const projectPanelsByTreeWatcherId = new Map<number, ProjectPanel>();

type StartProjectTreeWatcherOptions = {
  panel: ProjectPanel;
  treeRequest: number;
};

type HandleProjectTreeChangeOptions = {
  panel: ProjectPanel;
  paths: string[] | null;
};

type ScheduleProjectTreeWatcherRetryOptions = {
  panel: ProjectPanel;
  projectTree: ProjectTree;
};

export function stopProjectTreeWatcher(panel: ProjectPanel): void {
  const watcher = panel.projectTreeWatcher;
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
  projectPanelsByTreeWatcherId.delete(watcherId);
  bridge.unwatchProjectTree({ watcherId });
}

async function refreshProjectTreeGitDecorations(
  panel: ProjectPanel,
): Promise<void> {
  const projectTree = panel.projectTree;
  if (projectTree === undefined) {
    return;
  }
  panel.latestGitRequest += 1;
  const gitRequest = panel.latestGitRequest;

  let result: ReadProjectTreeGitDecorationsResult;
  try {
    result = readProjectTreeGitDecorationsResultSchema.parse(
      await bridge.readProjectTreeGitDecorations({
        workspaceRootPath: projectTree.workspaceRootPath,
      }),
    );
  } catch {
    return;
  }
  if (
    gitRequest !== panel.latestGitRequest ||
    panel.projectTree !== projectTree ||
    result.workspaceRootPath !== projectTree.workspaceRootPath
  ) {
    return;
  }
  setProjectTreeGitDecorations({
    projectTree,
    decorations: result.decorations,
  });
}

export async function startProjectTreeWatcher({
  panel,
  treeRequest,
}: StartProjectTreeWatcherOptions): Promise<void> {
  const projectTree = panel.projectTree;
  if (projectTree === undefined) {
    return;
  }

  let result: WatchProjectTreeResult;
  try {
    result = watchProjectTreeResultSchema.parse(
      await bridge.watchProjectTree({
        workspaceRootPath: projectTree.workspaceRootPath,
      }),
    );
  } catch {
    return;
  }
  if ("error" in result) {
    return;
  }
  if (
    treeRequest !== panel.latestTreeRequest ||
    panel.projectTree !== projectTree
  ) {
    bridge.unwatchProjectTree({ watcherId: result.watcherId });
    return;
  }
  panel.projectTreeWatcher.id = result.watcherId;
  projectPanelsByTreeWatcherId.set(result.watcherId, panel);
}

export async function handleProjectTreeChange({
  panel,
  paths,
}: HandleProjectTreeChangeOptions): Promise<void> {
  const projectTree = panel.projectTree;
  if (projectTree === undefined) {
    return;
  }
  await refreshProjectTreePaths({
    projectTree,
    paths,
  });
  if (panel.projectTree !== projectTree) {
    return;
  }
  await refreshProjectTreeGitDecorations(panel);
}

function scheduleProjectTreeWatcherRetry({
  panel,
  projectTree,
}: ScheduleProjectTreeWatcherRetryOptions): void {
  const watcher = panel.projectTreeWatcher;
  if (
    watcher.retryCount >= PROJECT_TREE_WATCH_RETRY_LIMIT ||
    watcher.retryTimer !== undefined
  ) {
    return;
  }
  watcher.retryCount += 1;
  const retryDelay = PROJECT_TREE_WATCH_RETRY_DELAY_MS * watcher.retryCount;
  watcher.retryTimer = window.setTimeout(async () => {
    watcher.retryTimer = undefined;
    if (panel.projectTree !== projectTree || watcher.id !== undefined) {
      return;
    }
    const treeRequest = panel.latestTreeRequest;
    await startProjectTreeWatcher({
      panel,
      treeRequest,
    });
    if (
      panel.projectTree !== projectTree ||
      treeRequest !== panel.latestTreeRequest
    ) {
      return;
    }
    if (watcher.id === undefined) {
      scheduleProjectTreeWatcherRetry({
        panel,
        projectTree,
      });
      return;
    }
    await handleProjectTreeChange({
      panel,
      paths: null,
    });
  }, retryDelay);
}

bridge.onProjectTreeChanged(async (unvalidatedMessage) => {
  const messageResult = projectTreeChangeMessageSchema.safeParse(
    unvalidatedMessage,
  );
  if (!messageResult.success) {
    return;
  }
  const panel = projectPanelsByTreeWatcherId.get(messageResult.data.watcherId);
  if (
    panel === undefined ||
    panel.projectTreeWatcher.id !== messageResult.data.watcherId
  ) {
    return;
  }
  if (messageResult.data.stopped === true) {
    const projectTree = panel.projectTree;
    projectPanelsByTreeWatcherId.delete(messageResult.data.watcherId);
    panel.projectTreeWatcher.id = undefined;
    await handleProjectTreeChange({
      panel,
      paths: null,
    });
    if (projectTree !== undefined && panel.projectTree === projectTree) {
      scheduleProjectTreeWatcherRetry({
        panel,
        projectTree,
      });
    }
    return;
  }
  await handleProjectTreeChange({
    panel,
    paths: messageResult.data.paths,
  });
});
