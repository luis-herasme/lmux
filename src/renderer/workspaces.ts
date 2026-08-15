// One workspace = one Dockview instance = one pane layout with its own
// tabs, plus the one project panel beside it. Only the active one is
// displayed; the others keep their terminals and their shells alive off
// screen.
import { executeCommand, focusWorkspace } from "./tabs/index.ts";
import type { Tab } from "./tabs/index.ts";
import { disposeProjectPanel } from "./project-panel.ts";
import type { ProjectPanel } from "./project-panel.ts";
import type {
  LayoutNode,
  LmuxState,
  ProjectInfo,
  TabInfo,
  WorkspaceInfo,
} from "../api.ts";
import type {
  AddPanelPositionOptions,
  DockviewComponent,
  DockviewGroupPanel,
  IDockviewPanel,
  SerializedDockview,
} from "dockview";
import { bridge } from "./bridge.ts";
import { requireElement } from "./dom.ts";

type SerializedGridNode = SerializedDockview["grid"]["root"];
type SerializedGroup = Exclude<SerializedGridNode["data"], unknown[]>;

export type Workspace = {
  id: number;
  name: string;
  element: HTMLElement; // its Dockview root, hidden unless active
  rowElement: HTMLElement; // its row in the sidebar
  nameElement: HTMLElement; // the name in that row, beside its ×
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

const titleBarElement = requireElement("title-bar");
const layoutElement = requireElement("layout");
const projectHostElement = requireElement("project");
const workspaceListElement = requireElement("workspace-list");

// dockview is a classic script too, so it arrives as a page global; see
// renderer/bridge.ts for why these are read rather than declared.
const dockviewLibrary: typeof import("dockview") = Reflect.get(
  window,
  "dockview",
);
if (!dockviewLibrary) {
  throw new Error("dockview's script did not load: window.dockview is missing");
}

// The element a panel shows is built by the caller of addPanel; Dockview's
// factories only ever hand it over.
let handOffPaneElement: HTMLElement | undefined;
let handOffTabElement: HTMLElement | undefined;

// One options object for every instance: a workspace's identity lives in
// its own store entry, never in the layout engine's configuration.
const DOCKVIEW_OPTIONS = {
  theme: dockviewLibrary.themeDark,
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
    button.className = "new-tab";
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
  element.className = "workspace-layout";
  element.style.display = "none";
  layoutElement.append(element);

  // A row and not a button, because the × in it is one and buttons do not
  // nest; role, tabindex and the keydown below give back what the element
  // type stopped saying and doing. Same shape a tab has in the strip.
  const rowElement = document.createElement("div");
  rowElement.className = "workspace-row";
  rowElement.role = "tab";
  rowElement.tabIndex = 0;
  rowElement.ariaSelected = "false";

  const nameElement = document.createElement("span");
  nameElement.className = "workspace-name";

  const closeElement = document.createElement("button");
  closeElement.className = "workspace-close";
  closeElement.textContent = "×";
  closeElement.title = "Close Workspace (⇧⌘W)";
  closeElement.ariaLabel = "Close workspace";
  closeElement.addEventListener("click", (event) => {
    event.stopPropagation();
    // Through main rather than straight onto the bus: closing a workspace
    // ends every shell in it, and only main can ask about the busy ones.
    bridge.closeWorkspace(id);
  });

  rowElement.append(nameElement, closeElement);
  rowElement.addEventListener("click", () => {
    executeCommand({
      type: "activate-workspace",
      id,
    });
  });
  rowElement.addEventListener("keydown", (event) => {
    // the × is a button of its own and answers both of these itself
    if (event.target !== rowElement) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault(); // Space scrolls, and the page must never scroll
    executeCommand({
      type: "activate-workspace",
      id,
    });
  });
  rowElement.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    bridge.showWorkspaceMenu(id);
  });
  workspaceListElement.append(rowElement);

  const workspace: Workspace = {
    id,
    name: "", // refreshWorkspaceName fills it in, below
    element,
    rowElement,
    nameElement,
    dockview: new dockviewLibrary.DockviewComponent(element, DOCKVIEW_OPTIONS),
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
    activeWorkspace.rowElement.classList.remove("active");
    activeWorkspace.rowElement.ariaSelected = "false";
  }
  activeWorkspace = workspace;
  workspace.element.style.display = "";
  refreshProjectPanel();
  workspace.rowElement.classList.add("active");
  workspace.rowElement.ariaSelected = "true";
  titleBarElement.textContent = workspace.name;
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
    if (tab.kind !== "terminal") {
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
  workspace.rowElement.remove();
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
  workspace.nameElement.textContent = name;
  // the row ellipsizes a long name; the tooltip always has it whole
  workspace.rowElement.title = name;
  if (workspace === activeWorkspace) {
    titleBarElement.textContent = name;
  }
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
  if (activeTab && activeTab.titleElement.textContent !== null) {
    name = activeTab.titleElement.textContent;
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
  tabElement: HTMLElement;
  group: DockviewGroupPanel | undefined;
};

export function addPanel({
  workspace,
  id,
  component,
  title,
  paneElement,
  tabElement,
  group,
}: AddPanelOptions): IDockviewPanel {
  handOffPaneElement = paneElement;
  handOffTabElement = tabElement;
  let position: AddPanelPositionOptions | undefined;
  if (group !== undefined) {
    position = { referenceGroup: group };
  }
  return workspace.dockview.api.addPanel({
    id: String(id),
    component,
    tabComponent: `${component}-tab`,
    title,
    inactive: true,
    position,
  });
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

requireElement("new-workspace-button").addEventListener("click", () => {
  executeCommand({ type: "new-workspace" });
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
      let title = tab.titleElement.textContent;
      if (title === null) {
        title = "";
      }
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
  if (serialized.grid.orientation === dockviewLibrary.Orientation.HORIZONTAL) {
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
