// Menu items are Command sources: the renderer decides what a tab even is.
import { BrowserWindow, Menu, dialog, ipcMain } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { dispatch, lmuxState, runCommandUntil } from "./bus.ts";
import { chooseDirtyClose, confirmKilling } from "./dialogs.ts";
import type { CloseFileRequest } from "../ipc/bridge.ts";
import type { ProjectInfo, WorkspaceInfo } from "../api.ts";

const FILE_WRITE_TIMEOUT_MS = 5000; // 5 seconds

type CloseWorkspaceOptions = {
  // the question below needs a window to be asked in, and a click in the page
  // knows which one better than OS focus does.
  window: BrowserWindow | null;
  workspaceId?: number;
};

function workspaceInfo(
  workspaceId: number | undefined,
): WorkspaceInfo | undefined {
  let resolvedWorkspaceId = workspaceId;
  if (resolvedWorkspaceId === undefined) {
    resolvedWorkspaceId = lmuxState.activeWorkspaceId;
  }
  for (const workspace of lmuxState.workspaces) {
    if (workspace.id === resolvedWorkspaceId) {
      return workspace;
    }
  }
  return undefined;
}

// projectTabId defaults to the active workspace's panel, matching the
// Commands it forwards.
function projectInfo(projectTabId: number | undefined): ProjectInfo | null {
  if (projectTabId === undefined) {
    const workspace = workspaceInfo(undefined);
    if (workspace === undefined) {
      return null;
    }
    return workspace.project;
  }
  for (const workspace of lmuxState.workspaces) {
    if (workspace.project?.id === projectTabId) {
      return workspace.project;
    }
  }
  return null;
}

async function saveProjectFiles(projectTabId: number): Promise<boolean> {
  let timeoutMs: number | undefined = FILE_WRITE_TIMEOUT_MS;
  const project = projectInfo(projectTabId);
  if (project !== null) {
    for (const file of project.files) {
      if (file.dirty && file.path === null) {
        // an untitled buffer opens a save dialog, which waits on a person
        timeoutMs = undefined;
        break;
      }
    }
  }
  const result = await runCommandUntil({
    command: {
      type: "save-all-files",
      projectTabId,
    },
    predicate: (event) =>
      event.type === "files-save-finished" && event.id === projectTabId,
    timeoutMs,
  });
  if (result === undefined || result.type !== "files-save-finished") {
    return false;
  }
  return (
    result.failedPaths.length === 0 && result.failedUntitledIds.length === 0
  );
}

type SaveOneFileOptions = {
  projectTabId: number;
  filePath: string | undefined;
  untitledId: number | undefined;
};

type SaveOneFileResult =
  | { saved: true; filePath: string }
  | { saved: false };

async function saveOneFile({
  projectTabId,
  filePath,
  untitledId,
}: SaveOneFileOptions): Promise<SaveOneFileResult> {
  let timeoutMs: number | undefined = FILE_WRITE_TIMEOUT_MS;
  if (untitledId !== undefined) {
    timeoutMs = undefined;
  }
  const result = await runCommandUntil({
    command: {
      type: "save-file",
      projectTabId,
      path: filePath,
      untitledId,
    },
    predicate: (event) => {
      if (filePath !== undefined) {
        if (
          event.type !== "file-saved" &&
          event.type !== "file-save-failed"
        ) {
          return false;
        }
        return event.id === projectTabId && event.path === filePath;
      }
      if (untitledId === undefined) {
        return false;
      }
      if (event.type === "file-saved") {
        return (
          event.id === projectTabId &&
          event.previousUntitledId === untitledId
        );
      }
      if (
        event.type === "file-save-failed" ||
        event.type === "file-save-canceled"
      ) {
        return event.id === projectTabId && event.untitledId === untitledId;
      }
      return false;
    },
    timeoutMs,
  });
  if (result === undefined || result.type !== "file-saved") {
    return { saved: false };
  }
  return {
    saved: true,
    filePath: result.path,
  };
}

export async function saveDirtyProjects(
  projects: ProjectInfo[],
): Promise<boolean> {
  for (const project of projects) {
    let dirty = false;
    for (const file of project.files) {
      if (file.dirty) {
        dirty = true;
        break;
      }
    }
    if (!dirty) {
      continue;
    }
    const saved = await saveProjectFiles(project.id);
    if (!saved) {
      return false;
    }
  }
  return true;
}

// A workspace's panel, as the list chooseDirtyClose and the save above
// both take; empty when it has never been opened.
function projectsOfWorkspace(workspace: WorkspaceInfo): ProjectInfo[] {
  if (workspace.project === null) {
    return [];
  }
  return [workspace.project];
}

// Closing a workspace kills every shell and guards every dirty file in it.
async function closeWorkspace({
  window,
  workspaceId,
}: CloseWorkspaceOptions): Promise<void> {
  if (!window) {
    return;
  }
  const workspace = workspaceInfo(workspaceId);
  if (workspace === undefined) {
    return;
  }
  const tabIds: number[] = [];
  for (const tab of workspace.tabs) {
    tabIds.push(tab.id);
  }
  const killingConfirmed = confirmKilling({
    window,
    tabIds,
    action: "Close Workspace",
  });
  if (!killingConfirmed) {
    return;
  }
  const dirtyChoice = chooseDirtyClose({
    window,
    projects: projectsOfWorkspace(workspace),
    action: "Closing the workspace",
  });
  if (dirtyChoice === "cancel") {
    return;
  }
  if (dirtyChoice === "save") {
    const saved = await saveDirtyProjects(projectsOfWorkspace(workspace));
    if (!saved) {
      return;
    }
  }
  dispatch({
    type: "close-workspace",
    id: workspace.id,
  });
}

// The sidebar lists workspaces by position; the Command carries an id.
function activateWorkspaceAt(position: number): void {
  const workspace = lmuxState.workspaces[position];
  if (workspace === undefined) {
    return;
  }
  dispatch({
    type: "activate-workspace",
    id: workspace.id,
  });
}

// Wraps at both ends, so holding the shortcut walks the whole sidebar.
function cycleWorkspace(step: number): void {
  const workspaces = lmuxState.workspaces;
  if (workspaces.length === 0) {
    return;
  }
  let active = 0;
  for (const [position, workspace] of workspaces.entries()) {
    if (workspace.id === lmuxState.activeWorkspaceId) {
      active = position;
      break;
    }
  }
  activateWorkspaceAt((active + step + workspaces.length) % workspaces.length);
}

// Every tab is a terminal or a document now, and neither holds an unsaved
// file: only the project panel does, and it is not closed by closing a tab.
function closeTab(tabId: number | undefined): void {
  dispatch({
    type: "close-tab",
    id: tabId,
  });
}

type CloseFileOptions = {
  window: BrowserWindow | null;
  request: CloseFileRequest;
};

async function closeFile({
  window,
  request,
}: CloseFileOptions): Promise<void> {
  const project = projectInfo(request.projectTabId);
  if (project === null) {
    return;
  }
  if (!window) {
    return;
  }
  const dirtyChoice = chooseDirtyClose({
    window,
    projects: [project],
    action: "Closing the file",
    onlyFilePath: request.filePath,
    onlyUntitledId: request.untitledId,
  });
  if (dirtyChoice === "cancel") {
    return;
  }
  if (dirtyChoice === "save") {
    const result = await saveOneFile({
      projectTabId: request.projectTabId,
      filePath: request.filePath,
      untitledId: request.untitledId,
    });
    if (!result.saved) {
      return;
    }
    dispatch({
      type: "close-file",
      projectTabId: request.projectTabId,
      path: result.filePath,
    });
    return;
  }
  dispatch({
    type: "close-file",
    projectTabId: request.projectTabId,
    path: request.filePath,
    untitledId: request.untitledId,
  });
}

// ⌘W means the file you are looking at while the keyboard is in the panel,
// and the tab you are looking at otherwise.
function closeActiveFileOrTab(window: BrowserWindow | null): void {
  const workspace = workspaceInfo(undefined);
  const project = workspace?.project;
  if (
    workspace !== undefined &&
    project !== null &&
    project !== undefined &&
    project.visible &&
    workspace.focus === "project"
  ) {
    if (project.activeFilePath !== null) {
      closeFile({
        window,
        request: {
          projectTabId: project.id,
          filePath: project.activeFilePath,
        },
      });
      return;
    }
    if (project.activeUntitledId !== undefined) {
      closeFile({
        window,
        request: {
          projectTabId: project.id,
          untitledId: project.activeUntitledId,
        },
      });
      return;
    }
  }
  closeTab(undefined);
}

// One menu item for both directions: the panel is state, so main can read
// whether it is on screen and ask for the other one.
function toggleProjectPanel(): void {
  const workspace = workspaceInfo(undefined);
  if (workspace?.project?.visible === true) {
    dispatch({ type: "close-project" });
    return;
  }
  dispatch({ type: "open-project" });
}

async function chooseWorkspaceRoot(): Promise<void> {
  const window = BrowserWindow.getFocusedWindow();
  if (!window) {
    return;
  }
  const result = await dialog.showOpenDialog(window, {
    title: "Change Workspace Root",
    properties: ["openDirectory"],
  });
  if (result.canceled) {
    return;
  }
  const workspaceRootPath = result.filePaths.at(0);
  if (workspaceRootPath === undefined) {
    return;
  }
  dispatch({
    type: "change-workspace-root",
    path: workspaceRootPath,
  });
}

// Positions, not names: the menu is built once, and a name can change.
const workspacePositionItems: MenuItemConstructorOptions[] = [];
for (let position = 0; position < 9; position++) {
  workspacePositionItems.push({
    label: `Workspace ${position + 1}`,
    accelerator: `Control+${position + 1}`,
    click: () => activateWorkspaceAt(position),
  });
}

export function installAppMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      {
        label: "File",
        submenu: [
          {
            label: "New Tab",
            accelerator: "CmdOrCtrl+T",
            click: () => dispatch({ type: "new-tab" }),
          },
          {
            label: "Project Panel",
            accelerator: "CmdOrCtrl+B",
            click: () => toggleProjectPanel(),
          },
          {
            label: "Change Workspace Root…",
            click: () => {
              chooseWorkspaceRoot();
            },
          },
          {
            label: "Close File",
            accelerator: "CmdOrCtrl+W",
            click: () => {
              closeActiveFileOrTab(BrowserWindow.getFocusedWindow());
            },
          },
          { type: "separator" },
          {
            label: "Save",
            accelerator: "CmdOrCtrl+S",
            click: () => dispatch({ type: "save-file" }),
          },
          {
            label: "Save All",
            accelerator: "Alt+CmdOrCtrl+S",
            click: () => dispatch({ type: "save-all-files" }),
          },
        ],
      },
      {
        label: "Workspace",
        submenu: [
          {
            label: "New Workspace",
            accelerator: "Shift+CmdOrCtrl+T",
            click: () => dispatch({ type: "new-workspace" }),
          },
          {
            label: "Close Workspace",
            accelerator: "Shift+CmdOrCtrl+W",
            click: () => {
              closeWorkspace({
                window: BrowserWindow.getFocusedWindow(),
              });
            },
          },
          { type: "separator" },
          {
            label: "Next Workspace",
            accelerator: "Control+Tab",
            click: () => cycleWorkspace(1),
          },
          {
            label: "Previous Workspace",
            accelerator: "Shift+Control+Tab",
            click: () => cycleWorkspace(-1),
          },
          { type: "separator" },
          ...workspacePositionItems,
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

ipcMain.on("tab:menu", (event, tabId: number) => {
  Menu.buildFromTemplate([
    {
      label: "Rename Tab…",
      click: () => event.sender.send("tab:rename-request", tabId),
    },
    {
      label: "Close Tab",
      click: () => closeTab(tabId),
    },
    { type: "separator" },
    {
      label: "New Tab",
      click: () => dispatch({ type: "new-tab" }),
    },
  ]).popup();
});

ipcMain.on("workspace:close", (event, workspaceId: number) => {
  closeWorkspace({
    window: BrowserWindow.fromWebContents(event.sender),
    workspaceId,
  });
});

ipcMain.on("tab:close", (_event, tabId: number) => {
  closeTab(tabId);
});

ipcMain.on("file:close", (event, request: CloseFileRequest) => {
  closeFile({
    window: BrowserWindow.fromWebContents(event.sender),
    request,
  });
});

ipcMain.on("workspace:menu", (event, workspaceId: number) => {
  Menu.buildFromTemplate([
    {
      label: "Rename Workspace…",
      click: () =>
        event.sender.send("workspace:rename-request", workspaceId),
    },
    {
      label: "Close Workspace",
      click: () => {
        closeWorkspace({
          window: BrowserWindow.fromWebContents(event.sender),
          workspaceId,
        });
      },
    },
    { type: "separator" },
    {
      label: "New Workspace",
      click: () => dispatch({ type: "new-workspace" }),
    },
  ]).popup();
});
