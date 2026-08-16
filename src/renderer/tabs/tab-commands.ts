// Every Command about a tab: opening, closing, moving, titling, and the two
// a document answers.
import { bridge } from "../bridge.ts";
import { executeCommand, removeTab } from "./index.ts";
import type { Tab } from "./index.ts";
import {
  openMarkdownTab,
  reloadMarkdownTab,
  setMarkdownMode,
} from "./markdown-tab.tsx";
import { openTerminalTab } from "./terminal-tab.ts";
import { drawTabRow } from "../tab-strip.tsx";
import {
  activeWorkspace,
  findGroup,
  findTab,
  refreshWorkspaceName,
  snapshot,
} from "../workspaces.ts";
import type { Workspace } from "../workspaces.ts";
import type { Command } from "../../api.ts";
import type { DockviewGroupPanel } from "dockview";

// A resolved tab is the caller's explicit id or the active workspace's
// active tab, when optional; every command that touches a tab resolves
// through these.
type ResolvedTab = {
  id: number;
  tab: Tab;
  workspace: Workspace;
};

function resolveTab(id: number | undefined): ResolvedTab | undefined {
  let resolvedId = id;
  if (resolvedId === undefined) {
    if (!activeWorkspace) {
      return undefined;
    }
    resolvedId = activeWorkspace.activeId;
  }
  const found = findTab(resolvedId);
  if (found === undefined) {
    return undefined;
  }
  return {
    id: resolvedId,
    tab: found.tab,
    workspace: found.workspace,
  };
}

type ResolveTargetGroupOptions = {
  resolved: ResolvedTab;
  groupId: string | undefined;
};

// move/split command group resolution: falls back to the tab's own group;
// undefined means the named group wasn't found and the command bails.
function resolveTargetGroup({
  resolved,
  groupId,
}: ResolveTargetGroupOptions): DockviewGroupPanel | undefined {
  if (groupId === undefined) {
    return resolved.tab.panel.group;
  }
  return findGroup({
    workspace: resolved.workspace,
    groupId,
  });
}

// Where a new tab goes: the active workspace, in the group the command
// named or, with none named, the active one. Undefined means it named a
// group that isn't there.
type NewTabTarget = {
  workspace: Workspace;
  group?: DockviewGroupPanel;
};

function resolveNewTabTarget(
  groupId: string | undefined,
): NewTabTarget | undefined {
  const workspace = activeWorkspace;
  if (workspace === undefined) {
    return undefined;
  }
  if (groupId === undefined) {
    return { workspace };
  }
  const group = findGroup({
    workspace,
    groupId,
  });
  if (!group) {
    return undefined;
  }
  return {
    workspace,
    group,
  };
}

export function executeTabCommand(command: Command): void {
  switch (command.type) {
    case "new-tab": {
      const target = resolveNewTabTarget(command.groupId);
      if (target === undefined) {
        return;
      }
      openTerminalTab(target);
      return;
    }
    case "close-tab": {
      const resolved = resolveTab(command.id);
      if (resolved === undefined) {
        return;
      }
      // only a terminal has a shell to outlive it; every other kind of tab
      // is gone as soon as it is removed
      if (resolved.tab.kind !== "terminal") {
        removeTab(resolved.id);
        return;
      }
      bridge.killShell(resolved.id);
      return;
    }
    case "activate-tab": {
      const found = findTab(command.id);
      if (found === undefined) {
        return;
      }
      // a tab in a background workspace brings its workspace forward
      if (found.workspace !== activeWorkspace) {
        executeCommand({
          type: "activate-workspace",
          id: found.workspace.id,
        });
      }
      found.tab.panel.api.setActive();
      return;
    }
    case "write": {
      const resolved = resolveTab(command.id);
      if (resolved === undefined) {
        return;
      }
      bridge.writeToShell({
        id: resolved.id,
        data: command.text,
      });
      return;
    }
    case "move-tab": {
      const resolved = resolveTab(command.id);
      if (resolved === undefined) {
        return;
      }
      const targetGroup = resolveTargetGroup({
        resolved,
        groupId: command.groupId,
      });
      if (targetGroup === undefined) {
        return;
      }
      if (targetGroup === resolved.tab.panel.group) {
        if (targetGroup.panels.length === 1) {
          return;
        }
        if (targetGroup.panels.indexOf(resolved.tab.panel) === command.index) {
          return;
        }
      }
      resolved.tab.panel.api.moveTo({
        group: targetGroup,
        index: command.index,
      });
      bridge.emitEvent({
        type: "tab-moved",
        id: resolved.id,
        state: snapshot(),
      });
      return;
    }
    case "split-tab": {
      const resolved = resolveTab(command.id);
      if (resolved === undefined) {
        return;
      }
      const targetGroup = resolveTargetGroup({
        resolved,
        groupId: command.targetGroupId,
      });
      if (targetGroup === undefined) {
        return;
      }
      if (
        targetGroup === resolved.tab.panel.group &&
        targetGroup.panels.length === 1
      ) {
        return;
      }
      resolved.tab.panel.api.moveTo({
        group: targetGroup,
        position: command.side,
      });
      bridge.emitEvent({
        type: "tab-moved",
        id: resolved.id,
        state: snapshot(),
      });
      return;
    }
    case "set-tab-title": {
      const resolved = resolveTab(command.id);
      if (resolved === undefined) {
        return;
      }
      const { id, tab } = resolved;
      const trimmedTitle = command.title.trim();
      if (command.transient && tab.titlePinned) {
        return;
      }
      if (!command.transient) {
        tab.titlePinned = trimmedTitle !== "";
      }
      let title = trimmedTitle;
      if (title === "") {
        title = "Untitled";
      }
      tab.title = title;
      drawTabRow({
        row: tab.row,
        title,
      });
      tab.panel.setTitle(title);
      refreshWorkspaceName(resolved.workspace);
      bridge.emitEvent({
        type: "tab-retitled",
        id,
        state: snapshot(),
      });
      return;
    }
    case "toggle-maximize": {
      const resolved = resolveTab(command.id);
      if (resolved === undefined) {
        return;
      }
      const group = resolved.tab.panel.group;
      if (group.api.isMaximized()) {
        group.api.exitMaximized();
      } else {
        resolved.workspace.dockview.api.maximizeGroup(resolved.tab.panel);
      }
      bridge.emitEvent({
        type: "maximize-changed",
        id: resolved.id,
        state: snapshot(),
      });
      return;
    }
    case "open-markdown": {
      const target = resolveNewTabTarget(command.groupId);
      if (target === undefined) {
        return;
      }
      openMarkdownTab({
        ...target,
        filePath: command.path,
        baseTabId: command.baseTabId,
      });
      return;
    }
    case "set-markdown-mode": {
      const resolved = resolveTab(command.id);
      if (resolved === undefined || resolved.tab.kind !== "markdown") {
        return;
      }
      setMarkdownMode({
        id: resolved.id,
        tab: resolved.tab,
        mode: command.mode,
      });
      return;
    }
    case "reload-markdown": {
      const resolved = resolveTab(command.id);
      if (resolved === undefined || resolved.tab.kind !== "markdown") {
        return;
      }
      reloadMarkdownTab({
        id: resolved.id,
        tab: resolved.tab,
      });
      return;
    }
  }
}
