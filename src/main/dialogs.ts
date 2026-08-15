// Only main can show a native dialog or inspect processes.
import { dialog } from "electron";
import type { BrowserWindow } from "electron";
import { runningProcessNames } from "./shells.ts";

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
