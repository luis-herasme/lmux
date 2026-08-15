// The project panel's file tree: a view of directories read one at a time,
// drawn by React from what the tree holds rather than by hand from what the
// DOM already showed.
//
// The state is a plain object outside React (the ProjectTree below), because
// what changes it is asynchronous and belongs to the panel: a directory is
// expanded, a watcher reports a change, Git decorations come back. Every one
// of those ends in draw(), which renders the whole tree again and leaves the
// difference to React.
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { ReactNode } from "react";
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
  // how many reads each directory has asked for: an answer to any but the
  // last is dropped rather than shown
  requests: Map<string, number>;
  gitDecorations: Map<string, GitDecorationStatus>;
  propagatedGitDecorations: Map<string, GitDecorationStatus>;
  // the row the keyboard was last on, held by path because the element
  // holding it is replaced whenever its directory is re-read
  focusedPath: string | undefined;
};

function draw(projectTree: ProjectTree): void {
  projectTree.root.render(
    <ul className="project-tree-root m-0 list-none pl-0">
      <DirectoryContents projectTree={projectTree} directoryPath="" />
    </ul>,
  );
}

// A row is a <summary> or a <button>; each names its own horizontal padding,
// because a button brings the browser's otherwise, and shares the rest.
const ROW_CLASS =
  "project-tree-row box-border flex min-h-6 w-full cursor-pointer items-center gap-1 overflow-hidden border-0 bg-transparent py-[3px] text-left text-[length:inherit] leading-[18px] whitespace-nowrap text-inherit outline-none hover:bg-separator hover:text-tab-active focus-visible:bg-separator focus-visible:text-tab-active";

// a row that says something instead of naming a file, and the button
// offering the read again; the panel's root error wears both too
export const TREE_MESSAGE_CLASS = "px-2 py-[3px] leading-[18px] text-tab";

export const TREE_RETRY_CLASS =
  "rounded border-0 bg-separator px-2 py-[2px] text-[length:inherit] text-inherit";

type GitDecorationPresentation = {
  label: string;
  badge: string | undefined;
};

const GIT_DECORATION_PRESENTATIONS: Record<
  GitDecorationStatus,
  GitDecorationPresentation
> = {
  added: { label: "Index Added", badge: "A" },
  conflicting: { label: "Conflict", badge: "!" },
  copied: { label: "Index Copied", badge: "C" },
  deleted: { label: "Deleted", badge: "D" },
  ignored: { label: "Ignored", badge: undefined },
  "intent-to-add": { label: "Intent to Add", badge: "A" },
  "intent-to-rename": { label: "Intent to Rename", badge: "R" },
  modified: { label: "Modified", badge: "M" },
  renamed: { label: "Index Renamed", badge: "R" },
  "staged-deleted": { label: "Index Deleted", badge: "D" },
  "staged-modified": { label: "Index Modified", badge: "M" },
  submodule: { label: "Submodule", badge: "S" },
  "type-changed": { label: "Type Changed", badge: "T" },
  untracked: { label: "Untracked", badge: "U" },
};

// What a directory does not inherit from something below it: a deleted or
// ignored child says nothing about the directory holding it.
const UNPROPAGATED_GIT_STATUSES = new Set<GitDecorationStatus>([
  "deleted",
  "ignored",
  "staged-deleted",
  "submodule",
]);

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

type DecorateRowOptions = {
  projectTree: ProjectTree;
  entry: ProjectTreeEntry;
  name: string;
};

type RowDecoration = {
  title: string;
  "aria-label": string;
  "data-git-decoration"?: GitDecorationStatus;
  "data-git-decoration-badge"?: string;
  "data-git-decoration-bubble"?: "true";
};

// What Git has to say about one row, as the attributes that row wears. New
// decorations redraw every row whose answer here changed, which is what
// replaced walking the DOM to repaint them.
function decorateRow({
  projectTree,
  entry,
  name,
}: DecorateRowOptions): RowDecoration {
  const undecorated = {
    title: entry.path,
    "aria-label": name,
  };

  let status = projectTree.gitDecorations.get(entry.path);
  if (
    status === undefined &&
    hasIgnoredGitAncestor({
      projectTree,
      treePath: entry.path,
    })
  ) {
    status = "ignored";
  }
  if (status === "ignored") {
    return {
      ...undecorated,
      "data-git-decoration": status,
    };
  }
  if (status !== undefined) {
    const presentation = GIT_DECORATION_PRESENTATIONS[status];
    return {
      title: `${entry.path} • ${presentation.label}`,
      "aria-label": `${name}, ${presentation.label}`,
      "data-git-decoration": status,
      "data-git-decoration-badge": presentation.badge,
    };
  }
  // A directory wears the first decoration found below it, so a change deep
  // inside a collapsed tree is still visible at the top.
  const descendantStatus = projectTree.propagatedGitDecorations.get(entry.path);
  if (entry.kind === "directory" && descendantStatus !== undefined) {
    return {
      title: `${entry.path} • Contains emphasized items`,
      "aria-label": `${name}, contains emphasized items`,
      "data-git-decoration": descendantStatus,
      "data-git-decoration-bubble": "true",
    };
  }
  return undecorated;
}

type ReadDirectoryOptions = {
  projectTree: ProjectTree;
  directoryPath: string;
};

async function readDirectory({
  projectTree,
  directoryPath,
}: ReadDirectoryOptions): Promise<void> {
  // A directory with rows on screen is being re-read behind the reader's
  // back: it neither flashes a message over those rows nor replaces them
  // with an error. One with nothing to show is a read they are waiting on.
  const waitedOn =
    projectTree.directories.get(directoryPath)?.status !== "loaded";
  const request = (projectTree.requests.get(directoryPath) ?? 0) + 1;
  projectTree.requests.set(directoryPath, request);
  if (waitedOn) {
    projectTree.directories.set(directoryPath, { status: "loading" });
    draw(projectTree);
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
  if (projectTree.requests.get(directoryPath) !== request) {
    return;
  }
  if ("error" in result) {
    if (waitedOn) {
      projectTree.directories.set(directoryPath, {
        status: "error",
        message: result.error,
      });
      draw(projectTree);
    }
    return;
  }
  projectTree.directories.set(directoryPath, {
    status: "loaded",
    entries: result.entries,
  });
  draw(projectTree);
}

type DirectoryContentsProps = {
  projectTree: ProjectTree;
  directoryPath: string;
};

// One directory's children, in whichever of its states it is in. The root's
// emptiness reads differently from a subdirectory's, because an empty
// workspace is a thing the reader may have to fix.
function DirectoryContents({
  projectTree,
  directoryPath,
}: DirectoryContentsProps): ReactNode {
  const directory = projectTree.directories.get(directoryPath);
  if (directory === undefined) {
    return null;
  }
  if (directory.status === "loading") {
    return <li className={TREE_MESSAGE_CLASS}>Loading…</li>;
  }
  if (directory.status === "error") {
    return (
      <li className={`${TREE_MESSAGE_CLASS} flex flex-col items-start gap-1`}>
        <span>{directory.message}</span>
        <button
          className={TREE_RETRY_CLASS}
          type="button"
          onClick={(event) => {
            // the row above it is a summary, and a click on that toggles
            event.preventDefault();
            event.stopPropagation();
            readDirectory({
              projectTree,
              directoryPath,
            });
          }}
        >
          Retry
        </button>
      </li>
    );
  }
  if (directory.entries.length === 0) {
    if (directoryPath === "") {
      return <li className={TREE_MESSAGE_CLASS}>Empty workspace</li>;
    }
    return <li className={TREE_MESSAGE_CLASS}>Empty</li>;
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
  const rowProps = {
    "data-project-tree-path": entry.path,
    ...decorateRow({
      projectTree,
      entry,
      name,
    }),
    onFocus: () => {
      projectTree.focusedPath = entry.path;
    },
  };

  if (entry.kind === "file") {
    return (
      <li className="project-tree-item">
        <button
          className={`${ROW_CLASS} project-tree-file pr-2 pl-6`}
          type="button"
          data-project-tree-kind="file"
          data-file-name={name}
          onClick={() => {
            projectTree.openFile(entry.absolutePath);
          }}
          {...rowProps}
        >
          <span
            className="project-tree-file-icon h-4 w-4 flex-none"
            aria-hidden="true"
          />
          <span className="project-tree-name min-w-0 flex-1 truncate">
            {name}
          </span>
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
          // read on the first expansion only; after that the watcher keeps it
          if (
            !event.currentTarget.open ||
            projectTree.directories.has(entry.path)
          ) {
            return;
          }
          readDirectory({
            projectTree,
            directoryPath: entry.path,
          });
        }}
      >
        {/* list-none takes the browser's own disclosure triangle off */}
        <summary
          className={`${ROW_CLASS} list-none pr-2 pl-1`}
          data-project-tree-kind="directory"
          {...rowProps}
        >
          <span
            className="project-tree-disclosure h-4 w-4 flex-none"
            aria-hidden="true"
          />
          <span
            className="project-tree-folder-icon h-4 w-4 flex-none"
            aria-hidden="true"
          />
          <span className="project-tree-name min-w-0 flex-1 truncate">
            {name}
          </span>
        </summary>
        <ul className="m-0 list-none pl-4">
          <DirectoryContents
            projectTree={projectTree}
            directoryPath={entry.path}
          />
        </ul>
      </details>
    </li>
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
  const projectTree: ProjectTree = {
    treeElement,
    root: createRoot(treeElement),
    workspaceRootPath,
    openFile,
    // the panel read the root already, to learn the workspace's name, so the
    // tree starts with one directory it never has to ask for
    directories: new Map([["", { status: "loaded", entries }]]),
    requests: new Map(),
    gitDecorations: new Map(),
    propagatedGitDecorations: new Map(),
    focusedPath: undefined,
  };
  draw(projectTree);
  return projectTree;
}

type RefreshProjectTreePathsOptions = {
  projectTree: ProjectTree;
  paths: string[] | null;
};

// What the watcher reports are changed paths; what the tree can act on are
// the directories it is showing. A null list means "anything may have
// changed", and so does a change to the workspace root itself.
export async function refreshProjectTreePaths({
  projectTree,
  paths,
}: RefreshProjectTreePathsOptions): Promise<void> {
  const knownPaths = new Set(projectTree.directories.keys());
  const stalePaths = new Set<string>();

  if (paths === null || paths.includes("")) {
    for (const knownPath of knownPaths) {
      stalePaths.add(knownPath);
    }
  }
  for (const changedPath of paths ?? []) {
    if (changedPath === ".git" || changedPath.startsWith(".git/")) {
      continue;
    }
    // the directory the change happened in, whose listing gained or lost a
    // row because of it
    const separatorPosition = changedPath.lastIndexOf("/");
    let parentPath = "";
    if (separatorPosition >= 0) {
      parentPath = changedPath.slice(0, separatorPosition);
    }
    if (knownPaths.has(parentPath)) {
      stalePaths.add(parentPath);
    }
    // and anything open below it, since a renamed directory takes its whole
    // subtree with it
    const descendantPrefix = `${changedPath}/`;
    for (const knownPath of knownPaths) {
      if (knownPath === changedPath || knownPath.startsWith(descendantPrefix)) {
        stalePaths.add(knownPath);
      }
    }
  }

  for (const directoryPath of stalePaths) {
    await readDirectory({
      projectTree,
      directoryPath,
    });
  }
}

type SetProjectTreeGitDecorationsOptions = {
  projectTree: ProjectTree | undefined;
  decorations: ProjectTreeGitDecoration[];
};

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
    if (UNPROPAGATED_GIT_STATUSES.has(decoration.status)) {
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
  draw(projectTree);
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
