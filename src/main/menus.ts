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

// A panel belongs to a workspace but the Commands address it by its own id.
function projectInfo(projectTabId: number): ProjectInfo | null {
  for (const workspace of lmuxState.workspaces) {
    if (workspace.project?.id === projectTabId) {
      return workspace.project;
    }
  }
  return null;
}

export async function saveDirtyProjects(
  projects: ProjectInfo[],
): Promise<boolean> {
  for (const project of projects) {
    let dirty = false;
    let timeoutMs: number | undefined = FILE_WRITE_TIMEOUT_MS;
    for (const file of project.files) {
      if (!file.dirty) {
        continue;
      }
      dirty = true;
      if (file.path === null) {
        // an untitled buffer opens a save dialog, which waits on a person
        timeoutMs = undefined;
        break;
      }
    }
    if (!dirty) {
      continue;
    }
    const result = await runCommandUntil({
      command: {
        type: "save-all-files",
        projectTabId: project.id,
      },
      predicate: (event) =>
        event.type === "files-save-finished" && event.id === project.id,
      timeoutMs,
    });
    if (result === undefined || result.type !== "files-save-finished") {
      return false;
    }
    if (result.failedPaths.length > 0 || result.failedUntitledIds.length > 0) {
      return false;
    }
  }
  return true;
}

// The path the file landed on, null when it was not saved.
async function saveOneFile({
  projectTabId,
  filePath,
  untitledId,
}: CloseFileRequest): Promise<string | null> {
  let timeoutMs: number | undefined = FILE_WRITE_TIMEOUT_MS;
  if (untitledId !== undefined) {
    // an untitled buffer opens a save dialog, which waits on a person
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
      if (
        event.type !== "file-saved" &&
        event.type !== "file-save-failed" &&
        event.type !== "file-save-canceled"
      ) {
        return false;
      }
      if (event.id !== projectTabId) {
        return false;
      }
      if (filePath !== undefined) {
        // only an untitled buffer can be canceled, and it has no path
        return event.type !== "file-save-canceled" && event.path === filePath;
      }
      if (untitledId === undefined) {
        return false;
      }
      if (event.type === "file-saved") {
        return event.previousUntitledId === untitledId;
      }
      return event.untitledId === untitledId;
    },
    timeoutMs,
  });
  if (result === undefined || result.type !== "file-saved") {
    return null;
  }
  return result.path;
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
  // the workspace's panel, empty when it has never opened one
  const projects: ProjectInfo[] = [];
  if (workspace.project !== null) {
    projects.push(workspace.project);
  }
  const dirtyChoice = chooseDirtyClose({
    window,
    projects,
    action: "Closing the workspace",
  });
  if (dirtyChoice === "cancel") {
    return;
  }
  if (dirtyChoice === "save") {
    const saved = await saveDirtyProjects(projects);
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

type CloseFileOptions = {
  window: BrowserWindow | null;
  request: CloseFileRequest;
};

async function closeFile({
  window,
  request,
}: CloseFileOptions): Promise<void> {
  const project = projectInfo(request.projectTabId);
  if (project === null || !window) {
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
  let path = request.filePath;
  let untitledId = request.untitledId;
  if (dirtyChoice === "save") {
    const savedPath = await saveOneFile(request);
    if (savedPath === null) {
      return;
    }
    // saving gave an untitled buffer the path it is now known by
    path = savedPath;
    untitledId = undefined;
  }
  dispatch({
    type: "close-file",
    projectTabId: request.projectTabId,
    path,
    untitledId,
  });
}

// ⌘W means the file you are looking at while the keyboard is in the panel,
// and the tab you are looking at otherwise.
function closeActiveFileOrTab(window: BrowserWindow | null): void {
  const workspace = workspaceInfo(undefined);
  const project = workspace?.project;
  if (project?.visible === true && workspace?.focus === "project") {
    // the file on screen is named by its path, or by an untitled id until it
    // has one
    const request: CloseFileRequest = { projectTabId: project.id };
    if (project.activeFilePath === null) {
      request.untitledId = project.activeUntitledId;
    } else {
      request.filePath = project.activeFilePath;
    }
    if (request.filePath !== undefined || request.untitledId !== undefined) {
      closeFile({
        window,
        request,
      });
      return;
    }
  }
  // No tab holds an unsaved file, only the panel does, so this asks nothing.
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

ipcMain.on("tab:close", (_event, tabId: number) => {
  dispatch({
    type: "close-tab",
    id: tabId,
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
