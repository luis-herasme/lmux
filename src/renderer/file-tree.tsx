// The editor's file tree: a view of directories read one at a time,
// drawn by React from what the tree holds rather than by hand from what the
// DOM already showed.
//
// The state is a plain object outside React (the FileTree below), because
// what changes it is asynchronous and belongs to the editor: a directory is
// expanded, a watcher reports a change, Git decorations come back. Every one
// of those ends in redraw(), which draws the editor again — its rows included
// — and leaves the difference to React.
import type { ReactNode } from "react";
import { bridge } from "./bridge.ts";
import type {
  GitDecorationStatus,
  FileTreeEntry,
  FileTreeGitDecoration,
  ReadFileTreeResult,
} from "../inter-process-communication/bridge.ts";

type OpenTreeFile = (filePath: string) => void;

// What one directory's children are. A directory the reader never expanded
// has no entry at all, which is how "not asked for" is spelled.
type DirectoryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; entries: FileTreeEntry[] };

export type FileTree = {
  workspaceRootPath: string;
  openFile: OpenTreeFile;
  // Draws the editor these rows are rendered in. The tree owns no root of its
  // own: it is one region of the editor's, so a change here is a change there.
  redraw: () => void;
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

// A row is a <summary> or a <button>; each names its own horizontal padding,
// because a button brings the browser's otherwise, and shares the rest.
const ROW_CLASS =
  "file-tree-row box-border flex min-h-6 w-full cursor-pointer items-center gap-1 overflow-hidden border-0 bg-transparent py-[3px] text-left text-[length:inherit] leading-[18px] whitespace-nowrap text-inherit outline-none hover:bg-separator hover:text-tab-active focus-visible:bg-separator focus-visible:text-tab-active";

// a row that says something instead of naming a file
const TREE_MESSAGE_CLASS = "px-2 py-[3px] leading-[18px] text-tab";

type TreeMessageProps = {
  children: ReactNode;
};

export function TreeMessage({ children }: TreeMessageProps): ReactNode {
  return <li className={TREE_MESSAGE_CLASS}>{children}</li>;
}

type TreeErrorProps = {
  message: string;
  retry: () => void;
};

// A read that failed, and the button offering it again. The workspace root's
// failure wears this too, which is why it is a component and not markup
// written twice.
export function TreeError({ message, retry }: TreeErrorProps): ReactNode {
  return (
    <li className={`${TREE_MESSAGE_CLASS} flex flex-col items-start gap-1`}>
      <span>{message}</span>
      <button
        className="rounded border-0 bg-separator px-2 py-[2px] text-[length:inherit] text-inherit"
        type="button"
        onClick={(event) => {
          // the row above it is a summary, and a click on that toggles
          event.preventDefault();
          event.stopPropagation();
          retry();
        }}
      >
        Retry
      </button>
    </li>
  );
}

type GitDecorationPresentation = {
  label: string;
  badge: string | undefined;
};

const GIT_DECORATION_PRESENTATIONS = {
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
} satisfies Record<GitDecorationStatus, GitDecorationPresentation>;

// What a directory does not inherit from something below it: a deleted or
// ignored child says nothing about the directory holding it.
const UNPROPAGATED_GIT_STATUSES = new Set<GitDecorationStatus>([
  "deleted",
  "ignored",
  "staged-deleted",
  "submodule",
]);

type HasIgnoredGitAncestorOptions = {
  fileTree: FileTree;
  treePath: string;
};

function hasIgnoredGitAncestor({
  fileTree,
  treePath,
}: HasIgnoredGitAncestorOptions): boolean {
  let separatorPosition = treePath.lastIndexOf("/");
  while (separatorPosition >= 0) {
    const ancestorPath = treePath.slice(0, separatorPosition);
    if (fileTree.gitDecorations.get(ancestorPath) === "ignored") {
      return true;
    }
    separatorPosition = ancestorPath.lastIndexOf("/");
  }
  return false;
}

type DecorateRowOptions = {
  fileTree: FileTree;
  entry: FileTreeEntry;
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
  fileTree,
  entry,
  name,
}: DecorateRowOptions): RowDecoration {
  const undecorated = {
    title: entry.path,
    "aria-label": name,
  };

  let status = fileTree.gitDecorations.get(entry.path);
  if (
    status === undefined &&
    hasIgnoredGitAncestor({
      fileTree,
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
  const descendantStatus = fileTree.propagatedGitDecorations.get(entry.path);
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
  fileTree: FileTree;
  directoryPath: string;
};

async function readDirectory({
  fileTree,
  directoryPath,
}: ReadDirectoryOptions): Promise<void> {
  // A directory with rows on screen is being re-read behind the reader's
  // back: it neither flashes a message over those rows nor replaces them
  // with an error. One with nothing to show is a read they are waiting on.
  const waitedOn =
    fileTree.directories.get(directoryPath)?.status !== "loaded";
  const request = (fileTree.requests.get(directoryPath) ?? 0) + 1;
  fileTree.requests.set(directoryPath, request);
  if (waitedOn) {
    fileTree.directories.set(directoryPath, { status: "loading" });
    fileTree.redraw();
  }

  let result: ReadFileTreeResult;
  try {
    result = await bridge.readFileTree({
      workspaceRootPath: fileTree.workspaceRootPath,
      workspaceRelativeDirectoryPath: directoryPath,
    });
  } catch (error) {
    result = { error: String(error) };
  }
  if (fileTree.requests.get(directoryPath) !== request) {
    return;
  }
  if ("error" in result) {
    if (waitedOn) {
      fileTree.directories.set(directoryPath, {
        status: "error",
        message: result.error,
      });
      fileTree.redraw();
    }
    return;
  }
  fileTree.directories.set(directoryPath, {
    status: "loaded",
    entries: result.entries,
  });
  fileTree.redraw();
}

type DirectoryContentsProps = {
  fileTree: FileTree;
  directoryPath: string;
};

// One directory's children, in whichever of its states it is in. The root's
// emptiness reads differently from a subdirectory's, because an empty
// workspace is a thing the reader may have to fix.
export function DirectoryContents({
  fileTree,
  directoryPath,
}: DirectoryContentsProps): ReactNode {
  const directory = fileTree.directories.get(directoryPath);
  if (directory === undefined) {
    return null;
  }
  if (directory.status === "loading") {
    return <TreeMessage>Loading…</TreeMessage>;
  }
  if (directory.status === "error") {
    return (
      <TreeError
        message={directory.message}
        retry={() => {
          readDirectory({
            fileTree,
            directoryPath,
          });
        }}
      />
    );
  }
  if (directory.entries.length === 0) {
    if (directoryPath === "") {
      return <TreeMessage>Empty workspace</TreeMessage>;
    }
    return <TreeMessage>Empty</TreeMessage>;
  }
  return directory.entries.map((entry) => (
    <TreeEntry key={entry.path} fileTree={fileTree} entry={entry} />
  ));
}

type TreeEntryProps = {
  fileTree: FileTree;
  entry: FileTreeEntry;
};

function TreeEntry({ fileTree, entry }: TreeEntryProps): ReactNode {
  const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
  const rowProps = {
    "data-file-tree-path": entry.path,
    ...decorateRow({
      fileTree,
      entry,
      name,
    }),
    onFocus: () => {
      fileTree.focusedPath = entry.path;
    },
  };

  if (entry.kind === "file") {
    return (
      <li className="file-tree-item">
        <button
          className={`${ROW_CLASS} file-tree-file pr-2 pl-6`}
          type="button"
          data-file-tree-kind="file"
          data-file-name={name}
          onClick={() => {
            fileTree.openFile(entry.absolutePath);
          }}
          {...rowProps}
        >
          <span
            className="file-tree-file-icon h-4 w-4 flex-none"
            aria-hidden="true"
          />
          <span className="file-tree-name min-w-0 flex-1 truncate">
            {name}
          </span>
        </button>
      </li>
    );
  }

  return (
    <li className="file-tree-item">
      {/* <details> keeps its own open state, so a re-read of the directory
          above cannot collapse what the reader expanded. */}
      <details
        className="file-tree-directory"
        onToggle={(event) => {
          // read on the first expansion only; after that the watcher keeps it
          if (
            !event.currentTarget.open ||
            fileTree.directories.has(entry.path)
          ) {
            return;
          }
          readDirectory({
            fileTree,
            directoryPath: entry.path,
          });
        }}
      >
        {/* list-none takes the browser's own disclosure triangle off */}
        <summary
          className={`${ROW_CLASS} list-none pr-2 pl-1`}
          data-file-tree-kind="directory"
          {...rowProps}
        >
          <span
            className="file-tree-disclosure h-4 w-4 flex-none"
            aria-hidden="true"
          />
          <span
            className="file-tree-folder-icon h-4 w-4 flex-none"
            aria-hidden="true"
          />
          <span className="file-tree-name min-w-0 flex-1 truncate">
            {name}
          </span>
        </summary>
        <ul className="m-0 list-none pl-4">
          <DirectoryContents
            fileTree={fileTree}
            directoryPath={entry.path}
          />
        </ul>
      </details>
    </li>
  );
}

type CreateFileTreeOptions = {
  workspaceRootPath: string;
  entries: FileTreeEntry[];
  openFile: OpenTreeFile;
  redraw: () => void;
};

export function createFileTree({
  workspaceRootPath,
  entries,
  openFile,
  redraw,
}: CreateFileTreeOptions): FileTree {
  return {
    workspaceRootPath,
    openFile,
    redraw,
    // the editor read the root already, to learn the workspace's name, so the
    // tree starts with one directory it never has to ask for
    directories: new Map([["", { status: "loaded", entries }]]),
    requests: new Map(),
    gitDecorations: new Map(),
    propagatedGitDecorations: new Map(),
    focusedPath: undefined,
  };
}

type RefreshFileTreePathsOptions = {
  fileTree: FileTree;
  paths: string[] | null;
};

// What the watcher reports are changed paths; what the tree can act on are
// the directories it is showing. A null list means "anything may have
// changed", and so does a change to the workspace root itself.
export async function refreshFileTreePaths({
  fileTree,
  paths,
}: RefreshFileTreePathsOptions): Promise<void> {
  const knownPaths = new Set(fileTree.directories.keys());
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
      fileTree,
      directoryPath,
    });
  }
}

type SetFileTreeGitDecorationsOptions = {
  fileTree: FileTree | undefined;
  decorations: FileTreeGitDecoration[];
};

export function setFileTreeGitDecorations({
  fileTree,
  decorations,
}: SetFileTreeGitDecorationsOptions): void {
  if (fileTree === undefined) {
    return;
  }
  fileTree.gitDecorations.clear();
  fileTree.propagatedGitDecorations.clear();
  for (const decoration of decorations) {
    fileTree.gitDecorations.set(decoration.path, decoration.status);
    if (UNPROPAGATED_GIT_STATUSES.has(decoration.status)) {
      continue;
    }
    let separatorPosition = decoration.path.lastIndexOf("/");
    while (separatorPosition >= 0) {
      const directoryPath = decoration.path.slice(0, separatorPosition);
      if (!fileTree.propagatedGitDecorations.has(directoryPath)) {
        fileTree.propagatedGitDecorations.set(
          directoryPath,
          decoration.status,
        );
      }
      separatorPosition = directoryPath.lastIndexOf("/");
    }
  }
  fileTree.redraw();
}

type FocusFileTreeOptions = {
  fileTree: FileTree;
  treeElement: HTMLElement;
};

// The row the keyboard was last on, by path rather than by element: the one
// that held it may have been replaced by a re-read since. Focus is the one
// thing React has no way to declare, so it is asked for by hand here.
export function focusFileTree({
  fileTree,
  treeElement,
}: FocusFileTreeOptions): void {
  let rowElement: HTMLElement | null = null;
  if (fileTree.focusedPath !== undefined) {
    rowElement = treeElement.querySelector(
      `.file-tree-row[data-file-tree-path="${CSS.escape(
        fileTree.focusedPath,
      )}"]`,
    );
  }
  if (rowElement === null) {
    rowElement = treeElement.querySelector(".file-tree-row");
  }
  if (rowElement === null) {
    treeElement.focus();
    return;
  }
  fileTree.focusedPath = rowElement.dataset.fileTreePath;
  rowElement.focus();
}
