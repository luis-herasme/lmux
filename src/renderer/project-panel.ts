// One workspace's file experience: its stable root, tree and read-only
// editor. Not a tab: a workspace has exactly one of these, it lives in the
// panel beside the pane layout, and it shows one file at a time.
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

// The one file the panel holds: opening another replaces it.
type ProjectFile = {
  filePath: string; // canonical, as the tree and the Events name it
  model: monacoEditor.ITextModel | undefined;
  error: string | undefined;
  // only a markdown file ever leaves "raw"; the editor is its raw face
  markdownMode: MarkdownMode;
};

export type ProjectPanel = {
  id: number; // what a command's projectTabId names
  element: HTMLElement;
  nameElement: HTMLElement;
  name: string; // the root folder's, worn by the panel's header
  visible: boolean;
  treeElement: HTMLElement;
  editorElement: HTMLElement;
  emptyElement: HTMLElement;
  errorElement: HTMLElement;
  markdownElement: HTMLElement;
  markdownToolbarElement: HTMLElement;
  markdownModeButton: HTMLElement;
  workspaceRootPath: string;
  projectTree: ProjectTree | undefined;
  monaco: Monaco;
  editor: monacoEditor.IStandaloneCodeEditor;
  file: ProjectFile | undefined;
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
    applyProjectTreeWidth(paneBounds.right - event.clientX);
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
    // the arrows move the handle, and the tree is the side to its right
    if (event.key === "ArrowLeft") {
      requestedWidth += PROJECT_TREE_KEYBOARD_RESIZE_STEP_PX;
    } else if (event.key === "ArrowRight") {
      requestedWidth -= PROJECT_TREE_KEYBOARD_RESIZE_STEP_PX;
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

  const emptyElement = document.createElement("div");
  emptyElement.className = "project-empty";
  emptyElement.textContent = "Select a file from the workspace tree.";

  const errorElement = document.createElement("div");
  errorElement.className = "code-error project-file-error";
  errorElement.tabIndex = -1;

  // Monaco owns this element. Sibling UI lives around it, never inside it.
  const editorElement = document.createElement("div");
  editorElement.className = "code-editor project-editor";

  // the file's rendered face, drawn over the editor's spot
  const markdownElement = document.createElement("div");
  markdownElement.className = "markdown-scroll project-markdown";
  markdownElement.tabIndex = -1;

  const markdownModeButton = document.createElement("button");
  markdownModeButton.className = "markdown-action";
  markdownModeButton.title = "Show the file rendered, or back in the editor";

  // only surfaces while the open file is markdown
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
  editorRegionElement.append(markdownToolbarElement, editorBodyElement);

  const paneElement = document.createElement("div");
  paneElement.className = "project-pane";
  paneElement.style.setProperty(
    "--project-tree-width",
    `${DEFAULT_PROJECT_TREE_WIDTH_PX}px`,
  );
  paneElement.append(
    editorRegionElement,
    treeElement,
    treeScrollbarElement,
    resizeHandleElement,
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
    emptyElement,
    errorElement,
    markdownElement,
    markdownToolbarElement,
    markdownModeButton,
  };
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

// The panel's one view, drawn from what it holds: the file in its editor or,
// for markdown switched to rendered, that same model drawn as a document; the
// error its path answered with; or the empty state.
export function showProjectFile(panel: ProjectPanel): void {
  const file = panel.file;
  const model = file?.model;
  const markdown = model !== undefined && model.getLanguageId() === "markdown";
  const rendered = markdown && file?.markdownMode === "rendered";
  panel.emptyElement.classList.toggle("visible", file === undefined);
  panel.errorElement.classList.toggle("visible", file?.error !== undefined);
  panel.editorElement.classList.toggle(
    "visible",
    model !== undefined && !rendered,
  );
  panel.markdownToolbarElement.classList.toggle("visible", markdown);
  panel.markdownElement.classList.toggle("visible", rendered);

  if (model === undefined) {
    panel.editor.setModel(null);
    panel.markdownElement.replaceChildren();
    if (file?.error !== undefined) {
      panel.errorElement.textContent = file.error;
      panel.errorElement.focus();
    }
    return;
  }
  panel.editor.setModel(model);
  if (rendered) {
    // the button names the mode it would switch to, like a play button
    panel.markdownModeButton.textContent = "Source";
    const { view } = renderMarkdown(model.getValue());
    panel.markdownElement.replaceChildren(view);
    panel.markdownElement.focus();
    return;
  }
  panel.markdownModeButton.textContent = "Rendered";
  panel.markdownElement.replaceChildren();
  panel.editor.focus();
}

export function closeProjectFile(panel: ProjectPanel): void {
  const file = panel.file;
  if (file === undefined) {
    return;
  }
  panel.file = undefined;
  showProjectFile(panel);
  file.model?.dispose();
  bridge.emitEvent({
    type: "file-closed",
    id: panel.id,
    path: file.filePath,
    state: snapshot(),
  });
}

type SetProjectFileMarkdownModeOptions = {
  panel: ProjectPanel;
  mode: MarkdownMode;
};

// Only a markdown file has a rendered face; the command ignores anything
// else, the way set-markdown-mode ignores a tab that isn't a document.
export function setProjectFileMarkdownMode({
  panel,
  mode,
}: SetProjectFileMarkdownModeOptions): void {
  const file = panel.file;
  if (
    file === undefined ||
    file.model?.getLanguageId() !== "markdown" ||
    file.markdownMode === mode
  ) {
    return;
  }
  file.markdownMode = mode;
  showProjectFile(panel);
  bridge.emitEvent({
    type: "file-markdown-mode-changed",
    id: panel.id,
    path: file.filePath,
    state: snapshot(),
  });
}

type OpenProjectFileOptions = {
  panel: ProjectPanel;
  filePath: string;
  baseTabId: number | undefined;
};

// The panel holds one file, so opening another reads it and replaces what was
// there, including when it is the same path read again.
export async function openProjectFile({
  panel,
  filePath,
  baseTabId,
}: OpenProjectFileOptions): Promise<void> {
  panel.latestFileRequest += 1;
  const fileRequest = panel.latestFileRequest;

  const result = await bridge.readFile({
    path: filePath,
    baseTabId,
  });
  if (fileRequest !== panel.latestFileRequest) {
    return;
  }

  let resolvedPath = filePath;
  let model: monacoEditor.ITextModel | undefined;
  let error: string | undefined;
  if ("error" in result) {
    error = result.error;
  } else {
    resolvedPath = result.resolvedPath;
    model = panel.monaco.editor.createModel(
      result.content,
      languageForPath({
        monaco: panel.monaco,
        filePath: resolvedPath,
      }),
    );
  }
  const previous = panel.file;
  panel.file = {
    filePath: resolvedPath,
    model,
    error,
    markdownMode: "raw",
  };
  showProjectFile(panel);
  // disposed after the view took the new model, never while it holds this one
  previous?.model?.dispose();
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
    openFile: (filePath) => {
      executeCommand({
        type: "open-file",
        path: filePath,
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
    emptyElement: pane.emptyElement,
    errorElement: pane.errorElement,
    markdownElement: pane.markdownElement,
    markdownToolbarElement: pane.markdownToolbarElement,
    markdownModeButton: pane.markdownModeButton,
    workspaceRootPath: "",
    projectTree: undefined,
    monaco,
    editor,
    file: undefined,
    latestFileRequest: 0,
    latestTreeRequest: 0,
    latestGitRequest: 0,
    projectTreeWatcherId: undefined,
    projectTreeWatcherRetryCount: 0,
    projectTreeWatcherRetryTimer: undefined,
  };
  showProjectFile(panel);

  pane.markdownModeButton.addEventListener("click", () => {
    let mode: MarkdownMode = "rendered";
    if (panel.file?.markdownMode === "rendered") {
      mode = "raw";
    }
    executeCommand({
      type: "set-file-markdown-mode",
      projectTabId: panel.id,
      mode,
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
  const file = panel.file;
  if (file !== undefined && file.model !== undefined) {
    // a rendered file's editor is hidden; keys should scroll the document
    if (file.markdownMode === "rendered") {
      panel.markdownElement.focus();
      return;
    }
    panel.editor.focus();
    return;
  }
  if (panel.projectTree === undefined) {
    panel.treeElement.focus();
    return;
  }
  focusProjectTree(panel.projectTree);
}

// Only a closing workspace disposes its panel; hiding one keeps its file
// open behind it.
export function disposeProjectPanel(panel: ProjectPanel): void {
  panel.latestTreeRequest += 1;
  panel.latestGitRequest += 1;
  stopProjectTreeWatcher(panel);
  panel.file?.model?.dispose();
  panel.editor.dispose();
  panel.element.remove();
}
