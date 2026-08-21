// The page's fixed elements are in index.html; a missing id is a build mistake.
export function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`#${id} is missing from index.html`);
  }
  return element;
}

type DragSessionOptions = {
  handleElement: HTMLElement;
  // grabbing a handle inside a focusable region must not move the keyboard
  // into it
  stopMousedownPropagation: boolean;
  // body.resizing turns off pointer events over the panes for the drag
  markBodyResizing: boolean;
  onDragStart?: (event: MouseEvent) => void;
  onDragMove: (event: MouseEvent) => void;
  onDragEnd?: () => void;
};

// One left-button drag: mousedown marks the handle (and optionally the body)
// as dragging, mouseup unmarks both and ends the session.
export function installDragSession(options: DragSessionOptions): void {
  options.handleElement.addEventListener("mousedown", (mousedownEvent) => {
    if (mousedownEvent.button !== 0) {
      return;
    }
    // no text selection under the cursor for the length of the drag
    mousedownEvent.preventDefault();
    if (options.stopMousedownPropagation) {
      mousedownEvent.stopPropagation();
    }
    options.handleElement.classList.add("dragging");
    if (options.markBodyResizing) {
      document.body.classList.add("resizing");
    }
    if (options.onDragStart !== undefined) {
      options.onDragStart(mousedownEvent);
    }

    function endDrag(): void {
      document.removeEventListener("mousemove", options.onDragMove, true);
      document.removeEventListener("mouseup", endDrag, true);
      options.handleElement.classList.remove("dragging");
      if (options.markBodyResizing) {
        document.body.classList.remove("resizing");
      }
      if (options.onDragEnd !== undefined) {
        options.onDragEnd();
      }
    }

    // on the document, in the capture phase: the pointer spends the drag
    // over the terminal or Monaco, which handle mouse events on the way down
    document.addEventListener("mousemove", options.onDragMove, true);
    document.addEventListener("mouseup", endDrag, true);
  });
}
