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
  renameSync,
  rmSync,
  symlinkSync,
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
import { readProjectTreeGitDecorationsResultSchema } from "../ipc/bridge.ts";
import { matchTerminalLinks } from "../renderer/tabs/links.ts";

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
    "../../src/renderer/tabs/code.ts",
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
      let target = null;
      let gitVisible = false;
      for (const item of treeElement.querySelectorAll("[data-project-tree-path]")) {
        const itemPath = item.getAttribute("data-project-tree-path");
        if (itemPath === ".git") {
          gitVisible = true;
        }
        if (
          itemPath === ${JSON.stringify(relativePath)} &&
          item.getAttribute("data-project-tree-kind") === "file"
        ) {
          target = item;
        }
      }
      if (!(target instanceof HTMLElement)) {
        return { clicked: false, gitVisible };
      }
      target.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        detail: ${resolvedClickCount},
      }));
      return { clicked: true, gitVisible };
    }
    return { clicked: false, gitVisible: false };
  })()`);
  return treeClickSchema.parse(probed);
}

async function visibleTreeItemExists(relativePath: string): Promise<boolean> {
  const result = await lmuxWindow.webContents.executeJavaScript(`(() => {
    for (const treeElement of document.querySelectorAll(".project-tree")) {
      if (treeElement.offsetParent === null) {
        continue;
      }
      for (const item of treeElement.querySelectorAll("[data-project-tree-path]")) {
        if (item.getAttribute("data-project-tree-path") === ${JSON.stringify(relativePath)}) {
          return true;
        }
      }
    }
    return false;
  })()`);
  return z.boolean().parse(result);
}

async function expandVisibleTreeDirectory(relativePath: string): Promise<boolean> {
  const result = await lmuxWindow.webContents.executeJavaScript(`(() => {
    for (const treeElement of document.querySelectorAll(".project-tree")) {
      if (treeElement.offsetParent === null) {
        continue;
      }
      for (const item of treeElement.querySelectorAll("[data-project-tree-path]")) {
        if (
          item.getAttribute("data-project-tree-path") === ${JSON.stringify(relativePath)} &&
          item.getAttribute("data-project-tree-kind") === "directory" &&
          item instanceof HTMLElement
        ) {
          item.click();
          return true;
        }
      }
    }
    return false;
  })()`);
  return z.boolean().parse(result);
}

const projectTreeResizeResultSchema = z.object({
  found: z.boolean(),
  initialWidth: z.number(),
  pointerWidth: z.number(),
  keyboardWidth: z.number(),
  role: z.string().nullable(),
  orientation: z.string().nullable(),
});

const projectTreeAppearanceSchema = z.object({
  rootPaddingLeft: z.number(),
  disclosureUsesCodicon: z.boolean(),
  folderIconUsesCodicon: z.boolean(),
  fileIconUsesCodicon: z.boolean(),
  nameAlignmentDifference: z.number(),
  decorativeIconsHidden: z.boolean(),
  labelsMatchNames: z.boolean(),
});

type ProjectTreeAppearance = z.infer<typeof projectTreeAppearanceSchema>;

async function visibleProjectTreeAppearance(): Promise<ProjectTreeAppearance> {
  const result = await lmuxWindow.webContents.executeJavaScript(`(async () => {
    await document.fonts.load("16px codicon");
    for (const treeElement of document.querySelectorAll(".project-tree")) {
      if (treeElement.offsetParent === null) {
        continue;
      }
      const rootElement = treeElement.querySelector(".project-tree-root");
      const directoryElement = treeElement.querySelector(
        ".project-tree-directory > summary",
      );
      if (
        !(rootElement instanceof HTMLElement) ||
        !(directoryElement instanceof HTMLElement)
      ) {
        continue;
      }
      const disclosureElement = directoryElement.querySelector(
        ".project-tree-disclosure",
      );
      const folderIconElement = directoryElement.querySelector(
        ".project-tree-folder-icon",
      );
      const directoryNameElement = directoryElement.querySelector(
        ".project-tree-name",
      );
      const fileElement = rootElement.querySelector(
        ":scope > .project-tree-item > .project-tree-file",
      );
      const fileIconElement = fileElement?.querySelector(
        ".project-tree-file-icon",
      );
      const fileNameElement = fileElement?.querySelector(".project-tree-name");
      if (
        !(disclosureElement instanceof HTMLElement) ||
        !(folderIconElement instanceof HTMLElement) ||
        !(directoryNameElement instanceof HTMLElement) ||
        !(fileElement instanceof HTMLElement) ||
        !(fileIconElement instanceof HTMLElement) ||
        !(fileNameElement instanceof HTMLElement)
      ) {
        continue;
      }
      const disclosureStyle = getComputedStyle(disclosureElement, "::before");
      const folderIconStyle = getComputedStyle(folderIconElement, "::before");
      const fileIconStyle = getComputedStyle(fileIconElement, "::before");
      const codiconLoaded = document.fonts.check("16px codicon");
      const appearance = {
        rootPaddingLeft: Number.parseFloat(
          getComputedStyle(rootElement).paddingLeft,
        ),
        disclosureUsesCodicon:
          disclosureStyle.fontFamily.includes("codicon") &&
          disclosureStyle.content !== "none" &&
          codiconLoaded,
        folderIconUsesCodicon:
          folderIconStyle.fontFamily.includes("codicon") &&
          folderIconStyle.content !== "none" &&
          codiconLoaded,
        fileIconUsesCodicon:
          fileIconStyle.fontFamily.includes("codicon") &&
          fileIconStyle.content !== "none" &&
          codiconLoaded,
        nameAlignmentDifference: Math.abs(
          directoryNameElement.getBoundingClientRect().left -
            fileNameElement.getBoundingClientRect().left,
        ),
        decorativeIconsHidden:
          disclosureElement.ariaHidden === "true" &&
          folderIconElement.ariaHidden === "true" &&
          fileIconElement.ariaHidden === "true",
        labelsMatchNames:
          directoryElement.textContent === directoryNameElement.textContent &&
          fileElement.ariaLabel === fileElement.dataset.fileName,
      };
      return appearance;
    }
    return {
      rootPaddingLeft: 0,
      disclosureUsesCodicon: false,
      folderIconUsesCodicon: false,
      fileIconUsesCodicon: false,
      nameAlignmentDifference: -1,
      decorativeIconsHidden: false,
      labelsMatchNames: false,
    };
  })()`);
  return projectTreeAppearanceSchema.parse(result);
}

const gitDecorationAppearanceSchema = z.object({
  exists: z.boolean(),
  decoration: z.string().nullable(),
  badge: z.string().nullable(),
  nameColor: z.string(),
  badgeColor: z.string(),
  expectedColor: z.string(),
  badgeContent: z.string(),
  bubble: z.boolean(),
  badgeUsesCodicon: z.boolean(),
  title: z.string(),
  ariaLabel: z.string().nullable(),
});

type GitDecorationAppearance = z.infer<
  typeof gitDecorationAppearanceSchema
>;

type VisibleGitDecorationOptions = {
  relativePath: string;
};

async function visibleGitDecoration({
  relativePath,
}: VisibleGitDecorationOptions): Promise<GitDecorationAppearance> {
  const result = await lmuxWindow.webContents.executeJavaScript(`(() => {
    const cssVariables = {
      added: "--git-added-foreground",
      conflicting: "--git-conflicting-foreground",
      copied: "--git-renamed-foreground",
      deleted: "--git-deleted-foreground",
      ignored: "--git-ignored-foreground",
      "intent-to-add": "--git-added-foreground",
      "intent-to-rename": "--git-renamed-foreground",
      modified: "--git-modified-foreground",
      renamed: "--git-renamed-foreground",
      "staged-deleted": "--git-stage-deleted-foreground",
      "staged-modified": "--git-stage-modified-foreground",
      submodule: "--git-submodule-foreground",
      "type-changed": "--git-modified-foreground",
      untracked: "--git-untracked-foreground",
    };
    for (const treeElement of document.querySelectorAll(".project-tree")) {
      if (treeElement.offsetParent === null) {
        continue;
      }
      for (const rowElement of treeElement.querySelectorAll(
        "[data-project-tree-path]",
      )) {
        if (
          !(rowElement instanceof HTMLElement) ||
          rowElement.dataset.projectTreePath !== ${JSON.stringify(relativePath)}
        ) {
          continue;
        }
        const nameElement = rowElement.querySelector(".project-tree-name");
        if (!(nameElement instanceof HTMLElement)) {
          continue;
        }
        const decoration = rowElement.dataset.gitDecoration;
        const badgeStyle = getComputedStyle(rowElement, "::after");
        const colorProbe = document.createElement("span");
        if (decoration !== undefined) {
          const cssVariable = cssVariables[decoration];
          if (cssVariable !== undefined) {
            colorProbe.style.color = "var(" + cssVariable + ")";
          }
        }
        treeElement.append(colorProbe);
        let decorationValue = decoration;
        if (decorationValue === undefined) {
          decorationValue = null;
        }
        let badge = rowElement.dataset.gitDecorationBadge;
        if (badge === undefined) {
          badge = null;
        }
        const appearance = {
          exists: true,
          decoration: decorationValue,
          badge,
          nameColor: getComputedStyle(nameElement).color,
          badgeColor: badgeStyle.color,
          expectedColor: getComputedStyle(colorProbe).color,
          badgeContent: badgeStyle.content,
          bubble: rowElement.dataset.gitDecorationBubble === "true",
          badgeUsesCodicon: badgeStyle.fontFamily.includes("codicon"),
          title: rowElement.title,
          ariaLabel: rowElement.ariaLabel,
        };
        colorProbe.remove();
        return appearance;
      }
    }
    return {
      exists: false,
      decoration: null,
      badge: null,
      nameColor: "",
      badgeColor: "",
      expectedColor: "",
      badgeContent: "",
      bubble: false,
      badgeUsesCodicon: false,
      title: "",
      ariaLabel: null,
    };
  })()`);
  return gitDecorationAppearanceSchema.parse(result);
}

async function projectTreeGitDecorationStatuses(
  workspaceRootPath: string,
): Promise<Map<string, string>> {
  const result = readProjectTreeGitDecorationsResultSchema.parse(
    await lmuxWindow.webContents.executeJavaScript(`Reflect
      .get(window, "bridge")
      .readProjectTreeGitDecorations({
        workspaceRootPath: ${JSON.stringify(workspaceRootPath)},
      })`),
  );
  const statuses = new Map<string, string>();
  for (const decoration of result.decorations) {
    statuses.set(decoration.path, decoration.status);
  }
  return statuses;
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
    name: "the project file tree can be resized",
    body: async () => {
      const projectWorkspace = await openWorkspace();
      const terminalTab = projectWorkspace.tabs.at(0);
      if (terminalTab === undefined || terminalTab.kind !== "terminal") {
        throw new Error("the project workspace has no terminal");
      }
      sendCommand({
        type: "open-file",
        path: SOURCE_FILE_PATH,
        baseTabId: terminalTab.id,
      });
      await waitForEvent(
        (event) =>
          event.type === "file-opened" && event.path === SOURCE_FILE_PATH,
      );

      const resizeResult = projectTreeResizeResultSchema.parse(
        await lmuxWindow.webContents.executeJavaScript(`(() => {
          for (const paneElement of document.querySelectorAll(".project-pane")) {
            if (paneElement.offsetParent === null) {
              continue;
            }
            const treeElement = paneElement.querySelector(".project-tree");
            const resizeHandleElement = paneElement.querySelector(
              ".project-tree-resizer",
            );
            if (
              !(treeElement instanceof HTMLElement) ||
              !(resizeHandleElement instanceof HTMLElement)
            ) {
              continue;
            }
            const paneBounds = paneElement.getBoundingClientRect();
            const initialWidth = treeElement.getBoundingClientRect().width;
            const targetClientX = paneBounds.left + initialWidth + 48;
            resizeHandleElement.dispatchEvent(new MouseEvent("mousedown", {
              bubbles: true,
              button: 0,
              clientX: paneBounds.left + initialWidth,
            }));
            document.dispatchEvent(new MouseEvent("mousemove", {
              bubbles: true,
              clientX: targetClientX,
            }));
            document.dispatchEvent(new MouseEvent("mouseup", {
              bubbles: true,
              clientX: targetClientX,
            }));
            const pointerWidth = treeElement.getBoundingClientRect().width;
            resizeHandleElement.dispatchEvent(new KeyboardEvent("keydown", {
              bubbles: true,
              key: "ArrowLeft",
            }));
            return {
              found: true,
              initialWidth,
              pointerWidth,
              keyboardWidth: treeElement.getBoundingClientRect().width,
              role: resizeHandleElement.getAttribute("role"),
              orientation: resizeHandleElement.getAttribute("aria-orientation"),
            };
          }
          return {
            found: false,
            initialWidth: 0,
            pointerWidth: 0,
            keyboardWidth: 0,
            role: null,
            orientation: null,
          };
        })()`),
      );
      assert.equal(resizeResult.found, true);
      assert.ok(
        resizeResult.pointerWidth > resizeResult.initialWidth + 40,
        "dragging the handle did not widen the file tree",
      );
      assert.ok(
        resizeResult.keyboardWidth < resizeResult.pointerWidth,
        "ArrowLeft did not narrow the file tree",
      );
      assert.equal(resizeResult.role, "separator");
      assert.equal(resizeResult.orientation, "vertical");
    },
  });

  busTest({
    name: "one project tab previews and pins files from its workspace tree",
    body: async () => {
      const rootPath = mkdtempSync(path.join(os.tmpdir(), "lmux-tree-"));
      const nestedPath = path.join(rootPath, "nested");
      const nestedFilePath = path.join(nestedPath, "nested.ts");
      const filePath = path.join(rootPath, "project.ts");
      const otherFilePath = path.join(rootPath, "other.ts");
      mkdirSync(nestedPath);
      writeFileSync(nestedFilePath, "export const nested = true;\n");
      writeFileSync(path.join(nestedPath, "nested.ignored"), "ignored\n");
      writeFileSync(filePath, "export const project = true;\n");
      writeFileSync(otherFilePath, "export const other = true;\n");
      writeFileSync(path.join(rootPath, ".gitignore"), "*.ignored\n");
      writeFileSync(path.join(rootPath, "example.ignored"), "ignored\n");
      execFileSync("git", ["init", "--quiet", rootPath]);
      execFileSync("git", [
        "-C",
        rootPath,
        "config",
        "user.name",
        "lmux test",
      ]);
      execFileSync("git", [
        "-C",
        rootPath,
        "config",
        "user.email",
        "lmux@example.test",
      ]);
      execFileSync("git", [
        "-C",
        rootPath,
        "config",
        "commit.gpgSign",
        "false",
      ]);
      execFileSync("git", [
        "-C",
        rootPath,
        "config",
        "core.hooksPath",
        os.devNull,
      ]);
      execFileSync("git", [
        "-C",
        rootPath,
        "config",
        "core.excludesFile",
        os.devNull,
      ]);
      execFileSync("git", [
        "-C",
        rootPath,
        "config",
        "core.attributesFile",
        os.devNull,
      ]);
      execFileSync("git", ["-C", rootPath, "add", "."]);
      execFileSync("git", [
        "-C",
        rootPath,
        "commit",
        "--quiet",
        "-m",
        "Initial tree",
      ]);
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

        assert.equal(await visibleTreeItemExists("nested/nested.ts"), false);
        assert.equal(await expandVisibleTreeDirectory("nested"), true);
        await pollUntil({
          check: () => visibleTreeItemExists("nested/nested.ts"),
          description: "the expanded directory to load its immediate children",
        });
        const treeStyle = await visibleProjectTreeAppearance();
        assert.ok(
          treeStyle.rootPaddingLeft >= 8,
          "the root disclosure touches the tree edge",
        );
        assert.equal(treeStyle.disclosureUsesCodicon, true);
        assert.equal(treeStyle.folderIconUsesCodicon, true);
        assert.equal(treeStyle.fileIconUsesCodicon, true);
        assert.equal(treeStyle.nameAlignmentDifference, 0);
        assert.equal(treeStyle.decorativeIconsHidden, true);
        assert.equal(treeStyle.labelsMatchNames, true);

        const ignoredDecoration = await visibleGitDecoration({
          relativePath: "example.ignored",
        });
        assert.equal(ignoredDecoration.decoration, "ignored");
        assert.equal(ignoredDecoration.badge, null);
        assert.equal(ignoredDecoration.badgeContent, "none");
        assert.equal(ignoredDecoration.nameColor, ignoredDecoration.expectedColor);
        assert.equal(ignoredDecoration.ariaLabel, "example.ignored");

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

        const dirtying = waitForEvent(
          (event) =>
            event.type === "dirty-changed" &&
            event.path === canonicalOtherFilePath,
        );
        const edited = await editOpenEditor({
          expectedContent: "export const other = true;\n",
          addedContent: "// modified\n",
        });
        assert.equal(edited.edited, true);
        await dirtying;
        const unsavedDecoration = await visibleGitDecoration({
          relativePath: "other.ts",
        });
        assert.equal(
          unsavedDecoration.decoration,
          null,
          "an unsaved editor change was mistaken for Git status",
        );
        sendCommand({
          type: "save-file",
          projectTabId: opened.id,
          path: canonicalOtherFilePath,
        });
        await waitForEvent(
          (event) =>
            event.type === "file-saved" &&
            event.path === canonicalOtherFilePath,
        );
        await pollUntil({
          check: async () => {
            const appearance = await visibleGitDecoration({
              relativePath: "other.ts",
            });
            return appearance.decoration === "modified";
          },
          description: "the saved file to retain its Git modification",
        });
        const modifiedDecoration = await visibleGitDecoration({
          relativePath: "other.ts",
        });
        assert.equal(modifiedDecoration.badge, "M");
        assert.equal(modifiedDecoration.nameColor, modifiedDecoration.badgeColor);
        assert.equal(
          modifiedDecoration.nameColor,
          modifiedDecoration.expectedColor,
        );
        assert.match(modifiedDecoration.title, /Modified/);
        assert.equal(modifiedDecoration.ariaLabel, "other.ts, Modified");

        execFileSync("git", ["-C", rootPath, "add", "other.ts"]);
        await pollUntil({
          check: async () => {
            const appearance = await visibleGitDecoration({
              relativePath: "other.ts",
            });
            return appearance.decoration === "staged-modified";
          },
          description: "the staged file decoration to replace working-tree M",
        });
        const stagedDecoration = await visibleGitDecoration({
          relativePath: "other.ts",
        });
        assert.equal(stagedDecoration.badge, "M");
        assert.equal(stagedDecoration.nameColor, stagedDecoration.badgeColor);
        assert.equal(stagedDecoration.nameColor, stagedDecoration.expectedColor);

        writeFileSync(nestedFilePath, "export const nested = false;\n");
        await pollUntil({
          check: async () => {
            const appearance = await visibleGitDecoration({
              relativePath: "nested/nested.ts",
            });
            return appearance.decoration === "modified";
          },
          description: "an external file write to refresh Git decorations",
        });
        const folderDecoration = await visibleGitDecoration({
          relativePath: "nested",
        });
        assert.equal(folderDecoration.decoration, "modified");
        assert.equal(folderDecoration.badge, null);
        assert.equal(folderDecoration.bubble, true);
        assert.equal(folderDecoration.badgeUsesCodicon, true);
        assert.equal(folderDecoration.nameColor, folderDecoration.expectedColor);
        assert.match(folderDecoration.title, /Contains emphasized items/);

        const createdFilePath = path.join(rootPath, "created.ts");
        writeFileSync(createdFilePath, "export const created = true;\n");
        await pollUntil({
          check: async () => {
            const appearance = await visibleGitDecoration({
              relativePath: "created.ts",
            });
            return appearance.decoration === "untracked";
          },
          description: "a new untracked file to appear in the tree",
        });
        const untrackedDecoration = await visibleGitDecoration({
          relativePath: "created.ts",
        });
        assert.equal(untrackedDecoration.badge, "U");
        assert.equal(
          untrackedDecoration.nameColor,
          untrackedDecoration.badgeColor,
        );
        assert.equal(
          untrackedDecoration.nameColor,
          untrackedDecoration.expectedColor,
        );

        execFileSync("git", ["-C", rootPath, "add", "created.ts"]);
        await pollUntil({
          check: async () => {
            const appearance = await visibleGitDecoration({
              relativePath: "created.ts",
            });
            return appearance.decoration === "added";
          },
          description: "the untracked decoration to become staged added",
        });
        const addedDecoration = await visibleGitDecoration({
          relativePath: "created.ts",
        });
        assert.equal(addedDecoration.badge, "A");
        assert.equal(addedDecoration.nameColor, addedDecoration.badgeColor);
        assert.equal(addedDecoration.nameColor, addedDecoration.expectedColor);
        assert.notEqual(
          addedDecoration.nameColor,
          untrackedDecoration.nameColor,
        );

        unlinkSync(createdFilePath);
        await pollUntil({
          check: async () => !(await visibleTreeItemExists("created.ts")),
          description: "an externally deleted file to leave the tree",
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
            for (const paneElement of document.querySelectorAll(".project-pane")) {
              if (paneElement.offsetParent === null) {
                continue;
              }
              const element = paneElement.querySelector(".file-tab.active");
              if (!(element instanceof HTMLElement)) {
                return false;
              }
              element.dispatchEvent(new MouseEvent("dblclick", {
                bubbles: true,
                detail: 2,
              }));
              return true;
            }
            return false;
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

        const nestedIgnoredDecoration = await visibleGitDecoration({
          relativePath: "nested.ignored",
        });
        assert.equal(nestedIgnoredDecoration.decoration, "ignored");
        writeFileSync(path.join(rootPath, ".gitignore"), "*.other\n");
        await pollUntil({
          check: async () => {
            const appearance = await visibleGitDecoration({
              relativePath: "nested.ignored",
            });
            return appearance.decoration === "untracked";
          },
          description: "an ancestor ignore rule to refresh a subdirectory root",
        });

        for (const openFile of changedProject.files) {
          if (openFile.path === null) {
            throw new Error("the disk fixture became an untitled file");
          }
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
    name: "Git status maps every VS Code Explorer decoration state",
    body: async () => {
      const rootPath = mkdtempSync(path.join(os.tmpdir(), "lmux-git-status-"));
      const submoduleSourcePath = mkdtempSync(
        path.join(os.tmpdir(), "lmux-git-submodule-"),
      );
      try {
        execFileSync("git", ["init", "--quiet", submoduleSourcePath]);
        execFileSync("git", [
          "-C",
          submoduleSourcePath,
          "config",
          "user.name",
          "lmux test",
        ]);
        execFileSync("git", [
          "-C",
          submoduleSourcePath,
          "config",
          "user.email",
          "lmux@example.test",
        ]);
        execFileSync("git", [
          "-C",
          submoduleSourcePath,
          "config",
          "commit.gpgSign",
          "false",
        ]);
        execFileSync("git", [
          "-C",
          submoduleSourcePath,
          "config",
          "core.hooksPath",
          os.devNull,
        ]);
        execFileSync("git", [
          "-C",
          submoduleSourcePath,
          "config",
          "core.excludesFile",
          os.devNull,
        ]);
        execFileSync("git", [
          "-C",
          submoduleSourcePath,
          "config",
          "core.attributesFile",
          os.devNull,
        ]);
        writeFileSync(
          path.join(submoduleSourcePath, "module.ts"),
          "export const module = true;\n",
        );
        execFileSync("git", ["-C", submoduleSourcePath, "add", "."]);
        execFileSync("git", [
          "-C",
          submoduleSourcePath,
          "commit",
          "--quiet",
          "-m",
          "Initial submodule",
        ]);

        execFileSync("git", ["init", "--quiet", rootPath]);
        execFileSync("git", [
          "-C",
          rootPath,
          "config",
          "user.name",
          "lmux test",
        ]);
        execFileSync("git", [
          "-C",
          rootPath,
          "config",
          "user.email",
          "lmux@example.test",
        ]);
        execFileSync("git", [
          "-C",
          rootPath,
          "config",
          "commit.gpgSign",
          "false",
        ]);
        execFileSync("git", [
          "-C",
          rootPath,
          "config",
          "core.hooksPath",
          os.devNull,
        ]);
        execFileSync("git", [
          "-C",
          rootPath,
          "config",
          "core.excludesFile",
          os.devNull,
        ]);
        execFileSync("git", [
          "-C",
          rootPath,
          "config",
          "core.attributesFile",
          os.devNull,
        ]);
        execFileSync("git", [
          "-C",
          rootPath,
          "config",
          "status.renames",
          "copies",
        ]);
        const trackedFiles = [
          "modified.ts",
          "staged-modified.ts",
          "mixed.ts",
          "deleted.ts",
          "staged-deleted.ts",
          "renamed-from.ts",
          "intent-rename-from.ts",
          "copy-source.ts",
          "type-changed.ts",
          "conflict.ts",
        ];
        for (const trackedFile of trackedFiles) {
          writeFileSync(
            path.join(rootPath, trackedFile),
            `export const value = ${JSON.stringify(trackedFile)};\n`,
          );
        }
        writeFileSync(path.join(rootPath, ".gitignore"), "*.ignored\n");
        execFileSync("git", [
          "-c",
          "protocol.file.allow=always",
          "-C",
          rootPath,
          "submodule",
          "add",
          "--quiet",
          submoduleSourcePath,
          "submodule",
        ]);
        execFileSync("git", ["-C", rootPath, "add", "."]);
        execFileSync("git", [
          "-C",
          rootPath,
          "commit",
          "--quiet",
          "-m",
          "Initial repository",
        ]);

        const initialBranch = execFileSync(
          "git",
          ["-C", rootPath, "branch", "--show-current"],
          { encoding: "utf8" },
        ).trim();
        execFileSync("git", [
          "-C",
          rootPath,
          "checkout",
          "--quiet",
          "-b",
          "conflict-side",
        ]);
        writeFileSync(
          path.join(rootPath, "conflict.ts"),
          "export const conflict = 'side';\n",
        );
        execFileSync("git", ["-C", rootPath, "add", "conflict.ts"]);
        execFileSync("git", [
          "-C",
          rootPath,
          "commit",
          "--quiet",
          "-m",
          "Side conflict",
        ]);
        execFileSync("git", [
          "-C",
          rootPath,
          "checkout",
          "--quiet",
          initialBranch,
        ]);
        writeFileSync(
          path.join(rootPath, "conflict.ts"),
          "export const conflict = 'main';\n",
        );
        execFileSync("git", ["-C", rootPath, "add", "conflict.ts"]);
        execFileSync("git", [
          "-C",
          rootPath,
          "commit",
          "--quiet",
          "-m",
          "Main conflict",
        ]);
        let mergeConflicted = false;
        try {
          execFileSync(
            "git",
            ["-C", rootPath, "merge", "--no-edit", "conflict-side"],
            { stdio: "ignore" },
          );
        } catch {
          mergeConflicted = true;
        }
        assert.equal(mergeConflicted, true, "the Git fixture did not conflict");

        writeFileSync(
          path.join(rootPath, "modified.ts"),
          "export const modified = true;\n",
        );
        writeFileSync(
          path.join(rootPath, "staged-modified.ts"),
          "export const staged = true;\n",
        );
        execFileSync("git", [
          "-C",
          rootPath,
          "add",
          "staged-modified.ts",
        ]);
        writeFileSync(
          path.join(rootPath, "mixed.ts"),
          "export const mixed = 'staged';\n",
        );
        execFileSync("git", ["-C", rootPath, "add", "mixed.ts"]);
        writeFileSync(
          path.join(rootPath, "mixed.ts"),
          "export const mixed = 'working tree';\n",
        );
        unlinkSync(path.join(rootPath, "deleted.ts"));
        execFileSync("git", [
          "-C",
          rootPath,
          "rm",
          "--quiet",
          "staged-deleted.ts",
        ]);
        execFileSync("git", [
          "-C",
          rootPath,
          "mv",
          "renamed-from.ts",
          "renamed.ts",
        ]);
        writeFileSync(
          path.join(rootPath, "copy-source.ts"),
          "export const copySource = 'changed';\n",
        );
        writeFileSync(
          path.join(rootPath, "copied.ts"),
          "export const value = \"copy-source.ts\";\n",
        );
        execFileSync("git", [
          "-C",
          rootPath,
          "add",
          "copy-source.ts",
          "copied.ts",
        ]);
        unlinkSync(path.join(rootPath, "type-changed.ts"));
        symlinkSync("modified.ts", path.join(rootPath, "type-changed.ts"));
        writeFileSync(path.join(rootPath, "untracked.ts"), "untracked\n");
        writeFileSync(path.join(rootPath, "added.ts"), "added\n");
        execFileSync("git", ["-C", rootPath, "add", "added.ts"]);
        writeFileSync(
          path.join(rootPath, "added-modified.ts"),
          "staged\n",
        );
        execFileSync("git", [
          "-C",
          rootPath,
          "add",
          "added-modified.ts",
        ]);
        writeFileSync(
          path.join(rootPath, "added-modified.ts"),
          "working tree\n",
        );
        writeFileSync(path.join(rootPath, "intent.ts"), "intent\n");
        execFileSync("git", ["-C", rootPath, "add", "-N", "intent.ts"]);
        renameSync(
          path.join(rootPath, "intent-rename-from.ts"),
          path.join(rootPath, "intent-renamed.ts"),
        );
        execFileSync("git", [
          "-C",
          rootPath,
          "add",
          "-N",
          "intent-renamed.ts",
        ]);
        writeFileSync(path.join(rootPath, "cache.ignored"), "ignored\n");

        const statuses = await projectTreeGitDecorationStatuses(rootPath);
        assert.equal(statuses.get("modified.ts"), "modified");
        assert.equal(
          statuses.get("staged-modified.ts"),
          "staged-modified",
        );
        assert.equal(statuses.get("mixed.ts"), "modified");
        assert.equal(statuses.get("deleted.ts"), "deleted");
        assert.equal(
          statuses.get("staged-deleted.ts"),
          "staged-deleted",
        );
        assert.equal(statuses.get("renamed.ts"), "renamed");
        assert.equal(statuses.get("copied.ts"), "copied");
        assert.equal(statuses.get("type-changed.ts"), "type-changed");
        assert.equal(statuses.get("untracked.ts"), "untracked");
        assert.equal(statuses.get("added.ts"), "added");
        assert.equal(statuses.get("added-modified.ts"), "modified");
        assert.equal(statuses.get("intent.ts"), "intent-to-add");
        assert.equal(
          statuses.get("intent-renamed.ts"),
          "intent-to-rename",
        );
        assert.equal(statuses.get("cache.ignored"), "ignored");
        assert.equal(statuses.get("conflict.ts"), "conflicting");
        assert.equal(statuses.get("submodule"), "submodule");
      } finally {
        rmSync(rootPath, {
          recursive: true,
          force: true,
        });
        rmSync(submoduleSourcePath, {
          recursive: true,
          force: true,
        });
      }
    },
  });

  busTest({
    name: "file tabs can be dragged to reorder them",
    body: async () => {
      const rootPath = mkdtempSync(path.join(os.tmpdir(), "lmux-file-order-"));
      const firstPath = path.join(rootPath, "first.ts");
      const secondPath = path.join(rootPath, "second.ts");
      writeFileSync(firstPath, "export const first = true;\n");
      writeFileSync(secondPath, "export const second = true;\n");
      const canonicalFirstPath = realpathSync(firstPath);
      const canonicalSecondPath = realpathSync(secondPath);
      const projectWorkspace = await openWorkspace();

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
        sendCommand({ type: "open-file", path: secondPath });
        await waitForEvent(
          (event) =>
            event.type === "file-opened" &&
            event.path === canonicalSecondPath,
        );

        const moving = waitForEvent(
          (event) =>
            event.type === "file-moved" &&
            event.path === canonicalFirstPath,
        );
        const dragged = z.boolean().parse(
          await lmuxWindow.webContents.executeJavaScript(`(() => {
            let visiblePane = null;
            for (const pane of document.querySelectorAll(".project-pane")) {
              if (pane.offsetParent !== null) {
                visiblePane = pane;
                break;
              }
            }
            if (!(visiblePane instanceof HTMLElement)) {
              return false;
            }
            const source = visiblePane.querySelector(
              ${JSON.stringify(`[data-resource-key="${canonicalFirstPath}"]`)},
            );
            const target = visiblePane.querySelector(
              ${JSON.stringify(`[data-resource-key="${canonicalSecondPath}"]`)},
            );
            if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement)) {
              return false;
            }
            if (!source.draggable) {
              return false;
            }
            const transfer = new DataTransfer();
            source.dispatchEvent(new DragEvent("dragstart", {
              bubbles: true,
              dataTransfer: transfer,
            }));
            const bounds = target.getBoundingClientRect();
            target.dispatchEvent(new DragEvent("dragover", {
              bubbles: true,
              clientX: bounds.right - 1,
              dataTransfer: transfer,
            }));
            target.dispatchEvent(new DragEvent("drop", {
              bubbles: true,
              clientX: bounds.right - 1,
              dataTransfer: transfer,
            }));
            source.dispatchEvent(new DragEvent("dragend", {
              bubbles: true,
              dataTransfer: transfer,
            }));
            return true;
          })()`),
        );
        assert.equal(dragged, true, "the visible file tabs were not found");
        const moved = await moving;
        const project = findTabInfo({
          state: moved.state,
          id: firstOpened.id,
        });
        assert.equal(project?.kind, "project");
        if (project?.kind !== "project") {
          throw new Error("dragging lost the project tab");
        }
        const orderedPaths: string[] = [];
        for (const file of project.files) {
          if (file.path === null) {
            throw new Error("dragging a disk file made it untitled");
          }
          orderedPaths.push(file.path);
        }
        assert.deepEqual(orderedPaths, [
          canonicalSecondPath,
          canonicalFirstPath,
        ]);
        const visibleOrder = z.array(z.string()).parse(
          await lmuxWindow.webContents.executeJavaScript(`(() => {
            for (const pane of document.querySelectorAll(".project-pane")) {
              if (pane.offsetParent === null) {
                continue;
              }
              const order = [];
              for (const tab of pane.querySelectorAll(".file-tab")) {
                order.push(tab.getAttribute("data-resource-key"));
              }
              return order;
            }
            return [];
          })()`),
        );
        assert.deepEqual(visibleOrder, [
          canonicalSecondPath,
          canonicalFirstPath,
        ]);
        const savedProject = sessionFromState(moved.state)
          .workspaces.at(-1)
          ?.tabs.at(-1);
        assert.deepEqual(savedProject, {
          kind: "project",
          workspaceRootPath: realpathSync(rootPath),
          files: [canonicalSecondPath, canonicalFirstPath],
          activeFilePath: canonicalSecondPath,
        });
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
    name: "a double click on empty file-tab space creates an untitled file",
    body: async () => {
      const rootPath = mkdtempSync(path.join(os.tmpdir(), "lmux-untitled-"));
      const seedPath = path.join(rootPath, "seed.ts");
      const destinationPath = path.join(rootPath, "created.ts");
      writeFileSync(seedPath, "export const seed = true;\n");
      const canonicalSeedPath = realpathSync(seedPath);
      const projectWorkspace = await openWorkspace();

      try {
        sendCommand({ type: "open-file", path: seedPath });
        const seedOpened = await waitForEvent(
          (event) =>
            event.type === "file-opened" && event.path === canonicalSeedPath,
        );
        if (seedOpened.type !== "file-opened") {
          throw new Error(`the seed file arrived as a ${seedOpened.type}`);
        }

        const creating = waitForEvent((event) => event.type === "file-created");
        const doubleClicked = z.boolean().parse(
          await lmuxWindow.webContents.executeJavaScript(`(() => {
            for (const pane of document.querySelectorAll(".project-pane")) {
              if (pane.offsetParent === null) {
                continue;
              }
              const strip = pane.querySelector(".file-tabs");
              if (!(strip instanceof HTMLElement)) {
                return false;
              }
              strip.dispatchEvent(new MouseEvent("dblclick", {
                bubbles: true,
                detail: 2,
              }));
              return true;
            }
            return false;
          })()`),
        );
        assert.equal(doubleClicked, true, "the file-tab strip was not found");
        const created = await creating;
        if (created.type !== "file-created") {
          throw new Error(`the untitled file arrived as a ${created.type}`);
        }
        const untitledId = created.untitledId;
        const project = findTabInfo({
          state: created.state,
          id: seedOpened.id,
        });
        assert.equal(project?.kind, "project");
        if (project?.kind !== "project") {
          throw new Error("creating a file lost the project tab");
        }
        assert.deepEqual(project.files.at(-1), {
          path: null,
          title: "Untitled",
          untitledId,
          dirty: false,
          pinned: true,
        });
        assert.equal(project.activeFilePath, null);
        assert.equal(project.activeUntitledId, untitledId);
        const untitledTitle = z.string().parse(
          await lmuxWindow.webContents.executeJavaScript(`(() => {
            for (const pane of document.querySelectorAll(".project-pane")) {
              if (pane.offsetParent === null) {
                continue;
              }
              return pane.querySelector(".file-tab.active .file-tab-title")?.textContent;
            }
            return null;
          })()`),
        );
        assert.equal(untitledTitle, "Untitled");

        const dirtying = waitForEvent(
          (event) =>
            event.type === "dirty-changed" &&
            event.untitledId === untitledId,
        );
        const edit = await editOpenEditor({
          expectedContent: "",
          addedContent: "export const created = true;\n",
        });
        assert.equal(edit.edited, true, "the untitled editor was not editable");
        await dirtying;

        sendCommand({
          type: "save-file",
          projectTabId: seedOpened.id,
          destinationPath,
        });
        const saved = await waitForEvent(
          (event) =>
            event.type === "file-saved" &&
            event.previousUntitledId === untitledId,
        );
        const canonicalDestinationPath = realpathSync(destinationPath);
        if (saved.type !== "file-saved") {
          throw new Error(`the untitled save arrived as a ${saved.type}`);
        }
        assert.equal(saved.path, canonicalDestinationPath);
        assert.match(readFileSync(destinationPath, "utf8"), /created = true/);
        const savedProject = findTabInfo({
          state: saved.state,
          id: seedOpened.id,
        });
        assert.equal(savedProject?.kind, "project");
        if (savedProject?.kind !== "project") {
          throw new Error("saving lost the project tab");
        }
        assert.deepEqual(savedProject.files.at(-1), {
          path: canonicalDestinationPath,
          dirty: false,
          pinned: true,
        });
        assert.equal(savedProject.activeFilePath, canonicalDestinationPath);
        assert.equal(savedProject.activeUntitledId, undefined);
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

// Pure string-in, matches-out: the one part of the terminal link provider
// that does not need a mouse, so the one part the suite can pin down.
const linkMatching = describe("terminal link matching", () => {
  busTest({
    name: "a path ending in a linked extension is a file match",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("src/main/files.ts"), [
        { kind: "file", index: 0, text: "src/main/files.ts" },
      ]);
    },
  });

  busTest({
    name: "brackets around a path stay outside the match",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("(see docs/notes.md)"), [
        { kind: "file", index: 5, text: "docs/notes.md" },
      ]);
    },
  });

  busTest({
    name: "text without linkable paths matches nothing",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("ls -la && npm run build"), []);
    },
  });

  busTest({
    name: "two paths on one line match in the order they appear",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("diff src/a.ts src/b.ts"), [
        { kind: "file", index: 5, text: "src/a.ts" },
        { kind: "file", index: 14, text: "src/b.ts" },
      ]);
    },
  });

  busTest({
    name: "a URL is a url match",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("https://github.com/owner/repo"), [
        { kind: "url", index: 0, text: "https://github.com/owner/repo" },
      ]);
    },
  });

  busTest({
    name: "a URL ending in a linked extension is a url match, not a file match",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("https://example.com/app.js"), [
        { kind: "url", index: 0, text: "https://example.com/app.js" },
      ]);
    },
  });

  busTest({
    name: "a URL with a port links whole",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("http://localhost:3000/app.js"), [
        { kind: "url", index: 0, text: "http://localhost:3000/app.js" },
      ]);
    },
  });

  busTest({
    name: "sentence punctuation after a URL stays outside the match",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("visit https://example.com."), [
        { kind: "url", index: 6, text: "https://example.com" },
      ]);
    },
  });

  busTest({
    name: "a scheme with nothing usable behind it matches nothing",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("https://."), []);
    },
  });

  busTest({
    name: "URLs and file paths link side by side",
    body: async () => {
      assert.deepEqual(
        matchTerminalLinks("open https://a.com/x.ts or src/b.ts"),
        [
          { kind: "url", index: 5, text: "https://a.com/x.ts" },
          { kind: "file", index: 27, text: "src/b.ts" },
        ],
      );
    },
  });

  busTest({
    name: "a path match reaching back over a URL does not claim it",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("--docs=https://example.com/app.js"), [
        { kind: "url", index: 7, text: "https://example.com/app.js" },
      ]);
    },
  });

  busTest({
    name: "a trailing slash is part of the URL",
    body: async () => {
      assert.deepEqual(matchTerminalLinks("Local: http://localhost:5173/"), [
        { kind: "url", index: 7, text: "http://localhost:5173/" },
      ]);
    },
  });
});

await suite;
await linkMatching;
endRun();
