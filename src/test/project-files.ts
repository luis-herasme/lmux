import { describe } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import * as os from "os";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
import { sessionFromState } from "../session.ts";
import { findProjectInfo, openWorkspace } from "./shared.ts";

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

export const projectFiles = describe("project files", () => {
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
              ${JSON.stringify(`[data-file-path="${canonicalFirstPath}"]`)},
            );
            const target = visiblePane.querySelector(
              ${JSON.stringify(`[data-file-path="${canonicalSecondPath}"]`)},
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
        const project = findProjectInfo({
          state: moved.state,
          id: firstOpened.id,
        });
        if (project === undefined) {
          throw new Error("dragging lost the project panel");
        }
        const orderedPaths: string[] = [];
        for (const file of project.files) {
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
                order.push(tab.getAttribute("data-file-path"));
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
          ?.project;
        assert.deepEqual(savedProject, {
          workspaceRootPath: realpathSync(rootPath),
          files: [canonicalSecondPath, canonicalFirstPath],
          activeFilePath: canonicalSecondPath,
          visible: true,
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
    name: "the project editor refuses an edit and leaves the file alone",
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
        const opened = await waitForEvent(
          (event) =>
            event.type === "file-opened" && event.path === canonicalFilePath,
        );
        if (opened.type !== "file-opened") {
          throw new Error(`the file arrived as a ${opened.type}`);
        }

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
