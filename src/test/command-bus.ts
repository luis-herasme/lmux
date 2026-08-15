import { describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  busTest,
  lmuxWindow,
  pageHeight,
  pollUntil,
  sendCommand,
  waitForEvent,
} from "./harness.ts";
import { lmuxState } from "../main/bus.ts";
import type { WorkspaceInfo } from "../api.ts";
import { countTabs, findWorkspace, openWorkspace } from "./shared.ts";
import type { StateLookupOptions } from "./shared.ts";

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

// style.css keeps the terminal's 4px inset on .xterm, where the fit addon
// subtracts it; on the pane it would inflate the height the addon reads
// (Chromium reports a border-box height) and the grid could gain a row that
// hangs past the pane's bottom edge, cropping the terminal's last line.
const TERMINAL_INSET_PX = 4;

const VISIBLE_TERMINAL_BOTTOM_GAP = `(() => {
  for (const pane of document.querySelectorAll(".terminal-pane")) {
    if (pane.offsetParent === null) {
      continue;
    }
    const screen = pane.querySelector(".xterm-screen");
    return (
      pane.getBoundingClientRect().bottom -
      screen.getBoundingClientRect().bottom
    );
  }
  return null;
})()`;

// xterm's stylesheet paints .xterm-viewport black and, since v6, sets the
// theme background inline on the scrollable element, which only spans the
// character grid: without style.css overriding the viewport, the inset and
// the fit remainder around the grid show as a black frame.
const VISIBLE_TERMINAL_SURROUND = `(() => {
  for (const pane of document.querySelectorAll(".terminal-pane")) {
    if (pane.offsetParent === null) {
      continue;
    }
    const viewport = pane.querySelector(".xterm-viewport");
    return {
      viewport: getComputedStyle(viewport).backgroundColor,
      page: getComputedStyle(document.body).backgroundColor,
    };
  }
  return null;
})()`;

// A click whose target is the sidebar itself is what landing on the empty
// strip produces, and the target is the only thing the listener reads. A
// mouse sends both of these, in this order, for one double click, and the
// two cases below are that sequence split into the two questions it asks.
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
const bottomGapSchema = z.number();
const terminalSurroundSchema = z.object({
  viewport: z.string(),
  page: z.string(),
});

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

function tabIds(workspace: WorkspaceInfo): number[] {
  const ids: number[] = [];
  for (const tab of workspace.tabs) {
    ids.push(tab.id);
  }
  return ids;
}

export const commandBus = describe("the command bus", () => {
  // first, before any case has resized the window or split a pane: the gap
  // is a property of the boot layout the harness settled
  busTest({
    name: "the terminal grid keeps its inset from the pane's bottom edge",
    body: async () => {
      const probed = await lmuxWindow.webContents.executeJavaScript(
        VISIBLE_TERMINAL_BOTTOM_GAP,
      );
      const gap = bottomGapSchema.parse(probed);
      assert.ok(
        gap >= TERMINAL_INSET_PX,
        `the grid's last row ends ${gap}px above the pane's edge, inside the ${TERMINAL_INSET_PX}px inset`,
      );
    },
  });

  busTest({
    name: "the terminal's surround shares the page background",
    body: async () => {
      const probed = await lmuxWindow.webContents.executeJavaScript(
        VISIBLE_TERMINAL_SURROUND,
      );
      const surround = terminalSurroundSchema.parse(probed);
      assert.equal(
        surround.viewport,
        surround.page,
        "the viewport behind the grid's surround left xterm's black instead of the theme background",
      );
    },
  });

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
});
