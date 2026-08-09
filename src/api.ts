// Try me in devtools (⌥⌘I):
//   lmux.command({ type: "new-tab" })
//   lmux.command({ type: "write", text: "ls\n" })
// The Commands are declared as a schema and their types derived from it, so
// a caller from outside our own compiled code can be checked against the
// same one definition the compiler uses. Everything else here is types
// only; Events and state travel outwards, where the receiver is us.
// zod by path, not by name: this module is loaded by both the page, which
// cannot resolve a bare specifier, and by main.
import { z } from "../node_modules/zod/index.js";

const splitSideSchema = z.enum(["left", "right", "top", "bottom"]);
export type SplitSide = z.infer<typeof splitSideSchema>;

// A markdown tab shows the file rendered, or its source as it is on disk.
export const markdownModeSchema = z.enum(["rendered", "raw"]);
export type MarkdownMode = z.infer<typeof markdownModeSchema>;

// `theme` stays a plain string: which names exist is the consumer's business
// (renderer/settings.ts holds THEMES and corrects an unknown one).
// fontFamily/fontSize are the terminal's, uiFontFamily the chrome's,
// markdownFont* the rendered document's.
export const settingsSchema = z.object({
  theme: z.string(),
  fontFamily: z.string(),
  fontSize: z.number(),
  uiFontFamily: z.string(),
  markdownFontFamily: z.string(),
  markdownFontSize: z.number(),
  sidebarWidth: z.number(), // pixels; the sidebar's drag handle is its UI
});

export type Settings = z.infer<typeof settingsSchema>;

// `id` defaults to the active tab where optional. Tab ids are unique across
// workspaces; group ids are resolved inside the tab's own workspace.
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("new-tab"), groupId: z.string().optional() }),
  z.object({ type: z.literal("close-tab"), id: z.number().optional() }),
  z.object({ type: z.literal("activate-tab"), id: z.number() }),
  z.object({
    type: z.literal("write"),
    id: z.number().optional(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("move-tab"),
    id: z.number().optional(),
    groupId: z.string().optional(),
    index: z.number(),
  }),
  z.object({
    type: z.literal("split-tab"),
    id: z.number().optional(),
    targetGroupId: z.string().optional(),
    side: splitSideSchema,
  }),
  // An explicit rename pins against shell transient (OSC) titles;
  // `title: ""` reverts to "Untitled" and unpins.
  z.object({
    type: z.literal("set-tab-title"),
    id: z.number().optional(),
    title: z.string(),
    transient: z.boolean().optional(),
  }),
  // Out-of-range values are corrected to their defaults by the consumer, not
  // rejected here; a field of the wrong type is not a value at all, and does
  // not get in.
  z.object({
    type: z.literal("update-settings"),
    settings: settingsSchema.partial(),
  }),
  // Default: active group. Relative path resolves against baseTabId's cwd.
  z.object({
    type: z.literal("open-markdown"),
    path: z.string(),
    baseTabId: z.number().optional(),
    groupId: z.string().optional(),
  }),
  // Opens source in the workspace's one project tab. A preview file is
  // replaceable until edited or pinned; other command sources open pinned.
  z.object({
    type: z.literal("open-file"),
    path: z.string(),
    baseTabId: z.number().optional(),
    groupId: z.string().optional(),
    preview: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("activate-file"),
    projectTabId: z.number().optional(),
    path: z.string(),
  }),
  z.object({
    type: z.literal("pin-file"),
    projectTabId: z.number().optional(),
    path: z.string(),
  }),
  z.object({
    type: z.literal("close-file"),
    projectTabId: z.number().optional(),
    path: z.string(),
  }),
  // Save guards on the mtime captured at read. Omitting path means the
  // visible file; Save All covers every dirty buffer in one project tab.
  z.object({
    type: z.literal("save-file"),
    projectTabId: z.number().optional(),
    path: z.string().optional(),
  }),
  z.object({
    type: z.literal("save-all-files"),
    projectTabId: z.number().optional(),
  }),
  // Opens or activates the project tab rooted from a terminal.
  z.object({
    type: z.literal("open-project"),
    baseTabId: z.number().optional(),
    groupId: z.string().optional(),
  }),
  z.object({
    type: z.literal("change-workspace-root"),
    workspaceId: z.number().optional(),
    path: z.string(),
  }),
  z.object({ type: z.literal("toggle-maximize"), id: z.number().optional() }),
  // Both ignore a tab that isn't a markdown one.
  z.object({
    type: z.literal("set-markdown-mode"),
    id: z.number().optional(),
    mode: markdownModeSchema,
  }),
  // Re-reads the file from disk, keeping the scroll position.
  z.object({ type: z.literal("reload-markdown"), id: z.number().optional() }),
  // A new workspace starts empty, becomes active, and gets one terminal tab.
  z.object({ type: z.literal("new-workspace") }),
  // Kills every shell in the workspace; the last workspace can't be closed.
  z.object({ type: z.literal("close-workspace"), id: z.number().optional() }),
  z.object({ type: z.literal("activate-workspace"), id: z.number() }),
  // Pins the name against the active tab's title; `name: ""` unpins.
  z.object({
    type: z.literal("rename-workspace"),
    id: z.number().optional(),
    name: z.string(),
  }),
]);

export type Command = z.infer<typeof commandSchema>;

// The one question beside the bus. State is pushed with every Event because
// it is small and changes rarely; a screen changes on every byte and is
// kilobytes, so it is pulled, by whoever wants it, when they want it.
// Inbound like a Command, so it is checked like one.
export const screenRequestSchema = z.object({
  tabId: z.number(),
  // counted up from the bottom of the buffer, so the newest output is what
  // a caller gets without asking for anything
  rows: z.number().int().positive().max(1000).optional(),
});

export type ScreenRequest = z.infer<typeof screenRequestSchema>;

export type ScreenResult =
  // `alternate` means a full-screen program owns the tab (vim, htop): there
  // is no scrollback behind what it painted, and a `write` reaches that
  // program rather than a shell.
  | { kind: "terminal"; lines: string[]; alternate: boolean }
  // A document has no screen. Its text is the file's, and an agent that can
  // drive a shell can already read files; saying which file it shows is the
  // part lmux knows and the caller doesn't.
  | { kind: "markdown"; path: string; mode: MarkdownMode }
  // A project tab combines a workspace tree and one visible file buffer.
  | {
      kind: "project";
      workspaceRootPath: string;
      path: string | null;
      language: string | null;
    }
  | { kind: "no-such-tab" };

// Every event carries the full state it produced.
export type LmuxEvent =
  | { type: "tab-opened"; id: number; state: LmuxState }
  | { type: "tab-closed"; id: number; state: LmuxState }
  | { type: "tab-retitled"; id: number; state: LmuxState }
  | { type: "tab-moved"; id: number; state: LmuxState }
  | { type: "tab-activated"; id: number; state: LmuxState }
  // carries the settings as they actually took effect, not as requested
  | { type: "settings-changed"; settings: Settings; state: LmuxState }
  | { type: "maximize-changed"; id: number; state: LmuxState }
  | { type: "workspace-opened"; id: number; state: LmuxState }
  | { type: "workspace-closed"; id: number; state: LmuxState }
  | { type: "workspace-activated"; id: number; state: LmuxState }
  | { type: "workspace-renamed"; id: number; state: LmuxState }
  | { type: "markdown-mode-changed"; id: number; state: LmuxState }
  // the file was re-read; its text is in the view, not in the state
  | { type: "markdown-reloaded"; id: number; state: LmuxState }
  | { type: "file-opened"; id: number; path: string; state: LmuxState }
  | { type: "file-activated"; id: number; path: string; state: LmuxState }
  | { type: "file-pinned"; id: number; path: string; state: LmuxState }
  | { type: "file-closed"; id: number; path: string; state: LmuxState }
  | { type: "dirty-changed"; id: number; path: string; state: LmuxState }
  | { type: "file-saved"; id: number; path: string; state: LmuxState }
  | {
      type: "file-save-failed";
      id: number;
      path: string;
      error: string;
      state: LmuxState;
    }
  | {
      type: "files-save-finished";
      id: number;
      failedPaths: string[];
      state: LmuxState;
    }
  | {
      type: "workspace-root-changed";
      id: number;
      path: string;
      state: LmuxState;
    };

export type ProjectFileInfo = {
  path: string;
  dirty: boolean;
  pinned: boolean;
};

export type TabInfo =
  | { id: number; title: string; kind: "terminal" }
  // the file it shows, so an observer (and a restart) knows which document
  | { id: number; title: string; kind: "markdown"; mode: MarkdownMode; path: string }
  | {
      id: number;
      title: string;
      kind: "project";
      workspaceRootPath: string;
      activeFilePath: string | null;
      files: ProjectFileInfo[];
    };

// One tab strip and the pane below it. Group ids are opaque handles
// assigned by the layout engine, unique within their workspace only.
export type GroupInfo = {
  id: string;
  tabs: TabInfo[];
};

// Split direction: resizing changes no tab and emits no Event.
export type LayoutNode =
  | { type: "group"; group: GroupInfo }
  | { type: "split"; direction: "row" | "column"; children: LayoutNode[] };

// A workspace is a whole lmux of its own: its own pane layout, its own
// tabs, its own shells. Only one is on screen at a time; the rest keep
// running.
export type WorkspaceInfo = {
  id: number;
  // the active tab's title, unless an explicit rename pinned it
  name: string;
  namePinned: boolean; // whether `name` is that rename, or follows the tab
  tabs: TabInfo[]; // this workspace's tabs, in visual order
  layout: LayoutNode | null; // null only while the workspace has no tabs
  activeId: number; // this workspace's own active tab
  maximizedGroupId: string | null; // the group filling the window, if any
};

export type LmuxState = {
  workspaces: WorkspaceInfo[]; // in sidebar order
  activeWorkspaceId: number; // -1 only before the first workspace exists
};
