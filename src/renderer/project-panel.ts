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
import type {
  ReadProjectTreeRequest,
  ReadProjectTreeResult,
} from "../ipc/bridge.ts";
import { focusProjectTree, mountProjectTree } from "./project-tree.tsx";
import type { ProjectTree } from "./project-tree.tsx";
import { buildProjectPanelElements } from "./project-panel-elements.ts";
import {
  handleProjectTreeChange,
  startProjectTreeWatcher,
  stopProjectTreeWatcher,
} from "./project-tree-watcher.ts";
import type { ProjectTreeWatcher } from "./project-tree-watcher.ts";
import { renderMarkdown } from "./tabs/markdown.ts";
import { executeCommand } from "./tabs/index.ts";
import { nextTabId, snapshot } from "./workspaces.ts";
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
  // a request counter each: an answer that arrives after the panel moved on
  // is dropped rather than shown
  latestFileRequest: number;
  latestTreeRequest: number;
  latestGitRequest: number;
  projectTreeWatcher: ProjectTreeWatcher; // project-tree-watcher.ts owns it
};

// Holds one panel per workspace, the way #layout holds one Dockview root
// each; workspaces.ts decides which is on screen.
const projectHostElement = requireElement("project");

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
  baseTabId?: number; // the tab a relative path is resolved against
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
  // the message below is written straight into the element the old tree was
  // drawn in, so that tree has to let go of it first
  panel.projectTree?.root.unmount();
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
  baseTabId?: number;
  workspaceRootPath?: string;
  initialFilePath?: string;
};

// The panel is planted hidden: whoever asked for it decides when the
// workspace shows it, the way a workspace's own layout is planted hidden.
export async function createProjectPanel({
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
    id: nextTabId(),
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
    projectTreeWatcher: {
      id: undefined,
      retryCount: 0,
      retryTimer: undefined,
    },
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
  panel.projectTree?.root.unmount();
  panel.file?.model?.dispose();
  panel.editor.dispose();
  panel.element.remove();
}
