// The handle between the project panel's editor and its file tree. The tree
// is the side on the right, so dragging the handle left widens it. The width
// is one CSS variable on the pane, written only from here.
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

export function mountProjectTreeResizeHandle({
  paneElement,
  treeElement,
  resizeHandleElement,
}: MountProjectTreeResizeHandleOptions): void {
  // The starting width is stated, not measured: a panel is built hidden, and
  // a hidden pane is zero wide.
  paneElement.style.setProperty(
    "--project-tree-width",
    `${DEFAULT_PROJECT_TREE_WIDTH_PX}px`,
  );
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
