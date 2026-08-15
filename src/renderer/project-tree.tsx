// The project panel's file tree: a view of directories read one at a time,
// drawn by React from what the tree holds rather than by hand from what the
// DOM already showed.
//
// The state is a plain object outside React (the ProjectTree below), because
// everything that changes it is asynchronous and belongs to the panel: a
// directory is expanded, a watcher reports a change, Git decorations come
// back. React subscribes to it and renders; nothing here reads the DOM to
// decide what to do next.
import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { bridge } from "./bridge.ts";
import type {
  GitDecorationStatus,
  ProjectTreeEntry,
  ProjectTreeGitDecoration,
  ReadProjectTreeResult,
} from "../ipc/bridge.ts";

type OpenTreeFile = (filePath: string) => void;

// What one directory's children are. A directory the reader never expanded
// has no entry at all, which is how "not asked for" is spelled.
type DirectoryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; entries: ProjectTreeEntry[] };

export type ProjectTree = {
  treeElement: HTMLElement;
  root: Root;
  workspaceRootPath: string;
  openFile: OpenTreeFile;
  // keyed by workspace-relative directory path; "" is the workspace root
  directories: Map<string, DirectoryState>;
  // the last read asked for per directory: an answer that is not the one
  // still being waited on is dropped rather than shown
  requests: Map<string, number>;
  nextRequest: number;
  gitDecorations: Map<string, GitDecorationStatus>;
  propagatedGitDecorations: Map<string, GitDecorationStatus>;
  // the row the keyboard was last on, remembered by path because the element
  // holding it is replaced whenever its directory is re-read
  focusedPath: string | undefined;
  version: number; // bumped on every change; what React subscribes to
  listeners: Set<() => void>;
};

// Everything that changes the tree ends here, and this is the only thing
// that makes React draw again.
function changed(projectTree: ProjectTree): void {
  projectTree.version += 1;
  for (const listener of projectTree.listeners) {
    listener();
  }
}

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

type HasIgnoredGitAncestorOptions = {
  projectTree: ProjectTree;
  treePath: string;
};

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

// What a row wears once Git has had its say: the attributes are computed
// from the decoration maps and handed to the row as props, so a new set of
// decorations redraws every row that one changed.
type RowDecoration = {
  title: string;
  ariaLabel: string;
  status: GitDecorationStatus | undefined;
  badge: string | undefined;
  bubble: boolean;
};

type DecorateRowOptions = {
  projectTree: ProjectTree;
  entry: ProjectTreeEntry;
  name: string;
};

function decorateRow({
  projectTree,
  entry,
  name,
}: DecorateRowOptions): RowDecoration {
  const undecorated: RowDecoration = {
    title: entry.path,
    ariaLabel: name,
    status: undefined,
    badge: undefined,
    bubble: false,
  };

  let status = projectTree.gitDecorations.get(entry.path);
  let descendantDecoration = false;
  if (
    status === undefined &&
    hasIgnoredGitAncestor({
      projectTree,
      treePath: entry.path,
    })
  ) {
    status = "ignored";
  }
  if (status === undefined && entry.kind === "directory") {
    status = projectTree.propagatedGitDecorations.get(entry.path);
    descendantDecoration = status !== undefined;
  }
  if (status === undefined) {
    return undecorated;
  }
  if (status === "ignored") {
    return {
      ...undecorated,
      status,
    };
  }
  if (descendantDecoration) {
    return {
      ...undecorated,
      status,
      bubble: true,
      title: `${entry.path} • Contains emphasized items`,
      ariaLabel: `${name}, contains emphasized items`,
    };
  }
  const presentation = GIT_DECORATION_PRESENTATIONS[status];
  return {
    ...undecorated,
    status,
    badge: presentation.badge,
    title: `${entry.path} • ${presentation.label}`,
    ariaLabel: `${name}, ${presentation.label}`,
  };
}

type ReadDirectoryOptions = {
  projectTree: ProjectTree;
  directoryPath: string;
  // A first read is one the reader is waiting on: it may say "Loading…"
  // while it happens and it has to report what went wrong. A re-read happens
  // behind their back, so it neither flashes a message over rows they are
  // looking at nor replaces those rows with an error.
  firstRead: boolean;
};

async function readDirectory({
  projectTree,
  directoryPath,
  firstRead,
}: ReadDirectoryOptions): Promise<void> {
  projectTree.nextRequest += 1;
  const request = projectTree.nextRequest;
  projectTree.requests.set(directoryPath, request);
  if (firstRead) {
    projectTree.directories.set(directoryPath, { status: "loading" });
    changed(projectTree);
  }

  let result: ReadProjectTreeResult;
  try {
    result = await bridge.readProjectTree({
      workspaceRootPath: projectTree.workspaceRootPath,
      workspaceRelativeDirectoryPath: directoryPath,
    });
  } catch (error) {
    result = { error: String(error) };
  }
  // an answer to a read this directory has moved on from, or one from a
  // workspace root the panel has since left, is not an answer at all
  if (projectTree.requests.get(directoryPath) !== request) {
    return;
  }
  if ("error" in result) {
    if (firstRead) {
      projectTree.directories.set(directoryPath, {
        status: "error",
        message: result.error,
      });
      changed(projectTree);
    }
    return;
  }
  if (result.workspaceRootPath !== projectTree.workspaceRootPath) {
    return;
  }
  setDirectoryEntries({
    projectTree,
    directoryPath,
    entries: result.entries,
  });
}

type SetDirectoryEntriesOptions = {
  projectTree: ProjectTree;
  directoryPath: string;
  entries: ProjectTreeEntry[];
};

// A directory whose children are gone takes its own children's state with
// it: if that path comes back it should be read again, not redrawn from
// what it held the last time it existed.
function setDirectoryEntries({
  projectTree,
  directoryPath,
  entries,
}: SetDirectoryEntriesOptions): void {
  const survivingPaths = new Set<string>();
  for (const entry of entries) {
    survivingPaths.add(entry.path);
  }
  let prefix = "";
  if (directoryPath !== "") {
    prefix = `${directoryPath}/`;
  }
  for (const knownPath of Array.from(projectTree.directories.keys())) {
    if (knownPath === directoryPath || !knownPath.startsWith(prefix)) {
      continue;
    }
    const childName = knownPath.slice(prefix.length).split("/")[0];
    if (survivingPaths.has(`${prefix}${childName}`)) {
      continue;
    }
    projectTree.directories.delete(knownPath);
    projectTree.requests.delete(knownPath);
  }

  projectTree.directories.set(directoryPath, {
    status: "loaded",
    entries,
  });
  changed(projectTree);
}

type DirectoryContentsProps = {
  projectTree: ProjectTree;
  directoryPath: string;
};

// One directory's children, in whichever of its three states it is in. The
// root's own emptiness reads differently from a subdirectory's, because an
// empty workspace is a thing the reader may have to fix.
function DirectoryContents({
  projectTree,
  directoryPath,
}: DirectoryContentsProps): ReactNode {
  const directory = projectTree.directories.get(directoryPath);
  if (directory === undefined) {
    return null;
  }
  if (directory.status === "loading") {
    return <li className="project-tree-message">Loading…</li>;
  }
  if (directory.status === "error") {
    return (
      <li className="project-tree-message project-tree-error">
        <span>{directory.message}</span>
        <button
          className="project-tree-retry"
          type="button"
          onClick={(event) => {
            // the row underneath is a summary, and a click on it toggles
            event.preventDefault();
            event.stopPropagation();
            readDirectory({
              projectTree,
              directoryPath,
              firstRead: true,
            });
          }}
        >
          Retry
        </button>
      </li>
    );
  }
  if (directory.entries.length === 0) {
    let message = "Empty";
    if (directoryPath === "") {
      message = "Empty workspace";
    }
    return <li className="project-tree-message">{message}</li>;
  }
  return directory.entries.map((entry) => (
    <TreeEntry key={entry.path} projectTree={projectTree} entry={entry} />
  ));
}

type TreeEntryProps = {
  projectTree: ProjectTree;
  entry: ProjectTreeEntry;
};

function TreeEntry({ projectTree, entry }: TreeEntryProps): ReactNode {
  const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
  const decoration = decorateRow({
    projectTree,
    entry,
    name,
  });
  const rowProps = {
    "data-project-tree-path": entry.path,
    "data-git-decoration": decoration.status,
    "data-git-decoration-badge": decoration.badge,
    "data-git-decoration-bubble": decoration.bubble ? "true" : undefined,
    title: decoration.title,
    "aria-label": decoration.ariaLabel,
    onFocus: () => {
      projectTree.focusedPath = entry.path;
    },
  };

  if (entry.kind === "file") {
    return (
      <li className="project-tree-item">
        <button
          className="project-tree-row project-tree-file"
          type="button"
          data-project-tree-kind="file"
          data-file-name={name}
          onClick={() => {
            projectTree.openFile(entry.absolutePath);
          }}
          {...rowProps}
        >
          <span
            className="project-tree-icon project-tree-file-icon"
            aria-hidden="true"
          />
          <span className="project-tree-name">{name}</span>
        </button>
      </li>
    );
  }

  return (
    <li className="project-tree-item">
      {/* <details> keeps its own open state, so a re-read of the directory
          above cannot collapse what the reader expanded. */}
      <details
        className="project-tree-directory"
        onToggle={(event) => {
          if (!event.currentTarget.open) {
            return;
          }
          // read once, the first time it is opened; a directory already read
          // is refreshed by its watcher, not by being opened again
          if (projectTree.directories.has(entry.path)) {
            return;
          }
          readDirectory({
            projectTree,
            directoryPath: entry.path,
            firstRead: true,
          });
        }}
      >
        <summary
          className="project-tree-row"
          data-project-tree-kind="directory"
          {...rowProps}
        >
          <span className="project-tree-disclosure" aria-hidden="true" />
          <span
            className="project-tree-icon project-tree-folder-icon"
            aria-hidden="true"
          />
          <span className="project-tree-name">{name}</span>
        </summary>
        <ul className="project-tree-list">
          <DirectoryContents
            projectTree={projectTree}
            directoryPath={entry.path}
          />
        </ul>
      </details>
    </li>
  );
}

type ProjectTreeViewProps = {
  projectTree: ProjectTree;
};

function ProjectTreeView({
  projectTree,
}: ProjectTreeViewProps): ReactNode {
  // The store is outside React and mutated in place, so what React watches
  // is the version number: a new one means draw the tree again.
  useSyncExternalStore(
    (listener) => {
      projectTree.listeners.add(listener);
      return () => {
        projectTree.listeners.delete(listener);
      };
    },
    () => projectTree.version,
  );

  return (
    <ul className="project-tree-list project-tree-root">
      <DirectoryContents projectTree={projectTree} directoryPath="" />
    </ul>
  );
}

type MountProjectTreeOptions = {
  treeElement: HTMLElement;
  workspaceRootPath: string;
  entries: ProjectTreeEntry[];
  openFile: OpenTreeFile;
};

export function mountProjectTree({
  treeElement,
  workspaceRootPath,
  entries,
  openFile,
}: MountProjectTreeOptions): ProjectTree {
  treeElement.replaceChildren();
  const projectTree: ProjectTree = {
    treeElement,
    root: createRoot(treeElement),
    workspaceRootPath,
    openFile,
    // the panel already read the root to learn the workspace's name, so the
    // tree starts with one directory it never has to ask for
    directories: new Map([["", { status: "loaded", entries }]]),
    requests: new Map(),
    nextRequest: 0,
    gitDecorations: new Map(),
    propagatedGitDecorations: new Map(),
    focusedPath: undefined,
    version: 0,
    listeners: new Set(),
  };
  projectTree.root.render(<ProjectTreeView projectTree={projectTree} />);
  return projectTree;
}

// Only a panel that is reloading its root or going away unmounts its tree;
// hiding the panel leaves it standing.
export function unmountProjectTree(projectTree: ProjectTree): void {
  projectTree.root.unmount();
}

type RefreshProjectTreePathsOptions = {
  projectTree: ProjectTree;
  paths: string[] | null;
};

// What the watcher reports are changed paths; what the tree can act on are
// the directories it is showing. A null list means "anything may have
// changed", which is every directory it has.
export async function refreshProjectTreePaths({
  projectTree,
  paths,
}: RefreshProjectTreePathsOptions): Promise<void> {
  const knownPaths = new Set(projectTree.directories.keys());
  const directoryPaths = new Set<string>();

  if (paths === null) {
    for (const knownPath of knownPaths) {
      directoryPaths.add(knownPath);
    }
  } else {
    for (const changedPath of paths) {
      if (changedPath === ".git" || changedPath.startsWith(".git/")) {
        continue;
      }
      if (changedPath.length === 0) {
        for (const knownPath of knownPaths) {
          directoryPaths.add(knownPath);
        }
        continue;
      }
      // the directory the change happened in, which is the one whose listing
      // gained or lost a row
      const separatorPosition = changedPath.lastIndexOf("/");
      if (separatorPosition < 0) {
        directoryPaths.add("");
      } else {
        directoryPaths.add(changedPath.slice(0, separatorPosition));
      }
      // and anything below it that is open, since a renamed directory takes
      // its whole subtree with it
      const descendantPrefix = `${changedPath}/`;
      for (const knownPath of knownPaths) {
        if (
          knownPath === changedPath ||
          knownPath.startsWith(descendantPrefix)
        ) {
          directoryPaths.add(knownPath);
        }
      }
    }
  }

  for (const directoryPath of directoryPaths) {
    if (!knownPaths.has(directoryPath)) {
      continue;
    }
    await readDirectory({
      projectTree,
      directoryPath,
      firstRead: false,
    });
  }
}

type SetProjectTreeGitDecorationsOptions = {
  projectTree: ProjectTree | undefined;
  decorations: ProjectTreeGitDecoration[];
};

// Git reports the files it has something to say about; a directory wears the
// first decoration found below it, so a change deep in a collapsed tree is
// still visible at the top.
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
  changed(projectTree);
}

// The row the keyboard was last on, by path rather than by element: the one
// that held it may have been replaced by a re-read since.
export function focusProjectTree(projectTree: ProjectTree): void {
  let rowElement: HTMLElement | null = null;
  if (projectTree.focusedPath !== undefined) {
    rowElement = projectTree.treeElement.querySelector(
      `.project-tree-row[data-project-tree-path="${CSS.escape(
        projectTree.focusedPath,
      )}"]`,
    );
  }
  if (rowElement === null) {
    rowElement = projectTree.treeElement.querySelector(".project-tree-row");
  }
  if (rowElement === null) {
    projectTree.treeElement.focus();
    return;
  }
  projectTree.focusedPath = rowElement.dataset.projectTreePath;
  rowElement.focus();
}
