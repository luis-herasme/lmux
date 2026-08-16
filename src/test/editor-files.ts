import { describe } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import * as os from "os";
import {
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { z } from "zod";
import {
  busTest,
  lmuxWindow,
  sendCommand,
  waitForEvent,
} from "./harness.ts";

const editorContentSchema = z.string().nullable();

type TypeIntoOpenEditorOptions = {
  expectedContent: string;
  addedContent: string;
};

// Types into whichever open editor holds `expectedContent`, and answers with
// what it holds afterwards; null when no editor held that content.
async function typeIntoOpenEditor({
  expectedContent,
  addedContent,
}: TypeIntoOpenEditorOptions): Promise<string | null> {
  const result = await lmuxWindow.webContents.executeJavaScript(`(() => {
    for (const editor of window.monaco.editor.getEditors()) {
      if (editor.getModel()?.getValue() !== ${JSON.stringify(expectedContent)}) {
        continue;
      }
      editor.focus();
      editor.trigger("keyboard", "type", {
        text: ${JSON.stringify(addedContent)},
      });
      return editor.getValue();
    }
    return null;
  })()`);
  return editorContentSchema.parse(result);
}

export const editorFiles = describe("editor files", () => {
  busTest({
    name: "the editor refuses an edit and leaves the file alone",
    body: async () => {
      const filePath = path.join(
        os.tmpdir(),
        `lmux-read-only-${process.pid}.ts`,
      );
      const initialContent = "export const value = 1;\n";
      writeFileSync(filePath, initialContent);
      const canonicalFilePath = realpathSync(filePath);

      try {
        sendCommand({ type: "open-file", path: filePath });
        await waitForEvent(
          (event) =>
            event.type === "file-opened" && event.path === canonicalFilePath,
        );

        const afterTyping = await typeIntoOpenEditor({
          expectedContent: initialContent,
          addedContent: "\n// typed by the suite\n",
        });
        assert.equal(
          afterTyping,
          initialContent,
          "the open editor took the edit, or was not found at all",
        );
        assert.equal(
          readFileSync(filePath, "utf8"),
          initialContent,
          "the file on disk was written",
        );
      } finally {
        unlinkSync(filePath);
      }
    },
  });
});
