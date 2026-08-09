// What a restart is allowed to bring back. Deliberately not the state: a
// session is what can honestly be rebuilt, which is a workspace's tabs in
// order, a document's path and mode, and which of them you were looking at.
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
  // A code tab is its path and nothing else. Not the scroll position or the
  // cursor: both belong to a file that may have changed since, and a
  // restored caret pointing at a line that moved is worse than none.
  z.object({
    kind: z.literal("code"),
    path: z.string(),
  }),
  // The root is already resolved: restoring should show the same project,
  // not whichever directory a newly spawned shell happens to start in.
  z.object({
    kind: z.literal("tree"),
    path: z.string(),
  }),
]);

const sessionWorkspaceSchema = z.object({
  // the name only if a rename pinned it: a derived one belongs to whichever
  // tab is active, and restoring it as a pinned name would freeze it
  name: z.string().nullable(),
  tabs: z.array(sessionTabSchema),
  activeIndex: z.number().int(),
});

export const sessionSchema = z.object({
  workspaces: z.array(sessionWorkspaceSchema),
  activeIndex: z.number().int(),
});

export type Session = z.infer<typeof sessionSchema>;
type SessionWorkspace = z.infer<typeof sessionWorkspaceSchema>;
type SessionTab = z.infer<typeof sessionTabSchema>;

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
      if (tab.kind === "code") {
        tabs.push({
          kind: "code",
          path: tab.path,
        });
        continue;
      }
      if (tab.kind === "tree") {
        tabs.push({
          kind: "tree",
          path: tab.path,
        });
        continue;
      }
      tabs.push({ kind: "terminal" });
    }
    let name: string | null = null;
    if (workspace.namePinned) {
      name = workspace.name;
    }
    workspaces.push({
      name,
      tabs,
      activeIndex: activeTabIndex,
    });
  }
  return {
    workspaces,
    activeIndex,
  };
}
