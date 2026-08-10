// Menu items are Command sources: the renderer decides what a tab even is.
import { BrowserWindow, Menu, dialog, ipcMain } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { dispatch, lmuxState, runCommandUntil } from "./bus.ts";
import { chooseDirtyClose, confirmKilling } from "./dialogs.ts";
import type { CloseFileRequest } from "../ipc/bridge.ts";
import type { TabInfo, WorkspaceInfo } from "../api.ts";

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

// projectTabId defaults to the active tab, matching the Commands it forwards.
function tabInfo(projectTabId: number | undefined): TabInfo | undefined {
  if (projectTabId === undefined) {
    const workspace = workspaceInfo(undefined);
    if (workspace === undefined) {
      return undefined;
    }
    for (const tab of workspace.tabs) {
      if (tab.id === workspace.activeId) {
        return tab;
      }
    }
    return undefined;
  }
  for (const workspace of lmuxState.workspaces) {
    for (const tab of workspace.tabs) {
      if (tab.id === projectTabId) {
        return tab;
      }
    }
  }
  return undefined;
}

async function saveProjectFiles(projectTabId: number): Promise<boolean> {
  let timeoutMs: number | undefined = FILE_WRITE_TIMEOUT_MS;
  const tab = tabInfo(projectTabId);
  if (tab?.kind === "project") {
    for (const file of tab.files) {
      if (file.dirty && file.path === null) {
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

export async function saveDirtyTabs(tabs: TabInfo[]): Promise<boolean> {
  for (const tab of tabs) {
    if (tab.kind !== "project") {
      continue;
    }
    let dirty = false;
    for (const file of tab.files) {
      if (file.dirty) {
        dirty = true;
        break;
      }
    }
    if (!dirty) {
      continue;
    }
    const saved = await saveProjectFiles(tab.id);
    if (!saved) {
      return false;
    }
  }
  return true;
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
    tabs: workspace.tabs,
    action: "Closing the workspace",
  });
  if (dirtyChoice === "cancel") {
    return;
  }
  if (dirtyChoice === "save") {
    const saved = await saveDirtyTabs(workspace.tabs);
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

type CloseTabOptions = {
  window: BrowserWindow | null;
  tabId?: number;
};

async function closeTab({ window, tabId }: CloseTabOptions): Promise<void> {
  const tab = tabInfo(tabId);
  if (tab !== undefined && tab.kind === "project") {
    if (!window) {
      return;
    }
    const dirtyChoice = chooseDirtyClose({
      window,
      tabs: [tab],
      action: "Closing the project tab",
    });
    if (dirtyChoice === "cancel") {
      return;
    }
    if (dirtyChoice === "save") {
      const saved = await saveProjectFiles(tab.id);
      if (!saved) {
        return;
      }
    }
  }
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
  const tab = tabInfo(request.projectTabId);
  if (tab === undefined || tab.kind !== "project") {
    return;
  }
  if (!window) {
    return;
  }
  const dirtyChoice = chooseDirtyClose({
    window,
    tabs: [tab],
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

function closeActiveFileOrTab(window: BrowserWindow | null): void {
  const tab = tabInfo(undefined);
  if (tab !== undefined && tab.kind === "project") {
    if (tab.activeFilePath !== null) {
      closeFile({
        window,
        request: {
          projectTabId: tab.id,
          filePath: tab.activeFilePath,
        },
      });
      return;
    }
    if (tab.activeUntitledId !== undefined) {
      closeFile({
        window,
        request: {
          projectTabId: tab.id,
          untitledId: tab.activeUntitledId,
        },
      });
      return;
    }
  }
  closeTab({ window });
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
            label: "Open Project Tab",
            click: () => dispatch({ type: "open-project" }),
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
      click: () => {
        closeTab({
          window: BrowserWindow.getFocusedWindow(),
          tabId,
        });
      },
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

ipcMain.on("tab:close", (event, tabId: number) => {
  closeTab({
    window: BrowserWindow.fromWebContents(event.sender),
    tabId,
  });
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
