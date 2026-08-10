import { bridge } from "./bridge.ts";
import type {
  ProjectTreeEntry,
  ReadProjectTreeResult,
} from "../ipc/bridge.ts";

type OpenTreeFileOptions = {
  filePath: string;
  preview: boolean;
};

type OpenTreeFile = (options: OpenTreeFileOptions) => void;

export type ProjectTree = {
  treeElement: HTMLElement;
  workspaceRootPath: string;
  openFile: OpenTreeFile;
  dirtyTreePaths: Set<string>;
  focusedElement: HTMLElement | undefined;
};

type MountProjectTreeOptions = {
  treeElement: HTMLElement;
  workspaceRootPath: string;
  entries: ProjectTreeEntry[];
  openFile: OpenTreeFile;
};

type AppendProjectTreeEntriesOptions = {
  projectTree: ProjectTree;
  listElement: HTMLUListElement;
  entries: ProjectTreeEntry[];
};

type AppendProjectTreeEntryOptions = {
  projectTree: ProjectTree;
  listElement: HTMLUListElement;
  entry: ProjectTreeEntry;
};

type LoadProjectTreeDirectoryOptions = {
  projectTree: ProjectTree;
  detailsElement: HTMLDetailsElement;
  childrenElement: HTMLUListElement;
  workspaceRelativeDirectoryPath: string;
};

type SetProjectTreeDirtyOptions = {
  projectTree: ProjectTree | undefined;
  dirtyFilePaths: string[];
};

function treeEntryName(treePath: string): string {
  const separatorPosition = treePath.lastIndexOf("/");
  if (separatorPosition < 0) {
    return treePath;
  }
  return treePath.slice(separatorPosition + 1);
}

function appendProjectTreeEntries({
  projectTree,
  listElement,
  entries,
}: AppendProjectTreeEntriesOptions): void {
  for (const entry of entries) {
    appendProjectTreeEntry({
      projectTree,
      listElement,
      entry,
    });
  }
}

async function loadProjectTreeDirectory({
  projectTree,
  detailsElement,
  childrenElement,
  workspaceRelativeDirectoryPath,
}: LoadProjectTreeDirectoryOptions): Promise<void> {
  const loadingElement = document.createElement("li");
  loadingElement.className = "project-tree-message";
  loadingElement.textContent = "Loading…";
  childrenElement.replaceChildren(loadingElement);

  let result: ReadProjectTreeResult;
  try {
    result = await bridge.readProjectTree({
      workspaceRootPath: projectTree.workspaceRootPath,
      workspaceRelativeDirectoryPath,
    });
  } catch (error) {
    result = { error: String(error) };
  }

  if ("error" in result) {
    const errorElement = document.createElement("li");
    errorElement.className = "project-tree-message project-tree-error";

    const errorTextElement = document.createElement("span");
    errorTextElement.textContent = result.error;

    const retryElement = document.createElement("button");
    retryElement.className = "project-tree-retry";
    retryElement.type = "button";
    retryElement.textContent = "Retry";
    retryElement.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      loadProjectTreeDirectory({
        projectTree,
        detailsElement,
        childrenElement,
        workspaceRelativeDirectoryPath,
      });
    });

    errorElement.append(errorTextElement, retryElement);
    childrenElement.replaceChildren(errorElement);
    return;
  }

  childrenElement.replaceChildren();
  if (result.entries.length === 0) {
    const emptyElement = document.createElement("li");
    emptyElement.className = "project-tree-message";
    emptyElement.textContent = "Empty";
    childrenElement.append(emptyElement);
    return;
  }
  appendProjectTreeEntries({
    projectTree,
    listElement: childrenElement,
    entries: result.entries,
  });
}

function appendProjectTreeEntry({
  projectTree,
  listElement,
  entry,
}: AppendProjectTreeEntryOptions): void {
  const itemElement = document.createElement("li");
  itemElement.className = "project-tree-item";
  const name = treeEntryName(entry.path);

  if (entry.kind === "directory") {
    const detailsElement = document.createElement("details");
    detailsElement.className = "project-tree-directory";
    let directoryReadStarted = false;

    const summaryElement = document.createElement("summary");
    summaryElement.className = "project-tree-row";
    summaryElement.dataset.projectTreeKind = "directory";
    summaryElement.dataset.projectTreePath = entry.path;
    summaryElement.textContent = name;
    summaryElement.title = entry.path;
    summaryElement.addEventListener("focus", () => {
      projectTree.focusedElement = summaryElement;
    });

    const childrenElement = document.createElement("ul");
    childrenElement.className = "project-tree-list";
    detailsElement.append(summaryElement, childrenElement);
    detailsElement.addEventListener("toggle", () => {
      if (!detailsElement.open) {
        return;
      }
      if (directoryReadStarted) {
        return;
      }
      directoryReadStarted = true;
      loadProjectTreeDirectory({
        projectTree,
        detailsElement,
        childrenElement,
        workspaceRelativeDirectoryPath: entry.path,
      });
    });
    itemElement.append(detailsElement);
    listElement.append(itemElement);
    return;
  }

  const fileElement = document.createElement("button");
  fileElement.className = "project-tree-row project-tree-file";
  fileElement.type = "button";
  fileElement.dataset.projectTreeKind = "file";
  fileElement.dataset.projectTreePath = entry.path;
  fileElement.dataset.fileName = name;
  fileElement.textContent = name;
  fileElement.title = entry.path;
  const dirty = projectTree.dirtyTreePaths.has(entry.path);
  fileElement.classList.toggle("dirty", dirty);
  if (dirty) {
    fileElement.ariaLabel = `${name}, modified`;
  } else {
    fileElement.ariaLabel = name;
  }
  fileElement.addEventListener("focus", () => {
    projectTree.focusedElement = fileElement;
  });
  fileElement.addEventListener("click", (event) => {
    projectTree.openFile({
      filePath: entry.absolutePath,
      preview: event.detail < 2,
    });
  });

  itemElement.append(fileElement);
  listElement.append(itemElement);
}

export function mountProjectTree({
  treeElement,
  workspaceRootPath,
  entries,
  openFile,
}: MountProjectTreeOptions): ProjectTree {
  const projectTree: ProjectTree = {
    treeElement,
    workspaceRootPath,
    openFile,
    dirtyTreePaths: new Set(),
    focusedElement: undefined,
  };
  const listElement = document.createElement("ul");
  listElement.className = "project-tree-list project-tree-root";
  if (entries.length === 0) {
    const emptyElement = document.createElement("li");
    emptyElement.className = "project-tree-message";
    emptyElement.textContent = "Empty workspace";
    listElement.append(emptyElement);
  } else {
    appendProjectTreeEntries({
      projectTree,
      listElement,
      entries,
    });
  }
  treeElement.replaceChildren(listElement);
  return projectTree;
}

export function setProjectTreeDirty({
  projectTree,
  dirtyFilePaths,
}: SetProjectTreeDirtyOptions): void {
  if (projectTree === undefined) {
    return;
  }
  projectTree.dirtyTreePaths.clear();
  let prefix = projectTree.workspaceRootPath;
  if (!prefix.endsWith("/")) {
    prefix += "/";
  }
  for (const dirtyFilePath of dirtyFilePaths) {
    if (!dirtyFilePath.startsWith(prefix)) {
      continue;
    }
    projectTree.dirtyTreePaths.add(dirtyFilePath.slice(prefix.length));
  }

  const fileElements =
    projectTree.treeElement.querySelectorAll<HTMLButtonElement>(
      ".project-tree-file",
    );
  for (const fileElement of fileElements) {
    const treePath = fileElement.dataset.projectTreePath;
    if (treePath === undefined) {
      continue;
    }
    const dirty = projectTree.dirtyTreePaths.has(treePath);
    fileElement.classList.toggle("dirty", dirty);
    let label = fileElement.dataset.fileName;
    if (label === undefined) {
      label = treeEntryName(treePath);
    }
    if (dirty) {
      fileElement.ariaLabel = `${label}, modified`;
    } else {
      fileElement.ariaLabel = label;
    }
  }
}

export function focusProjectTree(projectTree: ProjectTree): void {
  const focusedElement = projectTree.focusedElement;
  if (focusedElement !== undefined && focusedElement.isConnected) {
    focusedElement.focus();
    return;
  }
  const firstElement = projectTree.treeElement.querySelector<HTMLElement>(
    ".project-tree-row",
  );
  if (firstElement === null) {
    projectTree.treeElement.focus();
    return;
  }
  projectTree.focusedElement = firstElement;
  firstElement.focus();
}
