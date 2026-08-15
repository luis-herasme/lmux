import { bridge } from "./bridge.ts";
import type {
  GitDecorationStatus,
  ProjectTreeEntry,
  ProjectTreeGitDecoration,
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
  gitDecorations: Map<string, GitDecorationStatus>;
  propagatedGitDecorations: Map<string, GitDecorationStatus>;
  loadedDirectoryLists: Map<string, HTMLUListElement>;
  directoryRequestGenerations: Map<string, number>;
  pendingDirectoryRefreshes: Set<string>;
  nextDirectoryRequestGeneration: number;
  focusedElement: HTMLElement | undefined;
};

type MountProjectTreeOptions = {
  treeElement: HTMLElement;
  workspaceRootPath: string;
  entries: ProjectTreeEntry[];
  openFile: OpenTreeFile;
};

type AppendProjectTreeEntryOptions = {
  projectTree: ProjectTree;
  listElement: HTMLUListElement;
  entry: ProjectTreeEntry;
};

type LoadProjectTreeDirectoryOptions = {
  projectTree: ProjectTree;
  childrenElement: HTMLUListElement;
  workspaceRelativeDirectoryPath: string;
};

type SetProjectTreeGitDecorationsOptions = {
  projectTree: ProjectTree | undefined;
  decorations: ProjectTreeGitDecoration[];
};

type ApplyProjectTreeRowDecorationOptions = {
  projectTree: ProjectTree;
  rowElement: HTMLElement;
  name: string;
};

type HasIgnoredGitAncestorOptions = {
  projectTree: ProjectTree;
  treePath: string;
};

type RefreshProjectTreePathsOptions = {
  projectTree: ProjectTree;
  paths: string[] | null;
};

type RefreshProjectTreeDirectoryOptions = {
  projectTree: ProjectTree;
  workspaceRelativeDirectoryPath: string;
  listElement: HTMLUListElement;
};

type ReconcileProjectTreeEntriesOptions = {
  projectTree: ProjectTree;
  listElement: HTMLUListElement;
  entries: ProjectTreeEntry[];
};

type PruneLoadedDirectoryOptions = {
  projectTree: ProjectTree;
  directoryPath: string;
};

type GitDecorationPresentation = {
  label: string;
  badge: string | undefined;
};

const GIT_DECORATION_PRESENTATIONS: Record<
  GitDecorationStatus,
  GitDecorationPresentation
> = {
  added: {
    label: "Index Added",
    badge: "A",
  },
  conflicting: {
    label: "Conflict",
    badge: "!",
  },
  copied: {
    label: "Index Copied",
    badge: "C",
  },
  deleted: {
    label: "Deleted",
    badge: "D",
  },
  ignored: {
    label: "Ignored",
    badge: undefined,
  },
  "intent-to-add": {
    label: "Intent to Add",
    badge: "A",
  },
  "intent-to-rename": {
    label: "Intent to Rename",
    badge: "R",
  },
  modified: {
    label: "Modified",
    badge: "M",
  },
  renamed: {
    label: "Index Renamed",
    badge: "R",
  },
  "staged-deleted": {
    label: "Index Deleted",
    badge: "D",
  },
  "staged-modified": {
    label: "Index Modified",
    badge: "M",
  },
  submodule: {
    label: "Submodule",
    badge: "S",
  },
  "type-changed": {
    label: "Type Changed",
    badge: "T",
  },
  untracked: {
    label: "Untracked",
    badge: "U",
  },
};

function gitDecorationPropagates(status: GitDecorationStatus): boolean {
  if (
    status === "deleted" ||
    status === "ignored" ||
    status === "staged-deleted" ||
    status === "submodule"
  ) {
    return false;
  }
  return true;
}

function hasIgnoredGitAncestor({
  projectTree,
  treePath,
}: HasIgnoredGitAncestorOptions): boolean {
  let separatorPosition = treePath.lastIndexOf("/");
  while (separatorPosition >= 0) {
    const ancestorPath = treePath.slice(0, separatorPosition);
    if (projectTree.gitDecorations.get(ancestorPath) === "ignored") {
      return true;
    }
    separatorPosition = ancestorPath.lastIndexOf("/");
  }
  return false;
}

function applyProjectTreeRowDecoration({
  projectTree,
  rowElement,
  name,
}: ApplyProjectTreeRowDecorationOptions): void {
  const treePath = rowElement.dataset.projectTreePath;
  const kind = rowElement.dataset.projectTreeKind;
  if (treePath === undefined || kind === undefined) {
    return;
  }

  delete rowElement.dataset.gitDecoration;
  delete rowElement.dataset.gitDecorationBadge;
  delete rowElement.dataset.gitDecorationBubble;
  rowElement.title = treePath;
  rowElement.ariaLabel = name;

  let status = projectTree.gitDecorations.get(treePath);
  let descendantDecoration = false;
  if (
    status === undefined &&
    hasIgnoredGitAncestor({
      projectTree,
      treePath,
    })
  ) {
    status = "ignored";
  }
  if (status === undefined && kind === "directory") {
    status = projectTree.propagatedGitDecorations.get(treePath);
    descendantDecoration = status !== undefined;
  }
  if (status === undefined) {
    return;
  }

  rowElement.dataset.gitDecoration = status;
  if (status === "ignored") {
    return;
  }
  if (descendantDecoration) {
    rowElement.dataset.gitDecorationBubble = "true";
    rowElement.title = `${treePath} • Contains emphasized items`;
    rowElement.ariaLabel = `${name}, contains emphasized items`;
    return;
  }

  const presentation = GIT_DECORATION_PRESENTATIONS[status];
  if (presentation.badge !== undefined) {
    rowElement.dataset.gitDecorationBadge = presentation.badge;
  }
  rowElement.title = `${treePath} • ${presentation.label}`;
  rowElement.ariaLabel = `${name}, ${presentation.label}`;
}

async function loadProjectTreeDirectory({
  projectTree,
  childrenElement,
  workspaceRelativeDirectoryPath,
}: LoadProjectTreeDirectoryOptions): Promise<void> {
  projectTree.nextDirectoryRequestGeneration += 1;
  const requestGeneration = projectTree.nextDirectoryRequestGeneration;
  projectTree.directoryRequestGenerations.set(
    workspaceRelativeDirectoryPath,
    requestGeneration,
  );

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

  if (
    projectTree.directoryRequestGenerations.get(
      workspaceRelativeDirectoryPath,
    ) !== requestGeneration
  ) {
    return;
  }
  projectTree.loadedDirectoryLists.set(
    workspaceRelativeDirectoryPath,
    childrenElement,
  );
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
        childrenElement,
        workspaceRelativeDirectoryPath,
      });
    });

    errorElement.append(errorTextElement, retryElement);
    childrenElement.replaceChildren(errorElement);
  } else if (result.entries.length === 0) {
    const emptyElement = document.createElement("li");
    emptyElement.className = "project-tree-message";
    emptyElement.textContent = "Empty";
    childrenElement.replaceChildren(emptyElement);
  } else {
    childrenElement.replaceChildren();
    for (const entry of result.entries) {
      appendProjectTreeEntry({
        projectTree,
        listElement: childrenElement,
        entry,
      });
    }
  }

  if (
    projectTree.pendingDirectoryRefreshes.delete(workspaceRelativeDirectoryPath)
  ) {
    await refreshProjectTreeDirectory({
      projectTree,
      workspaceRelativeDirectoryPath,
      listElement: childrenElement,
    });
  }
}

function appendProjectTreeEntry({
  projectTree,
  listElement,
  entry,
}: AppendProjectTreeEntryOptions): void {
  const itemElement = document.createElement("li");
  itemElement.className = "project-tree-item";
  const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);

  if (entry.kind === "directory") {
    const detailsElement = document.createElement("details");
    detailsElement.className = "project-tree-directory";
    let directoryReadStarted = false;

    const summaryElement = document.createElement("summary");
    summaryElement.className = "project-tree-row";
    summaryElement.dataset.projectTreeKind = "directory";
    summaryElement.dataset.projectTreePath = entry.path;
    summaryElement.title = entry.path;

    const disclosureElement = document.createElement("span");
    disclosureElement.className = "project-tree-disclosure";
    disclosureElement.ariaHidden = "true";

    const iconElement = document.createElement("span");
    iconElement.className = "project-tree-icon project-tree-folder-icon";
    iconElement.ariaHidden = "true";

    const nameElement = document.createElement("span");
    nameElement.className = "project-tree-name";
    nameElement.textContent = name;
    summaryElement.append(disclosureElement, iconElement, nameElement);
    applyProjectTreeRowDecoration({
      projectTree,
      rowElement: summaryElement,
      name,
    });
    summaryElement.addEventListener("focus", () => {
      projectTree.focusedElement = summaryElement;
    });

    const childrenElement = document.createElement("ul");
    childrenElement.className = "project-tree-list";
    detailsElement.append(summaryElement, childrenElement);
    detailsElement.addEventListener("toggle", () => {
      if (!detailsElement.open || directoryReadStarted) {
        return;
      }
      directoryReadStarted = true;
      loadProjectTreeDirectory({
        projectTree,
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
  fileElement.title = entry.path;

  const iconElement = document.createElement("span");
  iconElement.className = "project-tree-icon project-tree-file-icon";
  iconElement.ariaHidden = "true";

  const nameElement = document.createElement("span");
  nameElement.className = "project-tree-name";
  nameElement.textContent = name;
  fileElement.append(iconElement, nameElement);
  applyProjectTreeRowDecoration({
    projectTree,
    rowElement: fileElement,
    name,
  });
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
    gitDecorations: new Map(),
    propagatedGitDecorations: new Map(),
    loadedDirectoryLists: new Map(),
    directoryRequestGenerations: new Map(),
    pendingDirectoryRefreshes: new Set(),
    nextDirectoryRequestGeneration: 0,
    focusedElement: undefined,
  };
  const listElement = document.createElement("ul");
  listElement.className = "project-tree-list project-tree-root";
  projectTree.loadedDirectoryLists.set("", listElement);
  if (entries.length === 0) {
    const emptyElement = document.createElement("li");
    emptyElement.className = "project-tree-message";
    emptyElement.textContent = "Empty workspace";
    listElement.append(emptyElement);
  } else {
    for (const entry of entries) {
      appendProjectTreeEntry({
        projectTree,
        listElement,
        entry,
      });
    }
  }
  treeElement.replaceChildren(listElement);
  return projectTree;
}

function pruneLoadedDirectory({
  projectTree,
  directoryPath,
}: PruneLoadedDirectoryOptions): void {
  const descendantPrefix = `${directoryPath}/`;
  for (const loadedPath of Array.from(
    projectTree.loadedDirectoryLists.keys(),
  )) {
    if (
      loadedPath === directoryPath ||
      loadedPath.startsWith(descendantPrefix)
    ) {
      projectTree.loadedDirectoryLists.delete(loadedPath);
    }
  }
  for (const requestedPath of Array.from(
    projectTree.directoryRequestGenerations.keys(),
  )) {
    if (
      requestedPath === directoryPath ||
      requestedPath.startsWith(descendantPrefix)
    ) {
      projectTree.directoryRequestGenerations.delete(requestedPath);
      projectTree.pendingDirectoryRefreshes.delete(requestedPath);
    }
  }
}

const ITEM_ROW_SELECTOR =
  ":scope > .project-tree-file, :scope > .project-tree-directory > summary";

type ExistingTreeItem = {
  itemElement: HTMLLIElement;
  kind: string;
};

function reconcileProjectTreeEntries({
  projectTree,
  listElement,
  entries,
}: ReconcileProjectTreeEntriesOptions): void {
  const existingItems = new Map<string, ExistingTreeItem>();
  for (const childElement of Array.from(listElement.children)) {
    if (!(childElement instanceof HTMLLIElement)) {
      continue;
    }
    const rowElement =
      childElement.querySelector<HTMLElement>(ITEM_ROW_SELECTOR);
    const treePath = rowElement?.dataset.projectTreePath;
    const kind = rowElement?.dataset.projectTreeKind;
    if (treePath === undefined || kind === undefined) {
      continue;
    }
    existingItems.set(treePath, {
      itemElement: childElement,
      kind,
    });
  }

  const orderedItems: HTMLLIElement[] = [];
  for (const entry of entries) {
    // Consuming the match leaves only vanished paths for the prune pass below.
    const existingItem = existingItems.get(entry.path);
    existingItems.delete(entry.path);
    if (existingItem?.kind === entry.kind) {
      orderedItems.push(existingItem.itemElement);
      continue;
    }
    if (existingItem?.kind === "directory") {
      pruneLoadedDirectory({
        projectTree,
        directoryPath: entry.path,
      });
    }
    appendProjectTreeEntry({
      projectTree,
      listElement,
      entry,
    });
    const appendedItem = listElement.lastElementChild;
    if (appendedItem instanceof HTMLLIElement) {
      orderedItems.push(appendedItem);
    }
  }

  for (const [vanishedPath, vanishedItem] of existingItems) {
    if (vanishedItem.kind !== "directory") {
      continue;
    }
    pruneLoadedDirectory({
      projectTree,
      directoryPath: vanishedPath,
    });
  }

  if (orderedItems.length === 0) {
    const emptyElement = document.createElement("li");
    emptyElement.className = "project-tree-message";
    emptyElement.textContent = "Empty";
    listElement.replaceChildren(emptyElement);
    return;
  }
  listElement.replaceChildren(...orderedItems);
}

async function refreshProjectTreeDirectory({
  projectTree,
  workspaceRelativeDirectoryPath,
  listElement,
}: RefreshProjectTreeDirectoryOptions): Promise<void> {
  projectTree.nextDirectoryRequestGeneration += 1;
  const requestGeneration = projectTree.nextDirectoryRequestGeneration;
  projectTree.directoryRequestGenerations.set(
    workspaceRelativeDirectoryPath,
    requestGeneration,
  );

  let result: ReadProjectTreeResult;
  try {
    result = await bridge.readProjectTree({
      workspaceRootPath: projectTree.workspaceRootPath,
      workspaceRelativeDirectoryPath,
    });
  } catch {
    return;
  }
  if (
    "error" in result ||
    result.workspaceRootPath !== projectTree.workspaceRootPath ||
    projectTree.loadedDirectoryLists.get(workspaceRelativeDirectoryPath) !==
      listElement ||
    projectTree.directoryRequestGenerations.get(
      workspaceRelativeDirectoryPath,
    ) !== requestGeneration
  ) {
    return;
  }
  reconcileProjectTreeEntries({
    projectTree,
    listElement,
    entries: result.entries,
  });
}

export async function refreshProjectTreePaths({
  projectTree,
  paths,
}: RefreshProjectTreePathsOptions): Promise<void> {
  const directoryPaths = new Set<string>();
  const knownDirectoryPaths = new Set<string>();
  for (const directoryPath of projectTree.loadedDirectoryLists.keys()) {
    knownDirectoryPaths.add(directoryPath);
  }
  for (const directoryPath of projectTree.directoryRequestGenerations.keys()) {
    knownDirectoryPaths.add(directoryPath);
  }

  if (paths === null) {
    for (const directoryPath of knownDirectoryPaths) {
      directoryPaths.add(directoryPath);
    }
  } else {
    for (const changedPath of paths) {
      if (changedPath === ".git" || changedPath.startsWith(".git/")) {
        continue;
      }
      if (changedPath.length === 0) {
        for (const directoryPath of knownDirectoryPaths) {
          directoryPaths.add(directoryPath);
        }
        continue;
      }
      const separatorPosition = changedPath.lastIndexOf("/");
      if (separatorPosition < 0) {
        directoryPaths.add("");
      } else {
        directoryPaths.add(changedPath.slice(0, separatorPosition));
      }

      const descendantPrefix = `${changedPath}/`;
      for (const knownDirectoryPath of knownDirectoryPaths) {
        if (
          knownDirectoryPath === changedPath ||
          knownDirectoryPath.startsWith(descendantPrefix)
        ) {
          directoryPaths.add(knownDirectoryPath);
        }
      }
    }
  }

  for (const directoryPath of directoryPaths) {
    const listElement = projectTree.loadedDirectoryLists.get(directoryPath);
    if (listElement === undefined) {
      if (projectTree.directoryRequestGenerations.has(directoryPath)) {
        projectTree.pendingDirectoryRefreshes.add(directoryPath);
      }
      continue;
    }
    await refreshProjectTreeDirectory({
      projectTree,
      workspaceRelativeDirectoryPath: directoryPath,
      listElement,
    });
  }
}

export function setProjectTreeGitDecorations({
  projectTree,
  decorations,
}: SetProjectTreeGitDecorationsOptions): void {
  if (projectTree === undefined) {
    return;
  }
  projectTree.gitDecorations.clear();
  projectTree.propagatedGitDecorations.clear();
  for (const decoration of decorations) {
    projectTree.gitDecorations.set(decoration.path, decoration.status);
    if (!gitDecorationPropagates(decoration.status)) {
      continue;
    }
    let separatorPosition = decoration.path.lastIndexOf("/");
    while (separatorPosition >= 0) {
      const directoryPath = decoration.path.slice(0, separatorPosition);
      if (!projectTree.propagatedGitDecorations.has(directoryPath)) {
        projectTree.propagatedGitDecorations.set(
          directoryPath,
          decoration.status,
        );
      }
      separatorPosition = directoryPath.lastIndexOf("/");
    }
  }

  const rowElements =
    projectTree.treeElement.querySelectorAll<HTMLElement>(".project-tree-row");
  for (const rowElement of rowElements) {
    const nameElement = rowElement.querySelector(".project-tree-name");
    if (!(nameElement instanceof HTMLElement)) {
      continue;
    }
    let name = nameElement.textContent;
    if (name === null) {
      name = "";
    }
    applyProjectTreeRowDecoration({
      projectTree,
      rowElement,
      name,
    });
  }
}

export function focusProjectTree(projectTree: ProjectTree): void {
  const focusedElement = projectTree.focusedElement;
  if (focusedElement !== undefined && focusedElement.isConnected) {
    focusedElement.focus();
    return;
  }
  const firstElement =
    projectTree.treeElement.querySelector<HTMLElement>(".project-tree-row");
  if (firstElement === null) {
    projectTree.treeElement.focus();
    return;
  }
  projectTree.focusedElement = firstElement;
  firstElement.focus();
}
