// Only what more than one area file needs; the rest lives with its one area.
import * as net from "net";
import * as path from "path";
import { realpathSync } from "fs";
import { z } from "zod";
import { API_SOCKET_PATH, sendCommand, waitForEvent } from "./harness.ts";
import { lmuxState } from "../main/bus.ts";
import type { LmuxState, ProjectInfo, WorkspaceInfo } from "../api.ts";

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

// Structural, so it counts both a real state and the narrower one a case
// parses back out of the socket.
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

// The panel is workspace state, so its id is looked for beside the tabs
// rather than among them.
export function findProjectInfo({
  state,
  id,
}: StateLookupOptions): ProjectInfo | undefined {
  for (const workspace of state.workspaces) {
    if (workspace.project?.id === id) {
      return workspace.project;
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

// The API is reached the way any client reaches it, over the socket, so
// what a case exercises is the door rather than a function behind it. One
// connection per call, which is also the shortest way to prove the server
// answers a client that never said hello.
function callSocket(message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(API_SOCKET_PATH);
    let buffered = "";
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf("\n");
      if (newline === -1) {
        return;
      }
      socket.end();
      resolve(JSON.parse(buffered.slice(0, newline)));
    });
    socket.write(JSON.stringify(message) + "\n");
  });
}

const toolAnswerSchema = z.object({
  result: z.object({
    content: z.array(
      z.object({
        text: z.string(),
      }),
    ),
    isError: z.boolean().optional(),
  }),
});

type CallToolOptions = {
  name: string;
  toolArguments: Record<string, unknown>;
};

// Every tool answers with its own result as JSON, so a case gets back the
// same type the API declares.
export async function callTool({
  name,
  toolArguments,
}: CallToolOptions): Promise<unknown> {
  const answer = await callSocket({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name,
      arguments: toolArguments,
    },
  });
  const parsed = toolAnswerSchema.parse(answer);
  const first = parsed.result.content.at(0);
  if (first === undefined) {
    throw new Error(`the ${name} tool answered with no content`);
  }
  if (parsed.result.isError) {
    throw new Error(`the ${name} tool refused: ${first.text}`);
  }
  return JSON.parse(first.text);
}

export const screenSchema = z.object({
  kind: z.string(),
  lines: z.array(z.string()).optional(),
  alternate: z.boolean().optional(),
  language: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  workspaceRootPath: z.string().optional(),
});
