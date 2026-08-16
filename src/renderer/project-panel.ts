// One workspace's file experience: its stable root, tree and read-only
// editor. Not a tab: a workspace has exactly one of these, it lives in the
// panel beside the pane layout, and it shows one file at a time.
//
// What the panel looks like is project-panel-view.tsx; this is what it holds
// and what changes it. Every change ends in drawProjectPanel, which renders
// the whole panel again and leaves the difference to React.
import { createRef } from "react";
import { createRoot } from "react-dom/client";
import type { RefObject } from "react";
import type { Root } from "react-dom/client";
import { bridge } from "./bridge.ts";
import { createCodeEditor, languageForPath, loadMonaco } from "./code.ts";
import type { Monaco } from "./code.ts";
import type {
  ReadProjectTreeRequest,
  ReadProjectTreeResult,
} from "../ipc/bridge.ts";
import { createProjectTree, focusProjectTree } from "./project-tree.tsx";
import type { ProjectTree } from "./project-tree.tsx";
import { drawProjectPanel } from "./project-panel-view.tsx";
import {
  handleProjectTreeChange,
  startProjectTreeWatcher,
  stopProjectTreeWatcher,
} from "./project-tree-watcher.ts";
import type { ProjectTreeWatcher } from "./project-tree-watcher.ts";
import { renderMarkdown } from "./tabs/markdown.ts";
import { executeCommand } from "./tabs/index.ts";
import { snapshot } from "./snapshot.ts";
import { nextTabId } from "./workspaces.ts";
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
  element: HTMLElement; // the .project-panel host, hidden from workspaces.ts
  root: Root;
  // The four elements the rest of the panel writes into: Monaco's container,
  // the tree's scroll box, the rendered document, and the message the
  // keyboard is sent to. Each hosts DOM that is not React's, or is a focus
  // target; nothing else about the panel is reached this way.
  treeElement: RefObject<HTMLDivElement | null>;
  editorElement: RefObject<HTMLDivElement | null>;
  markdownElement: RefObject<HTMLDivElement | null>;
  errorElement: RefObject<HTMLDivElement | null>;
  name: string; // the root folder's, worn by the panel's header
  visible: boolean;
  workspaceRootPath: string;
  projectTree: ProjectTree | undefined; // undefined while its root is read
  treeError: string | undefined; // and set instead when that read failed
  treeRequest: ReadProjectTreeRequest; // the one Retry sends again
  monaco: Monaco;
  // Monaco is built against the element the first render leaves behind, so
  // it arrives one step after the panel does.
  editor: monacoEditor.IStandaloneCodeEditor | undefined;
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

type ProjectFileView = {
  model: monacoEditor.ITextModel | undefined;
  markdown: boolean; // the open file is a markdown document
  rendered: boolean; // and is being shown as one rather than as its source
  error: string | undefined;
};

// What the open file means for the view: which of the panel's four faces is
// up, and what the markdown button offers. The view draws from this and
// showProjectFile fills the elements it left, so the two cannot disagree.
export function projectFileView(panel: ProjectPanel): ProjectFileView {
  const file = panel.file;
  const model = file?.model;
  const markdown = model !== undefined && model.getLanguageId() === "markdown";
  return {
    model,
    markdown,
    rendered: markdown && file?.markdownMode === "rendered",
    error: file?.error,
  };
}

// The panel's one view, drawn from what it holds: the file in its editor or,
// for markdown switched to rendered, that same model drawn as a document; the
// error its path answered with; or the empty state. React puts the right one
// on screen; what is left here is the DOM that is not React's — Monaco's
// model, the rendered document — and where the keyboard goes.
export function showProjectFile(panel: ProjectPanel): void {
  const { model, rendered, error } = projectFileView(panel);
  drawProjectPanel(panel);
  const markdownElement = panel.markdownElement.current;
  panel.editor?.setModel(model ?? null);

  if (rendered && model !== undefined) {
    markdownElement?.replaceChildren(renderMarkdown(model.getValue()).view);
    markdownElement?.focus();
    return;
  }
  markdownElement?.replaceChildren();
  if (model !== undefined) {
    panel.editor?.focus();
    return;
  }
  if (error !== undefined) {
    panel.errorElement.current?.focus();
  }
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

export async function loadProjectTreeRoot({
  panel,
  request,
  emitWorkspaceRootChanged,
}: LoadProjectTreeRootOptions): Promise<void> {
  panel.latestTreeRequest += 1;
  panel.latestGitRequest += 1;
  const treeRequest = panel.latestTreeRequest;
  stopProjectTreeWatcher(panel);
  // no tree and no error is the state that says the root is being read; the
  // request is kept because the button offering another one sends this one
  panel.projectTree = undefined;
  panel.treeError = undefined;
  panel.treeRequest = request;
  drawProjectPanel(panel);

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
    panel.treeError = result.error;
    drawProjectPanel(panel);
    return;
  }

  panel.workspaceRootPath = result.workspaceRootPath;
  panel.projectTree = createProjectTree({
    workspaceRootPath: result.workspaceRootPath,
    entries: result.entries,
    openFile: (filePath) => {
      executeCommand({
        type: "open-file",
        path: filePath,
      });
    },
    redraw: () => {
      drawProjectPanel(panel);
    },
  });
  panel.name = result.name;
  drawProjectPanel(panel);
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
  // The host carries the panel's identity and its display, because
  // workspaces.ts hides it there; React draws everything inside it.
  const element = document.createElement("div");
  element.className = "project-panel flex h-full flex-col bg-background";
  element.style.display = "none";
  projectHostElement.append(element);

  const request: ReadProjectTreeRequest = {
    baseTabId,
    workspaceRootPath,
    filePath: initialFilePath,
  };
  const monaco = await loadMonaco();
  const panel: ProjectPanel = {
    id: nextTabId(),
    element,
    root: createRoot(element),
    treeElement: createRef(),
    editorElement: createRef(),
    markdownElement: createRef(),
    errorElement: createRef(),
    name: "",
    visible: false,
    workspaceRootPath: "",
    projectTree: undefined,
    treeError: undefined,
    treeRequest: request,
    monaco,
    editor: undefined,
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

  // the first render leaves the element Monaco is built against
  drawProjectPanel(panel);
  const editorElement = panel.editorElement.current;
  if (editorElement === null) {
    throw new Error("the project panel drew no editor element");
  }
  panel.editor = createCodeEditor({
    monaco,
    container: editorElement,
  });

  await loadProjectTreeRoot({
    panel,
    request,
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
      panel.markdownElement.current?.focus();
      return;
    }
    panel.editor?.focus();
    return;
  }
  const treeElement = panel.treeElement.current;
  if (panel.projectTree === undefined || treeElement === null) {
    treeElement?.focus();
    return;
  }
  focusProjectTree({
    projectTree: panel.projectTree,
    treeElement,
  });
}

// Only a closing workspace disposes its panel; hiding one keeps its file
// open behind it.
export function disposeProjectPanel(panel: ProjectPanel): void {
  panel.latestFileRequest += 1;
  panel.latestTreeRequest += 1;
  panel.latestGitRequest += 1;
  stopProjectTreeWatcher(panel);
  panel.projectTree = undefined;
  panel.file?.model?.dispose();
  panel.editor?.dispose();
  panel.root.unmount();
  panel.element.remove();
}
