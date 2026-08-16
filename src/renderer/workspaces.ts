// One workspace = one Dockview instance = one pane layout with its own
// tabs, plus the one project panel beside it. Only the active one is
// displayed; the others keep their terminals and their shells alive off
// screen.
import { executeCommand } from "./tabs/index.ts";
import type { Tab } from "./tabs/index.ts";
import { disposeProjectPanel, focusProjectPanel } from "./project-panel.ts";
import type { ProjectPanel } from "./project-panel.ts";
import type {
  LayoutNode,
  LmuxState,
  ProjectInfo,
  TabInfo,
  WorkspaceInfo,
} from "../api.ts";
import { DockviewComponent, Orientation, themeDark } from "dockview";
import type {
  AddPanelPositionOptions,
  DockviewGroupPanel,
  IDockviewPanel,
  SerializedDockview,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import { bridge } from "./bridge.ts";
import { drawChrome } from "./chrome.tsx";
import { mountTabRow } from "./tab-strip.tsx";
import type { TabRow } from "./tab-strip.tsx";
import { requireElement } from "./dom.ts";

type SerializedGridNode = SerializedDockview["grid"]["root"];
type SerializedGroup = Exclude<SerializedGridNode["data"], unknown[]>;

export type Workspace = {
  id: number;
  name: string;
  element: HTMLElement; // its Dockview root, hidden unless active
  dockview: DockviewComponent;
  tabs: Map<number, Tab>;
  activeId: number;
  namePinned: boolean;
  project: ProjectPanel | undefined; // built the first time it is opened
  focus: "layout" | "project"; // which half the keyboard is in
};

export const workspaces = new Map<number, Workspace>();

// live binding: importers read the current value, so no getter is needed
export let activeWorkspace: Workspace | undefined;

let nextWorkspaceId = 1;

// Tabs and project panels share one counter, so a panel can be named by a
// command the same way a tab is (see readScreen).
let nextId = 0;

export function nextTabId(): number {
  return nextId++;
}

const layoutElement = requireElement("layout");
const projectHostElement = requireElement("project");

// The element a panel shows is built by the caller of addPanel; Dockview's
// factories only ever hand it over.
let handOffPaneElement: HTMLElement | undefined;
let handOffTabElement: HTMLElement | undefined;

// One options object for every instance: a workspace's identity lives in
// its own store entry, never in the layout engine's configuration.
const DOCKVIEW_OPTIONS = {
  theme: themeDark,
  disableFloatingGroups: true,
  disableTabsOverflowList: true,
  createComponent: () => {
    const element = handOffPaneElement;
    handOffPaneElement = undefined;
    if (!element) {
      throw new Error("Panels are only added by addPanel");
    }
    return {
      element,
      init: () => {},
    };
  },
  createTabComponent: () => {
    const element = handOffTabElement;
    handOffTabElement = undefined;
    if (!element) {
      throw new Error("Tabs are only added by addPanel");
    }
    return {
      element,
      init: () => {},
    };
  },
  createRightHeaderActionComponent: (group: DockviewGroupPanel) => {
    const button = document.createElement("button");
    button.className =
      "cursor-pointer border-0 bg-transparent px-3 py-1 font-ui text-[15px] text-tab";
    button.title = "New Tab (⌘T)";
    button.textContent = "+";
    button.addEventListener("click", () => {
      executeCommand({
        type: "new-tab",
        groupId: group.id,
      });
    });
    return {
      element: button,
      init: () => {},
      dispose: () => {},
    };
  },
};

export function createWorkspace(): Workspace {
  const id = nextWorkspaceId++;

  const element = document.createElement("div");
  element.className = "min-w-0 flex-1";
  element.style.display = "none";
  layoutElement.append(element);

  const workspace: Workspace = {
    id,
    name: "", // refreshWorkspaceName fills it in, below
    element,
    dockview: new DockviewComponent(element, DOCKVIEW_OPTIONS),
    tabs: new Map(),
    activeId: -1,
    namePinned: false,
    project: undefined,
    focus: "layout",
  };
  workspaces.set(id, workspace);
  refreshWorkspaceName(workspace);

  // Drag-and-drop interception: cancel the drop, re-issue it as a Command,
  // and let the consumer perform the identical move.
  workspace.dockview.api.onWillDrop((event) => {
    event.preventDefault();
    const data = event.getData();
    if (!data || data.panelId === null) {
      return;
    }
    const tabId = Number(data.panelId);
    const group = event.group;
    if (!group) {
      return;
    }
    if (event.kind === "tab" || event.kind === "header_space") {
      let index = group.panels.length;
      if (event.panel) {
        index = group.panels.indexOf(event.panel);
      }
      executeCommand({
        type: "move-tab",
        id: tabId,
        groupId: group.id,
        index,
      });
      return;
    }
    if (event.position === "center") {
      if (data.groupId === group.id) {
        return;
      }
      executeCommand({
        type: "move-tab",
        id: tabId,
        groupId: group.id,
        index: group.panels.length,
      });
      return;
    }
    executeCommand({
      type: "split-tab",
      id: tabId,
      targetGroupId: group.id,
      side: event.position,
    });
  });

  workspace.dockview.api.onWillShowOverlay((event) => {
    if (event.kind === "edge") {
      event.preventDefault();
    }
  });

  workspace.dockview.api.onWillDragGroup((event) => {
    event.nativeEvent.preventDefault();
  });

  // Activation is applied by Dockview first, announced afterwards: blocking
  // the click would also block the drag that starts on the same mousedown.
  workspace.dockview.api.onDidActivePanelChange((event) => {
    if (!event.panel) {
      return;
    }
    const tabId = Number(event.panel.id);
    if (tabId === workspace.activeId) {
      return;
    }
    workspace.activeId = tabId;
    refreshWorkspaceName(workspace);
    focusWorkspace();
    bridge.emitEvent({
      type: "tab-activated",
      id: tabId,
      state: snapshot(),
    });
  });

  return workspace;
}

// The workspace a Command names, or the active one when it names none.
export function resolveWorkspace(
  id: number | undefined,
): Workspace | undefined {
  if (id === undefined) {
    return activeWorkspace;
  }
  return workspaces.get(id);
}

// Where the keyboard belongs in the active workspace: its project panel
// while that is the half being worked in, its active tab otherwise.
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
    tab.contentElement.current?.focus();
  }
}

// The host holds one panel per workspace and collapses when the active
// workspace has none open, so the pane layout gets the whole window back.
export function refreshProjectPanel(): void {
  for (const workspace of workspaces.values()) {
    if (workspace.project === undefined) {
      continue;
    }
    let display = "none";
    if (workspace === activeWorkspace && workspace.project.visible) {
      display = "";
    }
    workspace.project.element.style.display = display;
  }
  let hostDisplay = "none";
  if (activeWorkspace?.project?.visible === true) {
    hostDisplay = "";
  }
  projectHostElement.style.display = hostDisplay;
}

export function activateWorkspace(workspace: Workspace): void {
  if (activeWorkspace) {
    activeWorkspace.element.style.display = "none";
  }
  activeWorkspace = workspace;
  workspace.element.style.display = "";
  refreshProjectPanel();
  // which row is marked and what the title bar says both follow from the
  // line above, so drawing the chrome is all it takes to show them
  drawChrome();
  // Dockview measured its container while it was hidden, so it holds a zero
  // size; hand it the real one back.
  workspace.dockview.layout(
    workspace.element.clientWidth,
    workspace.element.clientHeight,
  );
  // Terminals skip fitting while their workspace is hidden (a zero box would
  // resize the shell to nothing), so re-fit them against the boxes they just
  // got back.
  for (const tab of workspace.tabs.values()) {
    if (tab.kind !== "terminal") {
      continue;
    }
    tab.fitAddon.fit();
  }
  focusWorkspace();
}

export function removeWorkspace(workspace: Workspace): void {
  for (const [tabId, tab] of workspace.tabs) {
    tab.row.root.unmount();
    if (tab.kind === "markdown") {
      tab.root.unmount();
      continue;
    }
    bridge.killShell(tabId);
    tab.observer.disconnect();
    tab.terminal.dispose();
  }
  if (workspace.project !== undefined) {
    disposeProjectPanel(workspace.project);
  }
  workspaces.delete(workspace.id);
  workspace.dockview.dispose();
  workspace.element.remove();
  drawChrome();
  if (activeWorkspace !== workspace) {
    return;
  }
  activeWorkspace = undefined;
  for (const remaining of workspaces.values()) {
    activateWorkspace(remaining);
    return;
  }
}

type SetWorkspaceNameOptions = {
  workspace: Workspace;
  name: string;
};

export function setWorkspaceName({
  workspace,
  name,
}: SetWorkspaceNameOptions): void {
  workspace.name = name;
  // its row wears it, and the title bar too while it is the active one
  drawChrome();
}

// A workspace wears its active tab's title, the way a tab wears the title
// its shell announces; an explicit rename pins it against both. Call this
// wherever the active tab, or its title, can have changed.
export function refreshWorkspaceName(workspace: Workspace): void {
  if (workspace.namePinned) {
    return;
  }
  let name = `Workspace ${workspace.id}`;
  const activeTab = workspace.tabs.get(workspace.activeId);
  if (activeTab) {
    name = activeTab.title;
  }
  setWorkspaceName({
    workspace,
    name,
  });
}

type FoundTab = {
  workspace: Workspace;
  tab: Tab;
};

// Tab ids are unique across workspaces (main keys its shells by them), so a
// background workspace's shell can still find its tab.
export function findTab(id: number): FoundTab | undefined {
  for (const workspace of workspaces.values()) {
    const tab = workspace.tabs.get(id);
    if (tab) {
      return {
        workspace,
        tab,
      };
    }
  }
  return undefined;
}

type FindGroupOptions = {
  workspace: Workspace;
  groupId: string;
};

export function findGroup({
  workspace,
  groupId,
}: FindGroupOptions): DockviewGroupPanel | undefined {
  for (const group of workspace.dockview.api.groups) {
    if (group.id === groupId) {
      return group;
    }
  }
  return undefined;
}

type AddPanelOptions = {
  workspace: Workspace;
  id: number;
  component: "terminal" | "markdown";
  title: string;
  paneElement: HTMLElement;
  group: DockviewGroupPanel | undefined;
};

type AddedPanel = {
  panel: IDockviewPanel;
  row: TabRow; // the tab's row in the strip, for retitling and disposal
};

export function addPanel({
  workspace,
  id,
  component,
  title,
  paneElement,
  group,
}: AddPanelOptions): AddedPanel {
  // The row in the strip is built here rather than by the caller: every kind
  // of tab wears the same one, and only the pane below it differs.
  const row = mountTabRow({
    id,
    title,
  });

  handOffPaneElement = paneElement;
  handOffTabElement = row.element;
  let position: AddPanelPositionOptions | undefined;
  if (group !== undefined) {
    position = { referenceGroup: group };
  }
  const panel = workspace.dockview.api.addPanel({
    id: String(id),
    component,
    tabComponent: `${component}-tab`,
    title,
    inactive: true,
    position,
  });
  return {
    panel,
    row,
  };
}

layoutElement.addEventListener("dblclick", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const tabElement = target.closest(".tab");
  if (tabElement instanceof HTMLElement && tabElement.dataset.tabId) {
    executeCommand({
      type: "toggle-maximize",
      id: Number(tabElement.dataset.tabId),
    });
    return;
  }
  if (!target.closest(".dv-void-container") || !activeWorkspace) {
    return;
  }
  for (const group of activeWorkspace.dockview.api.groups) {
    if (group.element.contains(target)) {
      executeCommand({
        type: "new-tab",
        groupId: group.id,
      });
      return;
    }
  }
});

// Which half of the window the keyboard belongs to, decided by where the
// last press landed: the panes take it back, the panel keeps it.
layoutElement.addEventListener("mousedown", () => {
  if (activeWorkspace) {
    activeWorkspace.focus = "layout";
  }
  setTimeout(focusWorkspace, 0);
});

projectHostElement.addEventListener("mousedown", () => {
  if (activeWorkspace) {
    activeWorkspace.focus = "project";
  }
});

// The empty strip under the list belongs to the sidebar itself, so a click
// whose target is the sidebar and not one of its buttons landed there, and
// reads as the same request the + button makes. A double click, like the one
// the empty space between panes answers to: a single click on a stretch of
// background is how you put focus somewhere, and opening a workspace out of
// that is more than a click that meant nothing should do.
const sidebarElement = requireElement("sidebar");
sidebarElement.addEventListener("dblclick", (event) => {
  if (event.target !== sidebarElement) {
    return;
  }
  executeCommand({ type: "new-workspace" });
});

type BuildLayoutOptions = {
  workspace: Workspace;
  node: SerializedGridNode;
  direction: "row" | "column";
};

function buildLayout({
  workspace,
  node,
  direction,
}: BuildLayoutOptions): LayoutNode {
  const data = node.data;
  if (!Array.isArray(data)) {
    const serializedGroup: SerializedGroup = data;
    const tabList: TabInfo[] = [];
    for (const panelId of serializedGroup.views) {
      const tab = workspace.tabs.get(Number(panelId));
      if (!tab) {
        continue;
      }
      const title = tab.title;
      if (tab.kind === "markdown") {
        tabList.push({
          id: Number(panelId),
          title,
          kind: "markdown",
          mode: tab.mode,
          path: tab.filePath,
        });
        continue;
      }
      tabList.push({
        id: Number(panelId),
        title,
        kind: "terminal",
      });
    }
    return {
      type: "group",
      group: {
        id: serializedGroup.id,
        tabs: tabList,
      },
    };
  }
  let childDirection: "row" | "column" = "row";
  if (direction === "row") {
    childDirection = "column";
  }
  const children: LayoutNode[] = [];
  for (const child of data) {
    children.push(
      buildLayout({
        workspace,
        node: child,
        direction: childDirection,
      }),
    );
  }
  return {
    type: "split",
    direction,
    children,
  };
}

type CollectTabsOptions = {
  node: LayoutNode;
  into: TabInfo[];
};

function collectTabs({ node, into }: CollectTabsOptions): void {
  if (node.type === "group") {
    for (const tab of node.group.tabs) {
      into.push(tab);
    }
    return;
  }
  for (const child of node.children) {
    collectTabs({
      node: child,
      into,
    });
  }
}

function describeProject(panel: ProjectPanel | undefined): ProjectInfo | null {
  if (panel === undefined) {
    return null;
  }
  let filePath: string | null = null;
  if (panel.file !== undefined) {
    filePath = panel.file.filePath;
  }
  return {
    id: panel.id,
    name: panel.name,
    workspaceRootPath: panel.workspaceRootPath,
    visible: panel.visible,
    filePath,
  };
}

function describeWorkspace(workspace: Workspace): WorkspaceInfo {
  let maximizedGroupId: string | null = null;
  for (const group of workspace.dockview.api.groups) {
    if (group.api.isMaximized()) {
      maximizedGroupId = group.id;
      break;
    }
  }
  const project = describeProject(workspace.project);
  if (workspace.dockview.api.panels.length === 0) {
    return {
      id: workspace.id,
      name: workspace.name,
      namePinned: workspace.namePinned,
      tabs: [],
      layout: null,
      activeId: workspace.activeId,
      maximizedGroupId,
      project,
      focus: workspace.focus,
    };
  }
  const serialized = workspace.dockview.api.toJSON();
  let rootDirection: "row" | "column" = "column";
  if (serialized.grid.orientation === Orientation.HORIZONTAL) {
    rootDirection = "row";
  }
  const layout = buildLayout({
    workspace,
    node: serialized.grid.root,
    direction: rootDirection,
  });
  const tabList: TabInfo[] = [];
  collectTabs({
    node: layout,
    into: tabList,
  });
  return {
    id: workspace.id,
    name: workspace.name,
    namePinned: workspace.namePinned,
    tabs: tabList,
    layout,
    activeId: workspace.activeId,
    maximizedGroupId,
    project,
    focus: workspace.focus,
  };
}

export function snapshot(): LmuxState {
  const workspaceList: WorkspaceInfo[] = [];
  for (const workspace of workspaces.values()) {
    workspaceList.push(describeWorkspace(workspace));
  }
  let activeWorkspaceId = -1;
  if (activeWorkspace) {
    activeWorkspaceId = activeWorkspace.id;
  }
  return {
    workspaces: workspaceList,
    activeWorkspaceId,
  };
}
