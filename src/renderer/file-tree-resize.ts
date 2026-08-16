// The handle between the editor's file view and its file tree. The tree
// is the side on the right, so dragging the handle left widens it. The width
// is one CSS variable on the pane, written only from here.
const DEFAULT_FILE_TREE_WIDTH_PX = 260;
const MIN_FILE_TREE_WIDTH_PX = 120;
const MAX_FILE_TREE_WIDTH_PX = 600;
const MIN_CODE_EDITOR_WIDTH_PX = 160;
const FILE_TREE_KEYBOARD_RESIZE_STEP_PX = 20;

type MountFileTreeResizeHandleOptions = {
  paneElement: HTMLElement;
  treeElement: HTMLElement;
  resizeHandleElement: HTMLElement;
};

export function mountFileTreeResizeHandle({
  paneElement,
  treeElement,
  resizeHandleElement,
}: MountFileTreeResizeHandleOptions): void {
  // The starting width is stated, not measured: an editor is built hidden, and
  // a hidden pane is zero wide.
  paneElement.style.setProperty(
    "--file-tree-width",
    `${DEFAULT_FILE_TREE_WIDTH_PX}px`,
  );
  resizeHandleElement.setAttribute("role", "separator");
  resizeHandleElement.setAttribute("aria-label", "Resize file tree");
  resizeHandleElement.setAttribute("aria-orientation", "vertical");
  resizeHandleElement.setAttribute(
    "aria-valuemin",
    String(MIN_FILE_TREE_WIDTH_PX),
  );
  resizeHandleElement.setAttribute(
    "aria-valuenow",
    String(DEFAULT_FILE_TREE_WIDTH_PX),
  );
  resizeHandleElement.setAttribute(
    "aria-valuemax",
    String(MAX_FILE_TREE_WIDTH_PX),
  );
  resizeHandleElement.tabIndex = 0;

  function applyFileTreeWidth(requestedWidth: number): void {
    const paneWidth = Math.round(paneElement.getBoundingClientRect().width);
    let maximumWidth = paneWidth - MIN_CODE_EDITOR_WIDTH_PX;
    maximumWidth = Math.min(MAX_FILE_TREE_WIDTH_PX, maximumWidth);
    if (maximumWidth < MIN_FILE_TREE_WIDTH_PX) {
      maximumWidth = MIN_FILE_TREE_WIDTH_PX;
    }
    const width = Math.min(
      maximumWidth,
      Math.max(MIN_FILE_TREE_WIDTH_PX, Math.round(requestedWidth)),
    );
    paneElement.style.setProperty("--file-tree-width", `${width}px`);
    resizeHandleElement.setAttribute("aria-valuenow", String(width));
    resizeHandleElement.setAttribute("aria-valuemax", String(maximumWidth));
  }

  function resizeFileTree(event: MouseEvent): void {
    event.preventDefault();
    const paneBounds = paneElement.getBoundingClientRect();
    applyFileTreeWidth(paneBounds.right - event.clientX);
  }

  function endFileTreeResize(): void {
    document.removeEventListener("mousemove", resizeFileTree, true);
    document.removeEventListener("mouseup", endFileTreeResize, true);
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
    document.addEventListener("mousemove", resizeFileTree, true);
    document.addEventListener("mouseup", endFileTreeResize, true);
  });

  resizeHandleElement.addEventListener("keydown", (event) => {
    let requestedWidth = Math.round(treeElement.getBoundingClientRect().width);
    // the arrows move the handle, and the tree is the side to its right
    if (event.key === "ArrowLeft") {
      requestedWidth += FILE_TREE_KEYBOARD_RESIZE_STEP_PX;
    } else if (event.key === "ArrowRight") {
      requestedWidth -= FILE_TREE_KEYBOARD_RESIZE_STEP_PX;
    } else if (event.key === "Home") {
      requestedWidth = MIN_FILE_TREE_WIDTH_PX;
    } else if (event.key === "End") {
      requestedWidth = MAX_FILE_TREE_WIDTH_PX;
    } else {
      return;
    }
    event.preventDefault();
    applyFileTreeWidth(requestedWidth);
  });
}
