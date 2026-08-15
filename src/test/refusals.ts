import { describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { busTest, lmuxWindow, sendCommand, waitForEvent } from "./harness.ts";
import { lmuxState } from "../main/bus.ts";
import { countTabs } from "./shared.ts";

const refusedSchema = z.boolean();

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

export const busRefusals = describe("what the bus refuses", () => {
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
});
