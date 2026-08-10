// Only main can show a native dialog or inspect processes and files.
import { dialog } from "electron";
import type { BrowserWindow } from "electron";
import * as path from "path";
import { runningProcessNames } from "./shells.ts";
import type { TabInfo } from "../api.ts";

type ConfirmKillingOptions = {
  window: BrowserWindow;
  tabIds: number[];
  action: string; // the affirmative button, phrased as what it does
};

// True when nothing is running, so no caller has to ask about idle tabs.
export function confirmKilling({
  window,
  tabIds,
  action,
}: ConfirmKillingOptions): boolean {
  const names = runningProcessNames(tabIds);
  if (names.length === 0) {
    return true;
  }
  let message = `${names.length} programs are still running.`;
  if (names.length === 1) {
    message = `"${names[0]}" is still running.`;
  }
  const choice = dialog.showMessageBoxSync(window, {
    type: "warning",
    message,
    detail: `Continuing ends ${names.join(", ")}.`,
    buttons: ["Cancel", action],
    defaultId: 0, // Escape and Return both mean "don't"
    cancelId: 0,
  });
  return choice === 1;
}

export type DirtyCloseChoice = "save" | "discard" | "cancel";

type DirtyFile = {
  path: string | null;
  untitledId: number | undefined;
  title: string;
  detail: string;
};

type ChooseDirtyCloseOptions = {
  window: BrowserWindow;
  tabs: TabInfo[];
  action: string;
  onlyFilePath?: string;
  onlyUntitledId?: number;
};

function dirtyFilesForTabs(tabs: TabInfo[]): DirtyFile[] {
  const dirtyFiles: DirtyFile[] = [];
  for (const tab of tabs) {
    if (tab.kind !== "project") {
      continue;
    }
    for (const file of tab.files) {
      if (!file.dirty) {
        continue;
      }
      if (file.path === null) {
        dirtyFiles.push({
          path: null,
          untitledId: file.untitledId,
          title: file.title,
          detail: file.title,
        });
        continue;
      }
      dirtyFiles.push({
        path: file.path,
        untitledId: undefined,
        title: path.basename(file.path),
        detail: file.path,
      });
    }
  }
  return dirtyFiles;
}

export function chooseDirtyClose({
  window,
  tabs,
  action,
  onlyFilePath,
  onlyUntitledId,
}: ChooseDirtyCloseOptions): DirtyCloseChoice {
  let dirtyFiles = dirtyFilesForTabs(tabs);
  if (onlyFilePath !== undefined || onlyUntitledId !== undefined) {
    const matchingFiles: DirtyFile[] = [];
    for (const dirtyFile of dirtyFiles) {
      let matches = false;
      if (onlyFilePath !== undefined && dirtyFile.path === onlyFilePath) {
        matches = true;
      }
      if (
        onlyUntitledId !== undefined &&
        dirtyFile.untitledId === onlyUntitledId
      ) {
        matches = true;
      }
      if (matches) {
        matchingFiles.push(dirtyFile);
      }
    }
    dirtyFiles = matchingFiles;
  }
  if (dirtyFiles.length === 0) {
    return "discard";
  }

  const dirtyDetails: string[] = [];
  for (const dirtyFile of dirtyFiles) {
    dirtyDetails.push(dirtyFile.detail);
  }
  let message = `${dirtyFiles.length} files have unsaved changes.`;
  let saveLabel = "Save All";
  if (dirtyFiles.length === 1) {
    message = `"${dirtyFiles[0].title}" has unsaved changes.`;
    saveLabel = "Save";
  }
  const choice = dialog.showMessageBoxSync(window, {
    type: "warning",
    message,
    detail: `${action} affects ${dirtyDetails.join(", ")}.`,
    buttons: ["Cancel", "Don't Save", saveLabel],
    defaultId: 0,
    cancelId: 0,
  });
  if (choice === 1) {
    return "discard";
  }
  if (choice === 2) {
    return "save";
  }
  return "cancel";
}
