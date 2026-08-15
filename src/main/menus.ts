// Menu items are Command sources: the renderer decides what a tab even is.
import { BrowserWindow, Menu, dialog, ipcMain } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { dispatch, lmuxState } from "./bus.ts";
import { confirmKilling } from "./dialogs.ts";
import type { WorkspaceInfo } from "../api.ts";

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

// Closing a workspace kills every shell in it.
function closeWorkspace({
  window,
  workspaceId,
}: CloseWorkspaceOptions): void {
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

// ⌘W means the file you are looking at while the keyboard is in the panel,
// and the tab you are looking at otherwise.
function closeActiveFileOrTab(): void {
  const workspace = workspaceInfo(undefined);
  const project = workspace?.project;
  if (
    project?.visible === true &&
    workspace?.focus === "project" &&
    project.filePath !== null
  ) {
    dispatch({
      type: "close-file",
      projectTabId: project.id,
    });
    return;
  }
  dispatch({
    type: "close-tab",
    id: undefined, // the active tab
  });
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
            click: () => closeActiveFileOrTab(),
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
      click: () =>
        dispatch({
          type: "close-tab",
          id: tabId,
        }),
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
