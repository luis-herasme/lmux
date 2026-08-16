// Every Command about a workspace itself: opening one, closing one,
// bringing one forward, naming one.
import { bridge } from "./bridge.ts";
import { openTerminalTab } from "./tabs/terminal-tab.ts";
import { snapshot } from "./snapshot.ts";
import {
  activateWorkspace,
  activeWorkspace,
  createWorkspace,
  refreshWorkspaceName,
  removeWorkspace,
  resolveWorkspace,
  setWorkspaceName,
  workspaces,
} from "./workspaces.ts";
import type { Command } from "../api.ts";

export function executeWorkspaceCommand(command: Command): void {
  switch (command.type) {
    case "new-workspace": {
      const workspace = createWorkspace();
      activateWorkspace(workspace);
      bridge.emitEvent({
        type: "workspace-opened",
        id: workspace.id,
        state: snapshot(),
      });
      openTerminalTab({ workspace });
      return;
    }
    case "close-workspace": {
      const workspace = resolveWorkspace(command.id);
      if (workspace === undefined) {
        return;
      }
      // the window always has a workspace to show
      if (workspaces.size === 1) {
        return;
      }
      removeWorkspace(workspace);
      bridge.emitEvent({
        type: "workspace-closed",
        id: workspace.id,
        state: snapshot(),
      });
      return;
    }
    case "activate-workspace": {
      const workspace = workspaces.get(command.id);
      if (workspace === undefined || workspace === activeWorkspace) {
        return;
      }
      activateWorkspace(workspace);
      bridge.emitEvent({
        type: "workspace-activated",
        id: workspace.id,
        state: snapshot(),
      });
      return;
    }
    case "rename-workspace": {
      const workspace = resolveWorkspace(command.id);
      if (workspace === undefined) {
        return;
      }
      const name = command.name.trim();
      workspace.namePinned = name !== "";
      if (name === "") {
        refreshWorkspaceName(workspace);
      }
      if (name !== "") {
        setWorkspaceName({
          workspace,
          name,
        });
      }
      bridge.emitEvent({
        type: "workspace-renamed",
        id: workspace.id,
        state: snapshot(),
      });
      return;
    }
  }
}
