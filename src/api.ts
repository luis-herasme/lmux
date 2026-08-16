// Try me in devtools (⌥⌘I):
//   lmux.command({ type: "new-tab" })
//   lmux.command({ type: "write", text: "ls\n" })
// The Commands are declared as a schema and their types derived from it, so
// a caller from outside our own compiled code can be checked against the
// same one definition the compiler uses. Everything else here is types
// only; Events and state travel outwards, where the receiver is us.
import { z } from "zod";

const splitSideSchema = z.enum(["left", "right", "top", "bottom"]);

// A markdown tab shows the file rendered, or its source as it is on disk.
export const markdownModeSchema = z.enum(["rendered", "raw"]);
export type MarkdownMode = z.infer<typeof markdownModeSchema>;

// `theme` stays a plain string: which names exist is the consumer's business
// (renderer/settings.ts holds THEMES and corrects an unknown one).
// fontFamily/fontSize are the terminal's, uiFontFamily the chrome's,
// markdownFont* the rendered document's.
const settingsSchema = z.object({
  theme: z.string(),
  fontFamily: z.string(),
  fontSize: z.number(),
  uiFontFamily: z.string(),
  markdownFontFamily: z.string(),
  markdownFontSize: z.number(),
  sidebarWidth: z.number(), // pixels; the sidebar's drag handle is its UI
  editorWidth: z.number(), // the editor's, the same way
});

export type Settings = z.infer<typeof settingsSchema>;

// `id` defaults to the active tab where optional. Tab ids are unique across
// workspaces; group ids are resolved inside the tab's own workspace.
// `editorId` names a workspace's editor and defaults to the active
// workspace's.
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
  // Opens source in the workspace's editor, for reading. The editor
  // shows one file, so this replaces whatever it was showing.
  z.object({
    type: z.literal("open-file"),
    path: z.string(),
    baseTabId: z.number().optional(),
  }),
  z.object({
    type: z.literal("close-file"),
    editorId: z.number().optional(),
  }),
  // Shows the open file rendered, or back in its editor; one that isn't
  // markdown is ignored.
  z.object({
    type: z.literal("set-file-markdown-mode"),
    editorId: z.number().optional(),
    mode: markdownModeSchema,
  }),
  // Shows the workspace's editor, rooting it from a terminal the
  // first time. Hiding it keeps its file, so nothing is asked or lost.
  z.object({
    type: z.literal("show-editor"),
    workspaceId: z.number().optional(),
    baseTabId: z.number().optional(),
  }),
  z.object({
    type: z.literal("hide-editor"),
    workspaceId: z.number().optional(),
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
  // the editor came on screen or left it; `id` is the editor's
  | { type: "editor-shown"; id: number; state: LmuxState }
  | { type: "editor-hidden"; id: number; state: LmuxState }
  // the open file swapped between its source and its rendering
  | {
      type: "file-markdown-mode-changed";
      id: number;
      path: string;
      state: LmuxState;
    }
  // the file was re-read; its text is in the view, not in the state
  | { type: "markdown-reloaded"; id: number; state: LmuxState }
  | { type: "file-opened"; id: number; path: string; state: LmuxState }
  | { type: "file-closed"; id: number; path: string; state: LmuxState }
  | {
      type: "workspace-root-changed";
      id: number;
      path: string;
      state: LmuxState;
    };

export type TabInfo =
  | { id: number; title: string; kind: "terminal" }
  // the file it shows, so an observer (and a restart) knows which document
  | { id: number; title: string; kind: "markdown"; mode: MarkdownMode; path: string };

// The workspace's own editor: its file tree and the one file it shows. Not a
// tab, so it has no place in the layout and no title of its own; `name` is
// the root folder's, which the editor's header wears. `id` is what a command's
// editorId names.
export type EditorInfo = {
  id: number;
  name: string;
  workspaceRootPath: string;
  visible: boolean; // hiding it keeps the file open behind it
  filePath: string | null;
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

// A workspace is a whole lmux of its own: its own pane area, its own
// tabs, its own shells, its own editor. Only one is on screen at a
// time; the rest keep running.
export type WorkspaceInfo = {
  id: number;
  // the active tab's title, unless an explicit rename pinned it
  name: string;
  namePinned: boolean; // whether `name` is that rename, or follows the tab
  tabs: TabInfo[]; // this workspace's tabs, in visual order
  layout: LayoutNode | null; // null only while the workspace has no tabs
  activeId: number; // this workspace's own active tab
  maximizedGroupId: string | null; // the group filling the window, if any
  editor: EditorInfo | null; // null until the editor is opened once
  // which side of the window the keyboard is in: the panes, or the editor
  focus: "panes" | "editor";
};

export type LmuxState = {
  workspaces: WorkspaceInfo[]; // in sidebar order
  activeWorkspaceId: number; // -1 only before the first workspace exists
};
