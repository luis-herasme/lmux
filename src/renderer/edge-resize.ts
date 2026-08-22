// A region's width is a setting, so a drag ends as one update-settings
// Command; the pixels moving under the cursor until then are a preview.
import { executeCommand } from "./tabs/index.ts";
import { focusWorkspace } from "./workspaces.ts";
import {
  MAX_EDITOR_WIDTH_PX,
  MAX_SIDEBAR_WIDTH_PX,
  MIN_EDITOR_WIDTH_PX,
  MIN_SIDEBAR_WIDTH_PX,
} from "./settings.ts";
import { installDragSession, requireElement } from "./dom.ts";

type EdgeResizeOptions = {
  resizerId: string;
  requestedWidth: (event: MouseEvent) => number;
  minWidthPx: number;
  maxWidthPx: number;
  cssVariable: string;
  commitWidth: (width: number) => void;
  stopMousedownPropagation: boolean;
};

function installEdgeResize(options: EdgeResizeOptions): void {
  // stays undefined until the pointer moves, so a click that resizes
  // nothing issues no Command
  let draggedWidth: number | undefined;

  installDragSession({
    handleElement: requireElement(options.resizerId),
    stopMousedownPropagation: options.stopMousedownPropagation,
    markBodyResizing: true,
    onDragStart: () => {
      draggedWidth = undefined;
    },
    onDragMove: (event) => {
      draggedWidth = Math.min(
        options.maxWidthPx,
        Math.max(options.minWidthPx, Math.round(options.requestedWidth(event))),
      );
      document.documentElement.style.setProperty(
        options.cssVariable,
        `${draggedWidth}px`,
      );
    },
    onDragEnd: () => {
      if (draggedWidth === undefined) {
        return;
      }
      options.commitWidth(draggedWidth);
      focusWorkspace();
    },
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
  resizerId: "editor-resizer",
  // the editor runs to the window's right edge
  requestedWidth: (event) => window.innerWidth - event.clientX,
  minWidthPx: MIN_EDITOR_WIDTH_PX,
  maxWidthPx: MAX_EDITOR_WIDTH_PX,
  cssVariable: "--editor-width",
  commitWidth: (width) =>
    executeCommand({
      type: "update-settings",
      settings: { editorWidth: width },
    }),
  stopMousedownPropagation: true,
});
