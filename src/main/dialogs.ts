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

// True when no code tab has unsaved work.
type ConfirmDiscardDirtyOptions = {
  window: BrowserWindow;
  tabs: TabInfo[];
  action: string; // the affirmative button, phrased as what it does
};

export function confirmDiscardDirty({
  window,
  tabs,
  action,
}: ConfirmDiscardDirtyOptions): boolean {
  const dirtyPaths: string[] = [];
  for (const tab of tabs) {
    if (tab.kind !== "code" || !tab.dirty) {
      continue;
    }
    dirtyPaths.push(tab.path);
  }
  if (dirtyPaths.length === 0) {
    return true;
  }
  let message: string;
  if (dirtyPaths.length === 1) {
    message = `"${path.basename(dirtyPaths[0])}" has unsaved changes.`;
  } else {
    message = `${dirtyPaths.length} files have unsaved changes.`;
  }
  const choice = dialog.showMessageBoxSync(window, {
    type: "warning",
    message,
    detail: `Closing loses the changes to ${dirtyPaths.join(", ")}.`,
    buttons: ["Cancel", action],
    defaultId: 0, // Escape and Return both mean "don't"
    cancelId: 0,
  });
  return choice === 1;
}
