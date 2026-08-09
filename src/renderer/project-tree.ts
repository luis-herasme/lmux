// Pierre Trees at the project-tab boundary: bundle loading, path translation
// and click activation. The project tab owns the resulting tree instance.
import type { ProjectTreeEntry } from "../ipc/bridge.ts";
import type { FileTree as PierreFileTree } from "@pierre/trees";

export type ProjectTreeLibrary = {
  FileTree: typeof PierreFileTree;
};

let treeLibraryPromise: Promise<ProjectTreeLibrary> | undefined;

export async function loadProjectTreeLibrary(): Promise<ProjectTreeLibrary> {
  if (treeLibraryPromise === undefined) {
    // @ts-expect-error package types, bundled browser value
    treeLibraryPromise = import("../vendor/trees.js");
  }
  return treeLibraryPromise;
}

export type OpenTreeFileOptions = {
  filePath: string;
  preview: boolean;
};

type OpenTreeFile = (options: OpenTreeFileOptions) => void;

type MountProjectTreeOptions = {
  treeElement: HTMLElement;
  entries: ProjectTreeEntry[];
  treeLibrary: ProjectTreeLibrary;
  openFile: OpenTreeFile;
};

export function mountProjectTree({
  treeElement,
  entries,
  treeLibrary,
  openFile,
}: MountProjectTreeOptions): PierreFileTree {
  const treePaths: string[] = [];
  const filePathsByTreePath = new Map<string, string>();
  for (const entry of entries) {
    let treePath = entry.path;
    if (entry.kind === "directory") {
      treePath += "/";
    } else {
      filePathsByTreePath.set(entry.path, entry.absolutePath);
    }
    treePaths.push(treePath);
  }

  treeElement.textContent = "";
  const fileTree = new treeLibrary.FileTree({
    initialExpansion: 1,
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

  shadowRoot.addEventListener("click", (event) => {
    let clickCount = 1;
    if (event instanceof MouseEvent) {
      clickCount = event.detail;
    }
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
      openFile({
        filePath,
        preview: clickCount < 2,
      });
      return;
    }
  });

  return fileTree;
}

type SetProjectTreeDirtyOptions = {
  fileTree: PierreFileTree | undefined;
  workspaceRootPath: string;
  dirtyFilePaths: string[];
};

export function setProjectTreeDirty({
  fileTree,
  workspaceRootPath,
  dirtyFilePaths,
}: SetProjectTreeDirtyOptions): void {
  if (fileTree === undefined) {
    return;
  }
  let prefix = workspaceRootPath;
  if (!prefix.endsWith("/")) {
    prefix += "/";
  }
  const statuses: { path: string; status: "modified" }[] = [];
  for (const dirtyFilePath of dirtyFilePaths) {
    if (!dirtyFilePath.startsWith(prefix)) {
      continue;
    }
    statuses.push({
      path: dirtyFilePath.slice(prefix.length),
      status: "modified",
    });
  }
  fileTree.setGitStatus(statuses);
}
