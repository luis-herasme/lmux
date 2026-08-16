// Everything a Markdown tab does: its pane, modes, reload and links.
//
// React draws the pane — the toolbar's two buttons and the box the document
// scrolls in — from what the tab holds. The document inside that box is not
// React's: markdown-it and mermaid build it (markdown.ts), and the pane
// hosts it the way the editor hosts Monaco.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createRef } from "react";
import type { ReactNode, RefObject } from "react";
import type { Root } from "react-dom/client";
import { bridge } from "../bridge.ts";
import { renderMarkdown } from "./markdown-renderer.ts";
import { executeCommand } from "./index.ts";
import { snapshot } from "../snapshot.ts";
import { addPanel, nextTabId } from "../workspaces.ts";
import type { TabRow } from "../tab-strip.tsx";
import type { Workspace } from "../workspaces.ts";
import type { MarkdownMode } from "../../api.ts";
import type { ReadFileResult } from "../../inter-process-communication/bridge.ts";
import type { DockviewGroupPanel, IDockviewPanel } from "dockview";

export type MarkdownTab = {
  kind: "markdown";
  panel: IDockviewPanel;
  row: TabRow; // its row in the strip
  title: string;
  titlePinned: boolean;
  root: Root; // over the pane host Dockview was handed
  contentElement: RefObject<HTMLDivElement | null>; // the document's box
  filePath: string;
  baseTabId: number | undefined;
  mode: MarkdownMode;
  markdown: string;
};

type MarkdownTextOptions = {
  result: ReadFileResult;
  filePath: string;
};

// A failed read is shown as a document of its own, so the tab (and its
// reload button) survive a path that isn't there yet.
function markdownText({ result, filePath }: MarkdownTextOptions): string {
  if ("error" in result) {
    return `# Could not open\n\n\`${filePath}\`\n\n${result.error}`;
  }
  return result.content;
}

// shared with the editor's copy of this toolbar
export const MARKDOWN_ACTION_CLASS =
  "markdown-action cursor-pointer rounded border-0 bg-transparent px-[7px] py-[2px] text-[11px] text-tab hover:bg-tab-bar hover:text-tab-active";

type MarkdownPaneProps = {
  tab: MarkdownTab;
};

function MarkdownPane({ tab }: MarkdownPaneProps): ReactNode {
  return (
    <>
      <div className="flex flex-none justify-end gap-1 px-2.5 pt-1.5">
        {/* the button names the mode it would switch to, like a play button */}
        <button
          className={MARKDOWN_ACTION_CLASS}
          type="button"
          title="Show the file's source, or its rendering"
          onClick={() => {
            executeCommand({
              type: "set-markdown-mode",
              id: tab.row.id,
              mode: tab.mode === "raw" ? "rendered" : "raw",
            });
          }}
        >
          {tab.mode === "raw" ? "Rendered" : "Raw"}
        </button>
        <button
          className={MARKDOWN_ACTION_CLASS}
          type="button"
          title="Read the file again"
          onClick={() => {
            executeCommand({
              type: "reload-markdown",
              id: tab.row.id,
            });
          }}
        >
          Reload
        </button>
      </div>
      <div
        className="markdown-scroll min-h-0 flex-1 overflow-auto outline-none"
        tabIndex={-1}
        ref={tab.contentElement}
        onClick={(event) => {
          openDocumentLink({
            tab,
            event: event.nativeEvent,
          });
        }}
      />
    </>
  );
}

// The pane is drawn synchronously, because the text goes straight into the
// box that render leaves behind; the returned promise settles once any
// diagrams have landed too, so a caller can measure the finished document.
async function showMarkdown(tab: MarkdownTab): Promise<void> {
  flushSync(() => {
    tab.root.render(<MarkdownPane tab={tab} />);
  });
  const contentElement = tab.contentElement.current;
  if (contentElement === null) {
    return;
  }
  if (tab.mode === "raw") {
    // the file as it is on disk, in the terminal's font
    const source = document.createElement("pre");
    source.className =
      "m-0 px-(--reading-inset) py-[18px] font-terminal text-[13px] leading-[1.5] wrap-anywhere whitespace-pre-wrap text-tab-active";
    source.textContent = tab.markdown;
    contentElement.replaceChildren(source);
    return;
  }
  const { view, ready } = renderMarkdown(tab.markdown);
  contentElement.replaceChildren(view);
  await ready;
}

// Redraw in place: the restore waits for the diagrams, or the document is
// still short and the browser clamps the position being restored.
export async function redrawMarkdown(tab: MarkdownTab): Promise<void> {
  const contentElement = tab.contentElement.current;
  const scrollTop = contentElement?.scrollTop ?? 0;
  await showMarkdown(tab);
  if (contentElement !== null) {
    contentElement.scrollTop = scrollTop;
  }
}

// scheme-carrying links (http:, mailto:, file:) are left to main, which
// cancels the navigation and decides what may reach the OS
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

type DocumentLinkOptions = {
  tab: MarkdownTab;
  event: MouseEvent;
};

// A link inside a document: a relative *.md opens as a tab, resolved
// against the document holding the link. Nothing else is followed.
function openDocumentLink({ tab, event }: DocumentLinkOptions): void {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const anchor = target.closest("a");
  if (anchor === null) {
    return;
  }
  const href = anchor.getAttribute("href");
  if (href === null || URL_SCHEME_PATTERN.test(href)) {
    return;
  }
  // ours to handle, and none of it may navigate
  event.preventDefault();
  const linkPath = href.split("#")[0];
  if (!linkPath.toLowerCase().endsWith(".md")) {
    return;
  }
  // relative to the document holding the link; the renderer has no node:path
  const directory = tab.filePath.slice(0, tab.filePath.lastIndexOf("/") + 1);
  executeCommand({
    type: "open-markdown",
    path: directory + linkPath,
  });
}

type OpenMarkdownTabOptions = {
  workspace: Workspace;
  filePath: string;
  baseTabId?: number; // the tab a relative path is resolved against
  group?: DockviewGroupPanel; // the active group when none is named
};

// Reads the file and opens the tab on it. The promise settles once the
// document is in the store, so restoring several keeps them in order.
export async function openMarkdownTab({
  workspace,
  filePath,
  baseTabId,
  group,
}: OpenMarkdownTabOptions): Promise<void> {
  const id = nextTabId();
  const result = await bridge.readFile({
    path: filePath,
    baseTabId,
  });

  // the host Dockview is handed; React draws the toolbar and the box inside
  const paneElement = document.createElement("div");
  paneElement.className = "flex h-full flex-col bg-background";

  let resolvedPath = filePath;
  if (!("error" in result)) {
    resolvedPath = result.resolvedPath;
  }
  // the renderer has no node:path; a document's name is its last segment
  const title = resolvedPath.slice(resolvedPath.lastIndexOf("/") + 1);

  const { panel, row } = addPanel({
    workspace,
    id,
    component: "markdown",
    title,
    paneElement,
    group,
  });

  const tab: MarkdownTab = {
    kind: "markdown",
    panel,
    row,
    title,
    titlePinned: true,
    root: createRoot(paneElement),
    contentElement: createRef(),
    filePath: resolvedPath,
    baseTabId,
    mode: "rendered",
    markdown: markdownText({
      result,
      filePath,
    }),
  };
  showMarkdown(tab);

  workspace.tabs.set(id, tab);
  bridge.emitEvent({
    type: "tab-opened",
    id,
    state: snapshot(),
  });
  tab.panel.api.setActive();
  tab.contentElement.current?.focus();
}

type SetMarkdownModeOptions = {
  id: number;
  tab: MarkdownTab;
  mode: MarkdownMode;
};

export function setMarkdownMode({
  id,
  tab,
  mode,
}: SetMarkdownModeOptions): void {
  if (tab.mode === mode) {
    return;
  }
  tab.mode = mode;
  showMarkdown(tab);
  bridge.emitEvent({
    type: "markdown-mode-changed",
    id,
    state: snapshot(),
  });
}

type ReloadMarkdownTabOptions = {
  id: number;
  tab: MarkdownTab;
};

export async function reloadMarkdownTab({
  id,
  tab,
}: ReloadMarkdownTabOptions): Promise<void> {
  const result = await bridge.readFile({
    path: tab.filePath,
    baseTabId: tab.baseTabId,
  });
  tab.markdown = markdownText({
    result,
    filePath: tab.filePath,
  });
  // an edit shouldn't cost you your place in a long document
  await redrawMarkdown(tab);
  bridge.emitEvent({
    type: "markdown-reloaded",
    id,
    state: snapshot(),
  });
}
