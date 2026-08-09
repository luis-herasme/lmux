// Send Commands, assert on the state that comes back. The architecture was
// built for this: executeCommand is the one place state changes, and every
// Event carries a full snapshot, so a case needs no DOM knowledge except
// where the state deliberately holds none (a terminal's fitted size, a
// document's scroll position), which is what the probes below are for.
import { execFileSync } from "child_process";
import { describe } from "node:test";
import assert from "node:assert/strict";
import * as net from "net";
import * as path from "path";
import * as os from "os";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { z } from "zod";
import {
  API_SOCKET_PATH,
  busTest,
  endRun,
  lmuxWindow,
  pageHeight,
  pollUntil,
  sendCommand,
  waitForEvent,
} from "./harness.ts";
import { lmuxState } from "../main/bus.ts";
import { sessionFromState } from "../session.ts";
import type { LmuxState, WorkspaceInfo } from "../api.ts";

// tsc emits no .md, so the fixture is read from source, the way main reads
// index.html.
const FIXTURE_PATH = path.join(
  import.meta.dirname,
  "../../src/test/fixtures/document.md",
);

// A real source file rather than a fixture: the case is about a grammar
// recognising TypeScript, and the app's own code is the TypeScript nearest
// to hand.
const SOURCE_FILE_PATH = path.join(
  import.meta.dirname,
  "../../src/renderer/code.ts",
);

// executeJavaScript is the only way to ask the page something the bus does
// not carry, and it takes a string: nothing typed can express a DOM read
// across processes. Every probe skips the elements of a hidden workspace,
// which are still in the DOM.
const VISIBLE_TERMINAL_ROWS = `(() => {
  const counts = [];
  for (const element of document.querySelectorAll(".xterm-rows")) {
    if (element.offsetParent === null) {
      continue;
    }
    counts.push(element.children.length);
  }
  return counts;
})()`;

const VISIBLE_DOCUMENT = `(() => {
  for (const element of document.querySelectorAll(".markdown-scroll")) {
    if (element.offsetParent === null) {
      continue;
    }
    return {
      scrollTop: element.scrollTop,
      maximumScrollTop: element.scrollHeight - element.clientHeight,
      diagramCount: element.querySelectorAll("svg").length,
    };
  }
  return null;
})()`;

// A click whose target is the sidebar itself is what landing on the empty
// strip produces, and the target is the only thing the listener reads. A
// mouse sends both of these, in this order, for one double click, and the
// two cases below are that sequence split into the two questions it asks.
const VISIBLE_CODE_TOKEN_CLASSES = `(() => {
  const classes = new Set();
  for (const element of document.querySelectorAll(".code-editor")) {
    if (element.offsetParent === null) {
      continue;
    }
    for (const span of element.querySelectorAll(".view-line span span")) {
      classes.add(span.className.split(" ")[0]);
    }
  }
  return Array.from(classes);
})()`;

const CLICK_SIDEBAR = `document.getElementById("sidebar").click()`;
// The rows are appended in creation order, so the last one belongs to the
// workspace the case just opened.
const CLICK_LAST_WORKSPACE_CLOSE = `(() => {
  const rows = document.querySelectorAll("#workspace-list .workspace-row");
  rows[rows.length - 1].querySelector(".workspace-close").click();
})()`;
const DOUBLE_CLICK_SIDEBAR = `document
  .getElementById("sidebar")
  .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`;

const rowCountsSchema = z.array(z.number().int());
const scrollTopSchema = z.number();
const refusedSchema = z.boolean();
const documentSchema = z.object({
  scrollTop: z.number(),
  maximumScrollTop: z.number(),
  diagramCount: z.number().int(),
});

async function visibleDocument(): Promise<z.infer<typeof documentSchema>> {
  const probed =
    await lmuxWindow.webContents.executeJavaScript(VISIBLE_DOCUMENT);
  return documentSchema.parse(probed);
}

// The one probe that takes an argument, so its script is built rather than
// declared: the offset is our own number, in our own script.
async function scrollDocumentTo(offset: number): Promise<number> {
  const probed = await lmuxWindow.webContents.executeJavaScript(`(() => {
    for (const element of document.querySelectorAll(".markdown-scroll")) {
      if (element.offsetParent === null) {
        continue;
      }
      element.scrollTop = ${offset};
      return element.scrollTop;
    }
    return null;
  })()`);
  return scrollTopSchema.parse(probed);
}

async function visibleTerminalRows(): Promise<number> {
  const probed =
    await lmuxWindow.webContents.executeJavaScript(VISIBLE_TERMINAL_ROWS);
  const counts = rowCountsSchema.parse(probed);
  const rows = counts.at(0);
  if (rows === undefined) {
    throw new Error("no terminal is visible");
  }
  return rows;
}

// window.lmux.command is the door for callers outside our compiled code, so
// it is reached the way they reach it. Whether it threw is what matters
// here; what it threw is zod's business, and asserting on that text would
// be testing zod.
async function consoleDoorRefuses(commandLiteral: string): Promise<boolean> {
  const probed = await lmuxWindow.webContents.executeJavaScript(`(() => {
    try {
      window.lmux.command(${commandLiteral});
      return false;
    } catch {
      return true;
    }
  })()`);
  return refusedSchema.parse(probed);
}

// Structural, so it counts both a real state and the narrower one a case
// parses back out of the socket.
type StateWithTabs = {
  workspaces: { tabs: unknown[] }[];
};

function countTabs(state: StateWithTabs): number {
  let count = 0;
  for (const workspace of state.workspaces) {
    count += workspace.tabs.length;
  }
  return count;
}

type StateLookupOptions = {
  state: LmuxState;
  id: number;
};

// Both lookups return undefined rather than throwing: they run inside wait
// predicates, where what is being waited for legitimately does not exist yet.
function findWorkspace({
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

function findTabTitle({ state, id }: StateLookupOptions): string | undefined {
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      if (tab.id === id) {
        return tab.title;
      }
    }
  }
  return undefined;
}

// undefined when the id is not a code tab, so a caller can tell "clean code
// tab" from "not a code tab".
function findCodeDirty({ state, id }: StateLookupOptions): boolean | undefined {
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      if (tab.id !== id) {
        continue;
      }
      if (tab.kind !== "code") {
        return undefined;
      }
      return tab.dirty;
    }
  }
  return undefined;
}

function tabIds(workspace: WorkspaceInfo): number[] {
  const ids: number[] = [];
  for (const tab of workspace.tabs) {
    ids.push(tab.id);
  }
  return ids;
}

// A new workspace announces itself, then its first shell, in two Events.
// Waiting on the tab count lands on the second one whatever the order.
async function openWorkspace(): Promise<WorkspaceInfo> {
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
async function callTool({
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

const stateSchema = z.object({
  workspaces: z.array(
    z.object({
      id: z.number(),
      tabs: z.array(
        z.object({
          id: z.number(),
        }),
      ),
    }),
  ),
  activeWorkspaceId: z.number(),
});

const screenSchema = z.object({
  kind: z.string(),
  lines: z.array(z.string()).optional(),
  alternate: z.boolean().optional(),
  language: z.string().optional(),
  path: z.string().optional(),
});

type WaitForTerminalTextOptions = {
  terminalId: number;
  text: string;
  description: string;
};

async function waitForTerminalText({
  terminalId,
  text,
  description,
}: WaitForTerminalTextOptions): Promise<void> {
  await pollUntil({
    check: async () => {
      const screen = screenSchema.parse(
        await callTool({
          name: "screen",
          toolArguments: { tabId: terminalId },
        }),
      );
      if (screen.kind !== "terminal" || screen.lines === undefined) {
        return false;
      }
      for (const line of screen.lines) {
        if (line.includes(text)) {
          return true;
        }
      }
      return false;
    },
    description,
  });
}

const tokenClassSchema = z.array(z.string());
const editorTypingSchema = z.object({
  found: z.boolean(),
  edited: z.boolean(),
});
const treeClickSchema = z.object({
  clicked: z.boolean(),
  gitVisible: z.boolean(),
});

type ClickVisibleTreeFileOptions = {
  relativePath: string;
};

async function clickVisibleTreeFile({
  relativePath,
}: ClickVisibleTreeFileOptions): Promise<z.infer<typeof treeClickSchema>> {
  const probed = await lmuxWindow.webContents.executeJavaScript(`(() => {
    for (const contentElement of document.querySelectorAll(".tree-content")) {
      if (contentElement.offsetParent === null) {
        continue;
      }
      const host = contentElement.querySelector("file-tree-container");
      if (host === null || host.shadowRoot === null) {
        return { clicked: false, gitVisible: false };
      }
      let target = null;
      let gitVisible = false;
      for (const item of host.shadowRoot.querySelectorAll("[data-item-path]")) {
        const itemPath = item.getAttribute("data-item-path");
        if (itemPath === ".git") {
          gitVisible = true;
        }
        if (itemPath === ${JSON.stringify(relativePath)}) {
          target = item;
        }
      }
      if (!(target instanceof HTMLElement)) {
        return { clicked: false, gitVisible };
      }
      target.click();
      return { clicked: true, gitVisible };
    }
    return { clicked: false, gitVisible: false };
  })()`);
  return treeClickSchema.parse(probed);
}

const suite = describe("the command bus", () => {
  busTest({
    name: "tab ids stay unique across workspaces",
    body: async () => {
      const workspace = await openWorkspace();
      const tabCount = countTabs(lmuxState);
      sendCommand({ type: "new-tab" });
      const opened = await waitForEvent(
        (event) => countTabs(event.state) === tabCount + 1,
      );
      const state = opened.state;

      assert.ok(
        state.workspaces.length > 1,
        "the case needs a second workspace to be worth anything",
      );
      const ids: number[] = [];
      for (const each of state.workspaces) {
        ids.push(...tabIds(each));
      }
      assert.equal(
        new Set(ids).size,
        ids.length,
        `two tabs share an id: ${ids.join(", ")}`,
      );
      assert.equal(
        findWorkspace({ state, id: workspace.id })?.tabs.length,
        2,
        "the new tab did not land in the new workspace",
      );
    },
  });

  busTest({
    name: "switching workspaces keeps the terminals, refitted to the window",
    body: async () => {
      const first = lmuxState.workspaces.at(0);
      if (first === undefined) {
        throw new Error("no workspace to switch between");
      }
      if (lmuxState.activeWorkspaceId !== first.id) {
        sendCommand({ type: "activate-workspace", id: first.id });
        await waitForEvent(
          (event) => event.state.activeWorkspaceId === first.id,
        );
      }
      const before = findWorkspace({ state: lmuxState, id: first.id });
      if (before === undefined) {
        throw new Error(`workspace ${first.id} vanished`);
      }
      const rowsBefore = await visibleTerminalRows();

      // grow the window while this workspace is off screen, where its
      // terminals cannot see it happen
      await openWorkspace();
      const heightBefore = await pageHeight();
      const [width, height] = lmuxWindow.getSize();
      lmuxWindow.setSize(width, height + 200);
      await pollUntil({
        check: async () => (await pageHeight()) > heightBefore,
        description: "the window's new height to reach the page",
      });

      sendCommand({ type: "activate-workspace", id: first.id });
      const activated = await waitForEvent(
        (event) => event.state.activeWorkspaceId === first.id,
      );

      const after = findWorkspace({ state: activated.state, id: first.id });
      if (after === undefined) {
        throw new Error(`workspace ${first.id} vanished`);
      }
      assert.deepEqual(
        tabIds(after),
        tabIds(before),
        "switching away and back lost a tab",
      );
      // the refit is applied on activation, but xterm writes the new rows
      // out on its next frame, so this polls rather than reading once
      await pollUntil({
        check: async () => (await visibleTerminalRows()) > rowsBefore,
        description: `the terminal to refit past its old ${rowsBefore} rows`,
      });

      // hand the window back the size it was found at, so the later cases
      // measure what they expect to
      lmuxWindow.setSize(width, height);
    },
  });

  busTest({
    name: "a workspace wears its active tab's title, unless a rename pins it",
    body: async () => {
      const workspace = await openWorkspace();
      const tab = workspace.tabs.at(0);
      if (tab === undefined) {
        throw new Error("a new workspace opens with one tab");
      }

      sendCommand({ type: "set-tab-title", id: tab.id, title: "compiler" });
      await waitForEvent(
        (event) =>
          findWorkspace({ state: event.state, id: workspace.id })?.name ===
          "compiler",
      );

      sendCommand({
        type: "rename-workspace",
        id: workspace.id,
        name: "release",
      });
      await waitForEvent(
        (event) =>
          findWorkspace({ state: event.state, id: workspace.id })?.name ===
          "release",
      );

      // pinned: the tab may retitle itself all it likes
      sendCommand({ type: "set-tab-title", id: tab.id, title: "linker" });
      const retitled = await waitForEvent(
        (event) => findTabTitle({ state: event.state, id: tab.id }) === "linker",
      );
      assert.equal(
        findWorkspace({ state: retitled.state, id: workspace.id })?.name,
        "release",
        "a pinned workspace name followed its tab",
      );

      // "" unpins, and the name falls back to the tab it is wearing
      sendCommand({ type: "rename-workspace", id: workspace.id, name: "" });
      const unpinned = await waitForEvent(
        (event) => event.type === "workspace-renamed",
      );
      assert.equal(
        findWorkspace({ state: unpinned.state, id: workspace.id })?.name,
        "linker",
        "unpinning left the workspace with its pinned name",
      );
    },
  });

  busTest({
    name: "the × on a sidebar row closes that workspace",
    body: async () => {
      const workspace = await openWorkspace();
      // The waiter goes up before the click: the × travels to main and back
      // as a Command, so its Event can arrive before the script answers.
      const closing = waitForEvent((event) => event.type === "workspace-closed");
      await lmuxWindow.webContents.executeJavaScript(
        CLICK_LAST_WORKSPACE_CLOSE,
      );
      const closed = await closing;

      assert.equal(
        findWorkspace({ state: closed.state, id: workspace.id }),
        undefined,
        "the × left its workspace in the state",
      );
    },
  });

  busTest({
    name: "a single click on the empty strip under the workspace list opens nothing",
    body: async () => {
      const workspaceCount = lmuxState.workspaces.length;
      await lmuxWindow.webContents.executeJavaScript(CLICK_SIDEBAR);

      // Nothing happening is not something to wait for, so the case asks the
      // bus a question instead: Events leave the page in the order they were
      // emitted, so a workspace this click had opened is already in the state
      // the answer carries. An empty settings update changes nothing and says
      // so in an Event, which is the whole reason it is the question asked.
      const answering = waitForEvent(
        (event) => event.type === "settings-changed",
      );
      sendCommand({ type: "update-settings", settings: {} });
      const answered = await answering;

      assert.equal(
        answered.state.workspaces.length,
        workspaceCount,
        "a single click on the strip opened a workspace",
      );
    },
  });

  busTest({
    name: "a double click on the empty strip under the workspace list opens a workspace",
    body: async () => {
      const workspaceCount = lmuxState.workspaces.length;
      const tabCount = countTabs(lmuxState);
      // The waiter goes up before the click, not after: the click's Events
      // reach main ahead of the script's own answer. A new workspace
      // announces itself, then its first shell, so waiting on the tab count
      // lands on the second one and leaves the next case nothing to read.
      const opening = waitForEvent(
        (event) => countTabs(event.state) === tabCount + 1,
      );
      await lmuxWindow.webContents.executeJavaScript(DOUBLE_CLICK_SIDEBAR);
      const opened = await opening;

      assert.equal(
        opened.state.workspaces.length,
        workspaceCount + 1,
        "the double click on the strip opened a tab, not a workspace",
      );
    },
  });

  busTest({
    name: "reloading a document keeps the reader's place",
    body: async () => {
      const tabCount = countTabs(lmuxState);
      sendCommand({ type: "open-markdown", path: FIXTURE_PATH });
      const opened = await waitForEvent(
        (event) => countTabs(event.state) === tabCount + 1,
      );
      if (opened.type !== "tab-opened") {
        throw new Error(`a tab arrived as a ${opened.type}`);
      }

      // mermaid replaces its fence with a drawing well after the text lands,
      // and the document grows when it does: measuring before that settles
      // would take a position against one document and check it against
      // another.
      let previousHeight = -1;
      await pollUntil({
        check: async () => {
          const probed = await visibleDocument();
          const settled =
            probed.diagramCount > 0 &&
            probed.maximumScrollTop === previousHeight;
          previousHeight = probed.maximumScrollTop;
          return settled;
        },
        description: "the drawn document's height to settle",
      });

      // Halfway, not the bottom: a position resting against the bottom moves
      // on its own whenever the viewport changes height, and the window does
      // change height under this suite. Halfway down the drawn document is
      // still far below the bottom of the undrawn one, which is what a
      // restore that ran too early would clamp to.
      const drawn = await visibleDocument();
      const target = Math.round(drawn.maximumScrollTop / 2);
      assert.ok(target > 0, "the fixture is too short to scroll");
      assert.equal(
        await scrollDocumentTo(target),
        target,
        "the document would not take the position to restore",
      );

      // the one case the state cannot answer: a reload changes none of it,
      // so the Event itself is the signal
      sendCommand({ type: "reload-markdown", id: opened.id });
      await waitForEvent((event) => event.type === "markdown-reloaded");

      const restored = await visibleDocument();
      assert.equal(
        restored.scrollTop,
        target,
        `the reload moved the reader within a document ${restored.maximumScrollTop} tall`,
      );
    },
  });

  busTest({
    name: "a code file opens in an editor, coloured by its grammar",
    body: async () => {
      const tabCount = countTabs(lmuxState);
      sendCommand({
        type: "open-file",
        path: SOURCE_FILE_PATH,
      });
      const opened = await waitForEvent(
        (event) => countTabs(event.state) === tabCount + 1,
      );
      if (opened.type !== "tab-opened") {
        throw new Error(`a tab arrived as a ${opened.type}`);
      }

      assert.equal(
        findTabTitle({
          state: opened.state,
          id: opened.id,
        }),
        "code.ts",
        "the tab is not named for the file it shows",
      );

      // A language's grammar is imported the first time it is needed, so the
      // first paint carries no colours at all. Asserting on that paint would
      // pass against an editor that never highlights anything: what says the
      // grammar arrived is the tokens being told apart, which is more than
      // the one class an unhighlighted document uses.
      await pollUntil({
        check: async () => {
          const classes = tokenClassSchema.parse(
            await lmuxWindow.webContents.executeJavaScript(
              VISIBLE_CODE_TOKEN_CLASSES,
            ),
          );
          return classes.length > 2;
        },
        description: "the TypeScript grammar to colour the tokens",
      });

      const screen = screenSchema.parse(
        await callTool({
          name: "screen",
          toolArguments: {
            tabId: opened.id,
          },
        }),
      );
      assert.equal(screen.kind, "code");
      assert.equal(
        screen.language,
        "typescript",
        "the editor did not recognise a .ts file",
      );
    },
  });

  busTest({
    name: "a project tree follows the terminal's git root and opens a selected file",
    body: async () => {
      const rootPath = mkdtempSync(path.join(os.tmpdir(), "lmux-tree-"));
      const nestedPath = path.join(rootPath, "nested");
      const filePath = path.join(rootPath, "project.ts");
      mkdirSync(nestedPath);
      writeFileSync(filePath, "export const project = true;\n");
      execFileSync("git", ["init", "--quiet", rootPath]);
      const canonicalRootPath = realpathSync(rootPath);
      const canonicalFilePath = path.join(canonicalRootPath, "project.ts");

      let terminalId: number | undefined;
      for (const workspace of lmuxState.workspaces) {
        if (terminalId !== undefined) {
          break;
        }
        for (const tab of workspace.tabs) {
          if (tab.kind === "terminal") {
            terminalId = tab.id;
            break;
          }
        }
      }
      if (terminalId === undefined) {
        rmSync(rootPath, {
          recursive: true,
          force: true,
        });
        throw new Error("the tree case found no terminal");
      }

      const quotedNestedPath =
        "'" + nestedPath.replaceAll("'", "'\"'\"'") + "'";
      const PROJECT_READY = "LMUX_TREE_PROJECT_READY";
      sendCommand({
        type: "write",
        id: terminalId,
        // A split marker keeps PTY input echo from looking like completion.
        text: `cd ${quotedNestedPath} && printf 'LMUX_TREE_PROJECT_%s\\n' READY\n`,
      });
      await waitForTerminalText({
        terminalId,
        text: PROJECT_READY,
        description: "the test shell to enter the nested project directory",
      });

      try {
        const tabCount = countTabs(lmuxState);
        sendCommand({
          type: "open-tree",
          baseTabId: terminalId,
        });
        const opened = await waitForEvent(
          (event) => countTabs(event.state) === tabCount + 1,
        );
        if (opened.type !== "tab-opened") {
          throw new Error(`a tab arrived as a ${opened.type}`);
        }

        let openedTreePath: string | undefined;
        for (const workspace of opened.state.workspaces) {
          for (const tab of workspace.tabs) {
            if (tab.id === opened.id && tab.kind === "tree") {
              openedTreePath = tab.path;
            }
          }
        }
        assert.equal(
          openedTreePath,
          canonicalRootPath,
          "the nested shell directory did not resolve to its git root",
        );
        assert.equal(
          findTabTitle({
            state: opened.state,
            id: opened.id,
          }),
          path.basename(rootPath),
          "the tree tab is not named for the project root",
        );

        const treeScreen = screenSchema.parse(
          await callTool({
            name: "screen",
            toolArguments: { tabId: opened.id },
          }),
        );
        assert.equal(treeScreen.kind, "tree");
        assert.equal(treeScreen.path, canonicalRootPath);

        const savedSession = sessionFromState(opened.state);
        let savedTreePath: string | undefined;
        for (const workspace of savedSession.workspaces) {
          for (const tab of workspace.tabs) {
            if (tab.kind === "tree") {
              savedTreePath = tab.path;
            }
          }
        }
        assert.equal(
          savedTreePath,
          canonicalRootPath,
          "the session did not keep the tree's resolved root",
        );

        const fileOpened = waitForEvent(
          (event) => countTabs(event.state) === tabCount + 2,
        );
        const clicked = await clickVisibleTreeFile({
          relativePath: "project.ts",
        });
        assert.equal(clicked.clicked, true, "the project file was not in the tree");
        assert.equal(clicked.gitVisible, false, ".git appeared in the project tree");

        const openedFile = await fileOpened;
        if (openedFile.type !== "tab-opened") {
          throw new Error(`a tab arrived as a ${openedFile.type}`);
        }
        assert.equal(
          findTabTitle({
            state: openedFile.state,
            id: openedFile.id,
          }),
          "project.ts",
          "selecting the file did not open a code tab",
        );
        const fileScreen = screenSchema.parse(
          await callTool({
            name: "screen",
            toolArguments: { tabId: openedFile.id },
          }),
        );
        assert.equal(fileScreen.kind, "code");
        assert.equal(fileScreen.path, canonicalFilePath);

        const treeActivated = waitForEvent(
          (event) => event.type === "tab-activated" && event.id === opened.id,
        );
        sendCommand({
          type: "activate-tab",
          id: opened.id,
        });
        await treeActivated;

        const fileReopened = waitForEvent(
          (event) => countTabs(event.state) === tabCount + 3,
        );
        const clickedAgain = await clickVisibleTreeFile({
          relativePath: "project.ts",
        });
        assert.equal(
          clickedAgain.clicked,
          true,
          "the selected project file could not be clicked again",
        );
        const reopenedFile = await fileReopened;
        assert.equal(
          reopenedFile.type,
          "tab-opened",
          "clicking the selected file did not open it again",
        );
      } finally {
        const SHELL_RESET = "LMUX_TREE_SHELL_RESET";
        sendCommand({
          type: "write",
          id: terminalId,
          text: "cd ~ && printf 'LMUX_TREE_SHELL_%s\\n' RESET\n",
        });
        try {
          await waitForTerminalText({
            terminalId,
            text: SHELL_RESET,
            description: "the test shell to leave the temporary project",
          });
        } finally {
          rmSync(rootPath, {
            recursive: true,
            force: true,
          });
        }
      }
    },
  });

  busTest({
    name: "editing a code tab marks it dirty, and saving writes it to disk",
    body: async () => {
      // A dedicated fixture, written and deleted by the case: the save is a
      // real disk write, and the app's own source is not a file to trample
      // on (the test above only reads it).
      const filePath = path.join(os.tmpdir(), `lmux-save-${process.pid}.ts`);
      const initialContent = "export const value = 1;\n";
      writeFileSync(filePath, initialContent);

      try {
        const tabCount = countTabs(lmuxState);
        sendCommand({ type: "open-file", path: filePath });
        const opened = await waitForEvent(
          (event) => countTabs(event.state) === tabCount + 1,
        );
        if (opened.type !== "tab-opened") {
          throw new Error(`a tab arrived as a ${opened.type}`);
        }

        // openCodeTab awaited Monaco, so the editor exists once the tab is
        // open; find it by the fixture's unique content and type through the
        // editor. The waiter goes up first because the change travels to main
        // and back before the script's own answer.
        const EDITED = "\n// edited in the suite\n";
        const dirtying = waitForEvent(
          (event) => event.type === "dirty-changed",
        );
        const probed = editorTypingSchema.parse(
          await lmuxWindow.webContents.executeJavaScript(`(() => {
            const expected = ${JSON.stringify(initialContent)};
            let target = null;
            for (const editor of window.monaco.editor.getEditors()) {
              const model = editor.getModel();
              if (model !== null && model.getValue() === expected) {
                target = editor;
                break;
              }
            }
            if (target === null) {
              return {
                found: false,
                edited: false,
              };
            }
            target.focus();
            target.trigger("keyboard", "type", {
              text: ${JSON.stringify(EDITED)},
            });
            return {
              found: true,
              edited: target.getValue() !== expected,
            };
          })()`),
        );
        assert.equal(
          probed.found,
          true,
          "the suite could not find the editor it opened",
        );
        assert.equal(
          probed.edited,
          true,
          "typing did not change the editor",
        );

        const dirty = await dirtying;
        assert.equal(
          findCodeDirty({ state: dirty.state, id: opened.id }),
          true,
          "an edit did not mark the code tab dirty",
        );

        sendCommand({ type: "save-file", id: opened.id });
        const saved = await waitForEvent(
          (event) => event.type === "file-saved",
        );
        assert.equal(
          findCodeDirty({ state: saved.state, id: opened.id }),
          false,
          "saving left the code tab dirty",
        );
        assert.match(
          readFileSync(filePath, "utf8"),
          /edited in the suite/,
          "save did not reach disk",
        );
      } finally {
        unlinkSync(filePath);
      }
    },
  });

  busTest({
    name: "save refuses to overwrite a file that changed on disk since it was read",
    body: async () => {
      const filePath = path.join(os.tmpdir(), `lmux-stale-${process.pid}.ts`);
      const initialContent = "export const value = 1;\n";
      writeFileSync(filePath, initialContent);

      try {
        const tabCount = countTabs(lmuxState);
        sendCommand({ type: "open-file", path: filePath });
        const opened = await waitForEvent(
          (event) => countTabs(event.state) === tabCount + 1,
        );
        if (opened.type !== "tab-opened") {
          throw new Error(`a tab arrived as a ${opened.type}`);
        }

        // Someone else changes it while we have it open. Set an mtime that is
        // provably different from the read's, so the guard cannot be beaten
        // by two writes landing in the same millisecond. The save below would
        // otherwise write the editor's stale copy over this.
        const EXTERNAL = "// someone else's version\n";
        writeFileSync(filePath, EXTERNAL);
        utimesSync(filePath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

        sendCommand({ type: "save-file", id: opened.id });
        // A refused save emits no Event, so the case asks the DOM what the
        // tab said and the disk what it kept.
        await pollUntil({
          check: async () => {
            const probed = await lmuxWindow.webContents.executeJavaScript(
              `(() => {
                for (const element of document.querySelectorAll(".code-status")) {
                  if (element.classList.contains("visible")) {
                    return element.textContent.includes("changed on disk");
                  }
                }
                return false;
              })()`,
            );
            return probed;
          },
          description: "the refused save to say why",
        });
        assert.equal(
          readFileSync(filePath, "utf8"),
          EXTERNAL,
          "a stale save buried the newer change",
        );
      } finally {
        unlinkSync(filePath);
      }
    },
  });

  busTest({
    name: "the console door refuses what is not a Command",
    body: async () => {
      const tabCount = countTabs(lmuxState);
      // a plausible typo rather than nonsense: groupId is a string, and a
      // number used to travel all the way to a group lookup that found
      // nothing and returned, which looks exactly like a broken app
      assert.ok(
        await consoleDoorRefuses(`{ type: "new-tab", groupId: 7 }`),
        "the door took a Command with a groupId of the wrong type",
      );

      // the fence again: a Command that does land, so what follows rests on
      // a snapshot rather than on a timeout
      sendCommand({ type: "rename-workspace", name: "fence" });
      const fenced = await waitForEvent(
        (event) => event.type === "workspace-renamed",
      );
      assert.equal(
        countTabs(fenced.state),
        tabCount,
        "the refused Command opened a tab anyway",
      );
    },
  });

  // Last: it closes every other workspace to get to the one that matters.
  busTest({
    name: "the last workspace refuses to close",
    body: async () => {
      while (lmuxState.workspaces.length > 1) {
        const doomed = lmuxState.workspaces.at(-1);
        if (doomed === undefined) {
          break;
        }
        const remaining = lmuxState.workspaces.length - 1;
        sendCommand({ type: "close-workspace", id: doomed.id });
        await waitForEvent(
          (event) => event.state.workspaces.length === remaining,
        );
      }
      const survivor = lmuxState.workspaces.at(0);
      if (survivor === undefined) {
        throw new Error("the app closed its way down to nothing");
      }

      const tabCount = countTabs(lmuxState);
      sendCommand({ type: "close-workspace", id: survivor.id });
      // A refused Command emits nothing, so there is nothing to wait for: a
      // Command that does emit fences it, and the snapshot that one carries
      // is the proof, rather than a timeout meaning success.
      sendCommand({ type: "new-tab" });
      const fenced = await waitForEvent(
        (event) => countTabs(event.state) === tabCount + 1,
      );

      assert.equal(
        fenced.state.workspaces.length,
        1,
        "the last workspace closed",
      );
      assert.equal(fenced.state.workspaces.at(0)?.id, survivor.id);
    },
  });

  busTest({
    name: "a Command over the socket is answered with the state it produced",
    body: async () => {
      const before = countTabs(lmuxState);
      const answered = stateSchema.parse(
        await callTool({
          name: "command",
          toolArguments: {
            command: { type: "new-tab" },
          },
        }),
      );

      // The point of the settle: the answer already holds the tab, so a
      // caller learns the id it just created without asking again.
      assert.equal(
        countTabs(answered),
        before + 1,
        "the answer did not wait for the tab it opened",
      );
      assert.deepEqual(
        answered,
        stateSchema.parse(lmuxState),
        "the answer disagrees with the read model it was taken from",
      );
    },
  });

  busTest({
    name: "a screen read is what the terminal shows, rejoined across wraps",
    body: async () => {
      const opened = stateSchema.parse(
        await callTool({
          name: "command",
          toolArguments: {
            command: { type: "new-tab" },
          },
        }),
      );
      const tab = opened.workspaces.at(-1)?.tabs.at(-1);
      if (tab === undefined) {
        throw new Error("new-tab opened nothing");
      }
      const tabId = tab.id;

      async function screen(): Promise<z.infer<typeof screenSchema>> {
        return screenSchema.parse(
          await callTool({
            name: "screen",
            toolArguments: {
              tabId,
            },
          }),
        );
      }

      // A shell that has not drawn its prompt yet would swallow the keys,
      // so the case waits for the tab to show something first.
      await pollUntil({
        check: async () => {
          const drawn = await screen();
          return drawn.lines !== undefined && drawn.lines.length > 0;
        },
        description: "the shell to reach its prompt",
      });

      // Longer than any terminal is wide, so the row it prints on is stored
      // as several and has to come back as one.
      const WRAPPED_WIDTH = 200;
      sendCommand({
        type: "write",
        id: tab.id,
        text: `printf 'a%.0s' {1..${WRAPPED_WIDTH}}; echo\n`,
      });

      let lines: string[] = [];
      await pollUntil({
        check: async () => {
          const drawn = await screen();
          if (drawn.lines === undefined) {
            return false;
          }
          lines = drawn.lines;
          for (const line of lines) {
            if (line === "a".repeat(WRAPPED_WIDTH)) {
              return true;
            }
          }
          return false;
        },
        description: "the wrapped line to come back whole",
      });

      assert.ok(
        lines.length > 0,
        "the screen read answered with no lines at all",
      );
    },
  });
});

await suite;
endRun();
