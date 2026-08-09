// A project-tree pane: Pierre Trees plus file activation into open-file.
import { bridge } from "./bridge.ts";
import { executeCommand } from "./tabs.ts";
import type { TabElements, TreeTab } from "./tabs.ts";
import { addPanel } from "./workspaces.ts";
import type { Workspace } from "./workspaces.ts";
import type { ProjectTreeEntry } from "../ipc/bridge.ts";
import type { FileTree as PierreFileTree } from "@pierre/trees";
import type { DockviewGroupPanel } from "dockview";

type TreeLibrary = {
  FileTree: typeof PierreFileTree;
};

let treeLibraryPromise: Promise<TreeLibrary> | undefined;

async function loadTreeLibrary(): Promise<TreeLibrary> {
  if (treeLibraryPromise === undefined) {
    // @ts-expect-error package types, bundled browser value
    treeLibraryPromise = import("../vendor/trees.js");
  }
  return treeLibraryPromise;
}

type MountProjectTreeOptions = {
  entries: ProjectTreeEntry[];
  treeElement: HTMLElement;
  treeLibrary: TreeLibrary;
};

function mountProjectTree({
  entries,
  treeElement,
  treeLibrary,
}: MountProjectTreeOptions): PierreFileTree {
  const treePaths: string[] = [];
  const filePathsByTreePath = new Map<string, string>();
  for (const entry of entries) {
    let treePath = entry.path;
    if (entry.kind === "directory") {
      // Pierre marks an explicit directory with a trailing slash.
      treePath += "/";
    } else {
      filePathsByTreePath.set(entry.path, entry.absolutePath);
    }
    treePaths.push(treePath);
  }

  const fileTree = new treeLibrary.FileTree({
    initialExpansion: 1, // expand the first directory level
    paths: treePaths,
  });
  fileTree.render({ containerWrapper: treeElement });

  const fileTreeContainer = fileTree.getFileTreeContainer();
  if (fileTreeContainer === undefined) {
    return fileTree;
  }
  const shadowRoot = fileTreeContainer.shadowRoot;
  if (shadowRoot === null) {
    return fileTree;
  }

  // Selection changes omit repeat clicks, so activation uses the shadow root.
  shadowRoot.addEventListener("click", (event) => {
    for (const eventTarget of event.composedPath()) {
      if (!(eventTarget instanceof HTMLElement)) {
        continue;
      }
      if (eventTarget.dataset.itemType !== "file") {
        continue;
      }
      const treePath = eventTarget.dataset.itemPath;
      if (treePath === undefined) {
        return;
      }
      const filePath = filePathsByTreePath.get(treePath);
      if (filePath === undefined) {
        return;
      }
      executeCommand({
        type: "open-file",
        path: filePath,
      });
      return;
    }
  });

  return fileTree;
}

type OpenTreeTabOptions = {
  id: number;
  workspace: Workspace;
  tabElements: TabElements;
  baseTabId: number | undefined;
  rootPath: string | undefined;
  group: DockviewGroupPanel | undefined;
};

export async function openTreeTab({
  id,
  workspace,
  tabElements,
  baseTabId,
  rootPath,
  group,
}: OpenTreeTabOptions): Promise<TreeTab> {
  const [result, treeLibrary] = await Promise.all([
    bridge.readProjectTree({
      baseTabId,
      rootPath,
    }),
    loadTreeLibrary(),
  ]);

  const treeElement = document.createElement("div");
  treeElement.className = "tree-pane";
  treeElement.tabIndex = -1;

  let tabTitle = "Project";
  let tabRootPath = "";
  if (rootPath !== undefined) {
    tabRootPath = rootPath;
  }
  if (!("error" in result)) {
    tabTitle = result.name;
    tabRootPath = result.rootPath;
  }
  tabElements.titleElement.textContent = tabTitle;

  const panel = addPanel({
    workspace,
    id,
    component: "tree",
    title: tabTitle,
    paneElement: treeElement,
    tabElement: tabElements.tabElement,
    group,
  });

  let fileTree: PierreFileTree | undefined;
  if ("error" in result) {
    const heading = document.createElement("strong");
    heading.textContent = "Could not open project tree";
    const detail = document.createElement("span");
    detail.textContent = result.error;
    const errorElement = document.createElement("div");
    errorElement.className = "tree-error";
    errorElement.append(heading, detail);
    treeElement.append(errorElement);
  } else {
    fileTree = mountProjectTree({
      entries: result.entries,
      treeElement,
      treeLibrary,
    });
  }

  return {
    kind: "tree",
    panel,
    titleElement: tabElements.titleElement,
    titlePinned: true,
    element: treeElement,
    rootPath: tabRootPath,
    fileTree,
  };
}

export function focusTreeTab(tab: TreeTab): void {
  if (tab.fileTree === undefined) {
    tab.element.focus();
    return;
  }
  const focusedItem = tab.fileTree.getFocusedItem();
  if (focusedItem !== null) {
    focusedItem.focus();
    return;
  }
  tab.fileTree.focusFirstItem();
}

export function disposeTreeTab(tab: TreeTab): void {
  if (tab.fileTree === undefined) {
    return;
  }
  tab.fileTree.cleanUp();
}
