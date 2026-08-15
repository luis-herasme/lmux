// The project panel's DOM, built once per workspace: a header, a file tree
// down the right, and the region that shows one file. Everything here is
// construction; what the panel does with these elements is project-panel.ts.
// A view that comes and goes carries both its display utility and `hidden`,
// which Tailwind emits last so it wins until project-panel.ts takes it off.
import { mountProjectTreeResizeHandle } from "./project-tree-resize.ts";
import { mountProjectTreeScrollbar } from "./project-tree-scrollbar.ts";
import { MARKDOWN_ACTION_CLASS } from "./tabs/markdown-tab.ts";
import { executeCommand } from "./tabs/index.ts";

export type ProjectPanelElements = {
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

export function buildProjectPanelElements(): ProjectPanelElements {
  const treeElement = document.createElement("div");
  treeElement.className =
    "project-tree min-w-0 overflow-auto border-l border-separator bg-background text-[13px] text-tab";
  treeElement.tabIndex = -1;
  treeElement.textContent = "Loading workspace…";

  // the tree's own scrollbar, floated over its rows: project-tree-scrollbar.ts
  // sizes it, and a tree short enough to fit never shows it at all
  const treeScrollbarElement = document.createElement("div");
  treeScrollbarElement.className =
    "absolute top-0 right-0 z-1 block w-(--scrollbar-size) bg-scrollbar-thumb hover:bg-scrollbar-thumb-hover [&.dragging]:bg-scrollbar-thumb-hover hidden";
  treeScrollbarElement.ariaHidden = "true";

  // 5px of hit area over the tree's inner edge; its hairline is in style.css,
  // and its width, limits and aria come from project-tree-resize.ts below
  const resizeHandleElement = document.createElement("div");
  resizeHandleElement.className =
    "project-tree-resizer absolute inset-y-0 right-[calc(var(--project-tree-width)-3px)] z-2 w-[5px] cursor-col-resize outline-none";

  const emptyElement = document.createElement("div");
  emptyElement.className = "block p-6 text-[13px] text-tab hidden";
  emptyElement.textContent = "Select a file from the workspace tree.";

  // shown instead of a file view when its path could not be read
  const errorElement = document.createElement("div");
  errorElement.className =
    "flex flex-col gap-1.5 px-6 py-[18px] text-[13px] text-tab-active hidden";
  errorElement.tabIndex = -1;

  // Monaco owns this element. Sibling UI lives around it, never inside it.
  const editorElement = document.createElement("div");
  editorElement.className =
    "code-editor project-editor absolute inset-0 block min-h-0 outline-none hidden";

  // the file's rendered face, drawn over the editor's spot
  const markdownElement = document.createElement("div");
  markdownElement.className =
    "markdown-scroll project-markdown absolute inset-0 block overflow-auto outline-none hidden";
  markdownElement.tabIndex = -1;

  const markdownModeButton = document.createElement("button");
  markdownModeButton.className = MARKDOWN_ACTION_CLASS;
  markdownModeButton.title = "Show the file rendered, or back in the editor";

  // only surfaces while the open file is markdown
  const markdownToolbarElement = document.createElement("div");
  markdownToolbarElement.className =
    "project-markdown-toolbar flex flex-none justify-end gap-1 px-2.5 pt-1.5 hidden";
  markdownToolbarElement.append(markdownModeButton);

  const editorBodyElement = document.createElement("div");
  editorBodyElement.className = "relative min-h-0 flex-1";
  editorBodyElement.append(
    emptyElement,
    errorElement,
    editorElement,
    markdownElement,
  );

  const editorRegionElement = document.createElement("div");
  editorRegionElement.className = "flex min-w-0 flex-col";
  editorRegionElement.append(markdownToolbarElement, editorBodyElement);

  // one editor region beside a resizable tree
  const paneElement = document.createElement("div");
  paneElement.className =
    "project-pane relative grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_var(--project-tree-width)] bg-background";
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
  nameElement.className = "min-w-0 flex-1 truncate";

  const hideElement = document.createElement("button");
  hideElement.className =
    "flex-none cursor-pointer border-0 bg-transparent p-0 text-[length:inherit] leading-none text-tab hover:text-tab-active";
  hideElement.textContent = "×";
  hideElement.title = "Hide Project Panel (⌘B)";
  hideElement.ariaLabel = "Hide project panel";
  hideElement.addEventListener("click", () => {
    executeCommand({ type: "close-project" });
  });

  // 35px is the tab strip's height, so the two line up across the window;
  // Dockview counts its own underline inside that, so this has to as well
  const headerElement = document.createElement("div");
  headerElement.className =
    "project-header box-border flex h-[35px] flex-none items-center gap-1.5 border-b border-separator bg-tab-bar px-2 text-[12px] text-tab-active";
  headerElement.append(nameElement, hideElement);

  const panelElement = document.createElement("div");
  panelElement.className = "project-panel flex h-full flex-col bg-background";
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
