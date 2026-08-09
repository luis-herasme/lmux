// One workspace's file experience: its stable root, tree, file tabs and
// editor. Dockview sees this whole unit as one project tab.
import { bridge } from "./bridge.ts";
import {
  createCodeEditor,
  languageForPath,
  loadMonaco,
} from "./code.ts";
import type { Monaco } from "./code.ts";
import {
  loadProjectTreeLibrary,
  mountProjectTree,
  setProjectTreeDirty,
} from "./project-tree.ts";
import { executeCommand } from "./tabs.ts";
import type { TabElements } from "./tabs.ts";
import {
  addPanel,
  refreshWorkspaceName,
  snapshot,
} from "./workspaces.ts";
import type { Workspace } from "./workspaces.ts";
import type { editor as monacoEditor } from "monaco-editor";
import type { FileTree as PierreFileTree } from "@pierre/trees";
import type { IDockviewPanel, DockviewGroupPanel } from "dockview";

export type ProjectFileBuffer = {
  filePath: string;
  baseTabId: number | undefined;
  model: monacoEditor.ITextModel | undefined;
  mtimeMs: number | undefined;
  dirty: boolean;
  pinned: boolean;
  error: string | undefined;
  tabElement: HTMLElement;
  titleElement: HTMLElement;
  viewState: monacoEditor.ICodeEditorViewState | null;
};

export type ProjectTab = {
  kind: "project";
  panel: IDockviewPanel;
  titleElement: HTMLElement;
  titlePinned: boolean;
  element: HTMLElement;
  treeElement: HTMLElement;
  editorElement: HTMLElement;
  fileTabsElement: HTMLElement;
  fileHeaderElement: HTMLElement;
  statusElement: HTMLElement;
  emptyElement: HTMLElement;
  errorElement: HTMLElement;
  workspaceRootPath: string;
  fileTree: PierreFileTree | undefined;
  monaco: Monaco;
  editor: monacoEditor.IStandaloneCodeEditor;
  files: Map<string, ProjectFileBuffer>;
  activeFilePath: string | undefined;
  previewFilePath: string | undefined;
  latestFileRequest: number;
};

type ProjectPane = {
  paneElement: HTMLElement;
  treeElement: HTMLElement;
  editorElement: HTMLElement;
  fileTabsElement: HTMLElement;
  fileHeaderElement: HTMLElement;
  statusElement: HTMLElement;
  emptyElement: HTMLElement;
  errorElement: HTMLElement;
};

function buildProjectPane(): ProjectPane {
  const treeElement = document.createElement("div");
  treeElement.className = "project-tree";
  treeElement.tabIndex = -1;
  treeElement.textContent = "Loading workspace…";

  const fileTabsElement = document.createElement("div");
  fileTabsElement.className = "file-tabs";
  fileTabsElement.setAttribute("role", "tablist");
  fileTabsElement.setAttribute("aria-label", "Open files");

  const fileHeaderElement = document.createElement("div");
  fileHeaderElement.className = "file-header";

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
    fileHeaderElement,
    statusElement,
    editorBodyElement,
  );

  const paneElement = document.createElement("div");
  paneElement.className = "project-pane";
  paneElement.append(treeElement, editorRegionElement);

  return {
    paneElement,
    treeElement,
    editorElement,
    fileTabsElement,
    fileHeaderElement,
    statusElement,
    emptyElement,
    errorElement,
  };
}

function fileNameForPath(filePath: string): string {
  const separatorPosition = filePath.lastIndexOf("/");
  return filePath.slice(separatorPosition + 1);
}

type PathInsideWorkspaceOptions = {
  tab: ProjectTab;
  filePath: string;
};

function pathInsideWorkspace({
  tab,
  filePath,
}: PathInsideWorkspaceOptions): string | undefined {
  let prefix = tab.workspaceRootPath;
  if (!prefix.endsWith("/")) {
    prefix += "/";
  }
  if (!filePath.startsWith(prefix)) {
    return undefined;
  }
  return filePath.slice(prefix.length);
}

type BuildFileTabOptions = {
  projectTabId: number;
  filePath: string;
};

type FileTabElements = {
  tabElement: HTMLElement;
  titleElement: HTMLElement;
};

function buildFileTab({
  projectTabId,
  filePath,
}: BuildFileTabOptions): FileTabElements {
  const titleElement = document.createElement("span");
  titleElement.className = "file-tab-title";
  titleElement.textContent = fileNameForPath(filePath);

  const closeElement = document.createElement("button");
  closeElement.className = "file-tab-close";
  closeElement.textContent = "×";
  closeElement.title = "Close File";
  closeElement.ariaLabel = `Close ${fileNameForPath(filePath)}`;
  closeElement.addEventListener("click", (event) => {
    event.stopPropagation();
    bridge.closeFile({
      projectTabId,
      filePath,
    });
  });

  const tabElement = document.createElement("div");
  tabElement.className = "file-tab";
  tabElement.dataset.filePath = filePath;
  tabElement.title = filePath;
  tabElement.tabIndex = -1;
  tabElement.setAttribute("role", "tab");
  tabElement.append(titleElement, closeElement);
  tabElement.addEventListener("click", () => {
    executeCommand({
      type: "activate-file",
      projectTabId,
      path: filePath,
    });
  });
  tabElement.addEventListener("dblclick", () => {
    executeCommand({
      type: "pin-file",
      projectTabId,
      path: filePath,
    });
  });
  tabElement.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    executeCommand({
      type: "activate-file",
      projectTabId,
      path: filePath,
    });
  });

  return {
    tabElement,
    titleElement,
  };
}

function updateFileTab(buffer: ProjectFileBuffer): void {
  let title = fileNameForPath(buffer.filePath);
  if (buffer.dirty) {
    title = `● ${title}`;
  }
  buffer.titleElement.textContent = title;
  buffer.tabElement.classList.toggle("preview", !buffer.pinned);
  buffer.tabElement.classList.toggle("dirty", buffer.dirty);
  buffer.tabElement.setAttribute("aria-selected", "false");
}

function updateTreeDirtyState(tab: ProjectTab): void {
  const dirtyFilePaths: string[] = [];
  for (const buffer of tab.files.values()) {
    if (buffer.dirty) {
      dirtyFilePaths.push(buffer.filePath);
    }
  }
  setProjectTreeDirty({
    fileTree: tab.fileTree,
    workspaceRootPath: tab.workspaceRootPath,
    dirtyFilePaths,
  });
}

function showEmptyEditor(tab: ProjectTab): void {
  tab.activeFilePath = undefined;
  tab.editor.setModel(null);
  tab.emptyElement.classList.add("visible");
  tab.errorElement.classList.remove("visible");
  tab.editorElement.classList.remove("visible");
  tab.fileHeaderElement.textContent = "";
  tab.statusElement.classList.remove("visible");
  for (const buffer of tab.files.values()) {
    buffer.tabElement.classList.remove("active");
    buffer.tabElement.setAttribute("aria-selected", "false");
  }
}

type ActivateBufferOptions = {
  tab: ProjectTab;
  buffer: ProjectFileBuffer;
  focus: boolean;
};

function activateBuffer({
  tab,
  buffer,
  focus,
}: ActivateBufferOptions): void {
  if (tab.activeFilePath !== undefined) {
    const activeBuffer = tab.files.get(tab.activeFilePath);
    if (activeBuffer !== undefined && activeBuffer.model !== undefined) {
      activeBuffer.viewState = tab.editor.saveViewState();
    }
  }

  tab.activeFilePath = buffer.filePath;
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

  let headerPath = buffer.filePath;
  const workspacePath = pathInsideWorkspace({
    tab,
    filePath: buffer.filePath,
  });
  if (workspacePath !== undefined) {
    headerPath = workspacePath;
  }
  tab.fileHeaderElement.textContent = headerPath;
  tab.fileHeaderElement.title = buffer.filePath;

  if (buffer.model === undefined) {
    tab.editor.setModel(null);
    tab.editorElement.classList.remove("visible");
    let errorMessage = "Could not open this file.";
    if (buffer.error !== undefined) {
      errorMessage = buffer.error;
    }
    tab.errorElement.textContent = errorMessage;
    tab.errorElement.classList.add("visible");
    if (focus) {
      tab.errorElement.focus();
    }
    return;
  }

  tab.errorElement.classList.remove("visible");
  tab.editorElement.classList.add("visible");
  tab.editor.setModel(buffer.model);
  if (buffer.viewState !== null) {
    tab.editor.restoreViewState(buffer.viewState);
  }
  if (focus) {
    tab.editor.focus();
  }
}

type PinProjectFileOptions = {
  id: number;
  tab: ProjectTab;
  filePath: string;
  announce: boolean;
};

export function pinProjectFile({
  id,
  tab,
  filePath,
  announce,
}: PinProjectFileOptions): void {
  const buffer = tab.files.get(filePath);
  if (buffer === undefined || buffer.pinned) {
    return;
  }
  buffer.pinned = true;
  if (tab.previewFilePath === filePath) {
    tab.previewFilePath = undefined;
  }
  updateFileTab(buffer);
  if (announce) {
    bridge.emitEvent({
      type: "file-pinned",
      id,
      path: filePath,
      state: snapshot(),
    });
  }
}

type DisposeBufferOptions = {
  tab: ProjectTab;
  buffer: ProjectFileBuffer;
};

function disposeBuffer({ tab, buffer }: DisposeBufferOptions): void {
  if (tab.previewFilePath === buffer.filePath) {
    tab.previewFilePath = undefined;
  }
  tab.files.delete(buffer.filePath);
  buffer.tabElement.remove();
  buffer.model?.dispose();
}

type CloseProjectFileOptions = {
  id: number;
  tab: ProjectTab;
  filePath: string;
};

export function closeProjectFile({
  id,
  tab,
  filePath,
}: CloseProjectFileOptions): void {
  const buffer = tab.files.get(filePath);
  if (buffer === undefined) {
    return;
  }
  const paths = Array.from(tab.files.keys());
  const closingPosition = paths.indexOf(filePath);
  disposeBuffer({
    tab,
    buffer,
  });

  if (tab.activeFilePath === filePath) {
    const remainingPaths = Array.from(tab.files.keys());
    let nextPosition = closingPosition;
    if (nextPosition >= remainingPaths.length) {
      nextPosition = remainingPaths.length - 1;
    }
    const nextPath = remainingPaths.at(nextPosition);
    if (nextPath === undefined) {
      showEmptyEditor(tab);
    } else {
      const nextBuffer = tab.files.get(nextPath);
      if (nextBuffer !== undefined) {
        activateBuffer({
          tab,
          buffer: nextBuffer,
          focus: true,
        });
      }
    }
  }

  updateTreeDirtyState(tab);
  bridge.emitEvent({
    type: "file-closed",
    id,
    path: filePath,
    state: snapshot(),
  });
}

type ActivateProjectFileOptions = {
  id: number;
  tab: ProjectTab;
  filePath: string;
};

export function activateProjectFile({
  id,
  tab,
  filePath,
}: ActivateProjectFileOptions): void {
  const buffer = tab.files.get(filePath);
  if (buffer === undefined) {
    return;
  }
  activateBuffer({
    tab,
    buffer,
    focus: true,
  });
  bridge.emitEvent({
    type: "file-activated",
    id,
    path: filePath,
    state: snapshot(),
  });
}

type OpenProjectFileOptions = {
  id: number;
  tab: ProjectTab;
  filePath: string;
  baseTabId: number | undefined;
  preview: boolean;
  announce: boolean;
};

export async function openProjectFile({
  id,
  tab,
  filePath,
  baseTabId,
  preview,
  announce,
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
        id,
        tab,
        filePath: resolvedPath,
        announce,
      });
    }
    activateBuffer({
      tab,
      buffer: existing,
      focus: true,
    });
    if (announce) {
      bridge.emitEvent({
        type: "file-activated",
        id,
        path: resolvedPath,
        state: snapshot(),
      });
    }
    return;
  }

  if (preview && tab.previewFilePath !== undefined) {
    const previousPreview = tab.files.get(tab.previewFilePath);
    if (previousPreview !== undefined) {
      disposeBuffer({
        tab,
        buffer: previousPreview,
      });
    }
  }

  const fileTab = buildFileTab({
    projectTabId: id,
    filePath: resolvedPath,
  });
  const buffer: ProjectFileBuffer = {
    filePath: resolvedPath,
    baseTabId,
    model: undefined,
    mtimeMs: undefined,
    dirty: false,
    pinned: !preview,
    error: undefined,
    tabElement: fileTab.tabElement,
    titleElement: fileTab.titleElement,
    viewState: null,
  };
  if ("error" in result) {
    buffer.error = result.error;
  } else {
    buffer.model = tab.monaco.editor.createModel(
      result.content,
      languageForPath({
        monaco: tab.monaco,
        filePath: resolvedPath,
      }),
    );
    buffer.mtimeMs = result.mtimeMs;
  }
  tab.files.set(resolvedPath, buffer);
  tab.fileTabsElement.append(fileTab.tabElement);
  if (preview) {
    tab.previewFilePath = resolvedPath;
  }
  updateFileTab(buffer);
  activateBuffer({
    tab,
    buffer,
    focus: true,
  });
  if (announce) {
    bridge.emitEvent({
      type: "file-opened",
      id,
      path: resolvedPath,
      state: snapshot(),
    });
  }
}

type SaveProjectFileOptions = {
  id: number;
  tab: ProjectTab;
  filePath: string | undefined;
};

export async function saveProjectFile({
  id,
  tab,
  filePath,
}: SaveProjectFileOptions): Promise<boolean> {
  let resolvedPath = filePath;
  if (resolvedPath === undefined) {
    resolvedPath = tab.activeFilePath;
  }
  if (resolvedPath === undefined) {
    return false;
  }
  const buffer = tab.files.get(resolvedPath);
  if (
    buffer === undefined ||
    buffer.model === undefined ||
    buffer.mtimeMs === undefined
  ) {
    return false;
  }
  const result = await bridge.writeFile({
    path: buffer.filePath,
    baseTabId: buffer.baseTabId,
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
  updateTreeDirtyState(tab);
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
  for (const buffer of tab.files.values()) {
    if (!buffer.dirty) {
      continue;
    }
    const saved = await saveProjectFile({
      id,
      tab,
      filePath: buffer.filePath,
    });
    if (!saved) {
      failedPaths.push(buffer.filePath);
    }
  }
  bridge.emitEvent({
    type: "files-save-finished",
    id,
    failedPaths,
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
  initialFileBaseTabId: number | undefined;
  group: DockviewGroupPanel | undefined;
};

export async function openProjectTab({
  id,
  workspace,
  tabElements,
  baseTabId,
  workspaceRootPath,
  initialFilePath,
  initialFileBaseTabId,
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

  const [treeResult, treeLibrary, monaco] = await Promise.all([
    bridge.readProjectTree({
      baseTabId,
      workspaceRootPath,
      filePath: initialFilePath,
      fileBaseTabId: initialFileBaseTabId,
    }),
    loadProjectTreeLibrary(),
    loadMonaco(),
  ]);

  let resolvedWorkspaceRootPath = "";
  let title = "Workspace";
  if (!("error" in treeResult)) {
    resolvedWorkspaceRootPath = treeResult.workspaceRootPath;
    title = treeResult.name;
  }
  tabElements.titleElement.textContent = title;
  panel.setTitle(title);

  const editor = createCodeEditor({
    monaco,
    container: pane.editorElement,
  });
  const tab: ProjectTab = {
    kind: "project",
    panel,
    titleElement: tabElements.titleElement,
    titlePinned: true,
    element: pane.paneElement,
    treeElement: pane.treeElement,
    editorElement: pane.editorElement,
    fileTabsElement: pane.fileTabsElement,
    fileHeaderElement: pane.fileHeaderElement,
    statusElement: pane.statusElement,
    emptyElement: pane.emptyElement,
    errorElement: pane.errorElement,
    workspaceRootPath: resolvedWorkspaceRootPath,
    fileTree: undefined,
    monaco,
    editor,
    files: new Map(),
    activeFilePath: undefined,
    previewFilePath: undefined,
    latestFileRequest: 0,
  };

  if ("error" in treeResult) {
    pane.treeElement.textContent = `Could not open workspace tree: ${treeResult.error}`;
  } else {
    tab.fileTree = mountProjectTree({
      treeElement: tab.treeElement,
      entries: treeResult.entries,
      treeLibrary,
      openFile: ({ filePath, preview }) => {
        executeCommand({
          type: "open-file",
          path: filePath,
          preview,
        });
      },
    });
  }
  showEmptyEditor(tab);

  editor.onDidChangeModelContent(() => {
    if (tab.activeFilePath === undefined) {
      return;
    }
    const buffer = tab.files.get(tab.activeFilePath);
    if (buffer === undefined || buffer.model !== editor.getModel()) {
      return;
    }
    if (buffer.dirty) {
      return;
    }
    buffer.dirty = true;
    pinProjectFile({
      id,
      tab,
      filePath: buffer.filePath,
      announce: false,
    });
    updateFileTab(buffer);
    updateTreeDirtyState(tab);
    bridge.emitEvent({
      type: "dirty-changed",
      id,
      path: buffer.filePath,
      state: snapshot(),
    });
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
  tab.treeElement.textContent = "Loading workspace…";
  const [result, treeLibrary] = await Promise.all([
    bridge.readProjectTree({ workspaceRootPath }),
    loadProjectTreeLibrary(),
  ]);
  if ("error" in result) {
    tab.treeElement.textContent = `Could not change workspace root: ${result.error}`;
    return;
  }
  tab.fileTree?.cleanUp();
  tab.workspaceRootPath = result.workspaceRootPath;
  tab.fileTree = mountProjectTree({
    treeElement: tab.treeElement,
    entries: result.entries,
    treeLibrary,
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
  updateTreeDirtyState(tab);
  refreshWorkspaceName(workspace);
  bridge.emitEvent({
    type: "workspace-root-changed",
    id,
    path: result.workspaceRootPath,
    state: snapshot(),
  });
}

export function focusProjectTab(tab: ProjectTab): void {
  if (tab.activeFilePath !== undefined) {
    const buffer = tab.files.get(tab.activeFilePath);
    if (buffer !== undefined && buffer.model !== undefined) {
      tab.editor.focus();
      return;
    }
  }
  if (tab.fileTree === undefined) {
    tab.treeElement.focus();
    return;
  }
  const focusedItem = tab.fileTree.getFocusedItem();
  if (focusedItem !== null) {
    focusedItem.focus();
    return;
  }
  tab.fileTree.focusFirstItem();
}

export function disposeProjectTab(tab: ProjectTab): void {
  tab.fileTree?.cleanUp();
  for (const buffer of tab.files.values()) {
    buffer.model?.dispose();
  }
  tab.editor.dispose();
}
