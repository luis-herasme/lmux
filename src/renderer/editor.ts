// One workspace's file experience: its stable root, tree and read-only
// editor. Not a tab: a workspace has exactly one of these, it lives in the
// editor beside the pane layout, and it shows one file at a time.
//
// What the editor looks like is editor-view.tsx; this is what it holds
// and what changes it. Every change ends in drawEditors, which draws the
// region again and leaves the difference to React.
import { createRef } from "react";
import type { RefObject } from "react";
import { bridge } from "./bridge.ts";
import { createCodeEditor, languageForPath, loadMonaco } from "./monaco.ts";
import type { Monaco } from "./monaco.ts";
import type {
  ReadFileTreeRequest,
  ReadFileTreeResult,
} from "../inter-process-communication/bridge.ts";
import { createFileTree, focusFileTree } from "./file-tree.tsx";
import type { FileTree } from "./file-tree.tsx";
import { drawEditors } from "./editor-view.tsx";
import {
  handleFileTreeChange,
  startFileTreeWatcher,
  stopFileTreeWatcher,
} from "./file-tree-watcher.ts";
import type { FileTreeWatcher } from "./file-tree-watcher.ts";
import { renderMarkdown } from "./tabs/markdown-renderer.ts";
import { executeCommand } from "./tabs/index.ts";
import { snapshot } from "./snapshot.ts";
import { nextTabId } from "./workspaces.ts";
import type { Workspace } from "./workspaces.ts";
import type { MarkdownMode } from "../api.ts";
import type { editor as monacoEditor } from "monaco-editor";

// The one file the editor holds: opening another replaces it.
type EditorFile = {
  filePath: string; // canonical, as the tree and the Events name it
  model: monacoEditor.ITextModel | undefined;
  error: string | undefined;
  // only a markdown file ever leaves "raw"; the code editor is its raw face
  markdownMode: MarkdownMode;
};

export type Editor = {
  id: number; // what a command's editorId names
  // The four elements the rest of the editor writes into: Monaco's container,
  // the tree's scroll box, the rendered document, and the message the
  // keyboard is sent to. Each hosts DOM that is not React's, or is a focus
  // target; nothing else about the editor is reached this way.
  treeElement: RefObject<HTMLDivElement | null>;
  codeEditorElement: RefObject<HTMLDivElement | null>;
  markdownElement: RefObject<HTMLDivElement | null>;
  errorElement: RefObject<HTMLDivElement | null>;
  name: string; // the root folder's, worn by the editor's header
  visible: boolean;
  workspaceRootPath: string;
  fileTree: FileTree | undefined; // undefined while its root is read
  treeError: string | undefined; // and set instead when that read failed
  treeRequest: ReadFileTreeRequest; // the one Retry sends again
  monaco: Monaco;
  // Monaco is built against the element the first render leaves behind, so
  // it arrives one step after the editor does.
  codeEditor: monacoEditor.IStandaloneCodeEditor | undefined;
  file: EditorFile | undefined;
  // a request counter each: an answer that arrives after the editor moved on
  // is dropped rather than shown
  latestFileRequest: number;
  latestTreeRequest: number;
  latestGitRequest: number;
  fileTreeWatcher: FileTreeWatcher; // file-tree-watcher.ts owns it
};

type EditorFileView = {
  model: monacoEditor.ITextModel | undefined;
  markdown: boolean; // the open file is a markdown document
  rendered: boolean; // and is being shown as one rather than as its source
  error: string | undefined;
};

// What the open file means for the view: which of the editor's four faces is
// up, and what the markdown button offers. The view draws from this and
// showEditorFile fills the elements it left, so the two cannot disagree.
export function editorFileView(editor: Editor): EditorFileView {
  const file = editor.file;
  const model = file?.model;
  const markdown = model !== undefined && model.getLanguageId() === "markdown";
  return {
    model,
    markdown,
    rendered: markdown && file?.markdownMode === "rendered",
    error: file?.error,
  };
}

// The editor's one view, drawn from what it holds: the file in its editor or,
// for markdown switched to rendered, that same model drawn as a document; the
// error its path answered with; or the empty state. React puts the right one
// on screen; what is left here is the DOM that is not React's — Monaco's
// model, the rendered document — and where the keyboard goes.
export function showEditorFile(editor: Editor): void {
  const { model, rendered, error } = editorFileView(editor);
  drawEditors();
  const markdownElement = editor.markdownElement.current;
  editor.codeEditor?.setModel(model ?? null);

  if (rendered && model !== undefined) {
    markdownElement?.replaceChildren(renderMarkdown(model.getValue()).view);
    markdownElement?.focus();
    return;
  }
  markdownElement?.replaceChildren();
  if (model !== undefined) {
    editor.codeEditor?.focus();
    return;
  }
  if (error !== undefined) {
    editor.errorElement.current?.focus();
  }
}

export function closeEditorFile(editor: Editor): void {
  const file = editor.file;
  if (file === undefined) {
    return;
  }
  editor.file = undefined;
  showEditorFile(editor);
  file.model?.dispose();
  bridge.emitEvent({
    type: "file-closed",
    id: editor.id,
    path: file.filePath,
    state: snapshot(),
  });
}

type SetEditorFileMarkdownModeOptions = {
  editor: Editor;
  mode: MarkdownMode;
};

// Only a markdown file has a rendered face; the command ignores anything
// else, the way set-markdown-mode ignores a tab that isn't a document.
export function setEditorFileMarkdownMode({
  editor,
  mode,
}: SetEditorFileMarkdownModeOptions): void {
  const file = editor.file;
  if (
    file === undefined ||
    file.model?.getLanguageId() !== "markdown" ||
    file.markdownMode === mode
  ) {
    return;
  }
  file.markdownMode = mode;
  showEditorFile(editor);
  bridge.emitEvent({
    type: "file-markdown-mode-changed",
    id: editor.id,
    path: file.filePath,
    state: snapshot(),
  });
}

type OpenEditorFileOptions = {
  editor: Editor;
  filePath: string;
  baseTabId?: number; // the tab a relative path is resolved against
};

// The editor holds one file, so opening another reads it and replaces what was
// there, including when it is the same path read again.
export async function openEditorFile({
  editor,
  filePath,
  baseTabId,
}: OpenEditorFileOptions): Promise<void> {
  editor.latestFileRequest += 1;
  const fileRequest = editor.latestFileRequest;

  const result = await bridge.readFile({
    path: filePath,
    baseTabId,
  });
  if (fileRequest !== editor.latestFileRequest) {
    return;
  }

  let resolvedPath = filePath;
  let model: monacoEditor.ITextModel | undefined;
  let error: string | undefined;
  if ("error" in result) {
    error = result.error;
  } else {
    resolvedPath = result.resolvedPath;
    model = editor.monaco.editor.createModel(
      result.content,
      languageForPath({
        monaco: editor.monaco,
        filePath: resolvedPath,
      }),
    );
  }
  const previous = editor.file;
  editor.file = {
    filePath: resolvedPath,
    model,
    error,
    markdownMode: "raw",
  };
  showEditorFile(editor);
  // disposed after the view took the new model, never while it holds this one
  previous?.model?.dispose();
  bridge.emitEvent({
    type: "file-opened",
    id: editor.id,
    path: resolvedPath,
    state: snapshot(),
  });
}

type LoadFileTreeRootOptions = {
  editor: Editor;
  request: ReadFileTreeRequest;
  emitWorkspaceRootChanged: boolean;
};

export async function loadFileTreeRoot({
  editor,
  request,
  emitWorkspaceRootChanged,
}: LoadFileTreeRootOptions): Promise<void> {
  editor.latestTreeRequest += 1;
  editor.latestGitRequest += 1;
  const treeRequest = editor.latestTreeRequest;
  stopFileTreeWatcher(editor);
  // no tree and no error is the state that says the root is being read; the
  // request is kept because the button offering another one sends this one
  editor.fileTree = undefined;
  editor.treeError = undefined;
  editor.treeRequest = request;
  drawEditors();

  let result: ReadFileTreeResult;
  try {
    result = await bridge.readFileTree(request);
  } catch (error) {
    result = { error: String(error) };
  }
  if (treeRequest !== editor.latestTreeRequest) {
    return;
  }
  if ("error" in result) {
    editor.treeError = result.error;
    drawEditors();
    return;
  }

  editor.workspaceRootPath = result.workspaceRootPath;
  editor.fileTree = createFileTree({
    workspaceRootPath: result.workspaceRootPath,
    entries: result.entries,
    openFile: (filePath) => {
      executeCommand({
        type: "open-file",
        path: filePath,
      });
    },
    redraw: () => {
      drawEditors();
    },
  });
  editor.name = result.name;
  drawEditors();
  await startFileTreeWatcher({
    editor,
    treeRequest,
  });
  if (treeRequest !== editor.latestTreeRequest) {
    return;
  }
  await handleFileTreeChange({
    editor,
    paths: null,
  });
  if (treeRequest !== editor.latestTreeRequest) {
    return;
  }
  if (!emitWorkspaceRootChanged) {
    return;
  }
  bridge.emitEvent({
    type: "workspace-root-changed",
    id: editor.id,
    path: result.workspaceRootPath,
    state: snapshot(),
  });
}

type CreateEditorOptions = {
  workspace: Workspace;
  baseTabId?: number;
  workspaceRootPath?: string;
  initialFilePath?: string;
};

// The editor is planted hidden: whoever asked for it decides when the
// workspace shows it, the way a workspace's own layout is planted hidden.
export async function createEditor({
  workspace,
  baseTabId,
  workspaceRootPath,
  initialFilePath,
}: CreateEditorOptions): Promise<Editor> {
  const request: ReadFileTreeRequest = {
    baseTabId,
    workspaceRootPath,
    filePath: initialFilePath,
  };
  const monaco = await loadMonaco();
  const editor: Editor = {
    id: nextTabId(),
    treeElement: createRef(),
    codeEditorElement: createRef(),
    markdownElement: createRef(),
    errorElement: createRef(),
    name: "",
    visible: false,
    workspaceRootPath: "",
    fileTree: undefined,
    treeError: undefined,
    treeRequest: request,
    monaco,
    codeEditor: undefined,
    file: undefined,
    latestFileRequest: 0,
    latestTreeRequest: 0,
    latestGitRequest: 0,
    fileTreeWatcher: {
      id: undefined,
      retryCount: 0,
      retryTimer: undefined,
    },
  };

  // The view draws from the store, so the editor goes in before the draw, and
  // that first render leaves the element Monaco is built against.
  workspace.editor = editor;
  drawEditors();
  const codeEditorElement = editor.codeEditorElement.current;
  if (codeEditorElement === null) {
    throw new Error("the editor drew no code editor element");
  }
  editor.codeEditor = createCodeEditor({
    monaco,
    container: codeEditorElement,
  });

  await loadFileTreeRoot({
    editor,
    request,
    emitWorkspaceRootChanged: false,
  });
  return editor;
}

type ChangeWorkspaceRootOptions = {
  editor: Editor;
  workspaceRootPath: string;
};

export async function changeEditorWorkspaceRoot({
  editor,
  workspaceRootPath,
}: ChangeWorkspaceRootOptions): Promise<void> {
  await loadFileTreeRoot({
    editor,
    request: { workspaceRootPath },
    emitWorkspaceRootChanged: true,
  });
}

export function focusEditor(editor: Editor): void {
  const file = editor.file;
  if (file !== undefined && file.model !== undefined) {
    // a rendered file's editor is hidden; keys should scroll the document
    if (file.markdownMode === "rendered") {
      editor.markdownElement.current?.focus();
      return;
    }
    editor.codeEditor?.focus();
    return;
  }
  const treeElement = editor.treeElement.current;
  if (editor.fileTree === undefined || treeElement === null) {
    treeElement?.focus();
    return;
  }
  focusFileTree({
    fileTree: editor.fileTree,
    treeElement,
  });
}

// Only a closing workspace disposes its editor; hiding one keeps its file
// open behind it.
export function disposeEditor(editor: Editor): void {
  editor.latestFileRequest += 1;
  editor.latestTreeRequest += 1;
  editor.latestGitRequest += 1;
  stopFileTreeWatcher(editor);
  editor.fileTree = undefined;
  editor.file?.model?.dispose();
  editor.codeEditor?.dispose();
}
