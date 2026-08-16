// Only what more than one area file needs; the rest lives with its one area.
import * as path from "path";
import { realpathSync } from "fs";
import { sendCommand, waitForEvent } from "./harness.ts";
import { lmuxState } from "../main/bus.ts";
import type { LmuxState, EditorInfo, WorkspaceInfo } from "../api.ts";

// tsc emits no .md, so the fixture is read from source, the way main reads
// index.html.
export const FIXTURE_PATH = path.join(
  import.meta.dirname,
  "../../src/test/fixtures/document.md",
);

// A real source file rather than a fixture: the case is about a grammar
// recognising TypeScript, and the app's own code is the TypeScript nearest
// to hand.
export const SOURCE_FILE_PATH = realpathSync(
  path.join(
    import.meta.dirname,
    "../../src/renderer/monaco.ts",
  ),
);

// Structural, so it counts a full state and any narrower view of one.
type StateWithTabs = {
  workspaces: { tabs: unknown[] }[];
};

export function countTabs(state: StateWithTabs): number {
  let count = 0;
  for (const workspace of state.workspaces) {
    count += workspace.tabs.length;
  }
  return count;
}

export type StateLookupOptions = {
  state: LmuxState;
  id: number;
};

// Both lookups return undefined rather than throwing: they run inside wait
// predicates, where what is being waited for legitimately does not exist yet.
export function findWorkspace({
  state,
  id,
}: StateLookupOptions): WorkspaceInfo | undefined {
  for (const workspace of state.workspaces) {
    if (workspace.id === id) {
      return workspace;
    }
  }
  return undefined;
}

// The editor is workspace state, so its id is looked for beside the tabs
// rather than among them.
export function findEditorInfo({
  state,
  id,
}: StateLookupOptions): EditorInfo | undefined {
  for (const workspace of state.workspaces) {
    if (workspace.editor?.id === id) {
      return workspace.editor;
    }
  }
  return undefined;
}

// A new workspace announces itself, then its first shell, in two Events.
// Waiting on the tab count lands on the second one whatever the order.
export async function openWorkspace(): Promise<WorkspaceInfo> {
  const tabCount = countTabs(lmuxState);
  sendCommand({ type: "new-workspace" });
  const opened = await waitForEvent(
    (event) => countTabs(event.state) === tabCount + 1,
  );
  const workspace = opened.state.workspaces.at(-1);
  if (workspace === undefined) {
    throw new Error("new-workspace opened nothing");
  }
  return workspace;
}
