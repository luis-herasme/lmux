// One workspace's file experience: its stable root, tree, file tabs and
// editor. Dockview sees this whole unit as one project tab.
import { bridge } from "../bridge.ts";
import {
  createCodeEditor,
  languageForPath,
  loadMonaco,
} from "./code.ts";
import type { Monaco } from "./code.ts";
import {
  projectTreeChangeMessageSchema,
  readProjectTreeGitDecorationsResultSchema,
  saveNewFileResultSchema,
  watchProjectTreeResultSchema,
} from "../../ipc/bridge.ts";
import type {
  ReadProjectTreeGitDecorationsResult,
  ReadProjectTreeRequest,
  ReadProjectTreeResult,
  WatchProjectTreeResult,
} from "../../ipc/bridge.ts";
import {
  focusProjectTree,
  mountProjectTree,
  refreshProjectTreePaths,
  setProjectTreeGitDecorations,
} from "./project-tree.ts";
import type { ProjectTree } from "./project-tree.ts";
import { executeCommand } from "./index.ts";
import type { TabElements } from "./index.ts";
import {
  addPanel,
  refreshWorkspaceName,
  snapshot,
} from "../workspaces.ts";
import type { Workspace } from "../workspaces.ts";
import type { editor as monacoEditor } from "monaco-editor";
import type { IDockviewPanel, DockviewGroupPanel } from "dockview";

export type ProjectFileBuffer = {
  resourceKey: string;
  filePath: string | undefined;
  untitledId: number | undefined;
  model: monacoEditor.ITextModel | undefined;
  mtimeMs: number | undefined;
  dirty: boolean;
  pinned: boolean;
  error: string | undefined;
  tabElement: HTMLElement;
  titleElement: HTMLElement;
  closeElement: HTMLButtonElement;
  viewState: monacoEditor.ICodeEditorViewState | null;
};

export type ProjectTab = {
  kind: "project";
  panel: IDockviewPanel;
  titleElement: HTMLElement;
  titlePinned: boolean;
  treeElement: HTMLElement;
  editorElement: HTMLElement;
  fileTabsElement: HTMLElement;
  statusElement: HTMLElement;
  emptyElement: HTMLElement;
  errorElement: HTMLElement;
  workspaceRootPath: string;
  projectTree: ProjectTree | undefined;
  monaco: Monaco;
  editor: monacoEditor.IStandaloneCodeEditor;
  files: Map<string, ProjectFileBuffer>;
  activeFileKey: string | undefined;
  previewFileKey: string | undefined;
  draggedFileKey: string | undefined;
  latestFileRequest: number;
  latestTreeRequest: number;
  latestGitRequest: number;
  projectTreeWatcherId: number | undefined;
  projectTreeWatcherRetryCount: number;
  projectTreeWatcherRetryTimer: number | undefined;
};

type ProjectPane = {
  paneElement: HTMLElement;
  treeElement: HTMLElement;
  editorElement: HTMLElement;
  fileTabsElement: HTMLElement;
  statusElement: HTMLElement;
  emptyElement: HTMLElement;
  errorElement: HTMLElement;
};

const DEFAULT_PROJECT_TREE_WIDTH_PX = 260;
const MIN_PROJECT_TREE_WIDTH_PX = 120;
const MAX_PROJECT_TREE_WIDTH_PX = 600;
const MIN_PROJECT_EDITOR_WIDTH_PX = 160;
const PROJECT_TREE_KEYBOARD_RESIZE_STEP_PX = 20;

type MountProjectTreeResizeHandleOptions = {
  paneElement: HTMLElement;
  treeElement: HTMLElement;
  resizeHandleElement: HTMLElement;
};

function mountProjectTreeResizeHandle({
  paneElement,
  treeElement,
  resizeHandleElement,
}: MountProjectTreeResizeHandleOptions): void {
  function applyProjectTreeWidth(requestedWidth: number): void {
    const paneWidth = Math.round(paneElement.getBoundingClientRect().width);
    let maximumWidth = paneWidth - MIN_PROJECT_EDITOR_WIDTH_PX;
    maximumWidth = Math.min(MAX_PROJECT_TREE_WIDTH_PX, maximumWidth);
    if (maximumWidth < MIN_PROJECT_TREE_WIDTH_PX) {
      maximumWidth = MIN_PROJECT_TREE_WIDTH_PX;
    }
    const width = Math.min(
      maximumWidth,
      Math.max(MIN_PROJECT_TREE_WIDTH_PX, Math.round(requestedWidth)),
    );
    paneElement.style.setProperty("--project-tree-width", `${width}px`);
    resizeHandleElement.setAttribute("aria-valuenow", String(width));
    resizeHandleElement.setAttribute("aria-valuemax", String(maximumWidth));
  }

  function resizeProjectTree(event: MouseEvent): void {
    event.preventDefault();
    const paneBounds = paneElement.getBoundingClientRect();
    applyProjectTreeWidth(event.clientX - paneBounds.left);
  }

  function endProjectTreeResize(): void {
    document.removeEventListener("mousemove", resizeProjectTree, true);
    document.removeEventListener("mouseup", endProjectTreeResize, true);
    document.body.classList.remove("resizing");
    resizeHandleElement.classList.remove("dragging");
  }

  resizeHandleElement.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    resizeHandleElement.classList.add("dragging");
    document.body.classList.add("resizing");
    document.addEventListener("mousemove", resizeProjectTree, true);
    document.addEventListener("mouseup", endProjectTreeResize, true);
  });

  resizeHandleElement.addEventListener("keydown", (event) => {
    let requestedWidth = Math.round(treeElement.getBoundingClientRect().width);
    if (event.key === "ArrowLeft") {
      requestedWidth -= PROJECT_TREE_KEYBOARD_RESIZE_STEP_PX;
    } else if (event.key === "ArrowRight") {
      requestedWidth += PROJECT_TREE_KEYBOARD_RESIZE_STEP_PX;
    } else if (event.key === "Home") {
      requestedWidth = MIN_PROJECT_TREE_WIDTH_PX;
    } else if (event.key === "End") {
      requestedWidth = MAX_PROJECT_TREE_WIDTH_PX;
    } else {
      return;
    }
    event.preventDefault();
    applyProjectTreeWidth(requestedWidth);
  });
}

function buildProjectPane(): ProjectPane {
  const treeElement = document.createElement("div");
  treeElement.className = "project-tree";
  treeElement.tabIndex = -1;
  treeElement.textContent = "Loading workspace…";

  const resizeHandleElement = document.createElement("div");
  resizeHandleElement.className = "project-tree-resizer";
  resizeHandleElement.setAttribute("role", "separator");
  resizeHandleElement.setAttribute("aria-label", "Resize file tree");
  resizeHandleElement.setAttribute("aria-orientation", "vertical");
  resizeHandleElement.setAttribute(
    "aria-valuemin",
    String(MIN_PROJECT_TREE_WIDTH_PX),
  );
  resizeHandleElement.setAttribute(
    "aria-valuenow",
    String(DEFAULT_PROJECT_TREE_WIDTH_PX),
  );
  resizeHandleElement.setAttribute(
    "aria-valuemax",
    String(MAX_PROJECT_TREE_WIDTH_PX),
  );
  resizeHandleElement.tabIndex = 0;

  const fileTabsElement = document.createElement("div");
  fileTabsElement.className = "file-tabs";
  fileTabsElement.setAttribute("role", "tablist");
  fileTabsElement.setAttribute("aria-label", "Open files");

  const statusElement = document.createElement("div");
  statusElement.className = "code-status";

  const emptyElement = document.createElement("div");
  emptyElement.className = "project-empty";
  emptyElement.textContent = "Select a file from the workspace tree.";

  const errorElement = document.createElement("div");
  errorElement.className = "code-error project-file-error";
  errorElement.tabIndex = -1;

  // Monaco owns this element. Sibling UI lives around it, never inside it.
  const editorElement = document.createElement("div");
  editorElement.className = "code-editor project-editor";

  const editorBodyElement = document.createElement("div");
  editorBodyElement.className = "project-editor-body";
  editorBodyElement.append(emptyElement, errorElement, editorElement);

  const editorRegionElement = document.createElement("div");
  editorRegionElement.className = "project-editor-region";
  editorRegionElement.append(
    fileTabsElement,
    statusElement,
    editorBodyElement,
  );

  const paneElement = document.createElement("div");
  paneElement.className = "project-pane";
  paneElement.style.setProperty(
    "--project-tree-width",
    `${DEFAULT_PROJECT_TREE_WIDTH_PX}px`,
  );
  paneElement.append(
    treeElement,
    resizeHandleElement,
    editorRegionElement,
  );
  mountProjectTreeResizeHandle({
    paneElement,
    treeElement,
    resizeHandleElement,
  });

  return {
    paneElement,
    treeElement,
    editorElement,
    fileTabsElement,
    statusElement,
    emptyElement,
    errorElement,
  };
}

let nextUntitledId = 1;

function fileNameForPath(filePath: string): string {
  const separatorPosition = filePath.lastIndexOf("/");
  return filePath.slice(separatorPosition + 1);
}

type WorkspaceRelativePathOptions = {
  workspaceRootPath: string;
  filePath: string;
};

function workspaceRelativePath({
  workspaceRootPath,
  filePath,
}: WorkspaceRelativePathOptions): string | undefined {
  let workspacePrefix = workspaceRootPath;
  if (!workspacePrefix.endsWith("/")) {
    workspacePrefix += "/";
  }
  if (!filePath.startsWith(workspacePrefix)) {
    return undefined;
  }
  return filePath.slice(workspacePrefix.length);
}

type BuildFileTabOptions = {
  title: string;
};

type FileTabElements = {
  tabElement: HTMLElement;
  titleElement: HTMLElement;
  closeElement: HTMLButtonElement;
};

function buildFileTab({ title }: BuildFileTabOptions): FileTabElements {
  const titleElement = document.createElement("span");
  titleElement.className = "file-tab-title";
  titleElement.textContent = title;

  const closeElement = document.createElement("button");
  closeElement.className = "file-tab-close";
  closeElement.textContent = "×";
  closeElement.title = "Close File";
  closeElement.ariaLabel = `Close ${title}`;

  const tabElement = document.createElement("div");
  tabElement.className = "file-tab";
  tabElement.tabIndex = -1;
  tabElement.draggable = true;
  tabElement.setAttribute("role", "tab");
  tabElement.append(titleElement, closeElement);

  return {
    tabElement,
    titleElement,
    closeElement,
  };
}

function clearFileTabDropIndicators(tab: ProjectTab): void {
  for (const buffer of tab.files.values()) {
    buffer.tabElement.classList.remove("file-drop-before");
    buffer.tabElement.classList.remove("file-drop-after");
  }
}

type AddProjectFileBufferOptions = {
  id: number;
  tab: ProjectTab;
  resourceKey: string;
  filePath: string | undefined;
  untitledId: number | undefined;
  model: monacoEditor.ITextModel | undefined;
  mtimeMs: number | undefined;
  dirty: boolean;
  pinned: boolean;
  error: string | undefined;
};

function addProjectFileBuffer({
  id,
  tab,
  resourceKey,
  filePath,
  untitledId,
  model,
  mtimeMs,
  dirty,
  pinned,
  error,
}: AddProjectFileBufferOptions): ProjectFileBuffer {
  let title = "Untitled";
  if (filePath !== undefined) {
    title = fileNameForPath(filePath);
  }
  const fileTab = buildFileTab({ title });
  const buffer: ProjectFileBuffer = {
    resourceKey,
    filePath,
    untitledId,
    model,
    mtimeMs,
    dirty,
    pinned,
    error,
    tabElement: fileTab.tabElement,
    titleElement: fileTab.titleElement,
    closeElement: fileTab.closeElement,
    viewState: null,
  };
  fileTab.tabElement.dataset.resourceKey = resourceKey;

  fileTab.closeElement.addEventListener("click", (event) => {
    event.stopPropagation();
    if (buffer.filePath !== undefined) {
      bridge.closeFile({
        projectTabId: id,
        filePath: buffer.filePath,
      });
      return;
    }
    if (buffer.untitledId !== undefined) {
      bridge.closeFile({
        projectTabId: id,
        untitledId: buffer.untitledId,
      });
    }
  });
  fileTab.tabElement.addEventListener("click", () => {
    if (buffer.filePath !== undefined) {
      executeCommand({
        type: "activate-file",
        projectTabId: id,
        path: buffer.filePath,
      });
      return;
    }
    executeCommand({
      type: "activate-file",
      projectTabId: id,
      untitledId: buffer.untitledId,
    });
  });
  fileTab.tabElement.addEventListener("dblclick", () => {
    if (buffer.filePath !== undefined) {
      executeCommand({
        type: "open-file",
        path: buffer.filePath,
        preview: false,
      });
      return;
    }
    executeCommand({
      type: "activate-file",
      projectTabId: id,
      untitledId: buffer.untitledId,
    });
  });
  fileTab.tabElement.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    if (buffer.filePath !== undefined) {
      executeCommand({
        type: "activate-file",
        projectTabId: id,
        path: buffer.filePath,
      });
      return;
    }
    executeCommand({
      type: "activate-file",
      projectTabId: id,
      untitledId: buffer.untitledId,
    });
  });
  fileTab.tabElement.addEventListener("dragstart", (event) => {
    tab.draggedFileKey = buffer.resourceKey;
    if (event.dataTransfer !== null) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", buffer.resourceKey);
    }
  });
  fileTab.tabElement.addEventListener("dragend", () => {
    tab.draggedFileKey = undefined;
    clearFileTabDropIndicators(tab);
  });

  tab.files.set(resourceKey, buffer);
  tab.fileTabsElement.append(fileTab.tabElement);
  return buffer;
}

function updateFileTab(buffer: ProjectFileBuffer): void {
  let title = "Untitled";
  if (buffer.filePath !== undefined) {
    title = fileNameForPath(buffer.filePath);
    buffer.tabElement.title = buffer.filePath;
  } else {
    buffer.tabElement.title = "Untitled";
  }
  buffer.closeElement.ariaLabel = `Close ${title}`;
  if (buffer.dirty) {
    title = `● ${title}`;
  }
  buffer.titleElement.textContent = title;
  buffer.tabElement.classList.toggle("preview", !buffer.pinned);
  buffer.tabElement.classList.toggle("dirty", buffer.dirty);
  buffer.tabElement.setAttribute("aria-selected", "false");
}

const PROJECT_TREE_WATCH_RETRY_LIMIT = 3;
const PROJECT_TREE_WATCH_RETRY_DELAY_MS = 500;

const projectTabsByTreeWatcherId = new Map<number, ProjectTab>();

type StartProjectTreeWatcherOptions = {
  tab: ProjectTab;
  treeRequest: number;
};

type HandleProjectTreeChangeOptions = {
  tab: ProjectTab;
  paths: string[] | null;
};

type ScheduleProjectTreeWatcherRetryOptions = {
  tab: ProjectTab;
  projectTree: ProjectTree;
};

function stopProjectTreeWatcher(tab: ProjectTab): void {
  if (tab.projectTreeWatcherRetryTimer !== undefined) {
    window.clearTimeout(tab.projectTreeWatcherRetryTimer);
    tab.projectTreeWatcherRetryTimer = undefined;
  }
  tab.projectTreeWatcherRetryCount = 0;

  const watcherId = tab.projectTreeWatcherId;
  if (watcherId === undefined) {
    return;
  }
  tab.projectTreeWatcherId = undefined;
  projectTabsByTreeWatcherId.delete(watcherId);
  bridge.unwatchProjectTree({ watcherId });
}

async function refreshProjectTreeGitDecorations(
  tab: ProjectTab,
): Promise<void> {
  const projectTree = tab.projectTree;
  if (projectTree === undefined) {
    return;
  }
  tab.latestGitRequest += 1;
  const gitRequest = tab.latestGitRequest;

  let result: ReadProjectTreeGitDecorationsResult;
  try {
    result = readProjectTreeGitDecorationsResultSchema.parse(
      await bridge.readProjectTreeGitDecorations({
        workspaceRootPath: projectTree.workspaceRootPath,
      }),
    );
  } catch {
    return;
  }
  if (
    gitRequest !== tab.latestGitRequest ||
    tab.projectTree !== projectTree ||
    result.workspaceRootPath !== projectTree.workspaceRootPath
  ) {
    return;
  }
  setProjectTreeGitDecorations({
    projectTree,
    decorations: result.decorations,
  });
}

async function startProjectTreeWatcher({
  tab,
  treeRequest,
}: StartProjectTreeWatcherOptions): Promise<void> {
  const projectTree = tab.projectTree;
  if (projectTree === undefined) {
    return;
  }

  let result: WatchProjectTreeResult;
  try {
    result = watchProjectTreeResultSchema.parse(
      await bridge.watchProjectTree({
        workspaceRootPath: projectTree.workspaceRootPath,
      }),
    );
  } catch {
    return;
  }
  if ("error" in result) {
    return;
  }
  if (
    treeRequest !== tab.latestTreeRequest ||
    tab.projectTree !== projectTree
  ) {
    bridge.unwatchProjectTree({ watcherId: result.watcherId });
    return;
  }
  tab.projectTreeWatcherId = result.watcherId;
  projectTabsByTreeWatcherId.set(result.watcherId, tab);
}

async function handleProjectTreeChange({
  tab,
  paths,
}: HandleProjectTreeChangeOptions): Promise<void> {
  const projectTree = tab.projectTree;
  if (projectTree === undefined) {
    return;
  }
  await refreshProjectTreePaths({
    projectTree,
    paths,
  });
  if (tab.projectTree !== projectTree) {
    return;
  }
  await refreshProjectTreeGitDecorations(tab);
}

function scheduleProjectTreeWatcherRetry({
  tab,
  projectTree,
}: ScheduleProjectTreeWatcherRetryOptions): void {
  if (
    tab.projectTreeWatcherRetryCount >= PROJECT_TREE_WATCH_RETRY_LIMIT ||
    tab.projectTreeWatcherRetryTimer !== undefined
  ) {
    return;
  }
  tab.projectTreeWatcherRetryCount += 1;
  const retryDelay =
    PROJECT_TREE_WATCH_RETRY_DELAY_MS * tab.projectTreeWatcherRetryCount;
  tab.projectTreeWatcherRetryTimer = window.setTimeout(async () => {
    tab.projectTreeWatcherRetryTimer = undefined;
    if (
      tab.projectTree !== projectTree ||
      tab.projectTreeWatcherId !== undefined
    ) {
      return;
    }
    const treeRequest = tab.latestTreeRequest;
    await startProjectTreeWatcher({
      tab,
      treeRequest,
    });
    if (
      tab.projectTree !== projectTree ||
      treeRequest !== tab.latestTreeRequest
    ) {
      return;
    }
    if (tab.projectTreeWatcherId === undefined) {
      scheduleProjectTreeWatcherRetry({
        tab,
        projectTree,
      });
      return;
    }
    await handleProjectTreeChange({
      tab,
      paths: null,
    });
  }, retryDelay);
}

bridge.onProjectTreeChanged(async (unvalidatedMessage) => {
  const messageResult = projectTreeChangeMessageSchema.safeParse(
    unvalidatedMessage,
  );
  if (!messageResult.success) {
    return;
  }
  const tab = projectTabsByTreeWatcherId.get(
    messageResult.data.watcherId,
  );
  if (
    tab === undefined ||
    tab.projectTreeWatcherId !== messageResult.data.watcherId
  ) {
    return;
  }
  if (messageResult.data.stopped === true) {
    const projectTree = tab.projectTree;
    projectTabsByTreeWatcherId.delete(messageResult.data.watcherId);
    tab.projectTreeWatcherId = undefined;
    await handleProjectTreeChange({
      tab,
      paths: null,
    });
    if (projectTree !== undefined && tab.projectTree === projectTree) {
      scheduleProjectTreeWatcherRetry({
        tab,
        projectTree,
      });
    }
    return;
  }
  await handleProjectTreeChange({
    tab,
    paths: messageResult.data.paths,
  });
});

function showEmptyEditor(tab: ProjectTab): void {
  tab.activeFileKey = undefined;
  tab.editor.setModel(null);
  tab.emptyElement.classList.add("visible");
  tab.errorElement.classList.remove("visible");
  tab.editorElement.classList.remove("visible");
  tab.statusElement.classList.remove("visible");
  for (const buffer of tab.files.values()) {
    buffer.tabElement.classList.remove("active");
    buffer.tabElement.setAttribute("aria-selected", "false");
  }
}

type ActivateBufferOptions = {
  tab: ProjectTab;
  buffer: ProjectFileBuffer;
};

function activateBuffer({
  tab,
  buffer,
}: ActivateBufferOptions): void {
  if (tab.activeFileKey !== undefined) {
    const activeBuffer = tab.files.get(tab.activeFileKey);
    if (activeBuffer !== undefined && activeBuffer.model !== undefined) {
      activeBuffer.viewState = tab.editor.saveViewState();
    }
  }

  tab.activeFileKey = buffer.resourceKey;
  tab.emptyElement.classList.remove("visible");
  tab.statusElement.classList.remove("visible");
  for (const candidate of tab.files.values()) {
    const active = candidate === buffer;
    candidate.tabElement.classList.toggle("active", active);
    candidate.tabElement.setAttribute("aria-selected", String(active));
    candidate.tabElement.tabIndex = -1;
    if (active) {
      candidate.tabElement.tabIndex = 0;
    }
  }

  if (buffer.model === undefined) {
    tab.editor.setModel(null);
    tab.editorElement.classList.remove("visible");
    let errorMessage = "Could not open this file.";
    if (buffer.error !== undefined) {
      errorMessage = buffer.error;
    }
    tab.errorElement.textContent = errorMessage;
    tab.errorElement.classList.add("visible");
    tab.errorElement.focus();
    return;
  }

  tab.errorElement.classList.remove("visible");
  tab.editorElement.classList.add("visible");
  tab.editor.setModel(buffer.model);
  if (buffer.viewState !== null) {
    tab.editor.restoreViewState(buffer.viewState);
  }
  tab.editor.focus();
}

type PinProjectFileOptions = {
  tab: ProjectTab;
  filePath: string;
};

function pinProjectFile({
  tab,
  filePath,
}: PinProjectFileOptions): void {
  const buffer = tab.files.get(filePath);
  if (buffer === undefined || buffer.pinned) {
    return;
  }
  buffer.pinned = true;
  if (tab.previewFileKey === filePath) {
    tab.previewFileKey = undefined;
  }
  updateFileTab(buffer);
}

type DisposeBufferOptions = {
  tab: ProjectTab;
  buffer: ProjectFileBuffer;
};

function disposeBuffer({ tab, buffer }: DisposeBufferOptions): void {
  if (tab.previewFileKey === buffer.resourceKey) {
    tab.previewFileKey = undefined;
  }
  tab.files.delete(buffer.resourceKey);
  buffer.tabElement.remove();
  buffer.model?.dispose();
}

type FindProjectFileBufferOptions = {
  tab: ProjectTab;
  filePath: string | undefined;
  untitledId: number | undefined;
};

function findProjectFileBuffer({
  tab,
  filePath,
  untitledId,
}: FindProjectFileBufferOptions): ProjectFileBuffer | undefined {
  if (filePath !== undefined) {
    return tab.files.get(filePath);
  }
  if (untitledId === undefined) {
    return undefined;
  }
  for (const buffer of tab.files.values()) {
    if (buffer.untitledId === untitledId) {
      return buffer;
    }
  }
  return undefined;
}

type CloseProjectFileOptions = {
  id: number;
  tab: ProjectTab;
  filePath: string | undefined;
  untitledId: number | undefined;
};

export function closeProjectFile({
  id,
  tab,
  filePath,
  untitledId,
}: CloseProjectFileOptions): void {
  const buffer = findProjectFileBuffer({
    tab,
    filePath,
    untitledId,
  });
  if (buffer === undefined) {
    return;
  }
  const resourceKeys = Array.from(tab.files.keys());
  const closingPosition = resourceKeys.indexOf(buffer.resourceKey);
  const wasActive = tab.activeFileKey === buffer.resourceKey;
  const closedPath = buffer.filePath;
  const closedUntitledId = buffer.untitledId;
  disposeBuffer({
    tab,
    buffer,
  });

  if (wasActive) {
    const remainingKeys = Array.from(tab.files.keys());
    let nextPosition = closingPosition;
    if (nextPosition >= remainingKeys.length) {
      nextPosition = remainingKeys.length - 1;
    }
    const nextKey = remainingKeys.at(nextPosition);
    if (nextKey === undefined) {
      showEmptyEditor(tab);
    } else {
      const nextBuffer = tab.files.get(nextKey);
      if (nextBuffer !== undefined) {
        activateBuffer({
          tab,
          buffer: nextBuffer,
        });
      }
    }
  }

  let eventPath: string | null = null;
  if (closedPath !== undefined) {
    eventPath = closedPath;
  }
  bridge.emitEvent({
    type: "file-closed",
    id,
    path: eventPath,
    untitledId: closedUntitledId,
    state: snapshot(),
  });
}

type ActivateProjectFileOptions = {
  id: number;
  tab: ProjectTab;
  filePath: string | undefined;
  untitledId: number | undefined;
};

export function activateProjectFile({
  id,
  tab,
  filePath,
  untitledId,
}: ActivateProjectFileOptions): void {
  const buffer = findProjectFileBuffer({
    tab,
    filePath,
    untitledId,
  });
  if (buffer === undefined) {
    return;
  }
  activateBuffer({
    tab,
    buffer,
  });
  let eventPath: string | null = null;
  if (buffer.filePath !== undefined) {
    eventPath = buffer.filePath;
  }
  bridge.emitEvent({
    type: "file-activated",
    id,
    path: eventPath,
    untitledId: buffer.untitledId,
    state: snapshot(),
  });
}

type CreateUntitledProjectFileOptions = {
  id: number;
  tab: ProjectTab;
};

export function createUntitledProjectFile({
  id,
  tab,
}: CreateUntitledProjectFileOptions): void {
  const untitledId = nextUntitledId++;
  const resourceKey = `untitled:${untitledId}`;
  const buffer = addProjectFileBuffer({
    id,
    tab,
    resourceKey,
    filePath: undefined,
    untitledId,
    model: tab.monaco.editor.createModel("", "plaintext"),
    mtimeMs: undefined,
    dirty: false,
    pinned: true,
    error: undefined,
  });
  updateFileTab(buffer);
  activateBuffer({
    tab,
    buffer,
  });
  bridge.emitEvent({
    type: "file-created",
    id,
    untitledId,
    state: snapshot(),
  });
}

type MoveProjectFileOptions = {
  id: number;
  tab: ProjectTab;
  filePath: string | undefined;
  untitledId: number | undefined;
  index: number;
};

export function moveProjectFile({
  id,
  tab,
  filePath,
  untitledId,
  index,
}: MoveProjectFileOptions): void {
  const buffer = findProjectFileBuffer({
    tab,
    filePath,
    untitledId,
  });
  if (buffer === undefined) {
    return;
  }
  const orderedBuffers = Array.from(tab.files.values());
  const currentIndex = orderedBuffers.indexOf(buffer);
  orderedBuffers.splice(currentIndex, 1);
  let targetIndex = index;
  if (targetIndex < 0) {
    targetIndex = 0;
  }
  if (targetIndex > orderedBuffers.length) {
    targetIndex = orderedBuffers.length;
  }
  if (targetIndex === currentIndex) {
    return;
  }
  orderedBuffers.splice(targetIndex, 0, buffer);
  tab.files.clear();
  const tabElements: HTMLElement[] = [];
  for (const orderedBuffer of orderedBuffers) {
    tab.files.set(orderedBuffer.resourceKey, orderedBuffer);
    tabElements.push(orderedBuffer.tabElement);
  }
  tab.fileTabsElement.replaceChildren(...tabElements);
  let eventPath: string | null = null;
  if (buffer.filePath !== undefined) {
    eventPath = buffer.filePath;
  }
  bridge.emitEvent({
    type: "file-moved",
    id,
    path: eventPath,
    untitledId: buffer.untitledId,
    state: snapshot(),
  });
}

type OpenProjectFileOptions = {
  id: number;
  tab: ProjectTab;
  filePath: string;
  baseTabId: number | undefined;
  preview: boolean;
};

export async function openProjectFile({
  id,
  tab,
  filePath,
  baseTabId,
  preview,
}: OpenProjectFileOptions): Promise<void> {
  tab.latestFileRequest += 1;
  const fileRequest = tab.latestFileRequest;

  const result = await bridge.readFile({
    path: filePath,
    baseTabId,
  });
  if (preview && fileRequest !== tab.latestFileRequest) {
    return;
  }

  let resolvedPath = filePath;
  if (!("error" in result)) {
    resolvedPath = result.resolvedPath;
  }

  const existing = tab.files.get(resolvedPath);
  if (existing !== undefined) {
    if (!preview) {
      pinProjectFile({
        tab,
        filePath: resolvedPath,
      });
    }
    activateBuffer({
      tab,
      buffer: existing,
    });
    bridge.emitEvent({
      type: "file-activated",
      id,
      path: resolvedPath,
      state: snapshot(),
    });
    return;
  }

  if (preview && tab.previewFileKey !== undefined) {
    const previousPreview = tab.files.get(tab.previewFileKey);
    if (previousPreview !== undefined) {
      disposeBuffer({
        tab,
        buffer: previousPreview,
      });
    }
  }

  let model: monacoEditor.ITextModel | undefined;
  let mtimeMs: number | undefined;
  let error: string | undefined;
  if ("error" in result) {
    error = result.error;
  } else {
    model = tab.monaco.editor.createModel(
      result.content,
      languageForPath({
        monaco: tab.monaco,
        filePath: resolvedPath,
      }),
    );
    mtimeMs = result.mtimeMs;
  }
  const buffer = addProjectFileBuffer({
    id,
    tab,
    resourceKey: resolvedPath,
    filePath: resolvedPath,
    untitledId: undefined,
    model,
    mtimeMs,
    dirty: false,
    pinned: !preview,
    error,
  });
  if (preview) {
    tab.previewFileKey = resolvedPath;
  }
  updateFileTab(buffer);
  activateBuffer({
    tab,
    buffer,
  });
  bridge.emitEvent({
    type: "file-opened",
    id,
    path: resolvedPath,
    state: snapshot(),
  });
}

type SaveProjectFileOptions = {
  id: number;
  tab: ProjectTab;
  filePath: string | undefined;
  untitledId: number | undefined;
  destinationPath: string | undefined;
};

export async function saveProjectFile({
  id,
  tab,
  filePath,
  untitledId,
  destinationPath,
}: SaveProjectFileOptions): Promise<boolean> {
  let buffer = findProjectFileBuffer({
    tab,
    filePath,
    untitledId,
  });
  if (
    filePath === undefined &&
    untitledId === undefined &&
    tab.activeFileKey !== undefined
  ) {
    buffer = tab.files.get(tab.activeFileKey);
  }
  if (buffer === undefined || buffer.model === undefined) {
    return false;
  }

  if (buffer.filePath === undefined) {
    if (buffer.untitledId === undefined) {
      return false;
    }
    const excludedPaths: string[] = [];
    for (const openBuffer of tab.files.values()) {
      if (openBuffer.filePath !== undefined) {
        excludedPaths.push(openBuffer.filePath);
      }
    }
    const result = saveNewFileResultSchema.parse(
      await bridge.saveNewFile({
        directoryPath: tab.workspaceRootPath,
        suggestedName: "Untitled",
        content: buffer.model.getValue(),
        destinationPath,
        excludedPaths,
      }),
    );
    if ("canceled" in result) {
      bridge.emitEvent({
        type: "file-save-canceled",
        id,
        untitledId: buffer.untitledId,
        state: snapshot(),
      });
      return false;
    }
    if ("error" in result) {
      tab.statusElement.textContent = result.error;
      tab.statusElement.classList.add("visible");
      bridge.emitEvent({
        type: "file-save-failed",
        id,
        path: null,
        untitledId: buffer.untitledId,
        error: result.error,
        state: snapshot(),
      });
      return false;
    }

    const previousResourceKey = buffer.resourceKey;
    const previousUntitledId = buffer.untitledId;
    const orderedBuffers = Array.from(tab.files.values());
    buffer.resourceKey = result.resolvedPath;
    buffer.filePath = result.resolvedPath;
    buffer.untitledId = undefined;
    buffer.mtimeMs = result.mtimeMs;
    buffer.dirty = false;
    buffer.tabElement.dataset.resourceKey = result.resolvedPath;
    tab.monaco.editor.setModelLanguage(
      buffer.model,
      languageForPath({
        monaco: tab.monaco,
        filePath: result.resolvedPath,
      }),
    );
    tab.files.clear();
    for (const orderedBuffer of orderedBuffers) {
      tab.files.set(orderedBuffer.resourceKey, orderedBuffer);
    }
    if (tab.activeFileKey === previousResourceKey) {
      tab.activeFileKey = result.resolvedPath;
    }
    tab.statusElement.classList.remove("visible");
    updateFileTab(buffer);
    const relativePath = workspaceRelativePath({
      workspaceRootPath: tab.workspaceRootPath,
      filePath: result.resolvedPath,
    });
    if (tab.projectTree !== undefined && relativePath !== undefined) {
      await refreshProjectTreePaths({
        projectTree: tab.projectTree,
        paths: [relativePath],
      });
    }
    await refreshProjectTreeGitDecorations(tab);
    bridge.emitEvent({
      type: "file-saved",
      id,
      path: result.resolvedPath,
      previousUntitledId,
      state: snapshot(),
    });
    return true;
  }

  if (buffer.mtimeMs === undefined) {
    return false;
  }
  const result = await bridge.writeFile({
    path: buffer.filePath,
    expectedMtimeMs: buffer.mtimeMs,
    content: buffer.model.getValue(),
  });
  if ("error" in result) {
    tab.statusElement.textContent = result.error;
    tab.statusElement.classList.add("visible");
    bridge.emitEvent({
      type: "file-save-failed",
      id,
      path: buffer.filePath,
      error: result.error,
      state: snapshot(),
    });
    return false;
  }
  tab.statusElement.classList.remove("visible");
  buffer.mtimeMs = result.mtimeMs;
  buffer.dirty = false;
  updateFileTab(buffer);
  await refreshProjectTreeGitDecorations(tab);
  bridge.emitEvent({
    type: "file-saved",
    id,
    path: buffer.filePath,
    state: snapshot(),
  });
  return true;
}

type SaveAllProjectFilesOptions = {
  id: number;
  tab: ProjectTab;
};

export async function saveAllProjectFiles({
  id,
  tab,
}: SaveAllProjectFilesOptions): Promise<void> {
  const failedPaths: string[] = [];
  const failedUntitledIds: number[] = [];
  const buffers = Array.from(tab.files.values());
  for (const buffer of buffers) {
    if (!buffer.dirty) {
      continue;
    }
    const filePath = buffer.filePath;
    const untitledId = buffer.untitledId;
    const saved = await saveProjectFile({
      id,
      tab,
      filePath,
      untitledId,
      destinationPath: undefined,
    });
    if (saved) {
      continue;
    }
    if (filePath !== undefined) {
      failedPaths.push(filePath);
      continue;
    }
    if (untitledId !== undefined) {
      failedUntitledIds.push(untitledId);
    }
  }
  bridge.emitEvent({
    type: "files-save-finished",
    id,
    failedPaths,
    failedUntitledIds,
    state: snapshot(),
  });
}

type LoadProjectTreeRootOptions = {
  id: number;
  tab: ProjectTab;
  workspace: Workspace;
  request: ReadProjectTreeRequest;
  emitWorkspaceRootChanged: boolean;
};

async function loadProjectTreeRoot({
  id,
  tab,
  workspace,
  request,
  emitWorkspaceRootChanged,
}: LoadProjectTreeRootOptions): Promise<void> {
  tab.latestTreeRequest += 1;
  tab.latestGitRequest += 1;
  const treeRequest = tab.latestTreeRequest;
  stopProjectTreeWatcher(tab);
  tab.projectTree = undefined;
  tab.treeElement.textContent = "Loading workspace…";

  let result: ReadProjectTreeResult;
  try {
    result = await bridge.readProjectTree(request);
  } catch (error) {
    result = { error: String(error) };
  }
  if (treeRequest !== tab.latestTreeRequest) {
    return;
  }
  if ("error" in result) {
    const messageElement = document.createElement("div");
    messageElement.className = "project-tree-root-error";
    messageElement.textContent = `Could not load workspace: ${result.error}`;

    const retryElement = document.createElement("button");
    retryElement.className = "project-tree-retry";
    retryElement.type = "button";
    retryElement.textContent = "Retry";
    retryElement.addEventListener("click", () => {
      loadProjectTreeRoot({
        id,
        tab,
        workspace,
        request,
        emitWorkspaceRootChanged: true,
      });
    });
    tab.treeElement.replaceChildren(messageElement, retryElement);
    return;
  }

  tab.workspaceRootPath = result.workspaceRootPath;
  tab.projectTree = mountProjectTree({
    treeElement: tab.treeElement,
    workspaceRootPath: result.workspaceRootPath,
    entries: result.entries,
    openFile: ({ filePath, preview }) => {
      executeCommand({
        type: "open-file",
        path: filePath,
        preview,
      });
    },
  });
  tab.titleElement.textContent = result.name;
  tab.panel.setTitle(result.name);
  await startProjectTreeWatcher({
    tab,
    treeRequest,
  });
  if (treeRequest !== tab.latestTreeRequest) {
    return;
  }
  await handleProjectTreeChange({
    tab,
    paths: null,
  });
  if (treeRequest !== tab.latestTreeRequest) {
    return;
  }
  if (!emitWorkspaceRootChanged) {
    return;
  }
  refreshWorkspaceName(workspace);
  bridge.emitEvent({
    type: "workspace-root-changed",
    id,
    path: result.workspaceRootPath,
    state: snapshot(),
  });
}

type OpenProjectTabOptions = {
  id: number;
  workspace: Workspace;
  tabElements: TabElements;
  baseTabId: number | undefined;
  workspaceRootPath: string | undefined;
  initialFilePath: string | undefined;
  group: DockviewGroupPanel | undefined;
};

export async function openProjectTab({
  id,
  workspace,
  tabElements,
  baseTabId,
  workspaceRootPath,
  initialFilePath,
  group,
}: OpenProjectTabOptions): Promise<ProjectTab> {
  const pane = buildProjectPane();
  const panel = addPanel({
    workspace,
    id,
    component: "project",
    title: "Workspace",
    paneElement: pane.paneElement,
    tabElement: tabElements.tabElement,
    group,
  });
  const monaco = await loadMonaco();
  const editor = createCodeEditor({
    monaco,
    container: pane.editorElement,
  });
  const tab: ProjectTab = {
    kind: "project",
    panel,
    titleElement: tabElements.titleElement,
    titlePinned: true,
    treeElement: pane.treeElement,
    editorElement: pane.editorElement,
    fileTabsElement: pane.fileTabsElement,
    statusElement: pane.statusElement,
    emptyElement: pane.emptyElement,
    errorElement: pane.errorElement,
    workspaceRootPath: "",
    projectTree: undefined,
    monaco,
    editor,
    files: new Map(),
    activeFileKey: undefined,
    previewFileKey: undefined,
    draggedFileKey: undefined,
    latestFileRequest: 0,
    latestTreeRequest: 0,
    latestGitRequest: 0,
    projectTreeWatcherId: undefined,
    projectTreeWatcherRetryCount: 0,
    projectTreeWatcherRetryTimer: undefined,
  };
  showEmptyEditor(tab);

  pane.fileTabsElement.addEventListener("dblclick", (event) => {
    if (event.target !== pane.fileTabsElement) {
      return;
    }
    executeCommand({
      type: "new-file",
      projectTabId: id,
    });
  });
  pane.fileTabsElement.addEventListener("dragover", (event) => {
    if (tab.draggedFileKey === undefined) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer !== null) {
      event.dataTransfer.dropEffect = "move";
    }
    clearFileTabDropIndicators(tab);
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const targetTabElement = target.closest(".file-tab");
    if (
      !(targetTabElement instanceof HTMLElement) ||
      targetTabElement.parentElement !== pane.fileTabsElement ||
      targetTabElement.dataset.resourceKey === tab.draggedFileKey
    ) {
      return;
    }
    const bounds = targetTabElement.getBoundingClientRect();
    if (event.clientX < bounds.left + bounds.width / 2) {
      targetTabElement.classList.add("file-drop-before");
      return;
    }
    targetTabElement.classList.add("file-drop-after");
  });
  pane.fileTabsElement.addEventListener("dragleave", (event) => {
    const relatedTarget = event.relatedTarget;
    if (
      relatedTarget instanceof Node &&
      pane.fileTabsElement.contains(relatedTarget)
    ) {
      return;
    }
    clearFileTabDropIndicators(tab);
  });
  pane.fileTabsElement.addEventListener("drop", (event) => {
    const draggedFileKey = tab.draggedFileKey;
    if (draggedFileKey === undefined) {
      return;
    }
    event.preventDefault();
    const draggedBuffer = tab.files.get(draggedFileKey);
    const target = event.target;
    let targetTabElement: HTMLElement | undefined;
    if (target instanceof Element) {
      const closestTabElement = target.closest(".file-tab");
      if (
        closestTabElement instanceof HTMLElement &&
        closestTabElement.parentElement === pane.fileTabsElement
      ) {
        targetTabElement = closestTabElement;
      }
    }
    if (targetTabElement?.dataset.resourceKey === draggedFileKey) {
      tab.draggedFileKey = undefined;
      clearFileTabDropIndicators(tab);
      return;
    }

    const candidateBuffers: ProjectFileBuffer[] = [];
    for (const candidateBuffer of tab.files.values()) {
      if (candidateBuffer.resourceKey !== draggedFileKey) {
        candidateBuffers.push(candidateBuffer);
      }
    }
    let targetIndex = candidateBuffers.length;
    if (targetTabElement !== undefined) {
      const targetResourceKey = targetTabElement.dataset.resourceKey;
      for (let position = 0; position < candidateBuffers.length; position++) {
        if (candidateBuffers[position].resourceKey !== targetResourceKey) {
          continue;
        }
        targetIndex = position;
        if (targetTabElement.classList.contains("file-drop-after")) {
          targetIndex += 1;
        }
        break;
      }
    }
    tab.draggedFileKey = undefined;
    clearFileTabDropIndicators(tab);
    if (draggedBuffer === undefined) {
      return;
    }
    executeCommand({
      type: "move-file",
      projectTabId: id,
      path: draggedBuffer.filePath,
      untitledId: draggedBuffer.untitledId,
      index: targetIndex,
    });
  });

  editor.onDidChangeModelContent(() => {
    if (tab.activeFileKey === undefined) {
      return;
    }
    const buffer = tab.files.get(tab.activeFileKey);
    if (buffer === undefined || buffer.model !== editor.getModel()) {
      return;
    }
    let dirty = true;
    if (buffer.filePath === undefined && buffer.model.getValue() === "") {
      dirty = false;
    }
    if (buffer.dirty === dirty) {
      return;
    }
    buffer.dirty = dirty;
    if (buffer.filePath !== undefined) {
      pinProjectFile({
        tab,
        filePath: buffer.filePath,
      });
    }
    updateFileTab(buffer);
    let eventPath: string | null = null;
    if (buffer.filePath !== undefined) {
      eventPath = buffer.filePath;
    }
    bridge.emitEvent({
      type: "dirty-changed",
      id,
      path: eventPath,
      untitledId: buffer.untitledId,
      state: snapshot(),
    });
  });

  await loadProjectTreeRoot({
    id,
    tab,
    workspace,
    request: {
      baseTabId,
      workspaceRootPath,
      filePath: initialFilePath,
    },
    emitWorkspaceRootChanged: false,
  });
  return tab;
}

type ChangeWorkspaceRootOptions = {
  id: number;
  tab: ProjectTab;
  workspace: Workspace;
  workspaceRootPath: string;
};

export async function changeProjectWorkspaceRoot({
  id,
  tab,
  workspace,
  workspaceRootPath,
}: ChangeWorkspaceRootOptions): Promise<void> {
  await loadProjectTreeRoot({
    id,
    tab,
    workspace,
    request: { workspaceRootPath },
    emitWorkspaceRootChanged: true,
  });
}

export function focusProjectTab(tab: ProjectTab): void {
  if (tab.activeFileKey !== undefined) {
    const buffer = tab.files.get(tab.activeFileKey);
    if (buffer !== undefined && buffer.model !== undefined) {
      tab.editor.focus();
      return;
    }
  }
  if (tab.projectTree === undefined) {
    tab.treeElement.focus();
    return;
  }
  focusProjectTree(tab.projectTree);
}

export function disposeProjectTab(tab: ProjectTab): void {
  tab.latestTreeRequest += 1;
  tab.latestGitRequest += 1;
  stopProjectTreeWatcher(tab);
  for (const buffer of tab.files.values()) {
    buffer.model?.dispose();
  }
  tab.editor.dispose();
}
