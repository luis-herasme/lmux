// Everything a Markdown tab does: its pane, modes, reload and links.
//
// React draws the pane, the toolbar's two buttons and the box the document
// scrolls in, from what the tab holds. The document inside that box is not
// React's: markdown-it and mermaid build it (markdown-renderer.ts), and the
// pane hosts it the way the editor hosts Monaco.
import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { bridge } from "../bridge.ts";
import { renderMarkdown } from "./markdown-renderer.ts";
import { executeCommand } from "./index.ts";
import { snapshot } from "../snapshot.ts";
import { addPanel, findTab, nextTabId } from "../workspaces.ts";
import { drawPanes } from "../panes.tsx";
import type { Workspace } from "../workspaces.ts";
import type { MarkdownMode } from "../../api.ts";
import type { ReadFileResult } from "../../inter-process-communication/bridge.ts";
import type { DockviewGroupPanel, IDockviewPanel } from "dockview";
import type { IDockviewPanelProps } from "dockview-react";

export type MarkdownTab = {
  kind: "markdown";
  panel: IDockviewPanel;
  title: string;
  titlePinned: boolean;
  // the document's box, handed over by the pane when it draws
  contentElement: HTMLDivElement | undefined;
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

// A panel's parameters are how a tab whose state lives outside React asks its
// pane to be drawn again, so the mode rides in them rather than being read off
// the record.
type MarkdownPaneParameters = {
  mode: MarkdownMode;
};

export function MarkdownPane({
  api,
  params,
}: IDockviewPanelProps<MarkdownPaneParameters>): ReactNode {
  const contentElement = useRef<HTMLDivElement>(null);
  const id = Number(api.id);

  // The box this render left is where the document goes, and where the rest of
  // the app reaches for it. Reading a document is what opens it, so it takes
  // the keyboard too.
  useEffect(() => {
    const box = contentElement.current;
    const found = findTab(id);
    if (box === null || found === undefined || found.tab.kind !== "markdown") {
      return;
    }
    found.tab.contentElement = box;
    fillDocument(found.tab);
    box.focus();
  }, [id]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex flex-none justify-end gap-1 px-2.5 pt-1.5">
        {/* the button names the mode it would switch to, like a play button */}
        <button
          className={MARKDOWN_ACTION_CLASS}
          type="button"
          title="Show the file's source, or its rendering"
          onClick={() => {
            executeCommand({
              type: "set-markdown-mode",
              id,
              mode: params.mode === "raw" ? "rendered" : "raw",
            });
          }}
        >
          {params.mode === "raw" ? "Rendered" : "Raw"}
        </button>
        <button
          className={MARKDOWN_ACTION_CLASS}
          type="button"
          title="Read the file again"
          onClick={() => {
            executeCommand({
              type: "reload-markdown",
              id,
            });
          }}
        >
          Reload
        </button>
      </div>
      <div
        className="markdown-scroll min-h-0 flex-1 overflow-auto outline-none"
        tabIndex={-1}
        ref={contentElement}
        onClick={(event) => {
          openDocumentLink({
            id,
            event: event.nativeEvent,
          });
        }}
      />
    </div>
  );
}

// The document itself, put into the box the pane left behind. The returned
// promise settles once any diagrams have landed too, so a caller can measure
// the finished document.
async function fillDocument(tab: MarkdownTab): Promise<void> {
  const contentElement = tab.contentElement;
  if (contentElement === undefined) {
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
  const contentElement = tab.contentElement;
  const scrollTop = contentElement?.scrollTop ?? 0;
  await fillDocument(tab);
  if (contentElement !== undefined) {
    contentElement.scrollTop = scrollTop;
  }
}

// scheme-carrying links (http:, mailto:, file:) are left to main, which
// cancels the navigation and decides what may reach the OS
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

type DocumentLinkOptions = {
  id: number;
  event: MouseEvent;
};

// A link inside a document: a relative *.md opens as a tab, resolved
// against the document holding the link. Nothing else is followed.
function openDocumentLink({ id, event }: DocumentLinkOptions): void {
  const found = findTab(id);
  if (found === undefined || found.tab.kind !== "markdown") {
    return;
  }
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
  const filePath = found.tab.filePath;
  const directory = filePath.slice(0, filePath.lastIndexOf("/") + 1);
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

  let resolvedPath = filePath;
  if (!("error" in result)) {
    resolvedPath = result.resolvedPath;
  }
  // the renderer has no node:path; a document's name is its last segment
  const title = resolvedPath.slice(resolvedPath.lastIndexOf("/") + 1);
  const mode: MarkdownMode = "rendered";

  const panel = addPanel({
    workspace,
    id,
    component: "markdown",
    title,
    parameters: { mode },
    group,
  });

  workspace.tabs.set(id, {
    kind: "markdown",
    panel,
    title,
    titlePinned: true,
    contentElement: undefined,
    filePath: resolvedPath,
    baseTabId,
    mode,
    markdown: markdownText({
      result,
      filePath,
    }),
  });
  // the draw reads the document into the pane, and comes before the Event so
  // the page it describes is the page that is there
  drawPanes();
  bridge.emitEvent({
    type: "tab-opened",
    id,
    state: snapshot(),
  });
  panel.api.setActive();
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
  // the toolbar's button names the mode it would switch to, so the pane is
  // redrawn before the document goes back into it
  flushSync(() => {
    tab.panel.api.updateParameters({ mode });
  });
  fillDocument(tab);
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
