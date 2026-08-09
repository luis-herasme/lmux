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
import type { LmuxState, TabInfo, WorkspaceInfo } from "../api.ts";

// tsc emits no .md, so the fixture is read from source, the way main reads
// index.html.
const FIXTURE_PATH = path.join(
  import.meta.dirname,
  "../../src/test/fixtures/document.md",
);

// A real source file rather than a fixture: the case is about a grammar
// recognising TypeScript, and the app's own code is the TypeScript nearest
// to hand.
const SOURCE_FILE_PATH = realpathSync(
  path.join(
    import.meta.dirname,
    "../../src/renderer/code.ts",
  ),
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

function findTabInfo({ state, id }: StateLookupOptions): TabInfo | undefined {
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      if (tab.id === id) {
        return tab;
      }
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

type FindProjectFileDirtyOptions = StateLookupOptions & {
  filePath: string;
};

function findProjectFileDirty({
  state,
  id,
  filePath,
}: FindProjectFileDirtyOptions): boolean | undefined {
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      if (tab.id !== id || tab.kind !== "project") {
        continue;
      }
      for (const file of tab.files) {
        if (file.path === filePath) {
          return file.dirty;
        }
      }
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
  language: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  workspaceRootPath: z.string().optional(),
});

const tokenClassSchema = z.array(z.string());
const editorTypingSchema = z.object({
  editorFound: z.boolean(),
  edited: z.boolean(),
});

type EditOpenEditorOptions = {
  expectedContent: string;
  addedContent: string;
};

async function editOpenEditor({
  expectedContent,
  addedContent,
}: EditOpenEditorOptions): Promise<z.infer<typeof editorTypingSchema>> {
  const result = await lmuxWindow.webContents.executeJavaScript(`(() => {
    const expected = ${JSON.stringify(expectedContent)};
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
        editorFound: false,
        edited: false,
      };
    }
    target.focus();
    target.trigger("keyboard", "type", {
      text: ${JSON.stringify(addedContent)},
    });
    return {
      editorFound: true,
      edited: target.getValue() !== expected,
    };
  })()`);
  return editorTypingSchema.parse(result);
}

const treeClickSchema = z.object({
  clicked: z.boolean(),
  gitVisible: z.boolean(),
});

type ClickVisibleTreeFileOptions = {
  relativePath: string;
  clickCount?: number;
};

async function clickVisibleTreeFile({
  relativePath,
  clickCount,
}: ClickVisibleTreeFileOptions) {
  let resolvedClickCount = clickCount;
  if (resolvedClickCount === undefined) {
    resolvedClickCount = 1;
  }
  const probed = await lmuxWindow.webContents.executeJavaScript(`(() => {
    for (const treeElement of document.querySelectorAll(".project-tree")) {
      if (treeElement.offsetParent === null) {
        continue;
      }
      const host = treeElement.querySelector("file-tree-container");
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
      target.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        composed: true,
        detail: ${resolvedClickCount},
      }));
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
    name: "a code file opens inside the workspace project tab",
    body: async () => {
      const tabCount = countTabs(lmuxState);
      sendCommand({
        type: "open-file",
        path: SOURCE_FILE_PATH,
      });
      const opened = await waitForEvent(
        (event) =>
          event.type === "file-opened" && event.path === SOURCE_FILE_PATH,
      );
      if (opened.type !== "file-opened") {
        throw new Error(`the file arrived as a ${opened.type}`);
      }
      const project = findTabInfo({
        state: opened.state,
        id: opened.id,
      });
      assert.equal(project?.kind, "project");
      if (project?.kind !== "project") {
        throw new Error("open-file created no project tab");
      }
      assert.equal(countTabs(opened.state), tabCount + 1);
      assert.equal(
        project.title,
        path.basename(realpathSync(path.join(import.meta.dirname, "../.."))),
      );
      assert.equal(project.activeFilePath, SOURCE_FILE_PATH);
      assert.deepEqual(project.files, [
        {
          path: SOURCE_FILE_PATH,
          dirty: false,
          pinned: true,
        },
      ]);

      // A language's grammar is imported the first time it is needed, so the
      // first paint carries no colours at all.
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
      assert.equal(screen.kind, "project");
      assert.equal(screen.path, SOURCE_FILE_PATH);
      assert.equal(screen.language, "typescript");
    },
  });

  busTest({
    name: "one project tab previews and pins files from its workspace tree",
    body: async () => {
      const rootPath = mkdtempSync(path.join(os.tmpdir(), "lmux-tree-"));
      const nestedPath = path.join(rootPath, "nested");
      const filePath = path.join(rootPath, "project.ts");
      const otherFilePath = path.join(rootPath, "other.ts");
      mkdirSync(nestedPath);
      writeFileSync(filePath, "export const project = true;\n");
      writeFileSync(otherFilePath, "export const other = true;\n");
      execFileSync("git", ["init", "--quiet", rootPath]);
      const canonicalRootPath = realpathSync(rootPath);
      const canonicalFilePath = path.join(canonicalRootPath, "project.ts");
      const canonicalOtherFilePath = path.join(canonicalRootPath, "other.ts");
      const projectWorkspace = await openWorkspace();

      try {
        const terminalTab = projectWorkspace.tabs.at(0);
        if (terminalTab === undefined || terminalTab.kind !== "terminal") {
          throw new Error("the project workspace has no terminal");
        }
        const terminalId = terminalTab.id;
        const quotedNestedPath =
          "'" + nestedPath.replaceAll("'", "'\"'\"'") + "'";
        const PROJECT_READY = "LMUX_TREE_PROJECT_READY";
        sendCommand({
          type: "write",
          id: terminalId,
          text: `cd ${quotedNestedPath} && printf 'LMUX_TREE_PROJECT_%s\\n' READY\n`,
        });
        await pollUntil({
          check: async () => {
            const terminalScreen = screenSchema.parse(
              await callTool({
                name: "screen",
                toolArguments: { tabId: terminalId },
              }),
            );
            if (
              terminalScreen.kind !== "terminal" ||
              terminalScreen.lines === undefined
            ) {
              return false;
            }
            for (const line of terminalScreen.lines) {
              if (line.includes(PROJECT_READY)) {
                return true;
              }
            }
            return false;
          },
          description: "the test shell to enter the nested workspace directory",
        });

        const tabCount = countTabs(lmuxState);
        sendCommand({
          type: "open-project",
          baseTabId: terminalId,
        });
        const opened = await waitForEvent(
          (event) => countTabs(event.state) === tabCount + 1,
        );
        if (opened.type !== "tab-opened") {
          throw new Error(`a tab arrived as a ${opened.type}`);
        }

        const openedProject = findTabInfo({
          state: opened.state,
          id: opened.id,
        });
        assert.deepEqual(openedProject, {
          id: opened.id,
          title: path.basename(canonicalRootPath),
          kind: "project",
          workspaceRootPath: canonicalRootPath,
          activeFilePath: null,
          files: [],
        });

        const projectScreen = screenSchema.parse(
          await callTool({
            name: "screen",
            toolArguments: { tabId: opened.id },
          }),
        );
        assert.equal(projectScreen.kind, "project");
        assert.equal(projectScreen.workspaceRootPath, canonicalRootPath);
        assert.equal(projectScreen.path, null);

        const firstOpening = waitForEvent(
          (event) =>
            event.type === "file-opened" &&
            event.path === canonicalFilePath,
        );
        const firstClick = await clickVisibleTreeFile({
          relativePath: "project.ts",
        });
        assert.equal(firstClick.clicked, true);
        assert.equal(firstClick.gitVisible, false, ".git appeared in the tree");
        const firstOpened = await firstOpening;
        assert.equal(countTabs(firstOpened.state), tabCount + 1);

        const secondOpening = waitForEvent(
          (event) =>
            event.type === "file-opened" &&
            event.path === canonicalOtherFilePath,
        );
        const secondClick = await clickVisibleTreeFile({
          relativePath: "other.ts",
        });
        assert.equal(secondClick.clicked, true);
        const secondOpened = await secondOpening;
        const secondProject = findTabInfo({
          state: secondOpened.state,
          id: opened.id,
        });
        assert.equal(secondProject?.kind, "project");
        if (secondProject?.kind !== "project") {
          throw new Error("the project tab disappeared");
        }
        assert.deepEqual(secondProject.files, [
          {
            path: canonicalOtherFilePath,
            dirty: false,
            pinned: false,
          },
        ]);

        const pinning = waitForEvent(
          (event) =>
            event.type === "file-activated" &&
            event.path === canonicalOtherFilePath,
        );
        await clickVisibleTreeFile({
          relativePath: "other.ts",
          clickCount: 2,
        });
        const pinned = await pinning;
        const pinnedProject = findTabInfo({
          state: pinned.state,
          id: opened.id,
        });
        assert.equal(pinnedProject?.kind, "project");
        if (pinnedProject?.kind !== "project") {
          throw new Error("pinning lost the project tab");
        }
        assert.equal(pinnedProject.files.at(0)?.pinned, true);

        const savedProject = sessionFromState(pinned.state)
          .workspaces.at(-1)
          ?.tabs.at(-1);
        assert.deepEqual(savedProject, {
          kind: "project",
          workspaceRootPath: canonicalRootPath,
          files: [canonicalOtherFilePath],
          activeFilePath: canonicalOtherFilePath,
        });

        const nextPreview = waitForEvent(
          (event) =>
            event.type === "file-opened" &&
            event.path === canonicalFilePath,
        );
        await clickVisibleTreeFile({ relativePath: "project.ts" });
        const previewed = await nextPreview;
        const previewedProject = findTabInfo({
          state: previewed.state,
          id: opened.id,
        });
        assert.equal(previewedProject?.kind, "project");
        if (previewedProject?.kind !== "project") {
          throw new Error("previewing lost the project tab");
        }
        assert.equal(previewedProject.files.length, 2);
        assert.equal(previewedProject.files.at(1)?.pinned, false);

        const tabPinning = waitForEvent(
          (event) =>
            event.type === "file-activated" &&
            event.path === canonicalFilePath,
        );
        const tabDoubleClicked = z.boolean().parse(
          await lmuxWindow.webContents.executeJavaScript(`(() => {
            const element = document.querySelector(".file-tab.active");
            if (!(element instanceof HTMLElement)) {
              return false;
            }
            element.dispatchEvent(new MouseEvent("dblclick", {
              bubbles: true,
              detail: 2,
            }));
            return true;
          })()`),
        );
        assert.equal(tabDoubleClicked, true);
        const tabPinned = await tabPinning;
        const tabPinnedProject = findTabInfo({
          state: tabPinned.state,
          id: opened.id,
        });
        assert.equal(tabPinnedProject?.kind, "project");
        if (tabPinnedProject?.kind !== "project") {
          throw new Error("file-tab pinning lost the project tab");
        }
        assert.equal(tabPinnedProject.files.at(1)?.pinned, true);

        const canonicalNestedPath = realpathSync(nestedPath);
        sendCommand({
          type: "change-workspace-root",
          workspaceId: projectWorkspace.id,
          path: canonicalNestedPath,
        });
        const rootChanged = await waitForEvent(
          (event) =>
            event.type === "workspace-root-changed" &&
            event.path === canonicalNestedPath,
        );
        const changedProject = findTabInfo({
          state: rootChanged.state,
          id: opened.id,
        });
        assert.equal(changedProject?.kind, "project");
        if (changedProject?.kind !== "project") {
          throw new Error("changing the root lost the project tab");
        }
        assert.equal(changedProject.workspaceRootPath, canonicalNestedPath);
        assert.equal(changedProject.files.length, 2);

        for (const openFile of changedProject.files) {
          const closing = waitForEvent(
            (event) =>
              event.type === "file-closed" && event.path === openFile.path,
          );
          sendCommand({
            type: "close-file",
            projectTabId: opened.id,
            path: openFile.path,
          });
          await closing;
        }
        const emptiedProject = findTabInfo({
          state: lmuxState,
          id: opened.id,
        });
        assert.equal(emptiedProject?.kind, "project");
        if (emptiedProject?.kind !== "project") {
          throw new Error("closing files closed the project tab");
        }
        assert.equal(emptiedProject.activeFilePath, null);
        assert.equal(emptiedProject.files.length, 0);
        assert.equal(countTabs(lmuxState), tabCount + 1);
      } finally {
        const workspaceClosed = waitForEvent(
          (event) =>
            event.type === "workspace-closed" &&
            event.id === projectWorkspace.id,
        );
        sendCommand({
          type: "close-workspace",
          id: projectWorkspace.id,
        });
        try {
          await workspaceClosed;
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
    name: "editing a project file pins it, marks it dirty and saves it",
    body: async () => {
      // A dedicated fixture, written and deleted by the case: the save is a
      // real disk write, and the app's own source is not a file to trample
      // on (the test above only reads it).
      const filePath = path.join(os.tmpdir(), `lmux-save-${process.pid}.ts`);
      const initialContent = "export const value = 1;\n";
      writeFileSync(filePath, initialContent);
      const canonicalFilePath = realpathSync(filePath);

      try {
        sendCommand({ type: "open-file", path: filePath });
        const opened = await waitForEvent(
          (event) =>
            event.type === "file-opened" && event.path === canonicalFilePath,
        );
        if (opened.type !== "file-opened") {
          throw new Error(`the file arrived as a ${opened.type}`);
        }

        // Find the fixture's unique model and type through the real editor.
        // The waiter goes up first because the change travels to main and
        // back before the script's own answer.
        const EDITED = "\n// edited in the suite\n";
        const dirtying = waitForEvent(
          (event) =>
            event.type === "dirty-changed" &&
            event.path === canonicalFilePath,
        );
        const probed = await editOpenEditor({
          expectedContent: initialContent,
          addedContent: EDITED,
        });
        assert.equal(
          probed.editorFound,
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
          findProjectFileDirty({
            state: dirty.state,
            id: opened.id,
            filePath: canonicalFilePath,
          }),
          true,
          "an edit did not mark the project file dirty",
        );
        const dirtyProject = findTabInfo({
          state: dirty.state,
          id: opened.id,
        });
        assert.equal(dirtyProject?.kind, "project");
        if (dirtyProject?.kind !== "project") {
          throw new Error("editing lost the project tab");
        }
        let dirtyFilePinned: boolean | undefined;
        for (const projectFile of dirtyProject.files) {
          if (projectFile.path === canonicalFilePath) {
            dirtyFilePinned = projectFile.pinned;
            break;
          }
        }
        assert.equal(
          dirtyFilePinned,
          true,
          "editing left a preview replaceable",
        );

        const switchingAway = waitForEvent(
          (event) =>
            (event.type === "file-opened" ||
              event.type === "file-activated") &&
            event.path === SOURCE_FILE_PATH,
        );
        sendCommand({
          type: "open-file",
          path: SOURCE_FILE_PATH,
        });
        await switchingAway;
        const switchingBack = waitForEvent(
          (event) =>
            event.type === "file-activated" &&
            event.path === canonicalFilePath,
        );
        sendCommand({
          type: "activate-file",
          projectTabId: opened.id,
          path: canonicalFilePath,
        });
        await switchingBack;
        const editSurvived = z.boolean().parse(
          await lmuxWindow.webContents.executeJavaScript(`(() => {
            for (const editor of window.monaco.editor.getEditors()) {
              if (editor.getValue().includes(${JSON.stringify(EDITED)})) {
                return true;
              }
            }
            return false;
          })()`),
        );
        assert.equal(editSurvived, true, "switching files lost unsaved work");

        sendCommand({
          type: "save-file",
          projectTabId: opened.id,
          path: canonicalFilePath,
        });
        const saved = await waitForEvent(
          (event) =>
            event.type === "file-saved" && event.path === canonicalFilePath,
        );
        assert.equal(
          findProjectFileDirty({
            state: saved.state,
            id: opened.id,
            filePath: canonicalFilePath,
          }),
          false,
          "saving left the project file dirty",
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
    name: "Save All writes every dirty project buffer",
    body: async () => {
      const firstPath = path.join(
        os.tmpdir(),
        `lmux-save-all-first-${process.pid}.ts`,
      );
      const secondPath = path.join(
        os.tmpdir(),
        `lmux-save-all-second-${process.pid}.ts`,
      );
      const firstContent = "export const first = 1;\n";
      const secondContent = "export const second = 2;\n";
      const FIRST_EDIT = "\n// first edit\n";
      const SECOND_EDIT = "\n// second edit\n";
      writeFileSync(firstPath, firstContent);
      writeFileSync(secondPath, secondContent);
      const canonicalFirstPath = realpathSync(firstPath);
      const canonicalSecondPath = realpathSync(secondPath);

      try {
        sendCommand({ type: "open-file", path: firstPath });
        const firstOpened = await waitForEvent(
          (event) =>
            event.type === "file-opened" &&
            event.path === canonicalFirstPath,
        );
        if (firstOpened.type !== "file-opened") {
          throw new Error(`the first file arrived as a ${firstOpened.type}`);
        }
        const firstDirtying = waitForEvent(
          (event) =>
            event.type === "dirty-changed" &&
            event.path === canonicalFirstPath,
        );
        const firstEdit = await editOpenEditor({
          expectedContent: firstContent,
          addedContent: FIRST_EDIT,
        });
        assert.equal(firstEdit.edited, true);
        await firstDirtying;

        sendCommand({ type: "open-file", path: secondPath });
        await waitForEvent(
          (event) =>
            event.type === "file-opened" &&
            event.path === canonicalSecondPath,
        );
        const secondDirtying = waitForEvent(
          (event) =>
            event.type === "dirty-changed" &&
            event.path === canonicalSecondPath,
        );
        const secondEdit = await editOpenEditor({
          expectedContent: secondContent,
          addedContent: SECOND_EDIT,
        });
        assert.equal(secondEdit.edited, true);
        await secondDirtying;

        sendCommand({
          type: "save-all-files",
          projectTabId: firstOpened.id,
        });
        const finished = await waitForEvent(
          (event) =>
            event.type === "files-save-finished" &&
            event.id === firstOpened.id,
        );
        if (finished.type !== "files-save-finished") {
          throw new Error(`Save All finished as a ${finished.type}`);
        }
        assert.deepEqual(finished.failedPaths, []);
        assert.equal(
          findProjectFileDirty({
            state: finished.state,
            id: firstOpened.id,
            filePath: canonicalFirstPath,
          }),
          false,
        );
        assert.equal(
          findProjectFileDirty({
            state: finished.state,
            id: firstOpened.id,
            filePath: canonicalSecondPath,
          }),
          false,
        );
        assert.match(readFileSync(firstPath, "utf8"), /first edit/);
        assert.match(readFileSync(secondPath, "utf8"), /second edit/);

        for (const filePath of [canonicalFirstPath, canonicalSecondPath]) {
          const closing = waitForEvent(
            (event) =>
              event.type === "file-closed" && event.path === filePath,
          );
          sendCommand({
            type: "close-file",
            projectTabId: firstOpened.id,
            path: filePath,
          });
          await closing;
        }
      } finally {
        unlinkSync(firstPath);
        unlinkSync(secondPath);
      }
    },
  });

  busTest({
    name: "save refuses to overwrite a file that changed on disk since it was read",
    body: async () => {
      const filePath = path.join(os.tmpdir(), `lmux-stale-${process.pid}.ts`);
      const initialContent = "export const value = 1;\n";
      writeFileSync(filePath, initialContent);
      const canonicalFilePath = realpathSync(filePath);

      try {
        sendCommand({ type: "open-file", path: filePath });
        const opened = await waitForEvent(
          (event) =>
            event.type === "file-opened" && event.path === canonicalFilePath,
        );
        if (opened.type !== "file-opened") {
          throw new Error(`the file arrived as a ${opened.type}`);
        }

        // Someone else changes it while we have it open. Set an mtime that is
        // provably different from the read's, so the guard cannot be beaten
        // by two writes landing in the same millisecond. The save below would
        // otherwise write the editor's stale copy over this.
        const EXTERNAL = "// someone else's version\n";
        writeFileSync(filePath, EXTERNAL);
        utimesSync(filePath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

        sendCommand({
          type: "save-file",
          projectTabId: opened.id,
          path: canonicalFilePath,
        });
        await waitForEvent(
          (event) =>
            event.type === "file-save-failed" &&
            event.path === canonicalFilePath,
        );
        // The case asks the DOM what the project tab said and the disk what
        // it kept.
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
