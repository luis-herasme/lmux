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
  utimesSync,
  writeFileSync,
} from "fs";
import { z } from "zod";
import {
  busTest,
  lmuxWindow,
  pollUntil,
  sendCommand,
  waitForEvent,
} from "./harness.ts";
import { sessionFromState } from "../session.ts";
import {
  SOURCE_FILE_PATH,
  editOpenEditor,
  findProjectInfo,
  openWorkspace,
} from "./shared.ts";
import type { StateLookupOptions } from "./shared.ts";

type FindProjectFileDirtyOptions = StateLookupOptions & {
  filePath: string;
};

function findProjectFileDirty({
  state,
  id,
  filePath,
}: FindProjectFileDirtyOptions): boolean | undefined {
  const project = findProjectInfo({
    state,
    id,
  });
  if (project === undefined) {
    return undefined;
  }
  for (const file of project.files) {
    if (file.path === filePath) {
      return file.dirty;
    }
  }
  return undefined;
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
        const project = findProjectInfo({
          state: moved.state,
          id: firstOpened.id,
        });
        if (project === undefined) {
          throw new Error("dragging lost the project panel");
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
        const project = findProjectInfo({
          state: created.state,
          id: seedOpened.id,
        });
        if (project === undefined) {
          throw new Error("creating a file lost the project panel");
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
        const savedProject = findProjectInfo({
          state: saved.state,
          id: seedOpened.id,
        });
        if (savedProject === undefined) {
          throw new Error("saving lost the project panel");
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
        const dirtyProject = findProjectInfo({
          state: dirty.state,
          id: opened.id,
        });
        if (dirtyProject === undefined) {
          throw new Error("editing lost the project panel");
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
        // The case asks the DOM what the project panel said and the disk what
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
});
