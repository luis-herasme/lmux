import { BrowserWindow, ipcMain } from "electron";
import type { Command, LmuxEvent, LmuxState } from "../api.ts";

export function dispatch(command: Command): void {
  BrowserWindow.getFocusedWindow()?.webContents.send("command", command);
}

// Read model: every Event carries a full snapshot, so the latest is truth.
// A live binding, so importers always read the current value.
export let lmuxState: LmuxState = {
  workspaces: [],
  activeWorkspaceId: -1,
};

ipcMain.on("event", (event, lmuxEvent: LmuxEvent) => {
  lmuxState = lmuxEvent.state;
  // Only a close can empty the app: a new workspace is momentarily empty
  // between its own Event and its first tab's, and must not count.
  if (
    lmuxEvent.type !== "tab-closed" &&
    lmuxEvent.type !== "workspace-closed"
  ) {
    return;
  }
  for (const workspace of lmuxState.workspaces) {
    if (workspace.tabs.length > 0) {
      return;
    }
  }
  BrowserWindow.fromWebContents(event.sender)?.close();
});
