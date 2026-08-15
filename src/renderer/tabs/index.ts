import { getSettings, updateSettings } from "../settings.ts";
import { bridge } from "../bridge.ts";
import { refreshCodeTheme } from "../code.ts";
import {
  activateProjectFile,
  changeProjectWorkspaceRoot,
  closeProjectFile,
  createProjectPanel,
  createUntitledProjectFile,
  focusProjectPanel,
  moveProjectFile,
  openProjectFile,
  redrawProjectMarkdown,
  saveAllProjectFiles,
  saveProjectFile,
  setProjectFileMarkdownMode,
} from "../project-panel.ts";
import type { ProjectPanel } from "../project-panel.ts";
import {
  openMarkdownTab,
  redrawMarkdown,
  reloadMarkdownTab,
  setMarkdownMode,
} from "./markdown-tab.ts";
import type { MarkdownTab } from "./markdown-tab.ts";
import {
  openTerminalTab,
  readTerminalScreen,
  refreshTerminalTabSettings,
} from "./terminal-tab.ts";
import type { TerminalTab } from "./terminal-tab.ts";
import {
  activateWorkspace,
  activeWorkspace,
  createWorkspace,
  findGroup,
  findTab,
  refreshProjectPanel,
  refreshWorkspaceName,
  removeWorkspace,
  setWorkspaceName,
  snapshot,
  workspaces,
} from "../workspaces.ts";
import type { Workspace } from "../workspaces.ts";
import type { Command, ScreenRequest, ScreenResult } from "../../api.ts";
import type { Session } from "../../session.ts";
import type { ShellDataMessage } from "../../ipc/bridge.ts";
import type { DockviewGroupPanel } from "dockview";

export type Tab = TerminalTab | MarkdownTab;

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

// A projectTabId names one workspace's panel, wherever that workspace is;
// without one the active workspace's panel is meant. A panel that has never
// been opened does not exist yet, and the command bails.
function resolveProject(
  projectTabId: number | undefined,
): ProjectPanel | undefined {
  if (projectTabId === undefined) {
    return activeWorkspace?.project;
  }
  for (const workspace of workspaces.values()) {
    if (workspace.project?.id === projectTabId) {
      return workspace.project;
    }
  }
  return undefined;
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

// `id` defaults to the active workspace where optional.
function resolveWorkspace(id: number | undefined): Workspace | undefined {
  if (id === undefined) {
    return activeWorkspace;
  }
  return workspaces.get(id);
}

export function getTabTitle(id: number): string | undefined {
  const found = findTab(id);
  if (!found) {
    return undefined;
  }
  let title = found.tab.titleElement.textContent;
  if (title === null) {
    title = "";
  }
  return title;
}

export type TabElements = {
  tabElement: HTMLElement;
  titleElement: HTMLElement;
};

function buildTabElement(id: number): TabElements {
  const titleElement = document.createElement("span");
  titleElement.className = "tab-title";
  titleElement.textContent = "Untitled";
  titleElement.title = "Double-click to fill the window";

  // a button, not a span: it has to be reachable and pressable by keyboard
  const closeElement = document.createElement("button");
  closeElement.className = "tab-close";
  closeElement.textContent = "×";
  closeElement.title = "Close Tab (⌘W)";
  closeElement.ariaLabel = "Close tab";
  closeElement.addEventListener("click", (event) => {
    event.stopPropagation();
    // a person's × routes through main, so a dirty tab is asked about
    // before it goes; an agent's close-tab Command goes the other way
    bridge.closeTab(id);
  });

  const tabElement = document.createElement("div");
  tabElement.className = "tab";
  tabElement.dataset.tabId = String(id);
  tabElement.append(titleElement, closeElement);
  tabElement.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    bridge.showTabMenu(id);
  });
  return {
    tabElement,
    titleElement,
  };
}

let nextId = 0;

type AddMarkdownTabOptions = {
  workspace: Workspace;
  filePath: string;
  baseTabId: number | undefined;
  group: DockviewGroupPanel | undefined;
};

// The store's half of opening a document: an id, a strip element, and
// putting the finished tab away. The pane is markdown-tab.ts's business.
async function addMarkdownTab({
  workspace,
  filePath,
  baseTabId,
  group,
}: AddMarkdownTabOptions): Promise<void> {
  const id = nextId++;
  const tab = await openMarkdownTab({
    id,
    workspace,
    tabElements: buildTabElement(id),
    filePath,
    baseTabId,
    group,
  });
  workspace.tabs.set(id, tab);
  bridge.emitEvent({
    type: "tab-opened",
    id,
    state: snapshot(),
  });
  tab.panel.api.setActive();
  tab.contentElement.focus();
}

type EnsureProjectPanelOptions = {
  workspace: Workspace;
  baseTabId: number | undefined;
  workspaceRootPath: string | undefined;
  initialFilePath: string | undefined;
};

// Building one waits on 4MB of Monaco, so a second request arriving
// meanwhile waits for the same panel rather than starting a second.
const pendingProjectPanels = new Map<Workspace, Promise<ProjectPanel>>();

async function ensureProjectPanel({
  workspace,
  baseTabId,
  workspaceRootPath,
  initialFilePath,
}: EnsureProjectPanelOptions): Promise<ProjectPanel> {
  const existing = workspace.project;
  if (existing !== undefined) {
    return existing;
  }
  let pendingPanel = pendingProjectPanels.get(workspace);
  if (pendingPanel === undefined) {
    pendingPanel = createProjectPanel({
      id: nextId++,
      baseTabId,
      workspaceRootPath,
      initialFilePath,
    });
    pendingProjectPanels.set(workspace, pendingPanel);
  }
  let panel: ProjectPanel;
  try {
    panel = await pendingPanel;
  } finally {
    if (pendingProjectPanels.get(workspace) === pendingPanel) {
      pendingProjectPanels.delete(workspace);
    }
  }
  workspace.project = panel;
  return panel;
}

type ShowProjectPanelOptions = {
  workspace: Workspace;
  panel: ProjectPanel;
};

// Coming on screen is state plus an Event, so every command that opens
// something in the panel ends here. A background workspace's panel is
// opened without taking the keyboard away from the one on screen.
function showProjectPanel({ workspace, panel }: ShowProjectPanelOptions): void {
  const wasVisible = panel.visible;
  panel.visible = true;
  refreshProjectPanel();
  if (workspace === activeWorkspace) {
    workspace.focus = "project";
    focusProjectPanel(panel);
  }
  // the Event carries the state it produced, so it goes out once the
  // keyboard has moved too
  if (wasVisible) {
    return;
  }
  bridge.emitEvent({
    type: "project-opened",
    id: panel.id,
    state: snapshot(),
  });
}

type OpenProjectOptions = EnsureProjectPanelOptions & {
  initialFilePreview: boolean;
};

async function openProject({
  workspace,
  baseTabId,
  workspaceRootPath,
  initialFilePath,
  initialFilePreview,
}: OpenProjectOptions): Promise<void> {
  const panel = await ensureProjectPanel({
    workspace,
    baseTabId,
    workspaceRootPath,
    initialFilePath,
  });
  // a new panel takes the path to find its root; opening the file is this
  if (initialFilePath !== undefined) {
    await openProjectFile({
      panel,
      filePath: initialFilePath,
      baseTabId,
      preview: initialFilePreview,
    });
  }
  showProjectPanel({
    workspace,
    panel,
  });
}

export function executeCommand(command: Command): void {
  switch (command.type) {
    case "new-tab": {
      if (!activeWorkspace) {
        return;
      }
      let group: DockviewGroupPanel | undefined;
      if (command.groupId !== undefined) {
        group = findGroup({
          workspace: activeWorkspace,
          groupId: command.groupId,
        });
        if (!group) {
          return;
        }
      }
      const terminalTabId = nextId++;
      openTerminalTab({
        workspace: activeWorkspace,
        tabId: terminalTabId,
        group,
        tabElements: buildTabElement(terminalTabId),
      });
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
      tab.titleElement.textContent = title;
      tab.panel.setTitle(title);
      refreshWorkspaceName(resolved.workspace);
      bridge.emitEvent({
        type: "tab-retitled",
        id,
        state: snapshot(),
      });
      return;
    }
    case "update-settings": {
      const previous = getSettings();
      updateSettings(command.settings);
      const settings = getSettings();
      // a drawn diagram has the theme and the font baked into its SVG, so
      // it only follows those two by being drawn again
      const redraw =
        settings.theme !== previous.theme ||
        settings.markdownFontFamily !== previous.markdownFontFamily;
      // Monaco's themes are global to the page, so the palette is redefined
      // once here rather than per editor; only the font is per instance.
      refreshCodeTheme();
      for (const workspace of workspaces.values()) {
        const panel = workspace.project;
        if (panel !== undefined) {
          panel.editor.updateOptions({
            fontFamily: settings.fontFamily,
            fontSize: settings.fontSize,
          });
          if (redraw) {
            redrawProjectMarkdown(panel);
          }
        }
        for (const tab of workspace.tabs.values()) {
          if (tab.kind === "markdown") {
            if (redraw) {
              redrawMarkdown(tab);
            }
            continue;
          }
          refreshTerminalTabSettings({
            tab,
            fit: workspace === activeWorkspace,
          });
        }
      }
      bridge.emitEvent({
        type: "settings-changed",
        settings,
        state: snapshot(),
      });
      return;
    }
    case "open-markdown": {
      if (!activeWorkspace) {
        return;
      }
      let group: DockviewGroupPanel | undefined;
      if (command.groupId !== undefined) {
        group = findGroup({
          workspace: activeWorkspace,
          groupId: command.groupId,
        });
        if (!group) {
          return;
        }
      }
      addMarkdownTab({
        workspace: activeWorkspace,
        filePath: command.path,
        baseTabId: command.baseTabId,
        group,
      });
      return;
    }
    case "open-file": {
      if (!activeWorkspace) {
        return;
      }
      let preview = false;
      if (command.preview !== undefined) {
        preview = command.preview;
      }
      openProject({
        workspace: activeWorkspace,
        baseTabId: command.baseTabId,
        workspaceRootPath: undefined,
        initialFilePath: command.path,
        initialFilePreview: preview,
      });
      return;
    }
    case "open-project": {
      const workspace = resolveWorkspace(command.workspaceId);
      if (workspace === undefined) {
        return;
      }
      let baseTabId = command.baseTabId;
      if (baseTabId === undefined) {
        baseTabId = workspace.activeId;
      }
      openProject({
        workspace,
        baseTabId,
        workspaceRootPath: undefined,
        initialFilePath: undefined,
        initialFilePreview: false,
      });
      return;
    }
    case "close-project": {
      const workspace = resolveWorkspace(command.workspaceId);
      const panel = workspace?.project;
      if (workspace === undefined || panel === undefined || !panel.visible) {
        return;
      }
      panel.visible = false;
      refreshProjectPanel();
      // the keyboard was in the panel that just left, so the panes take it
      if (workspace.focus === "project") {
        workspace.focus = "layout";
        focusWorkspace();
      }
      bridge.emitEvent({
        type: "project-closed",
        id: panel.id,
        state: snapshot(),
      });
      return;
    }
    case "change-workspace-root": {
      const workspace = resolveWorkspace(command.workspaceId);
      if (workspace === undefined) {
        return;
      }
      const panel = workspace.project;
      if (panel === undefined) {
        openProject({
          workspace,
          baseTabId: undefined,
          workspaceRootPath: command.path,
          initialFilePath: undefined,
          initialFilePreview: false,
        });
        return;
      }
      changeProjectWorkspaceRoot({
        panel,
        workspaceRootPath: command.path,
      });
      showProjectPanel({
        workspace,
        panel,
      });
      return;
    }
    case "new-file": {
      const panel = resolveProject(command.projectTabId);
      if (panel === undefined) {
        return;
      }
      createUntitledProjectFile(panel);
      return;
    }
    case "move-file": {
      const panel = resolveProject(command.projectTabId);
      if (panel === undefined) {
        return;
      }
      moveProjectFile({
        panel,
        filePath: command.path,
        untitledId: command.untitledId,
        index: command.index,
      });
      return;
    }
    case "activate-file": {
      const panel = resolveProject(command.projectTabId);
      if (panel === undefined) {
        return;
      }
      activateProjectFile({
        panel,
        filePath: command.path,
        untitledId: command.untitledId,
      });
      return;
    }
    case "close-file": {
      const panel = resolveProject(command.projectTabId);
      if (panel === undefined) {
        return;
      }
      closeProjectFile({
        panel,
        filePath: command.path,
        untitledId: command.untitledId,
      });
      return;
    }
    case "set-file-markdown-mode": {
      const panel = resolveProject(command.projectTabId);
      if (panel === undefined) {
        return;
      }
      setProjectFileMarkdownMode({
        panel,
        filePath: command.path,
        mode: command.mode,
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
    case "save-file": {
      const panel = resolveProject(command.projectTabId);
      if (panel === undefined) {
        return;
      }
      saveProjectFile({
        panel,
        filePath: command.path,
        untitledId: command.untitledId,
        destinationPath: command.destinationPath,
      });
      return;
    }
    case "save-all-files": {
      const panel = resolveProject(command.projectTabId);
      if (panel === undefined) {
        return;
      }
      saveAllProjectFiles(panel);
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
    case "new-workspace": {
      const workspace = createWorkspace();
      activateWorkspace(workspace);
      bridge.emitEvent({
        type: "workspace-opened",
        id: workspace.id,
        state: snapshot(),
      });
      const terminalTabId = nextId++;
      openTerminalTab({
        workspace,
        tabId: terminalTabId,
        group: undefined,
        tabElements: buildTabElement(terminalTabId),
      });
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
    if (panel.activeFileKey !== undefined) {
      const buffer = panel.files.get(panel.activeFileKey);
      if (buffer?.filePath !== undefined) {
        path = buffer.filePath;
      }
      const model = panel.editor.getModel();
      if (model !== null) {
        language = model.getLanguageId();
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
        await addMarkdownTab({
          workspace,
          filePath: tab.path,
          baseTabId: undefined,
          group: undefined,
        });
        continue;
      }
      const terminalTabId = nextId++;
      openTerminalTab({
        workspace,
        tabId: terminalTabId,
        group: undefined,
        tabElements: buildTabElement(terminalTabId),
      });
    }
    if (saved.project !== null) {
      const panel = await ensureProjectPanel({
        workspace,
        baseTabId: undefined,
        workspaceRootPath: saved.project.workspaceRootPath,
        initialFilePath: undefined,
      });
      for (const filePath of saved.project.files) {
        await openProjectFile({
          panel,
          filePath,
          baseTabId: undefined,
          preview: false,
        });
      }
      if (saved.project.activeFilePath !== null) {
        activateProjectFile({
          panel,
          filePath: saved.project.activeFilePath,
          untitledId: undefined,
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
  if (tab.kind === "terminal") {
    tab.observer.disconnect();
    tab.terminal.dispose();
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

// Where the keyboard belongs in the active workspace: its panel while that
// is the half being worked in, its active tab otherwise.
export function focusWorkspace(): void {
  if (!activeWorkspace) {
    return;
  }
  const panel = activeWorkspace.project;
  if (
    activeWorkspace.focus === "project" &&
    panel !== undefined &&
    panel.visible
  ) {
    focusProjectPanel(panel);
    return;
  }
  const tab = activeWorkspace.tabs.get(activeWorkspace.activeId);
  if (tab?.kind === "terminal") {
    tab.terminal.focus();
  }
  if (tab?.kind === "markdown") {
    tab.contentElement.focus();
  }
}
