// Every Command about a workspace's editor: showing it, hiding it,
// rooting it somewhere else, and the one file it holds.
import { bridge } from "./bridge.ts";
import {
  changeEditorWorkspaceRoot,
  closeEditorFile,
  createEditor,
  focusEditor,
  openEditorFile,
  setEditorFileMarkdownMode,
} from "./editor.ts";
import type { Editor } from "./editor.ts";
import { snapshot } from "./snapshot.ts";
import {
  activeWorkspace,
  focusWorkspace,
  refreshEditor,
  resolveWorkspace,
  workspaces,
} from "./workspaces.ts";
import type { Workspace } from "./workspaces.ts";
import type { Command } from "../api.ts";

// An `editorId` names one workspace's editor, wherever that workspace is;
// without one the active workspace's editor is meant. An editor that has never
// been opened does not exist yet, and the command bails.
function resolveEditor(
  editorId: number | undefined,
): Editor | undefined {
  if (editorId === undefined) {
    return activeWorkspace?.editor;
  }
  for (const workspace of workspaces.values()) {
    if (workspace.editor?.id === editorId) {
      return workspace.editor;
    }
  }
  return undefined;
}

type OpenEditorOptions = {
  workspace: Workspace;
  baseTabId?: number; // the tab a relative path is resolved against
  workspaceRootPath?: string; // where to root a editor being built
  initialFilePath?: string;
};

// Building one waits on 4MB of Monaco, so a second request arriving
// meanwhile waits for the same editor rather than starting a second.
const pendingEditors = new Map<Workspace, Promise<Editor>>();

export async function ensureEditor(
  options: OpenEditorOptions,
): Promise<Editor> {
  const { workspace } = options;
  const existing = workspace.editor;
  if (existing !== undefined) {
    return existing;
  }
  let pendingEditor = pendingEditors.get(workspace);
  if (pendingEditor === undefined) {
    pendingEditor = createEditor(options);
    pendingEditors.set(workspace, pendingEditor);
  }
  try {
    // createEditor puts it on the workspace, because its view draws from there
    return await pendingEditor;
  } finally {
    if (pendingEditors.get(workspace) === pendingEditor) {
      pendingEditors.delete(workspace);
    }
  }
}

type ShowEditorOptions = {
  workspace: Workspace;
  editor: Editor;
};

// Coming on screen is state plus an Event, so every command that opens
// something in the editor ends here. A background workspace's editor is
// opened without taking the keyboard away from the one on screen.
function showEditor({ workspace, editor }: ShowEditorOptions): void {
  const wasVisible = editor.visible;
  editor.visible = true;
  refreshEditor();
  if (workspace === activeWorkspace) {
    workspace.focus = "editor";
    focusEditor(editor);
  }
  // the Event carries the state it produced, so it goes out once the
  // keyboard has moved too
  if (wasVisible) {
    return;
  }
  bridge.emitEvent({
    type: "editor-shown",
    id: editor.id,
    state: snapshot(),
  });
}

async function openEditor(options: OpenEditorOptions): Promise<void> {
  const { workspace, baseTabId, initialFilePath } = options;
  const editor = await ensureEditor(options);
  // a new editor takes the path to find its root; opening the file is this
  if (initialFilePath !== undefined) {
    await openEditorFile({
      editor,
      filePath: initialFilePath,
      baseTabId,
    });
  }
  showEditor({
    workspace,
    editor,
  });
}

export function executeEditorCommand(command: Command): void {
  switch (command.type) {
    case "open-file": {
      if (!activeWorkspace) {
        return;
      }
      openEditor({
        workspace: activeWorkspace,
        baseTabId: command.baseTabId,
        initialFilePath: command.path,
      });
      return;
    }
    case "show-editor": {
      const workspace = resolveWorkspace(command.workspaceId);
      if (workspace === undefined) {
        return;
      }
      let baseTabId = command.baseTabId;
      if (baseTabId === undefined) {
        baseTabId = workspace.activeId;
      }
      openEditor({
        workspace,
        baseTabId,
      });
      return;
    }
    case "hide-editor": {
      const workspace = resolveWorkspace(command.workspaceId);
      const editor = workspace?.editor;
      if (workspace === undefined || editor === undefined || !editor.visible) {
        return;
      }
      editor.visible = false;
      refreshEditor();
      // the keyboard was in the editor that just left, so the panes take it
      if (workspace.focus === "editor") {
        workspace.focus = "panes";
        focusWorkspace();
      }
      bridge.emitEvent({
        type: "editor-hidden",
        id: editor.id,
        state: snapshot(),
      });
      return;
    }
    case "change-workspace-root": {
      const workspace = resolveWorkspace(command.workspaceId);
      if (workspace === undefined) {
        return;
      }
      const editor = workspace.editor;
      if (editor === undefined) {
        openEditor({
          workspace,
          workspaceRootPath: command.path,
        });
        return;
      }
      changeEditorWorkspaceRoot({
        editor,
        workspaceRootPath: command.path,
      });
      showEditor({
        workspace,
        editor,
      });
      return;
    }
    case "close-file": {
      const editor = resolveEditor(command.editorId);
      if (editor === undefined) {
        return;
      }
      closeEditorFile(editor);
      return;
    }
    case "set-file-markdown-mode": {
      const editor = resolveEditor(command.editorId);
      if (editor === undefined) {
        return;
      }
      setEditorFileMarkdownMode({
        editor,
        mode: command.mode,
      });
      return;
    }
  }
}
