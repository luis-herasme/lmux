import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { currentTheme, getSettings } from "../settings.ts";
import { bridge } from "../bridge.ts";
import { executeCommand, installTab } from "./index.ts";
import { registerTerminalLinks } from "./terminal-links.ts";
import { activeWorkspace, addPanel, findTab, nextTabId } from "../workspaces.ts";
import type { Workspace } from "../workspaces.ts";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { DockviewGroupPanel, IDockviewPanel } from "dockview";
import type { IDockviewPanelProps } from "dockview-react";

export type TerminalTab = {
  kind: "terminal";
  panel: IDockviewPanel;
  title: string;
  titlePinned: boolean;
  terminal: Terminal;
  observer: ResizeObserver;
  fitAddon: FitAddon;
};

type OpenTerminalTabOptions = {
  workspace: Workspace;
  group?: DockviewGroupPanel; // the active group when none is named
};

type RefreshTerminalTabSettingsOptions = {
  tab: TerminalTab;
  fit: boolean;
};

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

// The pane a terminal tab shows. xterm owns everything inside it, so React
// renders the box and hands it over: this is the first moment there is one,
// and xterm can only measure a container that is on screen. Fitting resizes
// the terminal, which tells the shell its real size.
export function TerminalPane({ api }: IDockviewPanelProps): ReactNode {
  const hostElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostElement.current;
    const found = findTab(Number(api.id));
    if (host === null || found === undefined || found.tab.kind !== "terminal") {
      return;
    }
    const { terminal, observer, fitAddon } = found.tab;
    observer.observe(host);
    terminal.open(host);
    fitAddon.fit();
    terminal.focus();
  }, [api]);

  return <div className="terminal-pane h-full" ref={hostElement} />;
}

// Everything a terminal tab needs, from its id to the shell behind it;
// openMarkdownTab has the same shape.
export function openTerminalTab({
  workspace,
  group,
}: OpenTerminalTabOptions): void {
  const tabId = nextTabId();
  const title = "Untitled";
  const settings = getSettings();
  const terminal = new Terminal({
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    cursorBlink: true,
    theme: xtermTheme(),
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  // a hidden workspace's pane measures zero, and fitting to that would resize
  // the shell to nothing
  const observer = new ResizeObserver((entries) => {
    const box = entries[0].contentRect;
    if (box.width === 0 || box.height === 0) {
      return;
    }
    fitAddon.fit();
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

  registerTerminalLinks({
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

  const panel = addPanel({
    workspace,
    id: tabId,
    component: "terminal",
    title,
    group,
  });
  installTab({
    workspace,
    id: tabId,
    tab: {
      kind: "terminal",
      panel,
      terminal,
      title,
      titlePinned: false,
      observer,
      fitAddon,
    },
  });
  // Last, because spawning a login shell blocks main while it forks: anything
  // sent after it waits behind it.
  bridge.spawnShell({
    id: tabId,
    cols: terminal.cols,
    rows: terminal.rows,
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
