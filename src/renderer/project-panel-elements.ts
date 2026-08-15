// The project panel's DOM, built once per workspace: a header, a file tree
// down the right, and the region that shows one file. Everything here is
// construction; what the panel does with these elements is project-panel.ts.
import { mountProjectTreeResizeHandle } from "./project-tree-resize.ts";
import { mountProjectTreeScrollbar } from "./project-tree-scrollbar.ts";
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
  treeElement.className = "project-tree";
  treeElement.tabIndex = -1;
  treeElement.textContent = "Loading workspace…";

  // the tree's own scrollbar, floated over its rows: project-tree-scrollbar.ts
  const treeScrollbarElement = document.createElement("div");
  treeScrollbarElement.className = "project-tree-scrollbar";
  treeScrollbarElement.ariaHidden = "true";

  // bare here; its width, its limits and its aria live in
  // project-tree-resize.ts, which mounts it below
  const resizeHandleElement = document.createElement("div");
  resizeHandleElement.className = "project-tree-resizer";

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
