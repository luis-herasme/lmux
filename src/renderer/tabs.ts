import { getSettings, currentTheme, updateSettings } from "./settings.ts";
import { bridge } from "./bridge.ts";
import { registerFileLinks } from "./file-links.ts";
import { refreshCodeTheme } from "./code.ts";
import {
  activateProjectFile,
  changeProjectWorkspaceRoot,
  closeProjectFile,
  disposeProjectTab,
  focusProjectTab,
  openProjectFile,
  openProjectTab,
  saveAllProjectFiles,
  saveProjectFile,
} from "./project-tab.ts";
import type { ProjectTab } from "./project-tab.ts";
import {
  openMarkdownTab,
  redrawMarkdown,
  reloadMarkdownTab,
  setMarkdownMode,
} from "./markdown-tab.ts";
import {
  activateWorkspace,
  activeWorkspace,
  addPanel,
  createWorkspace,
  findGroup,
  findTab,
  refreshWorkspaceName,
  removeWorkspace,
  setWorkspaceName,
  snapshot,
  workspaces,
} from "./workspaces.ts";
import type { Workspace } from "./workspaces.ts";
import type {
  Command,
  MarkdownMode,
  ScreenRequest,
  ScreenResult,
} from "../api.ts";
import type { Session } from "../session.ts";
import type { ShellDataMessage } from "../ipc/bridge.ts";
import type { ITheme, Terminal as XtermTerminal } from "@xterm/xterm";
import type { FitAddon as XtermFitAddon } from "@xterm/addon-fit";
import type { DockviewGroupPanel, IDockviewPanel } from "dockview";

// xterm ships classic scripts, so its constructors arrive as page globals
// rather than as modules (see the script tags in index.html). Picked up the
// same way the cable is, in renderer/bridge.ts.
const Terminal: typeof XtermTerminal = Reflect.get(window, "Terminal");
const FitAddon: { FitAddon: typeof XtermFitAddon } = Reflect.get(
  window,
  "FitAddon",
);
if (!Terminal || !FitAddon) {
  throw new Error("xterm's scripts did not load: window.Terminal is missing");
}

type TabCommon = {
  panel: IDockviewPanel;
  titleElement: HTMLElement;
  titlePinned: boolean;
};

type TerminalTab = TabCommon & {
  kind: "terminal";
  terminal: XtermTerminal;
  observer: ResizeObserver;
  fitAddon: XtermFitAddon;
};

export type MarkdownTab = TabCommon & {
  kind: "markdown";
  element: HTMLElement; // the pane: toolbar above, content below
  contentElement: HTMLElement; // what scrolls and takes focus
  modeButton: HTMLElement;
  // what a reload re-reads: the resolved path once we have one, so a
  // reload doesn't depend on the base tab's shell staying where it was
  filePath: string;
  baseTabId: number | undefined;
  mode: MarkdownMode;
  markdown: string; // the file's text, shown raw or rendered
};

export type Tab = TerminalTab | MarkdownTab | ProjectTab;

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

type ResolvedProjectTab = {
  id: number;
  tab: ProjectTab;
  workspace: Workspace;
};

function resolveProjectTab(
  projectTabId: number | undefined,
): ResolvedProjectTab | undefined {
  const resolved = resolveTab(projectTabId);
  if (resolved === undefined || resolved.tab.kind !== "project") {
    return undefined;
  }
  return {
    id: resolved.id,
    tab: resolved.tab,
    workspace: resolved.workspace,
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

function copyOnCmdC(event: KeyboardEvent): boolean {
  if (!activeWorkspace) {
    return true;
  }
  const tab = activeWorkspace.tabs.get(activeWorkspace.activeId);
  if (tab?.kind !== "terminal") {
    return true;
  }
  if (
    event.type === "keydown" &&
    event.metaKey &&
    event.key === "c" &&
    tab.terminal.hasSelection()
  ) {
    navigator.clipboard.writeText(tab.terminal.getSelection());
    return false;
  }
  return true;
}

function xtermTheme(): ITheme {
  const theme = currentTheme();
  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    selectionBackground: theme.selectionBackground,
  };
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

type CreateTabOptions = {
  workspace: Workspace;
  group: DockviewGroupPanel | undefined;
};

function createTab({ workspace, group }: CreateTabOptions): void {
  const id = nextId++;

  const paneElement = document.createElement("div");
  paneElement.className = "terminal-pane";

  const { tabElement, titleElement } = buildTabElement(id);
  const panel = addPanel({
    workspace,
    id,
    component: "terminal",
    title: "Untitled",
    paneElement,
    tabElement,
    group,
  });

  const settings = getSettings();
  const terminal = new Terminal({
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    cursorBlink: true,
    theme: xtermTheme(),
  });
  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);

  // one mechanism for grid sizing: any box change re-fits the grid, except
  // the zero box a hidden workspace reports (fitting against it would
  // resize the shell to nothing)
  const observer = new ResizeObserver(() => {
    if (paneElement.clientWidth === 0 || paneElement.clientHeight === 0) {
      return;
    }
    fitAddon.fit();
  });
  observer.observe(paneElement);

  workspace.tabs.set(id, {
    kind: "terminal",
    panel,
    terminal,
    titleElement,
    titlePinned: false,
    observer,
    fitAddon,
  });
  bridge.emitEvent({
    type: "tab-opened",
    id,
    state: snapshot(),
  });

  // xterm can only measure a visible container: activate first, then open
  panel.api.setActive();
  terminal.open(paneElement);
  fitAddon.fit();
  terminal.focus();

  bridge.spawnShell({
    id,
    cols: terminal.cols,
    rows: terminal.rows,
  });

  terminal.onData((data) => {
    bridge.writeToShell({
      id,
      data,
    });
  });
  terminal.onResize(({ cols, rows }) => {
    bridge.resizeShell({
      id,
      cols,
      rows,
    });
  });
  terminal.attachCustomKeyEventHandler(copyOnCmdC);

  terminal.onTitleChange((title) => {
    executeCommand({
      type: "set-tab-title",
      id,
      title,
      transient: true,
    });
  });

  registerFileLinks({
    terminal,
    openPath: ({ path, kind }) => {
      if (kind === "markdown") {
        executeCommand({
          type: "open-markdown",
          path,
          baseTabId: id,
        });
        return;
      }
      executeCommand({
        type: "open-file",
        path,
        baseTabId: id,
      });
    },
  });
}

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

type FoundProjectTab = {
  id: number;
  tab: ProjectTab;
};

function findProjectTab(workspace: Workspace): FoundProjectTab | undefined {
  for (const [id, tab] of workspace.tabs) {
    if (tab.kind !== "project") {
      continue;
    }
    return {
      id,
      tab,
    };
  }
  return undefined;
}

type AddProjectTabOptions = {
  workspace: Workspace;
  baseTabId: number | undefined;
  workspaceRootPath: string | undefined;
  initialFilePath: string | undefined;
  initialFilePreview: boolean;
  group: DockviewGroupPanel | undefined;
};

type CreateProjectTabOptions = Omit<
  AddProjectTabOptions,
  "initialFilePreview"
>;

const pendingProjectTabs = new Map<Workspace, Promise<FoundProjectTab>>();

async function createProjectTab({
  workspace,
  baseTabId,
  workspaceRootPath,
  initialFilePath,
  group,
}: CreateProjectTabOptions): Promise<FoundProjectTab> {
  const id = nextId++;
  const tab = await openProjectTab({
    id,
    workspace,
    tabElements: buildTabElement(id),
    baseTabId,
    workspaceRootPath,
    initialFilePath,
    group,
  });
  workspace.tabs.set(id, tab);
  bridge.emitEvent({
    type: "tab-opened",
    id,
    state: snapshot(),
  });
  tab.panel.api.setActive();
  return {
    id,
    tab,
  };
}

async function addProjectTab({
  workspace,
  baseTabId,
  workspaceRootPath,
  initialFilePath,
  initialFilePreview,
  group,
}: AddProjectTabOptions): Promise<ProjectTab> {
  let project = findProjectTab(workspace);
  if (project === undefined) {
    let pendingProject = pendingProjectTabs.get(workspace);
    if (pendingProject === undefined) {
      pendingProject = createProjectTab({
        workspace,
        baseTabId,
        workspaceRootPath,
        initialFilePath,
        group,
      });
      pendingProjectTabs.set(workspace, pendingProject);
    }
    try {
      project = await pendingProject;
    } finally {
      if (pendingProjectTabs.get(workspace) === pendingProject) {
        pendingProjectTabs.delete(workspace);
      }
    }
  }
  if (initialFilePath !== undefined) {
    await openProjectFile({
      id: project.id,
      tab: project.tab,
      filePath: initialFilePath,
      baseTabId,
      preview: initialFilePreview,
    });
  }
  project.tab.panel.api.setActive();
  focusProjectTab(project.tab);
  return project.tab;
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
      createTab({
        workspace: activeWorkspace,
        group,
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
        for (const tab of workspace.tabs.values()) {
          if (tab.kind === "markdown") {
            if (redraw) {
              redrawMarkdown(tab);
            }
            continue;
          }
          if (tab.kind === "project") {
            tab.editor.updateOptions({
              fontFamily: settings.fontFamily,
              fontSize: settings.fontSize,
            });
            continue;
          }
          tab.terminal.options.fontFamily = settings.fontFamily;
          tab.terminal.options.fontSize = settings.fontSize;
          tab.terminal.options.theme = xtermTheme();
          if (workspace === activeWorkspace) {
            tab.fitAddon.fit();
          }
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
      const project = findProjectTab(activeWorkspace);
      if (project !== undefined) {
        project.tab.panel.api.setActive();
        openProjectFile({
          id: project.id,
          tab: project.tab,
          filePath: command.path,
          baseTabId: command.baseTabId,
          preview,
        });
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
      addProjectTab({
        workspace: activeWorkspace,
        baseTabId: command.baseTabId,
        workspaceRootPath: undefined,
        initialFilePath: command.path,
        initialFilePreview: preview,
        group,
      });
      return;
    }
    case "open-project": {
      if (!activeWorkspace) {
        return;
      }
      const project = findProjectTab(activeWorkspace);
      if (project !== undefined) {
        project.tab.panel.api.setActive();
        focusProjectTab(project.tab);
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
      let baseTabId = command.baseTabId;
      if (baseTabId === undefined) {
        baseTabId = activeWorkspace.activeId;
      }
      addProjectTab({
        workspace: activeWorkspace,
        baseTabId,
        workspaceRootPath: undefined,
        initialFilePath: undefined,
        initialFilePreview: false,
        group,
      });
      return;
    }
    case "change-workspace-root": {
      const workspace = resolveWorkspace(command.workspaceId);
      if (workspace === undefined) {
        return;
      }
      const project = findProjectTab(workspace);
      if (project === undefined) {
        addProjectTab({
          workspace,
          baseTabId: undefined,
          workspaceRootPath: command.path,
          initialFilePath: undefined,
          initialFilePreview: false,
          group: undefined,
        });
        return;
      }
      changeProjectWorkspaceRoot({
        id: project.id,
        tab: project.tab,
        workspace,
        workspaceRootPath: command.path,
      });
      return;
    }
    case "activate-file": {
      const resolved = resolveProjectTab(command.projectTabId);
      if (resolved === undefined) {
        return;
      }
      activateProjectFile({
        id: resolved.id,
        tab: resolved.tab,
        filePath: command.path,
      });
      return;
    }
    case "close-file": {
      const resolved = resolveProjectTab(command.projectTabId);
      if (resolved === undefined) {
        return;
      }
      closeProjectFile({
        id: resolved.id,
        tab: resolved.tab,
        filePath: command.path,
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
      const resolved = resolveProjectTab(command.projectTabId);
      if (resolved === undefined) {
        return;
      }
      saveProjectFile({
        id: resolved.id,
        tab: resolved.tab,
        filePath: command.path,
      });
      return;
    }
    case "save-all-files": {
      const resolved = resolveProjectTab(command.projectTabId);
      if (resolved === undefined) {
        return;
      }
      saveAllProjectFiles({
        id: resolved.id,
        tab: resolved.tab,
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
    case "new-workspace": {
      const workspace = createWorkspace();
      activateWorkspace(workspace);
      bridge.emitEvent({
        type: "workspace-opened",
        id: workspace.id,
        state: snapshot(),
      });
      createTab({
        workspace,
        group: undefined,
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
      for (const tab of workspace.tabs.values()) {
        if (tab.kind === "project") {
          disposeProjectTab(tab);
        }
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
  if (found.tab.kind === "project") {
    let path: string | null = null;
    let language: string | null = null;
    if (found.tab.activeFilePath !== undefined) {
      path = found.tab.activeFilePath;
      const model = found.tab.editor.getModel();
      if (model !== null) {
        language = model.getLanguageId();
      }
    }
    return {
      kind: "project",
      workspaceRootPath: found.tab.workspaceRootPath,
      path,
      language,
    };
  }
  const buffer = found.tab.terminal.buffer.active;
  let rowCount = found.tab.terminal.rows;
  if (request.rows !== undefined) {
    rowCount = request.rows;
  }
  // The bottom of the buffer, not of the viewport: an agent asking what a
  // command printed wants the newest output, wherever the human has
  // scrolled to. On the alternate buffer there is no scrollback, so this is
  // the painted screen and nothing else.
  let top = buffer.length - rowCount;
  if (top < 0) {
    top = 0;
  }

  const lines: string[] = [];
  for (let row = top; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (line === undefined) {
      continue;
    }
    // A line too long for the width is stored as several rows. Trimming the
    // right of one whose successor continues it would eat the spaces at the
    // seam, so only the last row of a run is trimmed.
    const next = buffer.getLine(row + 1);
    let continues = false;
    if (next !== undefined && next.isWrapped) {
      continues = true;
    }
    const text = line.translateToString(!continues);
    const previous = lines.at(-1);
    if (line.isWrapped && previous !== undefined) {
      lines[lines.length - 1] = previous + text;
      continue;
    }
    lines.push(text);
  }
  // the empty rows below the last output are the terminal's, not the
  // shell's, and say nothing
  while (lines.at(-1) === "") {
    lines.pop();
  }
  return {
    kind: "terminal",
    lines,
    alternate: buffer.type === "alternate",
  };
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
      if (tab.kind === "project") {
        await addProjectTab({
          workspace,
          baseTabId: undefined,
          workspaceRootPath: tab.workspaceRootPath,
          initialFilePath: undefined,
          initialFilePreview: false,
          group: undefined,
        });
        const project = findProjectTab(workspace);
        if (project === undefined) {
          continue;
        }
        for (const filePath of tab.files) {
          await openProjectFile({
            id: project.id,
            tab: project.tab,
            filePath,
            baseTabId: undefined,
            preview: false,
          });
        }
        if (tab.activeFilePath !== null) {
          activateProjectFile({
            id: project.id,
            tab: project.tab,
            filePath: tab.activeFilePath,
          });
        }
        continue;
      }
      createTab({
        workspace,
        group: undefined,
      });
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
  if (tab.kind === "project") {
    disposeProjectTab(tab);
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

export function focusActiveTab(): void {
  if (!activeWorkspace) {
    return;
  }
  const tab = activeWorkspace.tabs.get(activeWorkspace.activeId);
  if (tab?.kind === "terminal") {
    tab.terminal.focus();
  }
  if (tab?.kind === "markdown") {
    tab.contentElement.focus();
  }
  if (tab?.kind === "project") {
    focusProjectTab(tab);
  }
}
