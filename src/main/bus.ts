import { BrowserWindow, ipcMain } from "electron";
import type {
  Command,
  LmuxEvent,
  LmuxState,
  ScreenRequest,
  ScreenResult,
} from "../api.ts";
import type { ScreenAnswerMessage } from "../ipc/bridge.ts";

// Whichever window is in front, or else whichever there is: an agent drives
// lmux while the human is in another app, and then nothing on this desktop
// has focus at all.
function targetWindow(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) {
    return focused;
  }
  return BrowserWindow.getAllWindows().at(0);
}

export function dispatch(command: Command): void {
  targetWindow()?.webContents.send("command", command);
}

// How long lmux has to stay quiet before a Command counts as finished, and
// the longest anyone waits to hear that.
const QUIET_MS = 50;
const SETTLE_CAP_MS = 500;

// A Command is answered with however many Events its work produced, which
// may be none, and some of that work outlives executeCommand: a document is
// read from disk, a shell takes a moment to die. So a caller that wants an
// answer waits for lmux to stop changing rather than for a particular
// Event, and reads the snapshot that left behind.
export function runCommand(command: Command): Promise<LmuxState> {
  return new Promise((resolve) => {
    let quietTimer: NodeJS.Timeout;

    function settled(): void {
      clearTimeout(quietTimer);
      clearTimeout(capTimer);
      ipcMain.off("event", restartQuiet);
      resolve(lmuxState);
    }

    function restartQuiet(): void {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(settled, QUIET_MS);
    }

    // the cap is what a human clicking around during a Command would
    // otherwise cost: their Events restart the quiet timer too
    const capTimer = setTimeout(settled, SETTLE_CAP_MS);
    quietTimer = setTimeout(settled, QUIET_MS);
    ipcMain.on("event", restartQuiet);
    dispatch(command);
  });
}

type PendingScreenRead = {
  resolve: (result: ScreenResult) => void;
  timer: NodeJS.Timeout;
};

const pendingScreenReads = new Map<number, PendingScreenRead>();
let nextReadId = 0;
const SCREEN_READ_TIMEOUT_MS = 2000;

// The other direction: main asking the page a question. Electron has no
// invoke here, so the id is what ties an answer to its asker.
export function readScreen(request: ScreenRequest): Promise<ScreenResult> {
  return new Promise((resolve, reject) => {
    const window = targetWindow();
    if (!window) {
      reject(new Error("lmux has no window"));
      return;
    }
    const readId = nextReadId;
    nextReadId += 1;
    // A page that has not answered in two seconds is a broken app, not a
    // tab that turned out to be missing, so this throws rather than
    // answering.
    const timer = setTimeout(() => {
      pendingScreenReads.delete(readId);
      reject(new Error("the page did not answer"));
    }, SCREEN_READ_TIMEOUT_MS);
    pendingScreenReads.set(readId, {
      resolve,
      timer,
    });
    window.webContents.send("screen:read", {
      readId,
      request,
    });
  });
}

ipcMain.on("screen:answer", (_event, message: ScreenAnswerMessage) => {
  const pending = pendingScreenReads.get(message.readId);
  if (!pending) {
    return;
  }
  pendingScreenReads.delete(message.readId);
  clearTimeout(pending.timer);
  pending.resolve(message.result);
});

// Read model: every Event carries a full snapshot, so the latest is truth.
// A live binding, so importers always read the current value.
export let lmuxState: LmuxState = {
  workspaces: [],
  activeWorkspaceId: -1,
};

ipcMain.on("event", (event, lmuxEvent: LmuxEvent) => {
  lmuxState = lmuxEvent.state;
  // Only a close can empty the app: a new workspace is momentarily empty
  // between its own Event and its first tab's, and must not count.
  if (lmuxEvent.type !== "tab-closed" && lmuxEvent.type !== "workspace-closed") {
    return;
  }
  for (const workspace of lmuxState.workspaces) {
    if (workspace.tabs.length > 0) {
      return;
    }
  }
  BrowserWindow.fromWebContents(event.sender)?.close();
});
