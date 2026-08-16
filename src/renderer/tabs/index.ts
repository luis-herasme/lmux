// The tab store's front door: what a tab is, the one dispatcher every
// Command arrives at, and the few things that are not Commands at all
// (reading a screen, restoring a session, shell bytes arriving).
import { bridge } from "../bridge.ts";
import { executeTabCommand } from "./tab-commands.ts";
import {
  ensureProjectPanel,
  executeProjectCommand,
  resolveProject,
} from "./project-commands.ts";
import { executeWorkspaceCommand } from "./workspace-commands.ts";
import { applySettings } from "./settings-command.ts";
import { openProjectFile } from "../project-panel.ts";
import { openMarkdownTab } from "./markdown-tab.tsx";
import type { MarkdownTab } from "./markdown-tab.tsx";
import { openTerminalTab, readTerminalScreen } from "./terminal-tab.ts";
import type { TerminalTab } from "./terminal-tab.ts";
import { snapshot } from "../snapshot.ts";
import {
  activateWorkspace,
  createWorkspace,
  findTab,
  refreshProjectPanel,
  refreshWorkspaceName,
  setWorkspaceName,
} from "../workspaces.ts";
import type { Workspace } from "../workspaces.ts";
import type { Command, ScreenRequest, ScreenResult } from "../../api.ts";
import type { Session } from "../../session.ts";
import type { ShellDataMessage } from "../../ipc/bridge.ts";

export type Tab = TerminalTab | MarkdownTab;

// Every Command in the app, sorted into the families that carry them out.
// The cases are grouped, not handled, so this stays a table of contents.
export function executeCommand(command: Command): void {
  switch (command.type) {
    case "new-tab":
    case "close-tab":
    case "activate-tab":
    case "write":
    case "move-tab":
    case "split-tab":
    case "set-tab-title":
    case "toggle-maximize":
    case "open-markdown":
    case "set-markdown-mode":
    case "reload-markdown":
      executeTabCommand(command);
      return;
    case "open-project":
    case "close-project":
    case "change-workspace-root":
    case "open-file":
    case "close-file":
    case "set-file-markdown-mode":
      executeProjectCommand(command);
      return;
    case "new-workspace":
    case "close-workspace":
    case "activate-workspace":
    case "rename-workspace":
      executeWorkspaceCommand(command);
      return;
    case "update-settings":
      applySettings(command.settings);
      return;
  }
}

export function getTabTitle(id: number): string | undefined {
  return findTab(id)?.tab.title;
}

// What a tab shows, read out of xterm's own grid rather than off the wire:
// the escape sequences are already interpreted here, into exactly the
// characters the human is looking at. Not a Command, because there is no
// button that reads a pane (a person reads by looking), and because a
// Command is answered with a state snapshot broadcast to every observer,
// which is the wrong shape for one caller asking about one tab.
export function readScreen(request: ScreenRequest): ScreenResult {
  // a panel's id shares the counter the tabs draw from, so it is asked for
  // the same way a tab is
  const panel = resolveProject(request.tabId);
  if (panel !== undefined) {
    let path: string | null = null;
    let language: string | null = null;
    const file = panel.file;
    if (file !== undefined) {
      path = file.filePath;
      if (file.model !== undefined) {
        language = file.model.getLanguageId();
      }
    }
    return {
      kind: "project",
      workspaceRootPath: panel.workspaceRootPath,
      path,
      language,
    };
  }
  const found = findTab(request.tabId);
  if (found === undefined) {
    return { kind: "no-such-tab" };
  }
  if (found.tab.kind === "markdown") {
    return {
      kind: "markdown",
      path: found.tab.filePath,
      mode: found.tab.mode,
    };
  }
  return readTerminalScreen({
    tab: found.tab,
    rows: request.rows,
  });
}

// Rebuilding what the last run left behind. Not a Command: it is the boot
// path deciding what to open instead of one empty workspace, and it needs
// the tab records as it makes them, which no snapshot hands back.
//
// A workspace is filled while it is the active one, because xterm can only
// measure a visible container; the workspace you were last looking at is
// activated at the end.
export async function restoreSession(session: Session): Promise<void> {
  const restored: Workspace[] = [];
  for (const saved of session.workspaces) {
    const workspace = createWorkspace();
    activateWorkspace(workspace);
    bridge.emitEvent({
      type: "workspace-opened",
      id: workspace.id,
      state: snapshot(),
    });
    if (saved.name !== null) {
      workspace.namePinned = true;
      setWorkspaceName({
        workspace,
        name: saved.name,
      });
    }
    for (const tab of saved.tabs) {
      if (tab.kind === "markdown") {
        // awaited one at a time: a document is read from disk, and the tabs
        // must come back in the order they were in
        await openMarkdownTab({
          workspace,
          filePath: tab.path,
        });
        continue;
      }
      openTerminalTab({ workspace });
    }
    if (saved.project !== null) {
      const panel = await ensureProjectPanel({
        workspace,
        workspaceRootPath: saved.project.workspaceRootPath,
      });
      if (saved.project.filePath !== null) {
        await openProjectFile({
          panel,
          filePath: saved.project.filePath,
        });
      }
      // restored, not opened: the panel comes back on screen without the
      // keyboard, which belongs to the tab that was active
      panel.visible = saved.project.visible;
      refreshProjectPanel();
    }
    // the store keeps insertion order, so the saved position is the tab
    const restoredIds = Array.from(workspace.tabs.keys());
    const activeId = restoredIds.at(saved.activeIndex);
    if (activeId !== undefined) {
      const active = workspace.tabs.get(activeId);
      if (active) {
        active.panel.api.setActive();
      }
    }
    restored.push(workspace);
  }
  const lastActive = restored[session.activeIndex];
  if (lastActive) {
    activateWorkspace(lastActive);
  }
}

export function handleShellData(message: ShellDataMessage): void {
  const found = findTab(message.id);
  if (found === undefined || found.tab.kind !== "terminal") {
    return;
  }
  found.tab.terminal.write(message.data);
}

export function removeTab(id: number): void {
  const found = findTab(id);
  if (found === undefined) {
    return;
  }
  const { workspace, tab } = found;
  workspace.tabs.delete(id);
  tab.row.root.unmount();
  if (tab.kind === "terminal") {
    tab.observer.disconnect();
    tab.terminal.dispose();
  } else {
    tab.root.unmount();
  }
  if (id === workspace.activeId) {
    workspace.activeId = -1;
  }
  workspace.dockview.api.removePanel(tab.panel);
  // removing the last tab activates no other panel, so nothing else would
  // take the name off the tab that just left
  refreshWorkspaceName(workspace);
  bridge.emitEvent({
    type: "tab-closed",
    id,
    state: snapshot(),
  });
}
