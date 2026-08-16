// The window's own furniture, drawn by React from the stores behind it: the
// title bar's name, the sidebar's list of workspaces, and the two modal
// dialogs. None of it holds state of its own — the workspaces are in
// workspaces.ts and the settings in settings.ts — so every change out there
// ends in drawChrome(), which draws all three again.
//
// The exceptions are which dialog is open, below, and what a dialog is
// mid-edit — a name being typed, a font not yet committed — which is the one
// thing that belongs to nobody but the field holding it.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { bridge } from "./bridge.ts";
import { requireElement } from "./dom.ts";
import { MAX_FONT_SIZE_PX, MIN_FONT_SIZE_PX, getSettings } from "./settings.ts";
import { executeCommand, getTabTitle } from "./tabs/index.ts";
import { activeWorkspace, focusWorkspace, workspaces } from "./workspaces.ts";
import type { Workspace } from "./workspaces.ts";
import { THEMES } from "../theme.ts";
import type { Settings } from "../api.ts";

// Three roots, because the three regions are three places in the page. Each
// host keeps its own identity and its own look; React draws what is inside
// it, which is what the rest of this file describes.
const titleBarRoot = createRoot(requireElement("title-bar"));
const sidebarRoot = createRoot(requireElement("sidebar"));
const dialogRoot = createRoot(requireElement("dialogs"));

type RenameTarget = {
  kind: "tab" | "workspace";
  id: number;
  name: string; // as it was when the dialog opened
};

let renameTarget: RenameTarget | undefined;
let settingsOpen = false;

// Drawn synchronously, so that a Command's Event and the window it produced
// are never a frame apart: whoever reads the page after the Event sees it.
// A dialog is only drawn while it is open, so mounting one is opening it.
export function drawChrome(): void {
  flushSync(() => {
    titleBarRoot.render(activeWorkspace?.name ?? "lmux");
    sidebarRoot.render(<Sidebar />);
    dialogRoot.render(
      <>
        {renameTarget !== undefined && <RenameDialog target={renameTarget} />}
        {settingsOpen && <SettingsDialog />}
      </>,
    );
  });
}

function Sidebar(): ReactNode {
  return (
    <>
      {/* one row per workspace. A tablist: picking one swaps which set of
          panes is on screen. */}
      <div
        id="workspace-list"
        role="tablist"
        aria-label="Workspaces"
        className="flex flex-col"
      >
        {Array.from(workspaces.values(), (workspace) => (
          <WorkspaceRow key={workspace.id} workspace={workspace} />
        ))}
      </div>
      {/* rows, not icons: every button shares the list's left edge */}
      <button
        className="mt-0.5 cursor-pointer border-0 bg-transparent px-3 py-1 text-left text-[12px] whitespace-nowrap text-tab hover:text-tab-active"
        type="button"
        title="New Workspace (⇧⌘T)"
        onClick={() => {
          executeCommand({ type: "new-workspace" });
        }}
      >
        + New Workspace
      </button>
      <button
        className="mt-auto cursor-pointer border-0 bg-transparent px-3 py-1 text-left text-[18px] whitespace-nowrap text-tab hover:text-tab-active"
        type="button"
        title="Settings"
        aria-label="Settings"
        onClick={() => {
          settingsOpen = true;
          drawChrome();
        }}
      >
        ⚙
      </button>
    </>
  );
}

type WorkspaceRowProps = {
  workspace: Workspace;
};

// A row and not a button, because the × in it is one and buttons do not
// nest; role, tabindex and the keydown below give back what the element type
// stopped saying and doing. Same shape a tab has in the strip.
function WorkspaceRow({ workspace }: WorkspaceRowProps): ReactNode {
  const active = workspace === activeWorkspace;
  return (
    <div
      className={`workspace-row relative flex cursor-pointer items-center gap-1.5 px-3 py-[5px] text-[12px] text-tab hover:text-tab-active${
        active ? " active" : ""
      }`}
      role="tab"
      tabIndex={0}
      aria-selected={active}
      // the row ellipsizes a long name; the tooltip always has it whole
      title={workspace.name}
      onClick={() => {
        executeCommand({
          type: "activate-workspace",
          id: workspace.id,
        });
      }}
      onKeyDown={(event) => {
        // the × is a button of its own and answers both of these itself
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault(); // Space scrolls, and the page must never scroll
        executeCommand({
          type: "activate-workspace",
          id: workspace.id,
        });
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        bridge.showWorkspaceMenu(workspace.id);
      }}
    >
      <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
      {/* the row's own padding is the ×'s hit area; it brings none of its own */}
      <button
        className="workspace-close flex-none cursor-pointer border-0 bg-transparent p-0 text-[length:inherit] leading-none text-inherit"
        type="button"
        title="Close Workspace (⇧⌘W)"
        aria-label="Close workspace"
        onClick={(event) => {
          event.stopPropagation();
          // Through main rather than straight onto the bus: closing a
          // workspace ends every shell in it, and only main can ask about
          // the busy ones.
          bridge.closeWorkspace(workspace.id);
        }}
      >
        ×
      </button>
    </div>
  );
}

// <dialog> + showModal(): real modality (backdrop, focus trap, Escape) from
// the browser engine. Electron has no native text-input dialog.
//
// The rename dialog names its target: a tab or a workspace. Nothing opens it
// but this, and a target it cannot name — a tab that has gone — opens
// nothing at all.
export function openRenameDialog({
  kind,
  id,
}: Omit<RenameTarget, "name">): void {
  const name = kind === "tab" ? getTabTitle(id) : workspaces.get(id)?.name;
  if (name === undefined) {
    return;
  }
  renameTarget = {
    kind,
    id,
    name,
  };
  drawChrome();
}

type RenameDialogProps = {
  target: RenameTarget;
};

function RenameDialog({ target }: RenameDialogProps): ReactNode {
  const [name, setName] = useState(target.name);
  const dialogElement = useRef<HTMLDialogElement>(null);
  const inputElement = useRef<HTMLInputElement>(null);
  // Opening it is showing it: the dialog is only drawn while there is a
  // target, so this runs once, when that target appears.
  useEffect(() => {
    dialogElement.current?.showModal();
    inputElement.current?.select();
  }, []);

  return (
    <dialog
      className="dialog-box"
      ref={dialogElement}
      onClose={(event) => {
        if (event.currentTarget.returnValue === "rename") {
          const renamed = name.trim();
          executeCommand(
            target.kind === "tab"
              ? { type: "set-tab-title", id: target.id, title: renamed }
              : { type: "rename-workspace", id: target.id, name: renamed },
          );
        }
        renameTarget = undefined;
        drawChrome();
        focusWorkspace();
      }}
    >
      <form method="dialog">
        {/* the heading names the target: a tab or a workspace */}
        <h2 className="mt-0 mb-2.5 text-[13px] font-semibold">
          {target.kind === "tab" ? "Rename Tab" : "Rename Workspace"}
        </h2>
        <input
          className="field w-full text-[13px]"
          type="text"
          spellCheck={false}
          value={name}
          ref={inputElement}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <div className="mt-3.5 flex justify-end gap-2">
          {/* Cancel is type=button so Enter always means Rename */}
          <button
            className="dialog-button bg-separator text-inherit"
            type="button"
            onClick={() => {
              dialogElement.current?.close();
            }}
          >
            Cancel
          </button>
          <button
            className="dialog-button bg-accent text-background"
            value="rename"
          >
            Rename
          </button>
        </div>
      </form>
    </dialog>
  );
}

// Controls apply live: each committed change is an update-settings Command.
// The dialog holds nothing itself — the settings are in settings.ts, and what
// a field is mid-edit is that field's own business.
function SettingsDialog(): ReactNode {
  const settings = getSettings();
  const dialogElement = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialogElement.current?.showModal();
  }, []);

  // the schema corrects what it has to, so this hands back what actually
  // stuck and the field redisplays that rather than what was typed
  function save(partial: Partial<Settings>): Settings {
    executeCommand({
      type: "update-settings",
      settings: partial,
    });
    return getSettings();
  }

  return (
    <dialog
      className="dialog-box"
      ref={dialogElement}
      onClose={() => {
        settingsOpen = false;
        drawChrome();
        focusWorkspace();
      }}
    >
      <h2 className="mt-0 mb-2.5 text-[13px] font-semibold">Settings</h2>
      <label className="settings-row">
        Theme
        {/* a theme cannot be half-picked, so this one commits as it changes */}
        <select
          className="field w-[140px] text-[12px]"
          defaultValue={settings.theme}
          onChange={(event) => {
            save({ theme: event.target.value });
          }}
        >
          {Object.keys(THEMES).map((name) => (
            <option key={name} value={name}>
              {/* dark-hard is Dark Hard, spelled the way a key has to be */}
              {name
                .split("-")
                .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                .join(" ")}
            </option>
          ))}
        </select>
      </label>
      <h3 className="settings-section">Terminal</h3>
      <SettingsField
        label="Font"
        value={settings.fontFamily}
        commit={(text) => save({ fontFamily: text }).fontFamily}
      />
      <SettingsField
        label="Font size"
        value={settings.fontSize}
        numeric
        commit={(text) => save({ fontSize: Number(text) }).fontSize}
      />
      <h3 className="settings-section">Interface</h3>
      <SettingsField
        label="Font"
        value={settings.uiFontFamily}
        commit={(text) => save({ uiFontFamily: text }).uiFontFamily}
      />
      <h3 className="settings-section">Markdown</h3>
      <SettingsField
        label="Font"
        value={settings.markdownFontFamily}
        commit={(text) => save({ markdownFontFamily: text }).markdownFontFamily}
      />
      <SettingsField
        label="Font size"
        value={settings.markdownFontSize}
        numeric
        commit={(text) =>
          save({ markdownFontSize: Number(text) }).markdownFontSize
        }
      />
      <div className="mt-3.5 flex justify-end gap-2">
        <button
          className="dialog-button bg-accent text-background"
          type="button"
          onClick={() => {
            dialogElement.current?.close();
          }}
        >
          Done
        </button>
      </div>
    </dialog>
  );
}

type SettingsFieldProps = {
  label: string;
  value: string | number; // string for families, number for sizes
  numeric?: boolean; // size fields render a number input with min and max
  commit: (text: string) => string | number;
};

// Typing changes nothing; leaving the field commits, which is what a native
// change event is, and Enter leaves it. A half-typed number is not one yet,
// which is why the text on the way in is the field's own and not the setting.
function SettingsField({
  label,
  value,
  numeric = false,
  commit,
}: SettingsFieldProps): ReactNode {
  const [text, setText] = useState(String(value));
  return (
    <label className="settings-row">
      {label}
      <input
        className="field w-[140px] text-[12px]"
        type={numeric ? "number" : "text"}
        spellCheck={false}
        min={numeric ? MIN_FONT_SIZE_PX : undefined}
        max={numeric ? MAX_FONT_SIZE_PX : undefined}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onBlur={(event) => {
          setText(String(commit(event.target.value)));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
