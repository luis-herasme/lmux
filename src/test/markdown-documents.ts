import { describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  busTest,
  lmuxWindow,
  pollUntil,
  sendCommand,
  waitForEvent,
} from "./harness.ts";
import { lmuxState } from "../main/bus.ts";
import { FIXTURE_PATH, countTabs } from "./shared.ts";

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

const scrollTopSchema = z.number();
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

export const markdownDocuments = describe("markdown documents", () => {
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
});
