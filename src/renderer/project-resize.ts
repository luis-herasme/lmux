// The project panel's width is a setting, so a drag ends as one
// update-settings Command; the pixels moving under the cursor are a
// preview, the way the sidebar's own handle works.
import { executeCommand, focusWorkspace } from "./tabs/index.ts";
import { MAX_PROJECT_WIDTH_PX, MIN_PROJECT_WIDTH_PX } from "./settings.ts";
import { requireElement } from "./dom.ts";

const resizer = requireElement("project-resizer");

// set only once the pointer actually moves, so a click that resizes
// nothing issues no Command
let draggedWidth: number | undefined;

function resizeProject(event: MouseEvent): void {
  // the panel runs to the window's right edge, so what is left of the
  // pointer is the width it is asking for
  draggedWidth = Math.min(
    MAX_PROJECT_WIDTH_PX,
    Math.max(
      MIN_PROJECT_WIDTH_PX,
      Math.round(window.innerWidth - event.clientX),
    ),
  );
  document.documentElement.style.setProperty(
    "--project-width",
    `${draggedWidth}px`,
  );
}

function endResize(): void {
  document.removeEventListener("mousemove", resizeProject, true);
  document.removeEventListener("mouseup", endResize, true);
  document.body.classList.remove("resizing");
  resizer.classList.remove("dragging");
  if (draggedWidth === undefined) {
    return;
  }
  executeCommand({
    type: "update-settings",
    settings: { projectWidth: draggedWidth },
  });
  draggedWidth = undefined;
  focusWorkspace();
}

resizer.addEventListener("mousedown", (event) => {
  event.preventDefault();
  // the handle sits inside the panel, and grabbing its edge is not the same
  // as working in it: the keyboard stays where it was
  event.stopPropagation();
  draggedWidth = undefined;
  resizer.classList.add("dragging");
  document.body.classList.add("resizing");
  // on the document, in the capture phase: the pointer spends the drag over
  // the terminal or Monaco, both of which handle mouse events themselves
  document.addEventListener("mousemove", resizeProject, true);
  document.addEventListener("mouseup", endResize, true);
});
