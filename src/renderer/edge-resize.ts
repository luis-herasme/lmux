// A panel's width is a setting, so a drag ends as one update-settings
// Command; the pixels moving under the cursor are a preview, the way a
// split's divider moves without announcing anything.
import { executeCommand, focusWorkspace } from "./tabs/index.ts";
import {
  MAX_PROJECT_WIDTH_PX,
  MAX_SIDEBAR_WIDTH_PX,
  MIN_PROJECT_WIDTH_PX,
  MIN_SIDEBAR_WIDTH_PX,
} from "./settings.ts";
import { requireElement } from "./dom.ts";

type EdgeResizeOptions = {
  resizerId: string;
  // the window edge the panel is anchored to, which decides what width a
  // pointer position is asking for
  edge: "left" | "right";
  minWidthPx: number;
  maxWidthPx: number;
  cssVariable: string;
  settingsKey: "sidebarWidth" | "projectWidth";
  // for a handle that sits inside its own panel: grabbing the edge is not
  // the same as working in the panel, so the keyboard stays where it was
  stopMousedownPropagation: boolean;
};

function installEdgeResize(options: EdgeResizeOptions): void {
  const resizer = requireElement(options.resizerId);

  // set only once the pointer actually moves, so a click that resizes
  // nothing issues no Command
  let draggedWidth: number | undefined;

  function resize(event: MouseEvent): void {
    // a panel anchored left starts at the window's left edge, so the
    // pointer's x is the width; one anchored right runs to the opposite
    // edge, so what is left of the pointer is the width
    let requestedWidth = event.clientX;
    if (options.edge === "right") {
      requestedWidth = window.innerWidth - event.clientX;
    }
    draggedWidth = Math.min(
      options.maxWidthPx,
      Math.max(options.minWidthPx, Math.round(requestedWidth)),
    );
    document.documentElement.style.setProperty(
      options.cssVariable,
      `${draggedWidth}px`,
    );
  }

  function endResize(): void {
    document.removeEventListener("mousemove", resize, true);
    document.removeEventListener("mouseup", endResize, true);
    document.body.classList.remove("resizing");
    resizer.classList.remove("dragging");
    if (draggedWidth === undefined) {
      return;
    }
    executeCommand({
      type: "update-settings",
      settings: { [options.settingsKey]: draggedWidth },
    });
    draggedWidth = undefined;
    focusWorkspace();
  }

  resizer.addEventListener("mousedown", (event) => {
    event.preventDefault();
    if (options.stopMousedownPropagation) {
      event.stopPropagation();
    }
    draggedWidth = undefined;
    resizer.classList.add("dragging");
    document.body.classList.add("resizing");
    // on the document, in the capture phase: the pointer spends the drag
    // over the terminal or Monaco, both of which handle mouse events on the
    // way down
    document.addEventListener("mousemove", resize, true);
    document.addEventListener("mouseup", endResize, true);
  });
}

installEdgeResize({
  resizerId: "sidebar-resizer",
  edge: "left",
  minWidthPx: MIN_SIDEBAR_WIDTH_PX,
  maxWidthPx: MAX_SIDEBAR_WIDTH_PX,
  cssVariable: "--sidebar-width",
  settingsKey: "sidebarWidth",
  stopMousedownPropagation: false,
});

installEdgeResize({
  resizerId: "project-resizer",
  edge: "right",
  minWidthPx: MIN_PROJECT_WIDTH_PX,
  maxWidthPx: MAX_PROJECT_WIDTH_PX,
  cssVariable: "--project-width",
  settingsKey: "projectWidth",
  stopMousedownPropagation: true,
});
