// Everything a Markdown tab does: its pane, modes, reload and links.
import { bridge } from "../bridge.ts";
import { renderMarkdown } from "./markdown.ts";
import { executeCommand } from "./index.ts";
import { addPanel, nextTabId, snapshot } from "../workspaces.ts";
import type { Workspace } from "../workspaces.ts";
import type { MarkdownMode } from "../../api.ts";
import type { ReadFileResult } from "../../ipc/bridge.ts";
import type { DockviewGroupPanel, IDockviewPanel } from "dockview";

export type MarkdownTab = {
  kind: "markdown";
  panel: IDockviewPanel;
  titleElement: HTMLElement;
  titlePinned: boolean;
  element: HTMLElement;
  contentElement: HTMLElement;
  modeButton: HTMLElement;
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

// The text lands synchronously; the returned promise settles once any
// diagrams have too, so a caller can measure the finished document.
async function showMarkdown(tab: MarkdownTab): Promise<void> {
  if (tab.mode === "raw") {
    // the file as it is on disk, in the terminal's font
    const source = document.createElement("pre");
    source.className =
      "m-0 px-(--reading-inset) py-[18px] font-terminal text-[13px] leading-[1.5] wrap-anywhere whitespace-pre-wrap text-tab-active";
    source.textContent = tab.markdown;
    tab.modeButton.textContent = "Rendered";
    tab.contentElement.replaceChildren(source);
    return;
  }
  const { view, ready } = renderMarkdown(tab.markdown);
  tab.modeButton.textContent = "Raw";
  tab.contentElement.replaceChildren(view);
  await ready;
}

// Redraw in place: the restore waits for the diagrams, or the document is
// still short and the browser clamps the position being restored.
export async function redrawMarkdown(tab: MarkdownTab): Promise<void> {
  const scrollTop = tab.contentElement.scrollTop;
  await showMarkdown(tab);
  tab.contentElement.scrollTop = scrollTop;
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

type MarkdownPane = {
  paneElement: HTMLElement;
  contentElement: HTMLElement;
  modeButton: HTMLElement;
};

// shared with the project panel's copy of this toolbar
export const MARKDOWN_ACTION_CLASS =
  "markdown-action cursor-pointer rounded border-0 bg-transparent px-[7px] py-[2px] text-[11px] text-tab hover:bg-tab-bar hover:text-tab-active";

// Built before the tab record exists, so only the affordances that need
// nothing but the id are wired here; attachPaneHandlers does the rest.
function buildMarkdownPane(id: number): MarkdownPane {
  const modeButton = document.createElement("button");
  modeButton.className = MARKDOWN_ACTION_CLASS;
  modeButton.title = "Show the file's source, or its rendering";

  const reloadButton = document.createElement("button");
  reloadButton.className = MARKDOWN_ACTION_CLASS;
  reloadButton.textContent = "Reload";
  reloadButton.title = "Read the file again";
  reloadButton.addEventListener("click", () => {
    executeCommand({
      type: "reload-markdown",
      id,
    });
  });

  const toolbar = document.createElement("div");
  toolbar.className = "flex flex-none justify-end gap-1 px-2.5 pt-1.5";
  toolbar.append(modeButton, reloadButton);

  const contentElement = document.createElement("div");
  contentElement.className =
    "markdown-scroll min-h-0 flex-1 overflow-auto outline-none";
  contentElement.tabIndex = -1;

  const paneElement = document.createElement("div");
  paneElement.className = "flex h-full flex-col bg-background";
  paneElement.append(toolbar, contentElement);

  return {
    paneElement,
    contentElement,
    modeButton,
  };
}

type AttachPaneHandlersOptions = {
  id: number;
  tab: MarkdownTab;
};

// The affordances that need the tab record itself.
function attachPaneHandlers({ id, tab }: AttachPaneHandlersOptions): void {
  tab.modeButton.addEventListener("click", () => {
    let mode: MarkdownMode = "raw";
    if (tab.mode === "raw") {
      mode = "rendered";
    }
    executeCommand({
      type: "set-markdown-mode",
      id,
      mode,
    });
  });

  tab.contentElement.addEventListener("click", (event) => {
    openDocumentLink({
      tab,
      event,
    });
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
  const pane = buildMarkdownPane(id);

  let resolvedPath = filePath;
  if (!("error" in result)) {
    resolvedPath = result.resolvedPath;
  }
  // the renderer has no node:path; a document's name is its last segment
  const title = resolvedPath.slice(resolvedPath.lastIndexOf("/") + 1);

  const { panel, titleElement } = addPanel({
    workspace,
    id,
    component: "markdown",
    title,
    paneElement: pane.paneElement,
    group,
  });

  const tab: MarkdownTab = {
    kind: "markdown",
    panel,
    titleElement,
    titlePinned: true,
    element: pane.paneElement,
    contentElement: pane.contentElement,
    modeButton: pane.modeButton,
    filePath: resolvedPath,
    baseTabId,
    mode: "rendered",
    markdown: markdownText({
      result,
      filePath,
    }),
  };
  attachPaneHandlers({
    id,
    tab,
  });
  showMarkdown(tab);

  workspace.tabs.set(id, tab);
  bridge.emitEvent({
    type: "tab-opened",
    id,
    state: snapshot(),
  });
  tab.panel.api.setActive();
  tab.contentElement.focus();
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
