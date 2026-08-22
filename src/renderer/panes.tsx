// The pane area: one Dockview per workspace, only the active one displayed.
// Like the sidebar (chrome.tsx), it is a view of the workspace store, so every
// change out there ends in drawPanes(). Every piece Dockview lets us supply, a
// pane, the row a tab wears, the strip's + button, is a React component it
// renders into an element of its own.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { DockviewReact, themeDark } from "dockview-react";
import type {
  IDockviewHeaderActionsProps,
  IDockviewPanelHeaderProps,
} from "dockview-react";
import "dockview/dist/styles/dockview.css";
import { requireElement } from "./dom.ts";
import { bridge } from "./bridge.ts";
import { executeCommand } from "./tabs/index.ts";
import { MarkdownPane } from "./tabs/markdown-tab.tsx";
import { TerminalPane } from "./tabs/terminal-tab.tsx";
import {
  activeWorkspace,
  dockviewOf,
  focusWorkspace,
  workspaceReady,
  workspaces,
} from "./workspaces.ts";
import type { Workspace } from "./workspaces.ts";

const panesRoot = createRoot(requireElement("panes"));

const PANE_COMPONENTS = {
  terminal: TerminalPane,
  markdown: MarkdownPane,
};

// Drawn synchronously, the way the chrome is: the page a Command's Event
// describes is the page that is on screen.
export function drawPanes(): void {
  flushSync(() => {
    panesRoot.render(
      Array.from(workspaces.values(), (workspace) => (
        <WorkspacePanes key={workspace.id} workspace={workspace} />
      )),
    );
  });
}

type WorkspacePanesProps = {
  workspace: Workspace;
};

// A background workspace is hidden rather than torn down: its terminals, and
// the shells behind them, stay live and a build left compiling keeps going.
function WorkspacePanes({ workspace }: WorkspacePanesProps): ReactNode {
  const containerElement = useRef<HTMLDivElement>(null);
  const active = workspace === activeWorkspace;

  // A hidden element measures zero, so Dockview and the terminals inside it
  // are handed the size they just got back the moment the workspace shows.
  useEffect(() => {
    const element = containerElement.current;
    if (!active || element === null) {
      return;
    }
    dockviewOf(workspace).layout(element.clientWidth, element.clientHeight);
    for (const tab of workspace.tabs.values()) {
      if (tab.kind !== "terminal") {
        continue;
      }
      tab.fitAddon.fit();
    }
  }, [active, workspace]);

  return (
    <div
      className={`min-w-0 flex-1${active ? "" : " hidden"}`}
      ref={containerElement}
      // Which half of the window the keyboard belongs to, decided by where
      // the last press landed: the panes take it back, the editor keeps it.
      // After the press has landed, so a click on a stretch of pane that
      // takes no keyboard still leaves it with the active tab.
      onMouseDown={() => {
        workspace.focus = "panes";
        setTimeout(focusWorkspace, 0);
      }}
    >
      <DockviewReact
        theme={themeDark}
        disableFloatingGroups
        // Dockview's overflow dropdown cannot render our tab rows, so the
        // strip scrolls instead.
        disableTabsOverflowList
        components={PANE_COMPONENTS}
        defaultTabComponent={TabRow}
        rightHeaderActionsComponent={NewTabAction}
        onReady={(event) => {
          workspaceReady({
            workspace,
            dockview: event.api,
          });
        }}
      />
    </div>
  );
}

// One tab's row in the strip: its title and the × that closes it. Every kind
// of tab wears the same one, and only the pane below it differs. The title is
// Dockview's, because a drag can carry the row to another strip and the row
// follows it rather than being redrawn from the tab store.
function TabRow({ api }: IDockviewPanelHeaderProps): ReactNode {
  const [title, setTitle] = useState(api.title);
  useEffect(() => {
    const subscription = api.onDidTitleChange((event) => setTitle(event.title));
    return () => subscription.dispose();
  }, [api]);

  const id = Number(api.id);
  return (
    <div
      className="flex h-full items-center gap-1.5 font-ui"
      onDoubleClick={() => {
        executeCommand({
          type: "toggle-maximize",
          id,
        });
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        bridge.showTabMenu(id);
      }}
    >
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
            id,
          });
        }}
      >
        ×
      </button>
    </div>
  );
}

// The + at the right end of a group's strip, which opens a tab in that group.
function NewTabAction({ group }: IDockviewHeaderActionsProps): ReactNode {
  return (
    <button
      className="cursor-pointer border-0 bg-transparent px-3 py-1 font-ui text-[15px] text-tab"
      type="button"
      title="New Tab (⌘T)"
      onClick={() => {
        executeCommand({
          type: "new-tab",
          groupId: group.id,
        });
      }}
    >
      +
    </button>
  );
}
