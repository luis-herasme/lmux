import { execFileSync } from "child_process";
import { describe } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import * as os from "os";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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
import { lmuxState } from "../main/bus.ts";
import { sessionFromState } from "../session.ts";
import { readProjectTreeGitDecorationsResultSchema } from "../ipc/bridge.ts";
import {
  SOURCE_FILE_PATH,
  callTool,
  countTabs,
  editOpenEditor,
  findProjectInfo,
  openWorkspace,
  screenSchema,
} from "./shared.ts";

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
  rowEdgeGap: z.number(),
  reservedScrollbarWidth: z.number(),
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
        rowEdgeGap:
          treeElement.getBoundingClientRect().right -
          Number.parseFloat(getComputedStyle(treeElement).borderRightWidth) -
          directoryElement.getBoundingClientRect().right,
        // what a native scrollbar would hold back from the rows, and what
        // Chromium would then clip them at
        reservedScrollbarWidth:
          treeElement.offsetWidth -
          treeElement.clientWidth -
          Number.parseFloat(getComputedStyle(treeElement).borderRightWidth),
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
      rootPaddingLeft: -1,
      rowEdgeGap: -1,
      reservedScrollbarWidth: -1,
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

export const projectTree = describe("the project tree", () => {
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
    name: "one project panel previews and pins files from its workspace tree",
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
          (event) => event.type === "project-opened",
        );
        if (opened.type !== "project-opened") {
          throw new Error(`the panel arrived as a ${opened.type}`);
        }
        // the panel is workspace state, so the strip is as it was
        assert.equal(countTabs(opened.state), tabCount);

        const openedProject = findProjectInfo({
          state: opened.state,
          id: opened.id,
        });
        assert.deepEqual(openedProject, {
          id: opened.id,
          name: path.basename(canonicalRootPath),
          workspaceRootPath: canonicalRootPath,
          visible: true,
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
        assert.equal(
          treeStyle.rootPaddingLeft,
          0,
          "a root row starts at the tree's left edge",
        );
        assert.equal(
          treeStyle.rowEdgeGap,
          0,
          "a row reaches the tree's right edge",
        );
        assert.equal(
          treeStyle.reservedScrollbarWidth,
          0,
          "the tree keeps its full width for the rows and draws its own bar",
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
        assert.equal(countTabs(firstOpened.state), tabCount);

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
        const secondProject = findProjectInfo({
          state: secondOpened.state,
          id: opened.id,
        });
        if (secondProject === undefined) {
          throw new Error("the project panel disappeared");
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
        const pinnedProject = findProjectInfo({
          state: pinned.state,
          id: opened.id,
        });
        if (pinnedProject === undefined) {
          throw new Error("pinning lost the project panel");
        }
        assert.equal(pinnedProject.files.at(0)?.pinned, true);

        const savedProject = sessionFromState(pinned.state)
          .workspaces.at(-1)
          ?.project;
        assert.deepEqual(savedProject, {
          workspaceRootPath: canonicalRootPath,
          files: [canonicalOtherFilePath],
          activeFilePath: canonicalOtherFilePath,
          visible: true,
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
        const previewedProject = findProjectInfo({
          state: previewed.state,
          id: opened.id,
        });
        if (previewedProject === undefined) {
          throw new Error("previewing lost the project panel");
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
        const tabPinnedProject = findProjectInfo({
          state: tabPinned.state,
          id: opened.id,
        });
        if (tabPinnedProject === undefined) {
          throw new Error("file-tab pinning lost the project panel");
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
        const changedProject = findProjectInfo({
          state: rootChanged.state,
          id: opened.id,
        });
        if (changedProject === undefined) {
          throw new Error("changing the root lost the project panel");
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
        const emptiedProject = findProjectInfo({
          state: lmuxState,
          id: opened.id,
        });
        if (emptiedProject === undefined) {
          throw new Error("closing files closed the project panel");
        }
        assert.equal(emptiedProject.activeFilePath, null);
        assert.equal(emptiedProject.files.length, 0);
        assert.equal(countTabs(lmuxState), tabCount);
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
});
