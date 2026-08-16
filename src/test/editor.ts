import { describe } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { realpathSync } from "fs";
import { z } from "zod";
import {
  busTest,
  lmuxWindow,
  pollUntil,
  sendCommand,
  waitForEvent,
} from "./harness.ts";
import { lmuxState } from "../main/bus.ts";
import {
  FIXTURE_PATH,
  SOURCE_FILE_PATH,
  countTabs,
  findEditorInfo,
  findWorkspace,
  openWorkspace,
} from "./shared.ts";

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

const tokenClassSchema = z.array(z.string());

const stripAlignmentSchema = z.object({
  stripBottom: z.number(),
  headerBottom: z.number(),
});

// Both are 35px tall, but only one of them counts its own underline inside
// that: the strip is border-box and the header had to be told to be.
async function visibleStripAlignment(): Promise<
  z.infer<typeof stripAlignmentSchema>
> {
  const probed = await lmuxWindow.webContents.executeJavaScript(`(() => {
    const bottomOf = (selector) => {
      for (const element of document.querySelectorAll(selector)) {
        if (element.offsetParent === null) {
          continue;
        }
        return element.getBoundingClientRect().bottom;
      }
      return -1;
    };
    return {
      stripBottom: bottomOf(".dv-tabs-and-actions-container"),
      headerBottom: bottomOf(".editor-header"),
    };
  })()`);
  return stripAlignmentSchema.parse(probed);
}

// One editor per workspace lives in the host, and only the active
// workspace's, while it is open, is the one on screen.
async function visibleEditorCount(): Promise<number> {
  const probed = await lmuxWindow.webContents.executeJavaScript(`(() => {
    let visible = 0;
    for (const editorElement of document.querySelectorAll(".editor")) {
      if (editorElement.offsetParent !== null) {
        visible += 1;
      }
    }
    return visible;
  })()`);
  return z.number().parse(probed);
}

const editorMarkdownViewSchema = z.object({
  toolbarVisible: z.boolean(),
  editorVisible: z.boolean(),
  renderedVisible: z.boolean(),
  renderedHeading: z.string().nullable(),
  buttonLabel: z.string().nullable(),
});

type EditorMarkdownView = z.infer<typeof editorMarkdownViewSchema>;

// The visible editor pane's two faces: which one shows, what the toolbar
// button offers, and the rendered document's first heading if it is up.
async function visibleEditorMarkdownView(): Promise<EditorMarkdownView> {
  const result = await lmuxWindow.webContents.executeJavaScript(`(() => {
    for (const paneElement of document.querySelectorAll(".editor-body")) {
      if (paneElement.offsetParent === null) {
        continue;
      }
      const toolbarElement = paneElement.querySelector(
        ".editor-markdown-toolbar",
      );
      const buttonElement = toolbarElement === null
        ? null
        : toolbarElement.querySelector(".markdown-action");
      const headingElement = paneElement.querySelector(
        ".editor-markdown .markdown-view h1",
      );
      return {
        toolbarVisible:
          toolbarElement !== null &&
          !toolbarElement.classList.contains("hidden"),
        editorVisible: !paneElement
          .querySelector(".editor-source")
          .classList.contains("hidden"),
        renderedVisible: !paneElement
          .querySelector(".editor-markdown")
          .classList.contains("hidden"),
        renderedHeading:
          headingElement === null ? null : headingElement.textContent,
        buttonLabel:
          buttonElement === null ? null : buttonElement.textContent,
      };
    }
    return null;
  })()`);
  return editorMarkdownViewSchema.parse(result);
}

export const editor = describe("the editor", () => {
  busTest({
    name: "a code file opens inside the workspace editor",
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
      const editor = findEditorInfo({
        state: opened.state,
        id: opened.id,
      });
      if (editor === undefined) {
        throw new Error("open-file created no editor");
      }
      // the editor is not a tab, so nothing joined the strip
      assert.equal(countTabs(opened.state), tabCount);
      assert.equal(
        editor.name,
        path.basename(realpathSync(path.join(import.meta.dirname, "../.."))),
      );
      assert.equal(editor.filePath, SOURCE_FILE_PATH);

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

    },
  });

  busTest({
    name: "the editor's header ends where the tab strip does",
    body: async () => {
      const alignment = await visibleStripAlignment();
      assert.ok(alignment.stripBottom > 0, "no tab strip was on screen");
      assert.equal(alignment.headerBottom, alignment.stripBottom);
    },
  });

  busTest({
    name: "hiding the editor keeps its file and hands back the window",
    body: async () => {
      const editorWorkspace = await openWorkspace();
      try {
        sendCommand({
          type: "open-file",
          path: SOURCE_FILE_PATH,
        });
        const opened = await waitForEvent(
          (event) => event.type === "editor-shown",
        );
        if (opened.type !== "editor-shown") {
          throw new Error(`the editor arrived as a ${opened.type}`);
        }
        assert.equal(await visibleEditorCount(), 1);
        assert.equal(
          findWorkspace({
            state: opened.state,
            id: editorWorkspace.id,
          })?.focus,
          "editor",
        );

        sendCommand({ type: "hide-editor" });
        const closed = await waitForEvent(
          (event) => event.type === "editor-hidden",
        );
        const hiddenEditor = findEditorInfo({
          state: closed.state,
          id: opened.id,
        });
        assert.equal(hiddenEditor?.visible, false);
        assert.equal(hiddenEditor?.filePath, SOURCE_FILE_PATH);
        assert.equal(
          findWorkspace({
            state: closed.state,
            id: editorWorkspace.id,
          })?.focus,
          "panes",
        );
        assert.equal(await visibleEditorCount(), 0);

        sendCommand({ type: "show-editor" });
        const reopened = await waitForEvent(
          (event) => event.type === "editor-shown",
        );
        const shownEditor = findEditorInfo({
          state: reopened.state,
          id: opened.id,
        });
        assert.equal(shownEditor?.visible, true);
        assert.equal(shownEditor?.filePath, SOURCE_FILE_PATH);
        assert.equal(await visibleEditorCount(), 1);
      } finally {
        const workspaceClosed = waitForEvent(
          (event) =>
            event.type === "workspace-closed" &&
            event.id === editorWorkspace.id,
        );
        sendCommand({
          type: "close-workspace",
          id: editorWorkspace.id,
        });
        await workspaceClosed;
      }
    },
  });

  busTest({
    name: "a markdown file in the editor can swap to its rendering",
    body: async () => {
      // realpath like SOURCE_FILE_PATH: the editor holds the resolved path,
      // and the Event carries it
      const documentPath = realpathSync(FIXTURE_PATH);
      sendCommand({
        type: "open-file",
        path: documentPath,
      });
      await waitForEvent(
        (event) =>
          event.type === "file-opened" && event.path === documentPath,
      );

      const source = await visibleEditorMarkdownView();
      assert.equal(source.toolbarVisible, true, "the toolbar did not surface");
      assert.equal(source.editorVisible, true);
      assert.equal(source.renderedVisible, false);
      assert.equal(source.buttonLabel, "Rendered");

      // no editorId and no path: the workspace's one editor is meant, and
      // the visible file is the one just opened
      sendCommand({
        type: "set-file-markdown-mode",
        mode: "rendered",
      });
      await waitForEvent(
        (event) =>
          event.type === "file-markdown-mode-changed" &&
          event.path === documentPath,
      );

      const rendered = await visibleEditorMarkdownView();
      assert.equal(rendered.editorVisible, false, "the editor stayed up");
      assert.equal(rendered.renderedVisible, true);
      assert.equal(
        rendered.renderedHeading,
        "A document with a diagram in it",
        "the rendering shows headings as headings",
      );
      assert.equal(rendered.buttonLabel, "Source");

      sendCommand({
        type: "set-file-markdown-mode",
        mode: "raw",
      });
      await waitForEvent(
        (event) =>
          event.type === "file-markdown-mode-changed" &&
          event.path === documentPath,
      );

      const back = await visibleEditorMarkdownView();
      assert.equal(back.editorVisible, true, "the editor did not come back");
      assert.equal(back.renderedVisible, false);
      assert.equal(back.buttonLabel, "Rendered");

      // a code file has no rendered face, so its toolbar goes away
      sendCommand({
        type: "open-file",
        path: SOURCE_FILE_PATH,
      });
      await waitForEvent(
        (event) =>
          event.type === "file-opened" && event.path === SOURCE_FILE_PATH,
      );
      const code = await visibleEditorMarkdownView();
      assert.equal(code.toolbarVisible, false, "the toolbar outlived markdown");
    },
  });
});
