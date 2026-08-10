import { currentTheme, getSettings } from "../settings.ts";
import { bridge } from "../bridge.ts";
import { executeCommand } from "./index.ts";
import { registerFileLinks } from "./file-links.ts";
import {
  activeWorkspace,
  addPanel,
  snapshot,
} from "../workspaces.ts";
import type { Workspace } from "../workspaces.ts";
import type { TabElements } from "./index.ts";
import type { ScreenResult } from "../../api.ts";
import type { ITheme, Terminal as XtermTerminal } from "@xterm/xterm";
import type { FitAddon as XtermFitAddon } from "@xterm/addon-fit";
import type { DockviewGroupPanel, IDockviewPanel } from "dockview";

// xterm ships classic scripts, so its constructors arrive as page globals
// rather than as modules (see the script tags in index.html).
const Terminal: typeof XtermTerminal = Reflect.get(window, "Terminal");
const FitAddon: { FitAddon: typeof XtermFitAddon } = Reflect.get(
  window,
  "FitAddon",
);
if (!Terminal || !FitAddon) {
  throw new Error("xterm's scripts did not load: window.Terminal is missing");
}

export type TerminalTab = {
  kind: "terminal";
  panel: IDockviewPanel;
  titleElement: HTMLElement;
  titlePinned: boolean;
  terminal: XtermTerminal;
  observer: ResizeObserver;
  fitAddon: XtermFitAddon;
};

type OpenTerminalTabOptions = {
  workspace: Workspace;
  tabId: number;
  group: DockviewGroupPanel | undefined;
  tabElements: TabElements;
};

type RefreshTerminalTabSettingsOptions = {
  tab: TerminalTab;
  fit: boolean;
};

type ReadTerminalScreenOptions = {
  tab: TerminalTab;
  rows: number | undefined;
};

type TerminalScreenResult = Extract<ScreenResult, { kind: "terminal" }>;

function copyOnCommandC(event: KeyboardEvent): boolean {
  if (!activeWorkspace) {
    return true;
  }
  const tab = activeWorkspace.tabs.get(activeWorkspace.activeId);
  if (tab?.kind !== "terminal") {
    return true;
  }
  if (
    event.type === "keydown" &&
    event.metaKey &&
    event.key === "c" &&
    tab.terminal.hasSelection()
  ) {
    navigator.clipboard.writeText(tab.terminal.getSelection());
    return false;
  }
  return true;
}

function xtermTheme(): ITheme {
  const theme = currentTheme();
  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    selectionBackground: theme.selectionBackground,
  };
}

export function openTerminalTab({
  workspace,
  tabId,
  group,
  tabElements,
}: OpenTerminalTabOptions): void {
  const paneElement = document.createElement("div");
  paneElement.className = "terminal-pane";

  const panel = addPanel({
    workspace,
    id: tabId,
    component: "terminal",
    title: "Untitled",
    paneElement,
    tabElement: tabElements.tabElement,
    group,
  });

  const settings = getSettings();
  const terminal = new Terminal({
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    cursorBlink: true,
    theme: xtermTheme(),
  });
  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);

  // Any visible box change re-fits the terminal grid.
  const observer = new ResizeObserver(() => {
    if (paneElement.clientWidth === 0 || paneElement.clientHeight === 0) {
      return;
    }
    fitAddon.fit();
  });
  observer.observe(paneElement);

  workspace.tabs.set(tabId, {
    kind: "terminal",
    panel,
    terminal,
    titleElement: tabElements.titleElement,
    titlePinned: false,
    observer,
    fitAddon,
  });
  bridge.emitEvent({
    type: "tab-opened",
    id: tabId,
    state: snapshot(),
  });

  // xterm can only measure a visible container.
  panel.api.setActive();
  terminal.open(paneElement);
  fitAddon.fit();
  terminal.focus();

  bridge.spawnShell({
    id: tabId,
    cols: terminal.cols,
    rows: terminal.rows,
  });

  terminal.onData((data) => {
    bridge.writeToShell({
      id: tabId,
      data,
    });
  });
  terminal.onResize(({ cols: columns, rows }) => {
    bridge.resizeShell({
      id: tabId,
      cols: columns,
      rows,
    });
  });
  terminal.attachCustomKeyEventHandler(copyOnCommandC);

  terminal.onTitleChange((title) => {
    executeCommand({
      type: "set-tab-title",
      id: tabId,
      title,
      transient: true,
    });
  });

  registerFileLinks({
    terminal,
    openPath: ({ path, kind }) => {
      if (kind === "markdown") {
        executeCommand({
          type: "open-markdown",
          path,
          baseTabId: tabId,
        });
        return;
      }
      executeCommand({
        type: "open-file",
        path,
        baseTabId: tabId,
      });
    },
  });
}

export function refreshTerminalTabSettings({
  tab,
  fit,
}: RefreshTerminalTabSettingsOptions): void {
  const settings = getSettings();
  tab.terminal.options.fontFamily = settings.fontFamily;
  tab.terminal.options.fontSize = settings.fontSize;
  tab.terminal.options.theme = xtermTheme();
  if (!fit) {
    return;
  }
  tab.fitAddon.fit();
}

export function readTerminalScreen({
  tab,
  rows,
}: ReadTerminalScreenOptions): TerminalScreenResult {
  const buffer = tab.terminal.buffer.active;
  let rowCount = tab.terminal.rows;
  if (rows !== undefined) {
    rowCount = rows;
  }

  // Read from the bottom of the buffer, not the visible viewport.
  let top = buffer.length - rowCount;
  if (top < 0) {
    top = 0;
  }

  const lines: string[] = [];
  for (let row = top; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (line === undefined) {
      continue;
    }
    const next = buffer.getLine(row + 1);
    let continues = false;
    if (next !== undefined && next.isWrapped) {
      continues = true;
    }
    const text = line.translateToString(!continues);
    const previous = lines.at(-1);
    if (line.isWrapped && previous !== undefined) {
      lines[lines.length - 1] = previous + text;
      continue;
    }
    lines.push(text);
  }
  while (lines.at(-1) === "") {
    lines.pop();
  }
  return {
    kind: "terminal",
    lines,
    alternate: buffer.type === "alternate",
  };
}
