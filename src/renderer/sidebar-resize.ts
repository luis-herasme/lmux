// The sidebar's width is a setting, so a drag ends as one update-settings
// Command; the pixels moving under the cursor are a preview, the way a
// split's divider moves without announcing anything.
import { executeCommand, focusActiveTab } from "./tabs/index.ts";
import { MAX_SIDEBAR_WIDTH_PX, MIN_SIDEBAR_WIDTH_PX } from "./settings.ts";
import { requireElement } from "./dom.ts";

const resizer = requireElement("sidebar-resizer");

// set only once the pointer actually moves, so a click that resizes
// nothing issues no Command
let draggedWidth: number | undefined;

function resizeSidebar(event: MouseEvent): void {
  // the sidebar starts at the window's left edge, so the pointer's x is the
  // width it is asking for
  draggedWidth = Math.min(
    MAX_SIDEBAR_WIDTH_PX,
    Math.max(MIN_SIDEBAR_WIDTH_PX, Math.round(event.clientX)),
  );
  document.documentElement.style.setProperty(
    "--sidebar-width",
    `${draggedWidth}px`,
  );
}

function endResize(): void {
  document.removeEventListener("mousemove", resizeSidebar, true);
  document.removeEventListener("mouseup", endResize, true);
  document.body.classList.remove("resizing");
  resizer.classList.remove("dragging");
  if (draggedWidth === undefined) {
    return;
  }
  executeCommand({
    type: "update-settings",
    settings: { sidebarWidth: draggedWidth },
  });
  draggedWidth = undefined;
  focusActiveTab();
}

resizer.addEventListener("mousedown", (event) => {
  event.preventDefault();
  draggedWidth = undefined;
  resizer.classList.add("dragging");
  document.body.classList.add("resizing");
  // on the document, in the capture phase: the pointer spends the drag over
  // the terminal, and xterm handles mouse events on the way down
  document.addEventListener("mousemove", resizeSidebar, true);
  document.addEventListener("mouseup", endResize, true);
});
