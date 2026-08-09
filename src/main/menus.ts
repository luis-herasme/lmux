// Menu items are Command sources: the renderer decides what a "tab" even is.
import { BrowserWindow, Menu, ipcMain } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { dispatch, lmuxState } from "./bus.ts";
import { confirmDiscardDirty, confirmKilling } from "./dialogs.ts";
import type { TabInfo } from "../api.ts";

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

// id defaults to the active tab, matching the Command it forwards. Returns
// undefined when there is no such tab to inspect.
function tabInfo(id: number | undefined): TabInfo | undefined {
  if (id === undefined) {
    for (const workspace of lmuxState.workspaces) {
      if (workspace.id !== lmuxState.activeWorkspaceId) {
        continue;
      }
      for (const tab of workspace.tabs) {
        if (tab.id === workspace.activeId) {
          return tab;
        }
      }
    }
    return undefined;
  }
  for (const workspace of lmuxState.workspaces) {
    for (const tab of workspace.tabs) {
      if (tab.id === id) {
        return tab;
      }
    }
  }
  return undefined;
}

type CloseTabOptions = {
  window: BrowserWindow | null;
  id?: number; // defaults to the active tab, matching the Command
};

// Closing a tab that shows unsaved work asks first; the answer decides
// whether the close Command goes out. A terminal tab never asks. An agent's
// own close-tab Command is not routed here: it has no window to ask in,
// exactly like close-workspace. A dirty close with no window to ask in is
// refused rather than silently losing the work; a clean close dispatches
// whatever the window state, as it always has.
function closeTab({ window, id }: CloseTabOptions): void {
  const tab = tabInfo(id);
  if (tab !== undefined && tab.kind === "code" && tab.dirty) {
    if (!window) {
      return;
    }
    const discard = confirmDiscardDirty({
      window,
      tabs: [tab],
      action: "Close Tab",
    });
    if (!discard) {
      return;
    }
  }
  dispatch({ type: "close-tab", id });
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
            click: () =>
              closeTab({ window: BrowserWindow.getFocusedWindow() }),
          },
          { type: "separator" },
          {
            label: "Save",
            accelerator: "CmdOrCtrl+S",
            click: () => dispatch({ type: "save-file" }),
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
        closeTab({
          window: BrowserWindow.getFocusedWindow(),
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

// A tab's × is a person closing that tab, so it comes here to be asked
// about unsaved work too.
ipcMain.on("tab:close", (event, id: number) =>
  closeTab({
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
