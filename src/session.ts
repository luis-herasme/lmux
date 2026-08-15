// What a restart is allowed to bring back. Deliberately not the state: a
// session is what can honestly be rebuilt, which is a workspace's tabs in
// order, its project panel, a document's path and mode, and which of them
// you were looking at.
// Shells cannot be restored, only respawned, so a terminal tab carries
// nothing at all; scrollback is gone either way.
//
// A schema rather than a type, because this arrives from a file on disk,
// which is the definition of untrusted here: a session written by an older
// version, or half-written by a crash, must read as "no session" rather than
// as a shape the renderer then trips over.
import { z } from "../node_modules/zod/index.js";
import { markdownModeSchema } from "./api.ts";
import type { LmuxState } from "./api.ts";

const sessionTabSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("terminal") }),
  z.object({
    kind: z.literal("markdown"),
    path: z.string(),
    mode: markdownModeSchema,
  }),
]);

// Only the open file's path returns: cursor and scroll positions are
// transient, and the file is re-read from disk.
const sessionProjectSchema = z.object({
  workspaceRootPath: z.string(),
  filePath: z.string().nullable(),
  visible: z.boolean(),
});

const sessionWorkspaceSchema = z.object({
  // the name only if a rename pinned it: a derived one belongs to whichever
  // tab is active, and restoring it as a pinned name would freeze it
  name: z.string().nullable(),
  tabs: z.array(sessionTabSchema),
  activeIndex: z.number().int(),
  project: sessionProjectSchema.nullable(),
});

export const sessionSchema = z.object({
  workspaces: z.array(sessionWorkspaceSchema),
  activeIndex: z.number().int(),
});

export type Session = z.infer<typeof sessionSchema>;
type SessionWorkspace = z.infer<typeof sessionWorkspaceSchema>;
type SessionTab = z.infer<typeof sessionTabSchema>;
type SessionProject = z.infer<typeof sessionProjectSchema>;

// Positions, not ids: the renderer assigns tab ids as it creates them, so a
// restored tab is a different tab wearing the same contents.
export function sessionFromState(state: LmuxState): Session {
  const workspaces: SessionWorkspace[] = [];
  let activeIndex = 0;
  for (const workspace of state.workspaces) {
    if (workspace.id === state.activeWorkspaceId) {
      activeIndex = workspaces.length;
    }
    const tabs: SessionTab[] = [];
    let activeTabIndex = 0;
    for (const tab of workspace.tabs) {
      if (tab.id === workspace.activeId) {
        activeTabIndex = tabs.length;
      }
      if (tab.kind === "markdown") {
        tabs.push({
          kind: "markdown",
          path: tab.path,
          mode: tab.mode,
        });
        continue;
      }
      tabs.push({ kind: "terminal" });
    }
    let name: string | null = null;
    if (workspace.namePinned) {
      name = workspace.name;
    }
    let project: SessionProject | null = null;
    if (workspace.project !== null) {
      project = {
        workspaceRootPath: workspace.project.workspaceRootPath,
        filePath: workspace.project.filePath,
        visible: workspace.project.visible,
      };
    }
    workspaces.push({
      name,
      tabs,
      activeIndex: activeTabIndex,
      project,
    });
  }
  return {
    workspaces,
    activeIndex,
  };
}
