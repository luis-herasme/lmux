// One workspace = one Dockview instance = one pane layout with its own
// tabs, plus the one editor beside it. Only the active one is
// displayed; the others keep their terminals and their shells alive off
// screen.
//
// What a workspace looks like is panes.tsx; this is what it holds and what
// changes it. Every change ends in drawPanes(), which draws the pane area
// again and leaves the difference to React.
import { executeCommand } from "./tabs/index.ts";
import type { Tab } from "./tabs/index.ts";
import { disposeEditor, focusEditor } from "./editor.ts";
import type { Editor } from "./editor.ts";
import type {
  AddPanelPositionOptions,
  DockviewApi,
  DockviewGroupPanel,
  IDockviewPanel,
  Parameters,
} from "dockview";
import { bridge } from "./bridge.ts";
import { snapshot } from "./snapshot.ts";
import { drawChrome } from "./chrome.tsx";
import { drawEditors } from "./editor-view.tsx";
import { drawPanes } from "./panes.tsx";
import { requireElement } from "./dom.ts";
import { markWindowTopStrips } from "./window-drag.ts";

export type Workspace = {
  id: number;
  name: string;
  dockview: DockviewApi | undefined; // read it through dockviewOf
  tabs: Map<number, Tab>;
  activeId: number;
  namePinned: boolean;
  editor: Editor | undefined; // built the first time it is opened
  focus: "panes" | "editor"; // which half the keyboard is in
};

export const workspaces = new Map<number, Workspace>();

// live binding: importers read the current value, so no getter is needed
export let activeWorkspace: Workspace | undefined;

let nextWorkspaceId = 1;

// Tabs and editors share one counter, so an editor can be named by a
// command the same way a tab is.
let nextId = 0;

export function nextTabId(): number {
  return nextId++;
}

const editorHostElement = requireElement("editor");

// A workspace's layout engine, which its view hands over as it mounts.
// createWorkspace draws before it returns, so a caller holding a workspace
// holds this too.
export function dockviewOf(workspace: Workspace): DockviewApi {
  const dockview = workspace.dockview;
  if (dockview === undefined) {
    throw new Error(`workspace ${workspace.id} is not on screen yet`);
  }
  return dockview;
}

export function createWorkspace(): Workspace {
  const id = nextWorkspaceId++;
  const workspace: Workspace = {
    id,
    name: "", // refreshWorkspaceName fills it in, below
    dockview: undefined,
    tabs: new Map(),
    activeId: -1,
    namePinned: false,
    editor: undefined,
    focus: "panes",
  };
  workspaces.set(id, workspace);
  refreshWorkspaceName(workspace);
  // The draw is part of creating one: it mounts the view, and the view builds
  // the Dockview and hands it back through onReady. That lands before this
  // returns because drawPanes is a flushSync, which runs effects as well as
  // committing the DOM; if that ever stops holding, dockviewOf says so.
  drawPanes();
  return workspace;
}

type WorkspaceReadyOptions = {
  workspace: Workspace;
  dockview: DockviewApi;
};

// Called by the workspace's view once Dockview is built against it. Every
// listener a workspace keeps on its layout engine is registered here, because
// this is the one moment there is an engine to register them on.
export function workspaceReady({
  workspace,
  dockview,
}: WorkspaceReadyOptions): void {
  workspace.dockview = dockview;

  // Drag-and-drop interception: cancel the drop, re-issue it as a Command,
  // and let the consumer perform the identical move.
  dockview.onWillDrop((event) => {
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

  // Every layout Dockview settles on decides afresh which strips are along
  // the window's top edge, and so where the window can be dragged by one.
  // The event is buffered onto a microtask, so it arrives once the groups
  // have moved.
  dockview.onDidLayoutChange(markWindowTopStrips);

  dockview.onWillShowOverlay((event) => {
    if (event.kind === "edge") {
      event.preventDefault();
    }
  });

  dockview.onWillDragGroup((event) => {
    event.nativeEvent.preventDefault();
  });

  // Activation is applied by Dockview first, announced afterwards: blocking
  // the click would also block the drag that starts on the same mousedown.
  dockview.onDidActivePanelChange((event) => {
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

// Where the keyboard belongs in the active workspace: its editor
// while that is the half being worked in, its active tab otherwise.
export function focusWorkspace(): void {
  if (!activeWorkspace) {
    return;
  }
  const editor = activeWorkspace.editor;
  if (
    activeWorkspace.focus === "editor" &&
    editor !== undefined &&
    editor.visible
  ) {
    focusEditor(editor);
    return;
  }
  const tab = activeWorkspace.tabs.get(activeWorkspace.activeId);
  if (tab?.kind === "terminal") {
    tab.terminal.focus();
  }
  if (tab?.kind === "markdown") {
    tab.contentElement?.focus();
  }
}

// Which editor is on screen is the region's own business; the host around it
// collapses when the active workspace has none open, so the pane layout gets
// the whole window back.
export function refreshEditor(): void {
  drawEditors();
  let hostDisplay = "none";
  if (activeWorkspace?.editor?.visible === true) {
    hostDisplay = "";
  }
  editorHostElement.style.display = hostDisplay;
}

export function activateWorkspace(workspace: Workspace): void {
  activeWorkspace = workspace;
  refreshEditor();
  // which layout is on screen, which row is marked and what the title bar
  // says all follow from the line above, so drawing the two regions is all it
  // takes to show them. Handing Dockview and the terminals the size they got
  // back is the pane area's own business (panes.tsx).
  drawPanes();
  drawChrome();
  focusWorkspace();
}

export function removeWorkspace(workspace: Workspace): void {
  for (const [tabId, tab] of workspace.tabs) {
    if (tab.kind === "markdown") {
      continue;
    }
    bridge.killShell(tabId);
    tab.observer.disconnect();
    tab.terminal.dispose();
  }
  if (workspace.editor !== undefined) {
    disposeEditor(workspace.editor);
  }
  workspaces.delete(workspace.id);
  // unmounting the workspace's view disposes the Dockview built against it
  drawPanes();
  refreshEditor();
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
  for (const group of dockviewOf(workspace).groups) {
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
  parameters?: Parameters; // what a pane that has any draws itself from
  group: DockviewGroupPanel | undefined;
};

// The one door a panel is added through, so Dockview stays confined to the
// workspace store. The pane itself is a React component (panes.tsx) named by
// `component`; the caller never builds one.
//
// The pane is not drawn here. Adding the panel only asks React for one, and
// a pane reads the tab it belongs to out of the store, so the caller puts
// the record in and calls drawPanes when it is there.
export function addPanel({
  workspace,
  id,
  component,
  title,
  parameters,
  group,
}: AddPanelOptions): IDockviewPanel {
  let position: AddPanelPositionOptions | undefined;
  if (group !== undefined) {
    position = { referenceGroup: group };
  }
  return dockviewOf(workspace).addPanel({
    id: String(id),
    component,
    title,
    params: parameters,
    inactive: true,
    position,
  });
}

editorHostElement.addEventListener("mousedown", () => {
  if (activeWorkspace) {
    activeWorkspace.focus = "editor";
  }
});
