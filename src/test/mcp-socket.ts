import { describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { busTest, pollUntil, sendCommand } from "./harness.ts";
import { lmuxState } from "../main/bus.ts";
import { callTool, countTabs, screenSchema } from "./shared.ts";

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

export const mcpSocket = describe("the MCP socket", () => {
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
