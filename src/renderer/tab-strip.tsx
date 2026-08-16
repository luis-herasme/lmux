// One tab's row in the strip: its title and the × that closes it. Every kind
// of tab wears the same one, and only the pane below it differs.
//
// Dockview hands a row over as an element, so each row is a React root of its
// own. The element carries the row's identity — the class the strip's
// double-click delegation looks for, and the id it reads off it — and React
// draws what is inside.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import { bridge } from "./bridge.ts";
import { executeCommand } from "./tabs/index.ts";

export type TabRow = {
  id: number;
  element: HTMLElement;
  root: Root;
};

type DrawTabRowOptions = {
  row: TabRow;
  title: string;
};

export function drawTabRow({ row, title }: DrawTabRowOptions): void {
  flushSync(() => {
    row.root.render(
      <>
        {/* shell-set titles can be long paths */}
        <span
          className="max-w-[160px] truncate"
          title="Double-click to fill the window"
        >
          {title}
        </span>
        {/* a button, not a span: it has to be reachable and pressable by
          keyboard */}
        <button
          className="cursor-pointer border-0 bg-transparent p-0 text-[length:inherit] leading-none text-inherit hover:text-tab-active"
          type="button"
          title="Close Tab (⌘W)"
          aria-label="Close tab"
          onClick={(event) => {
            event.stopPropagation();
            executeCommand({
              type: "close-tab",
              id: row.id,
            });
          }}
        >
          ×
        </button>
      </>,
    );
  });
}

type MountTabRowOptions = {
  id: number;
  title: string;
};

export function mountTabRow({ id, title }: MountTabRowOptions): TabRow {
  const element = document.createElement("div");
  element.className = "tab flex h-full items-center gap-1.5 font-ui";
  element.dataset.tabId = String(id);
  // the menu belongs to the whole row, so it stays on the element rather
  // than on either of the two things React draws inside it
  element.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    bridge.showTabMenu(id);
  });

  const row: TabRow = {
    id,
    element,
    root: createRoot(element),
  };
  drawTabRow({
    row,
    title,
  });
  return row;
}
