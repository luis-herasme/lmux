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
  findProjectInfo,
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
      headerBottom: bottomOf(".project-header"),
    };
  })()`);
  return stripAlignmentSchema.parse(probed);
}

// One panel per workspace lives in the host, and only the active
// workspace's, while it is open, is the one on screen.
async function visibleProjectPanelCount(): Promise<number> {
  const probed = await lmuxWindow.webContents.executeJavaScript(`(() => {
    let visible = 0;
    for (const panelElement of document.querySelectorAll(".project-panel")) {
      if (panelElement.offsetParent !== null) {
        visible += 1;
      }
    }
    return visible;
  })()`);
  return z.number().parse(probed);
}

const projectMarkdownViewSchema = z.object({
  toolbarVisible: z.boolean(),
  editorVisible: z.boolean(),
  renderedVisible: z.boolean(),
  renderedHeading: z.string().nullable(),
  buttonLabel: z.string().nullable(),
});

type ProjectMarkdownView = z.infer<typeof projectMarkdownViewSchema>;

// The visible project pane's two faces: which one shows, what the toolbar
// button offers, and the rendered document's first heading if it is up.
async function visibleProjectMarkdownView(): Promise<ProjectMarkdownView> {
  const result = await lmuxWindow.webContents.executeJavaScript(`(() => {
    for (const paneElement of document.querySelectorAll(".project-pane")) {
      if (paneElement.offsetParent === null) {
        continue;
      }
      const toolbarElement = paneElement.querySelector(
        ".project-markdown-toolbar",
      );
      const buttonElement = toolbarElement === null
        ? null
        : toolbarElement.querySelector(".markdown-action");
      const headingElement = paneElement.querySelector(
        ".project-markdown .markdown-view h1",
      );
      return {
        toolbarVisible:
          toolbarElement !== null &&
          !toolbarElement.classList.contains("hidden"),
        editorVisible: !paneElement
          .querySelector(".project-editor")
          .classList.contains("hidden"),
        renderedVisible: !paneElement
          .querySelector(".project-markdown")
          .classList.contains("hidden"),
        renderedHeading:
          headingElement === null ? null : headingElement.textContent,
        buttonLabel:
          buttonElement === null ? null : buttonElement.textContent,
      };
    }
    return null;
  })()`);
  return projectMarkdownViewSchema.parse(result);
}

export const projectPanel = describe("the project panel", () => {
  busTest({
    name: "a code file opens inside the workspace project panel",
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
      const project = findProjectInfo({
        state: opened.state,
        id: opened.id,
      });
      if (project === undefined) {
        throw new Error("open-file created no project panel");
      }
      // the panel is not a tab, so nothing joined the strip
      assert.equal(countTabs(opened.state), tabCount);
      assert.equal(
        project.name,
        path.basename(realpathSync(path.join(import.meta.dirname, "../.."))),
      );
      assert.equal(project.filePath, SOURCE_FILE_PATH);

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
    name: "the project panel's header ends where the tab strip does",
    body: async () => {
      const alignment = await visibleStripAlignment();
      assert.ok(alignment.stripBottom > 0, "no tab strip was on screen");
      assert.equal(alignment.headerBottom, alignment.stripBottom);
    },
  });

  busTest({
    name: "hiding the project panel keeps its file and hands back the window",
    body: async () => {
      const panelWorkspace = await openWorkspace();
      try {
        sendCommand({
          type: "open-file",
          path: SOURCE_FILE_PATH,
        });
        const opened = await waitForEvent(
          (event) => event.type === "project-opened",
        );
        if (opened.type !== "project-opened") {
          throw new Error(`the panel arrived as a ${opened.type}`);
        }
        assert.equal(await visibleProjectPanelCount(), 1);
        assert.equal(
          findWorkspace({
            state: opened.state,
            id: panelWorkspace.id,
          })?.focus,
          "project",
        );

        sendCommand({ type: "close-project" });
        const closed = await waitForEvent(
          (event) => event.type === "project-closed",
        );
        const hiddenProject = findProjectInfo({
          state: closed.state,
          id: opened.id,
        });
        assert.equal(hiddenProject?.visible, false);
        assert.equal(hiddenProject?.filePath, SOURCE_FILE_PATH);
        assert.equal(
          findWorkspace({
            state: closed.state,
            id: panelWorkspace.id,
          })?.focus,
          "layout",
        );
        assert.equal(await visibleProjectPanelCount(), 0);

        sendCommand({ type: "open-project" });
        const reopened = await waitForEvent(
          (event) => event.type === "project-opened",
        );
        const shownProject = findProjectInfo({
          state: reopened.state,
          id: opened.id,
        });
        assert.equal(shownProject?.visible, true);
        assert.equal(shownProject?.filePath, SOURCE_FILE_PATH);
        assert.equal(await visibleProjectPanelCount(), 1);
      } finally {
        const workspaceClosed = waitForEvent(
          (event) =>
            event.type === "workspace-closed" &&
            event.id === panelWorkspace.id,
        );
        sendCommand({
          type: "close-workspace",
          id: panelWorkspace.id,
        });
        await workspaceClosed;
      }
    },
  });

  busTest({
    name: "a markdown file in the project panel can swap to its rendering",
    body: async () => {
      // realpath like SOURCE_FILE_PATH: the panel holds the resolved path,
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

      const source = await visibleProjectMarkdownView();
      assert.equal(source.toolbarVisible, true, "the toolbar did not surface");
      assert.equal(source.editorVisible, true);
      assert.equal(source.renderedVisible, false);
      assert.equal(source.buttonLabel, "Rendered");

      // no projectTabId and no path: the workspace's one panel is meant, and
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

      const rendered = await visibleProjectMarkdownView();
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

      const back = await visibleProjectMarkdownView();
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
      const code = await visibleProjectMarkdownView();
      assert.equal(code.toolbarVisible, false, "the toolbar outlived markdown");
    },
  });
});
