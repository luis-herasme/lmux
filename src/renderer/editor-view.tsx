// The editor's markup: a header, a file tree down the right, and the
// region that shows one file. React draws all of it from what the editor
// holds; editor.ts is what changes that.
//
// The editor is one React root, and the tree is a region inside it rather
// than a root of its own, so a directory arriving and a file opening are the
// same kind of event: change the state, draw the editor again.
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { DirectoryContents, TreeError, TreeMessage } from "./file-tree.tsx";
import { mountFileTreeResizeHandle } from "./file-tree-resize.ts";
import { mountFileTreeScrollbar } from "./file-tree-scrollbar.ts";
import { loadFileTreeRoot, editorFileView } from "./editor.ts";
import type { Editor } from "./editor.ts";
import { MARKDOWN_ACTION_CLASS } from "./tabs/markdown-tab.tsx";
import { executeCommand } from "./tabs/index.ts";
import { requireElement } from "./dom.ts";
import { activeWorkspace, workspaces } from "./workspaces.ts";

const editorsRoot = createRoot(requireElement("editors"));

// One editor per workspace, only the active workspace's shown, the way the
// pane area holds one layout each (panes.tsx). Drawn synchronously, because
// the caller goes straight on to fill the elements this render leaves behind,
// Monaco's container and the document's box, and to move the keyboard into
// one of them.
export function drawEditors(): void {
  flushSync(() => {
    editorsRoot.render(
      Array.from(workspaces.values(), (workspace) => {
        const editor = workspace.editor;
        if (editor === undefined) {
          return null;
        }
        return (
          <EditorView
            key={workspace.id}
            editor={editor}
            visible={workspace === activeWorkspace && editor.visible}
          />
        );
      }),
    );
  });
}

type EditorViewProps = {
  editor: Editor;
  visible: boolean; // a background workspace keeps its editor off screen
};

function EditorView({ editor, visible }: EditorViewProps): ReactNode {
  const view = editorFileView(editor);
  // Two widgets that answer the pointer rather than the state, mounted once
  // against the elements below: the drag handle between the file and the
  // tree, and the tree's floating scrollbar. Both write classes and geometry
  // on their own elements afterwards, which survives every later draw
  // because React only touches an attribute whose rendered value changed.
  const paneElement = useRef<HTMLDivElement>(null);
  const scrollbarElement = useRef<HTMLDivElement>(null);
  const resizeHandleElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pane = paneElement.current;
    const tree = editor.treeElement.current;
    const scrollbar = scrollbarElement.current;
    const resizeHandle = resizeHandleElement.current;
    if (pane && tree && scrollbar && resizeHandle) {
      mountFileTreeResizeHandle({
        paneElement: pane,
        treeElement: tree,
        resizeHandleElement: resizeHandle,
      });
      mountFileTreeScrollbar({
        treeElement: tree,
        thumbElement: scrollbar,
      });
    }
  }, [editor]);

  return (
    <div
      className={`editor flex h-full flex-col bg-background${
        visible ? "" : " hidden"
      }`}
    >
      {/* The header sits along the window's top edge where a title bar
          would be, so it is a drag region too, like the empty stretch beside
          a tab strip (.dv-void-container in style.css). A drag region's
          pixels go to the window manager, which is why the button below has
          to opt back out to stay clickable. */}
      <div className="editor-header box-border flex h-8 flex-none items-center gap-1.5 border-b border-separator bg-tab-bar px-2 text-[12px] text-tab-active [-webkit-app-region:drag]">
        <span
          className="min-w-0 flex-1 truncate"
          title={editor.workspaceRootPath}
        >
          {editor.name}
        </span>
        <button
          className="flex-none cursor-pointer border-0 bg-transparent p-0 text-[length:inherit] leading-none text-tab hover:text-tab-active [-webkit-app-region:no-drag]"
          type="button"
          title="Hide Editor Editor (⌘B)"
          aria-label="Hide editor"
          onClick={() => {
            executeCommand({ type: "hide-editor" });
          }}
        >
          ×
        </button>
      </div>
      {/* one editor region beside a resizable tree */}
      <div
        className="editor-body relative grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_var(--file-tree-width)] bg-background"
        ref={paneElement}
      >
        <div className="flex min-w-0 flex-col">
          {/* only surfaces while the open file is markdown */}
          <div
            className={`editor-markdown-toolbar flex flex-none justify-end gap-1 px-2.5 pt-1.5${
              view.markdown ? "" : " hidden"
            }`}
          >
            {/* the button names the mode it would switch to, like a play
                button */}
            <button
              className={MARKDOWN_ACTION_CLASS}
              type="button"
              title="Show the file rendered, or back in the editor"
              onClick={() => {
                executeCommand({
                  type: "set-file-markdown-mode",
                  editorId: editor.id,
                  mode: view.rendered ? "raw" : "rendered",
                });
              }}
            >
              {view.rendered ? "Source" : "Rendered"}
            </button>
          </div>
          <div className="relative min-h-0 flex-1">
            <div
              className={`block p-6 text-[13px] text-tab${
                editor.file === undefined ? "" : " hidden"
              }`}
            >
              Select a file from the workspace tree.
            </div>
            {/* shown instead of a file view when its path could not be read */}
            <div
              className={`flex flex-col gap-1.5 px-6 py-[18px] text-[13px] text-tab-active${
                view.error === undefined ? " hidden" : ""
              }`}
              tabIndex={-1}
              ref={editor.errorElement}
            >
              {view.error}
            </div>
            {/* Monaco owns this element. Sibling UI lives around it, never
                inside it, which is why React renders it with no children. */}
            <div
              className={`code-editor editor-source absolute inset-0 block min-h-0 outline-none${
                view.model === undefined || view.rendered ? " hidden" : ""
              }`}
              ref={editor.codeEditorElement}
            />
            {/* the file's rendered face, drawn over the editor's spot; its
                one child is the document markdown.ts builds */}
            <div
              className={`markdown-scroll editor-markdown absolute inset-0 block overflow-auto outline-none${
                view.rendered ? "" : " hidden"
              }`}
              tabIndex={-1}
              ref={editor.markdownElement}
            />
          </div>
        </div>
        <div
          className="file-tree min-w-0 overflow-auto border-l border-separator bg-background text-[13px] text-tab"
          tabIndex={-1}
          ref={editor.treeElement}
        >
          <ul className="file-tree-root m-0 list-none pl-0">
            <FileTreeRegion editor={editor} />
          </ul>
        </div>
        {/* the tree's own scrollbar, floated over its rows:
            file-tree-scrollbar.ts sizes it, and a tree short enough to fit
            never shows it at all */}
        <div
          className="absolute top-0 right-0 z-1 block w-(--scrollbar-size) bg-scrollbar-thumb hover:bg-scrollbar-thumb-hover [&.dragging]:bg-scrollbar-thumb-hover hidden"
          aria-hidden="true"
          ref={scrollbarElement}
        />
        {/* 5px of hit area over the tree's inner edge; its hairline is in
            style.css, and its width, limits and aria come from
            file-tree-resize.ts */}
        <div
          className="file-tree-resizer absolute inset-y-0 right-[calc(var(--file-tree-width)-3px)] z-2 w-[5px] cursor-col-resize outline-none"
          ref={resizeHandleElement}
        />
      </div>
    </div>
  );
}

type FileTreeRegionProps = {
  editor: Editor;
};

// The tree, or what stands in for it: a root still being read, or the read
// that failed and the offer to try again. A directory deeper down says the
// same things in the same markup (file-tree.tsx).
function FileTreeRegion({ editor }: FileTreeRegionProps): ReactNode {
  if (editor.treeError !== undefined) {
    return (
      <TreeError
        message={`Could not load workspace: ${editor.treeError}`}
        retry={() => {
          loadFileTreeRoot({
            editor,
            request: editor.treeRequest,
            emitWorkspaceRootChanged: true,
          });
        }}
      />
    );
  }
  if (editor.fileTree === undefined) {
    return <TreeMessage>Loading workspace…</TreeMessage>;
  }
  return <DirectoryContents fileTree={editor.fileTree} directoryPath="" />;
}
