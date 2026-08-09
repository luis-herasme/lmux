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
  FileTree: typeof import("@pierre/trees").FileTree;
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
  paths: string[];
  absoluteFilePaths: Map<string, string>;
};

function prepareProjectTree(entries: ProjectTreeEntry[]): PreparedProjectTree {
  const paths: string[] = [];
  const absoluteFilePaths = new Map<string, string>();
  for (const entry of entries) {
    let treePath = entry.path;
    if (entry.kind === "directory") {
      // Pierre's path input marks an explicit directory with a trailing slash.
      treePath += "/";
    } else {
      absoluteFilePaths.set(entry.path, entry.absolutePath);
    }
    paths.push(treePath);
  }
  return {
    paths,
    absoluteFilePaths,
  };
}

type OpenProjectFileOptions = {
  relativePath: string;
  absoluteFilePaths: Map<string, string>;
};

function openProjectFile({
  relativePath,
  absoluteFilePaths,
}: OpenProjectFileOptions): void {
  const absolutePath = absoluteFilePaths.get(relativePath);
  if (absolutePath === undefined) {
    return;
  }
  executeCommand({
    type: "open-file",
    path: absolutePath,
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

  let title = "Project";
  let resolvedRootPath = rootPath;
  if (resolvedRootPath === undefined) {
    resolvedRootPath = "";
  }
  if (!("error" in result)) {
    title = result.name;
    resolvedRootPath = result.rootPath;
  }
  tabElements.titleElement.textContent = title;

  const panel = addPanel({
    workspace,
    id,
    component: "tree",
    title,
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
      paths: prepared.paths,
    });
    fileTree = mountedTree;
    mountedTree.render({ containerWrapper: pane.contentElement });

    // onSelectionChange omits repeat clicks, so activation listens in the shadow root.
    const fileTreeContainer = mountedTree.getFileTreeContainer();
    if (
      fileTreeContainer !== undefined &&
      fileTreeContainer.shadowRoot !== null
    ) {
      const shadowRoot = fileTreeContainer.shadowRoot;
      shadowRoot.addEventListener("click", (event) => {
        for (const eventTarget of event.composedPath()) {
          if (!(eventTarget instanceof HTMLElement)) {
            continue;
          }
          if (eventTarget.dataset.itemType !== "file") {
            continue;
          }
          const relativePath = eventTarget.dataset.itemPath;
          if (relativePath === undefined) {
            return;
          }
          openProjectFile({
            relativePath,
            absoluteFilePaths: prepared.absoluteFilePaths,
          });
          return;
        }
      });
      shadowRoot.addEventListener("keydown", (event) => {
        if (!(event instanceof KeyboardEvent) || event.key !== "Enter") {
          return;
        }
        const relativePath = mountedTree.getFocusedPath();
        if (relativePath === null) {
          return;
        }
        openProjectFile({
          relativePath,
          absoluteFilePaths: prepared.absoluteFilePaths,
        });
      });
    }
  }

  return {
    kind: "tree",
    panel,
    titleElement: tabElements.titleElement,
    titlePinned: true,
    element: pane.paneElement,
    contentElement: pane.contentElement,
    rootPath: resolvedRootPath,
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
