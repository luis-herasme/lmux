// The public read model: in-memory Workspace records plus the layout
// engine's serialization, turned into the LmuxState every Event carries, the
// session writer consumes, and the MCP `state` tool answers from.
//
// Dockview's serialized format is read here and nowhere else, so a change to
// how the engine serializes a layout is a change to this one module.
import { Orientation } from "dockview";
import type { SerializedDockview } from "dockview";
import type {
  LayoutNode,
  LmuxState,
  EditorInfo,
  TabInfo,
  WorkspaceInfo,
} from "../api.ts";
import { activeWorkspace, dockviewOf, workspaces } from "./workspaces.ts";
import type { Workspace } from "./workspaces.ts";
import type { Editor } from "./editor.ts";

type SerializedGridNode = SerializedDockview["grid"]["root"];
type SerializedGroup = Exclude<SerializedGridNode["data"], unknown[]>;

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

function describeEditor(editor: Editor | undefined): EditorInfo | null {
  if (editor === undefined) {
    return null;
  }
  let filePath: string | null = null;
  if (editor.file !== undefined) {
    filePath = editor.file.filePath;
  }
  return {
    id: editor.id,
    name: editor.name,
    workspaceRootPath: editor.workspaceRootPath,
    visible: editor.visible,
    filePath,
  };
}

function describeWorkspace(workspace: Workspace): WorkspaceInfo {
  const dockview = dockviewOf(workspace);
  let maximizedGroupId: string | null = null;
  for (const group of dockview.groups) {
    if (group.api.isMaximized()) {
      maximizedGroupId = group.id;
      break;
    }
  }
  const editor = describeEditor(workspace.editor);
  if (dockview.panels.length === 0) {
    return {
      id: workspace.id,
      name: workspace.name,
      namePinned: workspace.namePinned,
      tabs: [],
      layout: null,
      activeId: workspace.activeId,
      maximizedGroupId,
      editor,
      focus: workspace.focus,
    };
  }
  const serialized = dockview.toJSON();
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
    editor,
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
