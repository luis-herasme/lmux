// Menu items are Command sources: the renderer decides what a "tab" even is.
import { BrowserWindow, Menu, ipcMain } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { dispatch, lmuxState } from "./bus.ts";
import { confirmKilling } from "./dialogs.ts";

type CloseWorkspaceOptions = {
  // the question below needs a window to be asked in, and a click in the page
  // knows which one better than OS focus does: a page can send while another
  // app is frontmost, and then nothing is focused
  window: BrowserWindow | null;
  id?: number; // defaults to the active workspace, matching the Command
};

// Closing a workspace kills every shell in it.
function closeWorkspace({ window, id }: CloseWorkspaceOptions): void {
  if (!window) {
    return;
  }
  let workspaceId = id;
  if (workspaceId === undefined) {
    workspaceId = lmuxState.activeWorkspaceId;
  }
  const tabIds: number[] = [];
  for (const workspace of lmuxState.workspaces) {
    if (workspace.id !== workspaceId) {
      continue;
    }
    for (const tab of workspace.tabs) {
      tabIds.push(tab.id);
    }
  }
  const proceed = confirmKilling({
    window,
    tabIds,
    action: "Close Workspace",
  });
  if (!proceed) {
    return;
  }
  dispatch({
    type: "close-workspace",
    id: workspaceId,
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

// Positions, not names: the menu is built once, and a name can change
// while it is on screen.
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
            label: "Close Tab",
            accelerator: "CmdOrCtrl+W",
            click: () => dispatch({ type: "close-tab" }),
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
            click: () =>
              closeWorkspace({ window: BrowserWindow.getFocusedWindow() }),
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

ipcMain.on("tab:menu", (event, id: number) => {
  Menu.buildFromTemplate([
    {
      label: "Rename Tab…",
      click: () => event.sender.send("tab:rename-request", id),
    },
    {
      label: "Close Tab",
      click: () =>
        dispatch({
          type: "close-tab",
          id,
        }),
    },
    { type: "separator" },
    {
      label: "New Tab",
      click: () => dispatch({ type: "new-tab" }),
    },
  ]).popup();
});

// The sidebar's × is a person closing a workspace, like the menu item and
// the accelerator, so it comes here to be asked the same question.
ipcMain.on("workspace:close", (event, id: number) =>
  closeWorkspace({
    window: BrowserWindow.fromWebContents(event.sender),
    id,
  }),
);

ipcMain.on("workspace:menu", (event, id: number) => {
  Menu.buildFromTemplate([
    {
      label: "Rename Workspace…",
      click: () => event.sender.send("workspace:rename-request", id),
    },
    {
      label: "Close Workspace",
      click: () =>
        closeWorkspace({
          window: BrowserWindow.fromWebContents(event.sender),
          id,
        }),
    },
    { type: "separator" },
    {
      label: "New Workspace",
      click: () => dispatch({ type: "new-workspace" }),
    },
  ]).popup();
});
