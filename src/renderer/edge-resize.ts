// A panel's width is a setting, so a drag ends as one update-settings
// Command; the pixels moving under the cursor until then are a preview.
import { executeCommand } from "./tabs/index.ts";
import { focusWorkspace } from "./workspaces.ts";
import {
  MAX_PROJECT_WIDTH_PX,
  MAX_SIDEBAR_WIDTH_PX,
  MIN_PROJECT_WIDTH_PX,
  MIN_SIDEBAR_WIDTH_PX,
} from "./settings.ts";
import { requireElement } from "./dom.ts";

type EdgeResizeOptions = {
  resizerId: string;
  requestedWidth: (event: MouseEvent) => number;
  minWidthPx: number;
  maxWidthPx: number;
  cssVariable: string;
  commitWidth: (width: number) => void;
  // grabbing a handle inside its own panel must not move the keyboard into it
  stopMousedownPropagation: boolean;
};

function installEdgeResize(options: EdgeResizeOptions): void {
  const resizer = requireElement(options.resizerId);

  resizer.addEventListener("mousedown", (mousedownEvent) => {
    mousedownEvent.preventDefault();
    if (options.stopMousedownPropagation) {
      mousedownEvent.stopPropagation();
    }
    resizer.classList.add("dragging");
    document.body.classList.add("resizing");

    // stays undefined until the pointer moves, so a click that resizes
    // nothing issues no Command
    let draggedWidth: number | undefined;

    function resize(event: MouseEvent): void {
      draggedWidth = Math.min(
        options.maxWidthPx,
        Math.max(options.minWidthPx, Math.round(options.requestedWidth(event))),
      );
      document.documentElement.style.setProperty(
        options.cssVariable,
        `${draggedWidth}px`,
      );
    }

    function endResize(): void {
      document.removeEventListener("mousemove", resize, true);
      document.removeEventListener("mouseup", endResize, true);
      resizer.classList.remove("dragging");
      document.body.classList.remove("resizing");
      if (draggedWidth === undefined) {
        return;
      }
      options.commitWidth(draggedWidth);
      focusWorkspace();
    }

    // on the document, in the capture phase: the pointer spends the drag
    // over the terminal or Monaco, which handle mouse events on the way down
    document.addEventListener("mousemove", resize, true);
    document.addEventListener("mouseup", endResize, true);
  });
}

installEdgeResize({
  resizerId: "sidebar-resizer",
  // the sidebar starts at the window's left edge
  requestedWidth: (event) => event.clientX,
  minWidthPx: MIN_SIDEBAR_WIDTH_PX,
  maxWidthPx: MAX_SIDEBAR_WIDTH_PX,
  cssVariable: "--sidebar-width",
  commitWidth: (width) =>
    executeCommand({
      type: "update-settings",
      settings: { sidebarWidth: width },
    }),
  stopMousedownPropagation: false,
});

installEdgeResize({
  resizerId: "project-resizer",
  // the panel runs to the window's right edge
  requestedWidth: (event) => window.innerWidth - event.clientX,
  minWidthPx: MIN_PROJECT_WIDTH_PX,
  maxWidthPx: MAX_PROJECT_WIDTH_PX,
  cssVariable: "--project-width",
  commitWidth: (width) =>
    executeCommand({
      type: "update-settings",
      settings: { projectWidth: width },
    }),
  stopMousedownPropagation: true,
});
