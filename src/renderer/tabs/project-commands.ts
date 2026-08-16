// Every Command about a workspace's project panel: showing it, hiding it,
// rooting it somewhere else, and the one file it holds.
import { bridge } from "../bridge.ts";
import {
  changeProjectWorkspaceRoot,
  closeProjectFile,
  createProjectPanel,
  focusProjectPanel,
  openProjectFile,
  setProjectFileMarkdownMode,
} from "../project-panel.ts";
import type { ProjectPanel } from "../project-panel.ts";
import { snapshot } from "../snapshot.ts";
import {
  activeWorkspace,
  focusWorkspace,
  refreshProjectPanel,
  resolveWorkspace,
  workspaces,
} from "../workspaces.ts";
import type { Workspace } from "../workspaces.ts";
import type { Command } from "../../api.ts";

// A projectTabId names one workspace's panel, wherever that workspace is;
// without one the active workspace's panel is meant. A panel that has never
// been opened does not exist yet, and the command bails.
export function resolveProject(
  projectTabId: number | undefined,
): ProjectPanel | undefined {
  if (projectTabId === undefined) {
    return activeWorkspace?.project;
  }
  for (const workspace of workspaces.values()) {
    if (workspace.project?.id === projectTabId) {
      return workspace.project;
    }
  }
  return undefined;
}

export type OpenProjectOptions = {
  workspace: Workspace;
  baseTabId?: number; // the tab a relative path is resolved against
  workspaceRootPath?: string; // where to root a panel being built
  initialFilePath?: string;
};

// Building one waits on 4MB of Monaco, so a second request arriving
// meanwhile waits for the same panel rather than starting a second.
const pendingProjectPanels = new Map<Workspace, Promise<ProjectPanel>>();

export async function ensureProjectPanel(
  options: OpenProjectOptions,
): Promise<ProjectPanel> {
  const { workspace } = options;
  const existing = workspace.project;
  if (existing !== undefined) {
    return existing;
  }
  let pendingPanel = pendingProjectPanels.get(workspace);
  if (pendingPanel === undefined) {
    pendingPanel = createProjectPanel(options);
    pendingProjectPanels.set(workspace, pendingPanel);
  }
  let panel: ProjectPanel;
  try {
    panel = await pendingPanel;
  } finally {
    if (pendingProjectPanels.get(workspace) === pendingPanel) {
      pendingProjectPanels.delete(workspace);
    }
  }
  workspace.project = panel;
  return panel;
}

type ShowProjectPanelOptions = {
  workspace: Workspace;
  panel: ProjectPanel;
};

// Coming on screen is state plus an Event, so every command that opens
// something in the panel ends here. A background workspace's panel is
// opened without taking the keyboard away from the one on screen.
function showProjectPanel({ workspace, panel }: ShowProjectPanelOptions): void {
  const wasVisible = panel.visible;
  panel.visible = true;
  refreshProjectPanel();
  if (workspace === activeWorkspace) {
    workspace.focus = "project";
    focusProjectPanel(panel);
  }
  // the Event carries the state it produced, so it goes out once the
  // keyboard has moved too
  if (wasVisible) {
    return;
  }
  bridge.emitEvent({
    type: "project-opened",
    id: panel.id,
    state: snapshot(),
  });
}

async function openProject(options: OpenProjectOptions): Promise<void> {
  const { workspace, baseTabId, initialFilePath } = options;
  const panel = await ensureProjectPanel(options);
  // a new panel takes the path to find its root; opening the file is this
  if (initialFilePath !== undefined) {
    await openProjectFile({
      panel,
      filePath: initialFilePath,
      baseTabId,
    });
  }
  showProjectPanel({
    workspace,
    panel,
  });
}

export function executeProjectCommand(command: Command): void {
  switch (command.type) {
    case "open-file": {
      if (!activeWorkspace) {
        return;
      }
      openProject({
        workspace: activeWorkspace,
        baseTabId: command.baseTabId,
        initialFilePath: command.path,
      });
      return;
    }
    case "open-project": {
      const workspace = resolveWorkspace(command.workspaceId);
      if (workspace === undefined) {
        return;
      }
      let baseTabId = command.baseTabId;
      if (baseTabId === undefined) {
        baseTabId = workspace.activeId;
      }
      openProject({
        workspace,
        baseTabId,
      });
      return;
    }
    case "close-project": {
      const workspace = resolveWorkspace(command.workspaceId);
      const panel = workspace?.project;
      if (workspace === undefined || panel === undefined || !panel.visible) {
        return;
      }
      panel.visible = false;
      refreshProjectPanel();
      // the keyboard was in the panel that just left, so the panes take it
      if (workspace.focus === "project") {
        workspace.focus = "layout";
        focusWorkspace();
      }
      bridge.emitEvent({
        type: "project-closed",
        id: panel.id,
        state: snapshot(),
      });
      return;
    }
    case "change-workspace-root": {
      const workspace = resolveWorkspace(command.workspaceId);
      if (workspace === undefined) {
        return;
      }
      const panel = workspace.project;
      if (panel === undefined) {
        openProject({
          workspace,
          workspaceRootPath: command.path,
        });
        return;
      }
      changeProjectWorkspaceRoot({
        panel,
        workspaceRootPath: command.path,
      });
      showProjectPanel({
        workspace,
        panel,
      });
      return;
    }
    case "close-file": {
      const panel = resolveProject(command.projectTabId);
      if (panel === undefined) {
        return;
      }
      closeProjectFile(panel);
      return;
    }
    case "set-file-markdown-mode": {
      const panel = resolveProject(command.projectTabId);
      if (panel === undefined) {
        return;
      }
      setProjectFileMarkdownMode({
        panel,
        mode: command.mode,
      });
      return;
    }
  }
}
