// Only main can show a native dialog, and only main knows what a PTY is
// running or whether a file on disk has newer work than the page bought.
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

// True when no code tab in `tabs` has unsaved work, so callers close without
// asking about the ones that do. Mirrors confirmKilling: the path list is the
// whole of what the dialog needs to say.
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
  const dirty: string[] = [];
  for (const tab of tabs) {
    if (tab.kind === "code" && tab.dirty) {
      dirty.push(tab.path);
    }
  }
  if (dirty.length === 0) {
    return true;
  }
  let message: string;
  if (dirty.length === 1) {
    message = `"${path.basename(dirty[0])}" has unsaved changes.`;
  } else {
    message = `${dirty.length} files have unsaved changes.`;
  }
  const choice = dialog.showMessageBoxSync(window, {
    type: "warning",
    message,
    detail: `Closing loses the changes to ${dirty.join(", ")}.`,
    buttons: ["Cancel", action],
    defaultId: 0, // Escape and Return both mean "don't"
    cancelId: 0,
  });
  return choice === 1;
}
