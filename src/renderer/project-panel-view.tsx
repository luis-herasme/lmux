// The project panel's markup: a header, a file tree down the right, and the
// region that shows one file. React draws all of it from what the panel
// holds; project-panel.ts is what changes that.
//
// The panel is one React root, and the tree is a region inside it rather
// than a root of its own, so a directory arriving and a file opening are the
// same kind of event: change the state, draw the panel again.
import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { DirectoryContents, TreeError, TreeMessage } from "./project-tree.tsx";
import { mountProjectTreeResizeHandle } from "./project-tree-resize.ts";
import { mountProjectTreeScrollbar } from "./project-tree-scrollbar.ts";
import { loadProjectTreeRoot, projectFileView } from "./project-panel.ts";
import type { ProjectPanel } from "./project-panel.ts";
import { MARKDOWN_ACTION_CLASS } from "./tabs/markdown-tab.tsx";
import { executeCommand } from "./tabs/index.ts";

// Drawn synchronously, because the caller goes straight on to fill the
// elements this render leaves behind — Monaco's container, the document's
// box — and to move the keyboard into one of them.
export function drawProjectPanel(panel: ProjectPanel): void {
  flushSync(() => {
    panel.root.render(<ProjectPanelView panel={panel} />);
  });
}

type ProjectPanelViewProps = {
  panel: ProjectPanel;
};

function ProjectPanelView({ panel }: ProjectPanelViewProps): ReactNode {
  const view = projectFileView(panel);
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
    const tree = panel.treeElement.current;
    const scrollbar = scrollbarElement.current;
    const resizeHandle = resizeHandleElement.current;
    if (pane && tree && scrollbar && resizeHandle) {
      mountProjectTreeResizeHandle({
        paneElement: pane,
        treeElement: tree,
        resizeHandleElement: resizeHandle,
      });
      mountProjectTreeScrollbar({
        treeElement: tree,
        thumbElement: scrollbar,
      });
    }
  }, [panel]);

  return (
    <>
      {/* The header says which project this is and takes it off screen: what
          the Dockview tab used to do, for a panel that no longer has one.
          35px is the tab strip's height, so the two line up across the
          window; Dockview counts its own underline inside that, so this has
          to as well. */}
      <div className="project-header box-border flex h-[35px] flex-none items-center gap-1.5 border-b border-separator bg-tab-bar px-2 text-[12px] text-tab-active">
        <span
          className="min-w-0 flex-1 truncate"
          title={panel.workspaceRootPath}
        >
          {panel.name}
        </span>
        <button
          className="flex-none cursor-pointer border-0 bg-transparent p-0 text-[length:inherit] leading-none text-tab hover:text-tab-active"
          type="button"
          title="Hide Project Panel (⌘B)"
          aria-label="Hide project panel"
          onClick={() => {
            executeCommand({ type: "close-project" });
          }}
        >
          ×
        </button>
      </div>
      {/* one editor region beside a resizable tree */}
      <div
        className="project-pane relative grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_var(--project-tree-width)] bg-background"
        ref={paneElement}
      >
        <div className="flex min-w-0 flex-col">
          {/* only surfaces while the open file is markdown */}
          <div
            className={`project-markdown-toolbar flex flex-none justify-end gap-1 px-2.5 pt-1.5${
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
                  projectTabId: panel.id,
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
                panel.file === undefined ? "" : " hidden"
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
              ref={panel.errorElement}
            >
              {view.error}
            </div>
            {/* Monaco owns this element. Sibling UI lives around it, never
                inside it, which is why React renders it with no children. */}
            <div
              className={`code-editor project-editor absolute inset-0 block min-h-0 outline-none${
                view.model === undefined || view.rendered ? " hidden" : ""
              }`}
              ref={panel.editorElement}
            />
            {/* the file's rendered face, drawn over the editor's spot; its
                one child is the document markdown.ts builds */}
            <div
              className={`markdown-scroll project-markdown absolute inset-0 block overflow-auto outline-none${
                view.rendered ? "" : " hidden"
              }`}
              tabIndex={-1}
              ref={panel.markdownElement}
            />
          </div>
        </div>
        <div
          className="project-tree min-w-0 overflow-auto border-l border-separator bg-background text-[13px] text-tab"
          tabIndex={-1}
          ref={panel.treeElement}
        >
          <ul className="project-tree-root m-0 list-none pl-0">
            <ProjectTreeRegion panel={panel} />
          </ul>
        </div>
        {/* the tree's own scrollbar, floated over its rows:
            project-tree-scrollbar.ts sizes it, and a tree short enough to fit
            never shows it at all */}
        <div
          className="absolute top-0 right-0 z-1 block w-(--scrollbar-size) bg-scrollbar-thumb hover:bg-scrollbar-thumb-hover [&.dragging]:bg-scrollbar-thumb-hover hidden"
          aria-hidden="true"
          ref={scrollbarElement}
        />
        {/* 5px of hit area over the tree's inner edge; its hairline is in
            style.css, and its width, limits and aria come from
            project-tree-resize.ts */}
        <div
          className="project-tree-resizer absolute inset-y-0 right-[calc(var(--project-tree-width)-3px)] z-2 w-[5px] cursor-col-resize outline-none"
          ref={resizeHandleElement}
        />
      </div>
    </>
  );
}

type ProjectTreeRegionProps = {
  panel: ProjectPanel;
};

// The tree, or what stands in for it: a root still being read, or the read
// that failed and the offer to try again. A directory deeper down says the
// same things in the same markup (project-tree.tsx).
function ProjectTreeRegion({ panel }: ProjectTreeRegionProps): ReactNode {
  if (panel.treeError !== undefined) {
    return (
      <TreeError
        message={`Could not load workspace: ${panel.treeError}`}
        retry={() => {
          loadProjectTreeRoot({
            panel,
            request: panel.treeRequest,
            emitWorkspaceRootChanged: true,
          });
        }}
      />
    );
  }
  if (panel.projectTree === undefined) {
    return <TreeMessage>Loading workspace…</TreeMessage>;
  }
  return <DirectoryContents projectTree={panel.projectTree} directoryPath="" />;
}
