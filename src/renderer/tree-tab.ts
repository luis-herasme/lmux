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

type TreePane = {
  paneElement: HTMLElement;
  contentElement: HTMLElement;
};

function buildTreePane(): TreePane {
  const contentElement = document.createElement("div");
  contentElement.className = "tree-content";
  contentElement.tabIndex = -1;

  const paneElement = document.createElement("div");
  paneElement.className = "tree-pane";
  paneElement.append(contentElement);

  return {
    paneElement,
    contentElement,
  };
}

type ShowTreeErrorOptions = {
  contentElement: HTMLElement;
  message: string;
};

function showTreeError({
  contentElement,
  message,
}: ShowTreeErrorOptions): void {
  const heading = document.createElement("strong");
  heading.textContent = "Could not open project tree";
  const detail = document.createElement("span");
  detail.textContent = message;
  const errorElement = document.createElement("div");
  errorElement.className = "tree-error";
  errorElement.append(heading, detail);
  contentElement.append(errorElement);
}

type PreparedProjectTree = {
  treePaths: string[];
  filePathsByTreePath: Map<string, string>;
};

function prepareProjectTree(entries: ProjectTreeEntry[]): PreparedProjectTree {
  const treePaths: string[] = [];
  const filePathsByTreePath = new Map<string, string>();
  for (const entry of entries) {
    let treePath = entry.path;
    if (entry.kind === "directory") {
      // Pierre's path input marks an explicit directory with a trailing slash.
      treePath += "/";
    } else {
      filePathsByTreePath.set(entry.path, entry.absolutePath);
    }
    treePaths.push(treePath);
  }
  return {
    treePaths,
    filePathsByTreePath,
  };
}

type OpenProjectFileOptions = {
  treePath: string;
  filePathsByTreePath: Map<string, string>;
};

function openProjectFile({
  treePath,
  filePathsByTreePath,
}: OpenProjectFileOptions): void {
  const filePath = filePathsByTreePath.get(treePath);
  if (filePath === undefined) {
    return;
  }
  executeCommand({
    type: "open-file",
    path: filePath,
  });
}

function fileTreePathFromClick(event: Event): string | undefined {
  for (const eventTarget of event.composedPath()) {
    if (!(eventTarget instanceof HTMLElement)) {
      continue;
    }
    if (eventTarget.dataset.itemType !== "file") {
      continue;
    }
    return eventTarget.dataset.itemPath;
  }
  return undefined;
}

type AttachTreeActivationHandlersOptions = {
  fileTree: PierreFileTree;
  filePathsByTreePath: Map<string, string>;
};

// Repeat clicks do not change selection, so activation listens in the shadow root.
function attachTreeActivationHandlers({
  fileTree,
  filePathsByTreePath,
}: AttachTreeActivationHandlersOptions): void {
  const fileTreeContainer = fileTree.getFileTreeContainer();
  if (fileTreeContainer === undefined) {
    return;
  }
  const shadowRoot = fileTreeContainer.shadowRoot;
  if (shadowRoot === null) {
    return;
  }
  shadowRoot.addEventListener("click", (event) => {
    const treePath = fileTreePathFromClick(event);
    if (treePath === undefined) {
      return;
    }
    openProjectFile({
      treePath,
      filePathsByTreePath,
    });
  });
  shadowRoot.addEventListener("keydown", (event) => {
    if (!(event instanceof KeyboardEvent)) {
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    const treePath = fileTree.getFocusedPath();
    if (treePath === null) {
      return;
    }
    openProjectFile({
      treePath,
      filePathsByTreePath,
    });
  });
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
  const pane = buildTreePane();

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
    paneElement: pane.paneElement,
    tabElement: tabElements.tabElement,
    group,
  });

  let fileTree: PierreFileTree | undefined;
  if ("error" in result) {
    showTreeError({
      contentElement: pane.contentElement,
      message: result.error,
    });
  } else {
    const prepared = prepareProjectTree(result.entries);
    const mountedTree = new treeLibrary.FileTree({
      initialExpansion: 1, // expand the first directory level
      paths: prepared.treePaths,
    });
    fileTree = mountedTree;
    mountedTree.render({ containerWrapper: pane.contentElement });
    attachTreeActivationHandlers({
      fileTree: mountedTree,
      filePathsByTreePath: prepared.filePathsByTreePath,
    });
  }

  return {
    kind: "tree",
    panel,
    titleElement: tabElements.titleElement,
    titlePinned: true,
    element: pane.paneElement,
    contentElement: pane.contentElement,
    rootPath: tabRootPath,
    fileTree,
  };
}

export function focusTreeTab(tab: TreeTab): void {
  if (tab.fileTree === undefined) {
    tab.contentElement.focus();
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
