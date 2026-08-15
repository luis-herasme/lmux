// One workspace's file experience: its stable root, tree, file tabs and
// read-only editor. Not a tab: a workspace has exactly one of these, it lives
// in the panel beside the pane layout, and hiding it leaves every file open.
import { bridge } from "./bridge.ts";
import {
  createCodeEditor,
  languageForPath,
  loadMonaco,
} from "./code.ts";
import type { Monaco } from "./code.ts";
import {
  projectTreeChangeMessageSchema,
  readProjectTreeGitDecorationsResultSchema,
  watchProjectTreeResultSchema,
} from "../ipc/bridge.ts";
import type {
  ReadProjectTreeGitDecorationsResult,
  ReadProjectTreeRequest,
  ReadProjectTreeResult,
  WatchProjectTreeResult,
} from "../ipc/bridge.ts";
import {
  focusProjectTree,
  mountProjectTree,
  refreshProjectTreePaths,
  setProjectTreeGitDecorations,
} from "./project-tree.ts";
import type { ProjectTree } from "./project-tree.ts";
import { mountProjectTreeScrollbar } from "./project-tree-scrollbar.ts";
import { renderMarkdown } from "./tabs/markdown.ts";
import { executeCommand } from "./tabs/index.ts";
import { snapshot } from "./workspaces.ts";
import { requireElement } from "./dom.ts";
import type { MarkdownMode } from "../api.ts";
import type { editor as monacoEditor } from "monaco-editor";

export type ProjectFileBuffer = {
  filePath: string; // canonical, and the key its panel holds it under
  model: monacoEditor.ITextModel | undefined;
  pinned: boolean;
  error: string | undefined;
  // only a markdown buffer ever leaves "raw"; the editor is its raw face
  markdownMode: MarkdownMode;
  tabElement: HTMLElement;
  viewState: monacoEditor.ICodeEditorViewState | null;
};

export type ProjectPanel = {
  id: number; // what a command's projectTabId names
  element: HTMLElement;
  nameElement: HTMLElement;
  name: string; // the root folder's, worn by the panel's header
  visible: boolean;
  treeElement: HTMLElement;
  editorElement: HTMLElement;
  fileTabsElement: HTMLElement;
  emptyElement: HTMLElement;
  errorElement: HTMLElement;
  markdownElement: HTMLElement;
  markdownToolbarElement: HTMLElement;
  markdownModeButton: HTMLElement;
  workspaceRootPath: string;
  projectTree: ProjectTree | undefined;
  monaco: Monaco;
  editor: monacoEditor.IStandaloneCodeEditor;
  files: Map<string, ProjectFileBuffer>;
  activeFilePath: string | undefined;
  previewFilePath: string | undefined; // the one unpinned buffer, if any
  draggedFilePath: string | undefined;
  latestFileRequest: number;
  latestTreeRequest: number;
  latestGitRequest: number;
  projectTreeWatcherId: number | undefined;
  projectTreeWatcherRetryCount: number;
  projectTreeWatcherRetryTimer: number | undefined;
};

type ProjectPanelElements = {
  panelElement: HTMLElement;
  nameElement: HTMLElement;
  treeElement: HTMLElement;
  editorElement: HTMLElement;
  fileTabsElement: HTMLElement;
  emptyElement: HTMLElement;
  errorElement: HTMLElement;
  markdownElement: HTMLElement;
  markdownToolbarElement: HTMLElement;
  markdownModeButton: HTMLElement;
};

// Holds one panel per workspace, the way #layout holds one Dockview root
// each; workspaces.ts decides which is on screen.
const projectHostElement = requireElement("project");

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

function buildProjectPanelElements(): ProjectPanelElements {
  const treeElement = document.createElement("div");
  treeElement.className = "project-tree";
  treeElement.tabIndex = -1;
  treeElement.textContent = "Loading workspace…";

  // the tree's own scrollbar, floated over its rows: project-tree-scrollbar.ts
  const treeScrollbarElement = document.createElement("div");
  treeScrollbarElement.className = "project-tree-scrollbar";
  treeScrollbarElement.ariaHidden = "true";

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

  const emptyElement = document.createElement("div");
  emptyElement.className = "project-empty";
  emptyElement.textContent = "Select a file from the workspace tree.";

  const errorElement = document.createElement("div");
  errorElement.className = "code-error project-file-error";
  errorElement.tabIndex = -1;

  // Monaco owns this element. Sibling UI lives around it, never inside it.
  const editorElement = document.createElement("div");
  editorElement.className = "code-editor project-editor";

  // a markdown buffer's rendered face, drawn over the editor's spot
  const markdownElement = document.createElement("div");
  markdownElement.className = "markdown-scroll project-markdown";
  markdownElement.tabIndex = -1;

  const markdownModeButton = document.createElement("button");
  markdownModeButton.className = "markdown-action";
  markdownModeButton.title = "Show the file rendered, or back in the editor";

  // only surfaces while the visible buffer is markdown
  const markdownToolbarElement = document.createElement("div");
  markdownToolbarElement.className = "markdown-toolbar project-markdown-toolbar";
  markdownToolbarElement.append(markdownModeButton);

  const editorBodyElement = document.createElement("div");
  editorBodyElement.className = "project-editor-body";
  editorBodyElement.append(
    emptyElement,
    errorElement,
    editorElement,
    markdownElement,
  );

  const editorRegionElement = document.createElement("div");
  editorRegionElement.className = "project-editor-region";
  editorRegionElement.append(
    fileTabsElement,
    markdownToolbarElement,
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
    treeScrollbarElement,
    resizeHandleElement,
    editorRegionElement,
  );
  mountProjectTreeResizeHandle({
    paneElement,
    treeElement,
    resizeHandleElement,
  });
  mountProjectTreeScrollbar({
    treeElement,
    thumbElement: treeScrollbarElement,
  });

  // The header says which project this is and takes it off screen: what the
  // Dockview tab used to do, for a panel that no longer has one.
  const nameElement = document.createElement("span");
  nameElement.className = "project-name";

  const hideElement = document.createElement("button");
  hideElement.className = "project-hide";
  hideElement.textContent = "×";
  hideElement.title = "Hide Project Panel (⌘B)";
  hideElement.ariaLabel = "Hide project panel";
  hideElement.addEventListener("click", () => {
    executeCommand({ type: "close-project" });
  });

  const headerElement = document.createElement("div");
  headerElement.className = "project-header";
  headerElement.append(nameElement, hideElement);

  const panelElement = document.createElement("div");
  panelElement.className = "project-panel";
  panelElement.append(headerElement, paneElement);

  return {
    panelElement,
    nameElement,
    treeElement,
    editorElement,
    fileTabsElement,
    emptyElement,
    errorElement,
    markdownElement,
    markdownToolbarElement,
    markdownModeButton,
  };
}

function clearFileTabDropIndicators(panel: ProjectPanel): void {
  for (const buffer of panel.files.values()) {
    buffer.tabElement.classList.remove("file-drop-before");
    buffer.tabElement.classList.remove("file-drop-after");
  }
}

type AddProjectFileBufferOptions = {
  panel: ProjectPanel;
  filePath: string;
  model: monacoEditor.ITextModel | undefined;
  pinned: boolean;
  error: string | undefined;
};

function addProjectFileBuffer({
  panel,
  filePath,
  model,
  pinned,
  error,
}: AddProjectFileBufferOptions): ProjectFileBuffer {
  const title = filePath.slice(filePath.lastIndexOf("/") + 1);

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
  tabElement.title = filePath;
  tabElement.setAttribute("role", "panel");
  tabElement.dataset.filePath = filePath;
  tabElement.classList.toggle("preview", !pinned);
  tabElement.append(titleElement, closeElement);

  const buffer: ProjectFileBuffer = {
    filePath,
    model,
    pinned,
    error,
    markdownMode: "raw",
    tabElement,
    viewState: null,
  };
  const activate = () => {
    executeCommand({
      type: "activate-file",
      projectTabId: panel.id,
      path: filePath,
    });
  };

  closeElement.addEventListener("click", (event) => {
    event.stopPropagation();
    executeCommand({
      type: "close-file",
      projectTabId: panel.id,
      path: filePath,
    });
  });
  tabElement.addEventListener("click", activate);
  tabElement.addEventListener("dblclick", () => {
    executeCommand({
      type: "open-file",
      path: filePath,
      preview: false,
    });
  });
  tabElement.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    activate();
  });
  tabElement.addEventListener("dragstart", (event) => {
    panel.draggedFilePath = filePath;
    if (event.dataTransfer !== null) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", filePath);
    }
  });
  tabElement.addEventListener("dragend", () => {
    panel.draggedFilePath = undefined;
    clearFileTabDropIndicators(panel);
  });

  panel.files.set(filePath, buffer);
  panel.fileTabsElement.append(tabElement);
  return buffer;
}

const PROJECT_TREE_WATCH_RETRY_LIMIT = 3;
const PROJECT_TREE_WATCH_RETRY_DELAY_MS = 500;

const projectTabsByTreeWatcherId = new Map<number, ProjectPanel>();

type StartProjectTreeWatcherOptions = {
  panel: ProjectPanel;
  treeRequest: number;
};

type HandleProjectTreeChangeOptions = {
  panel: ProjectPanel;
  paths: string[] | null;
};

type ScheduleProjectTreeWatcherRetryOptions = {
  panel: ProjectPanel;
  projectTree: ProjectTree;
};

function stopProjectTreeWatcher(panel: ProjectPanel): void {
  if (panel.projectTreeWatcherRetryTimer !== undefined) {
    window.clearTimeout(panel.projectTreeWatcherRetryTimer);
    panel.projectTreeWatcherRetryTimer = undefined;
  }
  panel.projectTreeWatcherRetryCount = 0;

  const watcherId = panel.projectTreeWatcherId;
  if (watcherId === undefined) {
    return;
  }
  panel.projectTreeWatcherId = undefined;
  projectTabsByTreeWatcherId.delete(watcherId);
  bridge.unwatchProjectTree({ watcherId });
}

async function refreshProjectTreeGitDecorations(
  panel: ProjectPanel,
): Promise<void> {
  const projectTree = panel.projectTree;
  if (projectTree === undefined) {
    return;
  }
  panel.latestGitRequest += 1;
  const gitRequest = panel.latestGitRequest;

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
    gitRequest !== panel.latestGitRequest ||
    panel.projectTree !== projectTree ||
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
  panel,
  treeRequest,
}: StartProjectTreeWatcherOptions): Promise<void> {
  const projectTree = panel.projectTree;
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
    treeRequest !== panel.latestTreeRequest ||
    panel.projectTree !== projectTree
  ) {
    bridge.unwatchProjectTree({ watcherId: result.watcherId });
    return;
  }
  panel.projectTreeWatcherId = result.watcherId;
  projectTabsByTreeWatcherId.set(result.watcherId, panel);
}

async function handleProjectTreeChange({
  panel,
  paths,
}: HandleProjectTreeChangeOptions): Promise<void> {
  const projectTree = panel.projectTree;
  if (projectTree === undefined) {
    return;
  }
  await refreshProjectTreePaths({
    projectTree,
    paths,
  });
  if (panel.projectTree !== projectTree) {
    return;
  }
  await refreshProjectTreeGitDecorations(panel);
}

function scheduleProjectTreeWatcherRetry({
  panel,
  projectTree,
}: ScheduleProjectTreeWatcherRetryOptions): void {
  if (
    panel.projectTreeWatcherRetryCount >= PROJECT_TREE_WATCH_RETRY_LIMIT ||
    panel.projectTreeWatcherRetryTimer !== undefined
  ) {
    return;
  }
  panel.projectTreeWatcherRetryCount += 1;
  const retryDelay =
    PROJECT_TREE_WATCH_RETRY_DELAY_MS * panel.projectTreeWatcherRetryCount;
  panel.projectTreeWatcherRetryTimer = window.setTimeout(async () => {
    panel.projectTreeWatcherRetryTimer = undefined;
    if (
      panel.projectTree !== projectTree ||
      panel.projectTreeWatcherId !== undefined
    ) {
      return;
    }
    const treeRequest = panel.latestTreeRequest;
    await startProjectTreeWatcher({
      panel,
      treeRequest,
    });
    if (
      panel.projectTree !== projectTree ||
      treeRequest !== panel.latestTreeRequest
    ) {
      return;
    }
    if (panel.projectTreeWatcherId === undefined) {
      scheduleProjectTreeWatcherRetry({
        panel,
        projectTree,
      });
      return;
    }
    await handleProjectTreeChange({
      panel,
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
  const panel = projectTabsByTreeWatcherId.get(
    messageResult.data.watcherId,
  );
  if (
    panel === undefined ||
    panel.projectTreeWatcherId !== messageResult.data.watcherId
  ) {
    return;
  }
  if (messageResult.data.stopped === true) {
    const projectTree = panel.projectTree;
    projectTabsByTreeWatcherId.delete(messageResult.data.watcherId);
    panel.projectTreeWatcherId = undefined;
    await handleProjectTreeChange({
      panel,
      paths: null,
    });
    if (projectTree !== undefined && panel.projectTree === projectTree) {
      scheduleProjectTreeWatcherRetry({
        panel,
        projectTree,
      });
    }
    return;
  }
  await handleProjectTreeChange({
    panel,
    paths: messageResult.data.paths,
  });
});

function showEmptyEditor(panel: ProjectPanel): void {
  panel.activeFilePath = undefined;
  panel.editor.setModel(null);
  panel.emptyElement.classList.add("visible");
  panel.errorElement.classList.remove("visible");
  panel.editorElement.classList.remove("visible");
  hideMarkdownView(panel);
  for (const buffer of panel.files.values()) {
    buffer.tabElement.classList.remove("active");
    buffer.tabElement.setAttribute("aria-selected", "false");
  }
}

type ActivateBufferOptions = {
  panel: ProjectPanel;
  buffer: ProjectFileBuffer;
};

function activateBuffer({
  panel,
  buffer,
}: ActivateBufferOptions): void {
  if (panel.activeFilePath !== undefined) {
    const activeBuffer = panel.files.get(panel.activeFilePath);
    if (activeBuffer !== undefined && activeBuffer.model !== undefined) {
      activeBuffer.viewState = panel.editor.saveViewState();
    }
  }

  panel.activeFilePath = buffer.filePath;
  panel.emptyElement.classList.remove("visible");
  for (const candidate of panel.files.values()) {
    const active = candidate === buffer;
    candidate.tabElement.classList.toggle("active", active);
    candidate.tabElement.setAttribute("aria-selected", String(active));
    candidate.tabElement.tabIndex = -1;
    if (active) {
      candidate.tabElement.tabIndex = 0;
    }
  }

  if (buffer.model === undefined) {
    panel.editor.setModel(null);
    panel.editorElement.classList.remove("visible");
    hideMarkdownView(panel);
    let errorMessage = "Could not open this file.";
    if (buffer.error !== undefined) {
      errorMessage = buffer.error;
    }
    panel.errorElement.textContent = errorMessage;
    panel.errorElement.classList.add("visible");
    panel.errorElement.focus();
    return;
  }

  panel.errorElement.classList.remove("visible");
  panel.editor.setModel(buffer.model);
  if (buffer.viewState !== null) {
    panel.editor.restoreViewState(buffer.viewState);
  }
  showActiveFileView({
    panel,
    buffer,
  });
}

function hideMarkdownView(panel: ProjectPanel): void {
  panel.markdownToolbarElement.classList.remove("visible");
  panel.markdownElement.classList.remove("visible");
  panel.markdownElement.replaceChildren();
}

type ShowActiveFileViewOptions = {
  panel: ProjectPanel;
  buffer: ProjectFileBuffer;
};

// The visible buffer's face: its model in the editor or, for a markdown
// buffer switched to rendered, the same text drawn as a document. The model
// stays on the (hidden) editor either way, so view state never notices the
// swap. The rendering reads the buffer, so there is nothing to reload.
function showActiveFileView({
  panel,
  buffer,
}: ShowActiveFileViewOptions): void {
  const model = buffer.model;
  const markdown =
    model !== undefined && model.getLanguageId() === "markdown";
  panel.markdownToolbarElement.classList.toggle("visible", markdown);
  if (markdown && buffer.markdownMode === "rendered") {
    // the button names the mode it would switch to, like a play button
    panel.markdownModeButton.textContent = "Source";
    panel.editorElement.classList.remove("visible");
    const { view } = renderMarkdown(model.getValue());
    panel.markdownElement.replaceChildren(view);
    panel.markdownElement.classList.add("visible");
    panel.markdownElement.focus();
    return;
  }
  panel.markdownModeButton.textContent = "Rendered";
  panel.markdownElement.classList.remove("visible");
  panel.markdownElement.replaceChildren();
  panel.editorElement.classList.add("visible");
  panel.editor.focus();
}

type DisposeBufferOptions = {
  panel: ProjectPanel;
  buffer: ProjectFileBuffer;
};

function disposeBuffer({ panel, buffer }: DisposeBufferOptions): void {
  if (panel.previewFilePath === buffer.filePath) {
    panel.previewFilePath = undefined;
  }
  panel.files.delete(buffer.filePath);
  buffer.tabElement.remove();
  buffer.model?.dispose();
}

type CloseProjectFileOptions = {
  panel: ProjectPanel;
  filePath: string;
};

export function closeProjectFile({
  panel,
  filePath,
}: CloseProjectFileOptions): void {
  const buffer = panel.files.get(filePath);
  if (buffer === undefined) {
    return;
  }
  const remaining = Array.from(panel.files.values());
  const closingPosition = remaining.indexOf(buffer);
  remaining.splice(closingPosition, 1);
  const wasActive = panel.activeFilePath === filePath;
  disposeBuffer({
    panel,
    buffer,
  });

  if (wasActive) {
    // the tab that slid into its place, or the last one when it was last
    let next = remaining.at(closingPosition);
    if (next === undefined) {
      next = remaining.at(-1);
    }
    if (next === undefined) {
      showEmptyEditor(panel);
    } else {
      activateBuffer({
        panel,
        buffer: next,
      });
    }
  }

  bridge.emitEvent({
    type: "file-closed",
    id: panel.id,
    path: filePath,
    state: snapshot(),
  });
}

type ActivateProjectFileOptions = {
  panel: ProjectPanel;
  filePath: string;
};

export function activateProjectFile({
  panel,
  filePath,
}: ActivateProjectFileOptions): void {
  const buffer = panel.files.get(filePath);
  if (buffer === undefined) {
    return;
  }
  activateBuffer({
    panel,
    buffer,
  });
  bridge.emitEvent({
    type: "file-activated",
    id: panel.id,
    path: filePath,
    state: snapshot(),
  });
}

type SetProjectFileMarkdownModeOptions = {
  panel: ProjectPanel;
  filePath: string | undefined;
  mode: MarkdownMode;
};

// Only a markdown buffer has a rendered face; the command ignores anything
// else, the way set-markdown-mode ignores a panel that isn't a document.
export function setProjectFileMarkdownMode({
  panel,
  filePath,
  mode,
}: SetProjectFileMarkdownModeOptions): void {
  let targetPath = filePath;
  if (targetPath === undefined) {
    targetPath = panel.activeFilePath;
  }
  if (targetPath === undefined) {
    return;
  }
  const buffer = panel.files.get(targetPath);
  if (
    buffer === undefined ||
    buffer.model?.getLanguageId() !== "markdown" ||
    buffer.markdownMode === mode
  ) {
    return;
  }
  buffer.markdownMode = mode;
  if (panel.activeFilePath === buffer.filePath) {
    showActiveFileView({
      panel,
      buffer,
    });
  }
  bridge.emitEvent({
    type: "file-markdown-mode-changed",
    id: panel.id,
    path: buffer.filePath,
    state: snapshot(),
  });
}

// A drawn diagram has the theme and the font baked into its SVG, so a
// rendered buffer follows a settings change by being drawn again.
export function redrawProjectMarkdown(panel: ProjectPanel): void {
  if (panel.activeFilePath === undefined) {
    return;
  }
  const buffer = panel.files.get(panel.activeFilePath);
  if (buffer === undefined || buffer.markdownMode !== "rendered") {
    return;
  }
  showActiveFileView({
    panel,
    buffer,
  });
}

type MoveProjectFileOptions = {
  panel: ProjectPanel;
  filePath: string;
  index: number;
};

export function moveProjectFile({
  panel,
  filePath,
  index,
}: MoveProjectFileOptions): void {
  const buffer = panel.files.get(filePath);
  if (buffer === undefined) {
    return;
  }
  const orderedBuffers = Array.from(panel.files.values());
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
  panel.files.clear();
  const tabElements: HTMLElement[] = [];
  for (const orderedBuffer of orderedBuffers) {
    panel.files.set(orderedBuffer.filePath, orderedBuffer);
    tabElements.push(orderedBuffer.tabElement);
  }
  panel.fileTabsElement.replaceChildren(...tabElements);
  bridge.emitEvent({
    type: "file-moved",
    id: panel.id,
    path: filePath,
    state: snapshot(),
  });
}

type OpenProjectFileOptions = {
  panel: ProjectPanel;
  filePath: string;
  baseTabId: number | undefined;
  preview: boolean;
};

export async function openProjectFile({
  panel,
  filePath,
  baseTabId,
  preview,
}: OpenProjectFileOptions): Promise<void> {
  panel.latestFileRequest += 1;
  const fileRequest = panel.latestFileRequest;

  const result = await bridge.readFile({
    path: filePath,
    baseTabId,
  });
  if (preview && fileRequest !== panel.latestFileRequest) {
    return;
  }

  let resolvedPath = filePath;
  if (!("error" in result)) {
    resolvedPath = result.resolvedPath;
  }

  const existing = panel.files.get(resolvedPath);
  if (existing !== undefined) {
    // opening the preview deliberately keeps it instead of replacing it
    if (!preview && !existing.pinned) {
      existing.pinned = true;
      existing.tabElement.classList.remove("preview");
      panel.previewFilePath = undefined;
    }
    activateBuffer({
      panel,
      buffer: existing,
    });
    bridge.emitEvent({
      type: "file-activated",
      id: panel.id,
      path: resolvedPath,
      state: snapshot(),
    });
    return;
  }

  if (preview && panel.previewFilePath !== undefined) {
    const previousPreview = panel.files.get(panel.previewFilePath);
    if (previousPreview !== undefined) {
      disposeBuffer({
        panel,
        buffer: previousPreview,
      });
    }
  }

  let model: monacoEditor.ITextModel | undefined;
  let error: string | undefined;
  if ("error" in result) {
    error = result.error;
  } else {
    model = panel.monaco.editor.createModel(
      result.content,
      languageForPath({
        monaco: panel.monaco,
        filePath: resolvedPath,
      }),
    );
  }
  const buffer = addProjectFileBuffer({
    panel,
    filePath: resolvedPath,
    model,
    pinned: !preview,
    error,
  });
  if (preview) {
    panel.previewFilePath = resolvedPath;
  }
  activateBuffer({
    panel,
    buffer,
  });
  bridge.emitEvent({
    type: "file-opened",
    id: panel.id,
    path: resolvedPath,
    state: snapshot(),
  });
}

type LoadProjectTreeRootOptions = {
  panel: ProjectPanel;
  request: ReadProjectTreeRequest;
  emitWorkspaceRootChanged: boolean;
};

async function loadProjectTreeRoot({
  panel,
  request,
  emitWorkspaceRootChanged,
}: LoadProjectTreeRootOptions): Promise<void> {
  panel.latestTreeRequest += 1;
  panel.latestGitRequest += 1;
  const treeRequest = panel.latestTreeRequest;
  stopProjectTreeWatcher(panel);
  panel.projectTree = undefined;
  panel.treeElement.textContent = "Loading workspace…";

  let result: ReadProjectTreeResult;
  try {
    result = await bridge.readProjectTree(request);
  } catch (error) {
    result = { error: String(error) };
  }
  if (treeRequest !== panel.latestTreeRequest) {
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
        panel,
        request,
        emitWorkspaceRootChanged: true,
      });
    });
    panel.treeElement.replaceChildren(messageElement, retryElement);
    return;
  }

  panel.workspaceRootPath = result.workspaceRootPath;
  panel.projectTree = mountProjectTree({
    treeElement: panel.treeElement,
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
  panel.name = result.name;
  panel.nameElement.textContent = result.name;
  panel.nameElement.title = result.workspaceRootPath;
  await startProjectTreeWatcher({
    panel,
    treeRequest,
  });
  if (treeRequest !== panel.latestTreeRequest) {
    return;
  }
  await handleProjectTreeChange({
    panel,
    paths: null,
  });
  if (treeRequest !== panel.latestTreeRequest) {
    return;
  }
  if (!emitWorkspaceRootChanged) {
    return;
  }
  bridge.emitEvent({
    type: "workspace-root-changed",
    id: panel.id,
    path: result.workspaceRootPath,
    state: snapshot(),
  });
}

type CreateProjectPanelOptions = {
  id: number;
  baseTabId: number | undefined;
  workspaceRootPath: string | undefined;
  initialFilePath: string | undefined;
};

// The panel is planted hidden: whoever asked for it decides when the
// workspace shows it, the way a workspace's own layout is planted hidden.
export async function createProjectPanel({
  id,
  baseTabId,
  workspaceRootPath,
  initialFilePath,
}: CreateProjectPanelOptions): Promise<ProjectPanel> {
  const pane = buildProjectPanelElements();
  pane.panelElement.style.display = "none";
  projectHostElement.append(pane.panelElement);
  const monaco = await loadMonaco();
  const editor = createCodeEditor({
    monaco,
    container: pane.editorElement,
  });
  const panel: ProjectPanel = {
    id,
    element: pane.panelElement,
    nameElement: pane.nameElement,
    name: "",
    visible: false,
    treeElement: pane.treeElement,
    editorElement: pane.editorElement,
    fileTabsElement: pane.fileTabsElement,
    emptyElement: pane.emptyElement,
    errorElement: pane.errorElement,
    markdownElement: pane.markdownElement,
    markdownToolbarElement: pane.markdownToolbarElement,
    markdownModeButton: pane.markdownModeButton,
    workspaceRootPath: "",
    projectTree: undefined,
    monaco,
    editor,
    files: new Map(),
    activeFilePath: undefined,
    previewFilePath: undefined,
    draggedFilePath: undefined,
    latestFileRequest: 0,
    latestTreeRequest: 0,
    latestGitRequest: 0,
    projectTreeWatcherId: undefined,
    projectTreeWatcherRetryCount: 0,
    projectTreeWatcherRetryTimer: undefined,
  };
  showEmptyEditor(panel);

  pane.markdownModeButton.addEventListener("click", () => {
    if (panel.activeFilePath === undefined) {
      return;
    }
    const buffer = panel.files.get(panel.activeFilePath);
    if (buffer === undefined) {
      return;
    }
    let mode: MarkdownMode = "rendered";
    if (buffer.markdownMode === "rendered") {
      mode = "raw";
    }
    executeCommand({
      type: "set-file-markdown-mode",
      projectTabId: panel.id,
      mode,
    });
  });

  pane.fileTabsElement.addEventListener("dragover", (event) => {
    if (panel.draggedFilePath === undefined) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer !== null) {
      event.dataTransfer.dropEffect = "move";
    }
    clearFileTabDropIndicators(panel);
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const targetTabElement = target.closest(".file-tab");
    if (
      !(targetTabElement instanceof HTMLElement) ||
      targetTabElement.parentElement !== pane.fileTabsElement ||
      targetTabElement.dataset.filePath === panel.draggedFilePath
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
    clearFileTabDropIndicators(panel);
  });
  pane.fileTabsElement.addEventListener("drop", (event) => {
    const draggedFilePath = panel.draggedFilePath;
    if (draggedFilePath === undefined) {
      return;
    }
    event.preventDefault();
    const draggedBuffer = panel.files.get(draggedFilePath);
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
    if (targetTabElement?.dataset.filePath === draggedFilePath) {
      panel.draggedFilePath = undefined;
      clearFileTabDropIndicators(panel);
      return;
    }

    const candidateBuffers: ProjectFileBuffer[] = [];
    for (const candidateBuffer of panel.files.values()) {
      if (candidateBuffer.filePath !== draggedFilePath) {
        candidateBuffers.push(candidateBuffer);
      }
    }
    let targetIndex = candidateBuffers.length;
    if (targetTabElement !== undefined) {
      const targetFilePath = targetTabElement.dataset.filePath;
      for (let position = 0; position < candidateBuffers.length; position++) {
        if (candidateBuffers[position].filePath !== targetFilePath) {
          continue;
        }
        targetIndex = position;
        if (targetTabElement.classList.contains("file-drop-after")) {
          targetIndex += 1;
        }
        break;
      }
    }
    panel.draggedFilePath = undefined;
    clearFileTabDropIndicators(panel);
    if (draggedBuffer === undefined) {
      return;
    }
    executeCommand({
      type: "move-file",
      projectTabId: panel.id,
      path: draggedBuffer.filePath,
      index: targetIndex,
    });
  });

  await loadProjectTreeRoot({
    panel,
    request: {
      baseTabId,
      workspaceRootPath,
      filePath: initialFilePath,
    },
    emitWorkspaceRootChanged: false,
  });
  return panel;
}

type ChangeWorkspaceRootOptions = {
  panel: ProjectPanel;
  workspaceRootPath: string;
};

export async function changeProjectWorkspaceRoot({
  panel,
  workspaceRootPath,
}: ChangeWorkspaceRootOptions): Promise<void> {
  await loadProjectTreeRoot({
    panel,
    request: { workspaceRootPath },
    emitWorkspaceRootChanged: true,
  });
}

export function focusProjectPanel(panel: ProjectPanel): void {
  if (panel.activeFilePath !== undefined) {
    const buffer = panel.files.get(panel.activeFilePath);
    if (buffer !== undefined && buffer.model !== undefined) {
      // a rendered buffer's editor is hidden; keys should scroll the document
      if (buffer.markdownMode === "rendered") {
        panel.markdownElement.focus();
        return;
      }
      panel.editor.focus();
      return;
    }
  }
  if (panel.projectTree === undefined) {
    panel.treeElement.focus();
    return;
  }
  focusProjectTree(panel.projectTree);
}

// Only a closing workspace disposes its panel; hiding one keeps every file
// open behind it.
export function disposeProjectPanel(panel: ProjectPanel): void {
  panel.latestTreeRequest += 1;
  panel.latestGitRequest += 1;
  stopProjectTreeWatcher(panel);
  for (const buffer of panel.files.values()) {
    buffer.model?.dispose();
  }
  panel.editor.dispose();
  panel.element.remove();
}
