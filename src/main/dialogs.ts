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

type ChooseDirtyCloseOptions = {
  window: BrowserWindow;
  tabs: TabInfo[];
  action: string;
  onlyFilePath?: string;
};

export function dirtyPathsForTabs(tabs: TabInfo[]): string[] {
  const dirtyPaths: string[] = [];
  for (const tab of tabs) {
    if (tab.kind !== "project") {
      continue;
    }
    for (const file of tab.files) {
      if (!file.dirty) {
        continue;
      }
      dirtyPaths.push(file.path);
    }
  }
  return dirtyPaths;
}

export function chooseDirtyClose({
  window,
  tabs,
  action,
  onlyFilePath,
}: ChooseDirtyCloseOptions): DirtyCloseChoice {
  let dirtyPaths = dirtyPathsForTabs(tabs);
  if (onlyFilePath !== undefined) {
    const matchingPaths: string[] = [];
    for (const dirtyPath of dirtyPaths) {
      if (dirtyPath === onlyFilePath) {
        matchingPaths.push(dirtyPath);
      }
    }
    dirtyPaths = matchingPaths;
  }
  if (dirtyPaths.length === 0) {
    return "discard";
  }

  let message = `${dirtyPaths.length} files have unsaved changes.`;
  let saveLabel = "Save All";
  if (dirtyPaths.length === 1) {
    message = `"${path.basename(dirtyPaths[0])}" has unsaved changes.`;
    saveLabel = "Save";
  }
  const choice = dialog.showMessageBoxSync(window, {
    type: "warning",
    message,
    detail: `${action} affects ${dirtyPaths.join(", ")}.`,
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
