// Everything a code tab does: its pane, the editor inside it, and the file
// it shows. The tab record itself, and the store holding it, stay in
// tabs.ts — the same division markdown-tab.ts follows.
import { bridge } from "./bridge.ts";
import { createCodeEditor, loadMonaco } from "./code.ts";
import type { CodeTab, TabElements } from "./tabs.ts";
import { addPanel } from "./workspaces.ts";
import type { Workspace } from "./workspaces.ts";
import type { ReadFileResult } from "../ipc/bridge.ts";
import type { DockviewGroupPanel } from "dockview";

type CodePane = {
  paneElement: HTMLElement;
  contentElement: HTMLElement;
};

function buildCodePane(): CodePane {
  // Monaco measures and positions inside whatever it is given, and expects
  // to own it: nothing else goes in this element.
  const contentElement = document.createElement("div");
  contentElement.className = "code-editor";

  const paneElement = document.createElement("div");
  paneElement.className = "code-pane";
  paneElement.append(contentElement);

  return {
    paneElement,
    contentElement,
  };
}

// A file that could not be read still gets a tab, so the path you asked for
// is on screen with the reason beside it rather than vanishing.
function showReadError({
  contentElement,
  filePath,
  message,
}: {
  contentElement: HTMLElement;
  filePath: string;
  message: string;
}): void {
  const heading = document.createElement("strong");
  heading.textContent = `Could not open ${filePath}`;
  const detail = document.createElement("span");
  detail.textContent = message;
  const error = document.createElement("div");
  error.className = "code-error";
  error.append(heading, detail);
  contentElement.append(error);
}

type OpenCodeTabOptions = {
  id: number;
  workspace: Workspace;
  tabElements: TabElements;
  filePath: string;
  baseTabId: number | undefined;
  group: DockviewGroupPanel | undefined;
};

// Reads the file and builds the tab; the caller owns the store, so putting
// it there, announcing it and activating it stay on that side.
export async function openCodeTab({
  id,
  workspace,
  tabElements,
  filePath,
  baseTabId,
  group,
}: OpenCodeTabOptions): Promise<CodeTab> {
  // Both are slow and neither needs the other: the first code tab of a
  // session pays for a 4MB bundle, and paying for it after the disk read
  // rather than beside it would be twice the wait for no reason.
  const [result, monaco] = await Promise.all([
    bridge.readFile({
      path: filePath,
      baseTabId,
    }),
    loadMonaco(),
  ]);
  const pane = buildCodePane();

  let resolvedPath = filePath;
  if (!("error" in result)) {
    resolvedPath = result.resolvedPath;
  }
  // the renderer has no node:path; a file's name is its last segment
  const title = resolvedPath.slice(resolvedPath.lastIndexOf("/") + 1);
  tabElements.titleElement.textContent = title;

  const panel = addPanel({
    workspace,
    id,
    component: "code",
    title,
    paneElement: pane.paneElement,
    tabElement: tabElements.tabElement,
    group,
  });

  // Built after addPanel, so the container is in the document. Monaco
  // measures a hidden or zero-sized panel as it finds it and corrects
  // itself through automaticLayout when the panel is shown.
  let editor: CodeTab["editor"];
  if ("error" in result) {
    showReadError({
      contentElement: pane.contentElement,
      filePath,
      message: result.error,
    });
  } else {
    editor = createCodeEditor({
      monaco,
      container: pane.contentElement,
      content: result.content,
      filePath: resolvedPath,
    });
  }

  return {
    kind: "code",
    panel,
    titleElement: tabElements.titleElement,
    titlePinned: true,
    element: pane.paneElement,
    contentElement: pane.contentElement,
    filePath: resolvedPath,
    baseTabId,
    editor,
  };
}

// Monaco holds a model, a DOM subtree and listeners of its own; dropping the
// panel would leave all of it behind.
export function disposeCodeTab(tab: CodeTab): void {
  if (tab.editor === undefined) {
    return;
  }
  tab.editor.getModel()?.dispose();
  tab.editor.dispose();
}
