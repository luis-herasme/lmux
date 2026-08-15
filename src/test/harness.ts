// The cases run inside the real app: `npm test` starts Electron with
// src/test as its entry, so the window, the preload, the shells and the menu
// are the ones `npm start` produces. This module boots that app, and hands
// the suite a window, a way to wait for Events, and the tally npm test exits
// on.
import { app, BrowserWindow, ipcMain } from "electron";
import { test } from "node:test";
import { unlinkSync } from "fs";
import * as path from "path";
import { z } from "zod";
import type { Command, LmuxEvent } from "../api.ts";

// A throwaway profile: a run must not read or write the settings and window
// geometry of the app you actually use, and a fresh one starts at a known
// size with default settings.
app.setPath("userData", path.join(app.getPath("temp"), "lmux-test-profile"));

const WAIT_TIMEOUT_MS = 5000;

type Waiter = {
  predicate: (event: LmuxEvent) => boolean;
  resolve: (event: LmuxEvent) => void;
  timer: NodeJS.Timeout;
};

const waiters: Waiter[] = [];
let lastEvent: LmuxEvent | undefined;

// main/bus.ts keeps its own listener on this channel; a second one costs
// nothing, so the harness watches the bus without the app knowing.
ipcMain.on("event", (_ipcEvent, lmuxEvent: LmuxEvent) => {
  lastEvent = lmuxEvent;
  const matched: Waiter[] = [];
  for (const waiter of waiters) {
    if (!waiter.predicate(lmuxEvent)) {
      continue;
    }
    matched.push(waiter);
  }
  for (const waiter of matched) {
    waiters.splice(waiters.indexOf(waiter), 1);
    clearTimeout(waiter.timer);
    waiter.resolve(lmuxEvent);
  }
});

// Wait on state, not on event types, wherever the state can say it: one
// Command can emit several Events (new-workspace emits workspace-opened,
// then tab-opened for the shell it creates), and a derived change rides out
// in the Event that caused it. The waiter is registered synchronously, so a
// Command sent just before the await cannot be answered in between.
export function waitForEvent(
  predicate: (event: LmuxEvent) => boolean,
): Promise<LmuxEvent> {
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      predicate,
      resolve,
      timer: setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) {
          waiters.splice(index, 1);
        }
        reject(
          new Error(
            `no matching Event in ${WAIT_TIMEOUT_MS}ms; the last one was ${JSON.stringify(lastEvent)}`,
          ),
        );
      }, WAIT_TIMEOUT_MS),
    };
    waiters.push(waiter);
  });
}

// The app rebuilds its last session at boot, so a run that left one behind
// would hand the cases an app they did not describe.
const { SESSION_FILE_PATH } = await import("../main/session-state.ts");
try {
  unlinkSync(SESSION_FILE_PATH);
} catch {
  // no session to forget, which is the state this wants anyway
}

// Every main module here is imported dynamically: they compute their file
// paths off the profile set above, at import time (window-state.ts does), and
// a static import would be evaluated before that ran.
await import("../main/index.ts");
await app.whenReady();

const { SOCKET_PATH } = await import("../main/mcp.ts");
export const API_SOCKET_PATH = SOCKET_PATH;

const openWindows = BrowserWindow.getAllWindows();
if (openWindows.length === 0) {
  throw new Error("lmux booted without a window");
}

export const lmuxWindow = openWindows[0];

// Layout-reactive code (ResizeObserver delivery, xterm's fit) rides the
// render loop, which a throttled or occluded window stops running: without
// these, the cases that measure a pane read as false failures.
lmuxWindow.webContents.setBackgroundThrottling(false);
lmuxWindow.setAlwaysOnTop(true);
lmuxWindow.show();
lmuxWindow.focus();

// The renderer opens its first workspace, and its first shell, on boot.
await waitForEvent((event) => event.type === "tab-opened");

const POLL_INTERVAL_MS = 50;
const POLL_TIMEOUT_MS = 5000;

type PollOptions = {
  check: () => Promise<boolean>;
  description: string; // what was being waited for, for the failure message
};

// For what changes without an Event: a window's new size reaching the page,
// a terminal's rows being written out, a diagram being drawn.
export async function pollUntil({
  check,
  description,
}: PollOptions): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for ${description}`);
}

const pageHeightSchema = z.number();

export async function pageHeight(): Promise<number> {
  const probed =
    await lmuxWindow.webContents.executeJavaScript("window.innerHeight");
  return pageHeightSchema.parse(probed);
}

// The app remembers where its window was, so a run that was killed rather
// than exiting leaves its size behind for the next one, and the cases that
// measure the window would start somewhere unknown. Take the default size
// back, and let it reach the page before any case measures anything.
const TEST_WINDOW_WIDTH_PX = 900;
const TEST_WINDOW_HEIGHT_PX = 600;

lmuxWindow.setSize(TEST_WINDOW_WIDTH_PX, TEST_WINDOW_HEIGHT_PX);
let settlingHeight = -1;
await pollUntil({
  check: async () => {
    const height = await pageHeight();
    const settled = height === settlingHeight;
    settlingHeight = height;
    return settled;
  },
  description: "the window to settle at the size a run starts from",
});

// webContents.send takes `any`, so this is the one place a Command sent by a
// case is still checked against the API it is exercising. Sent straight to
// the window rather than through main's dispatch, which targets whichever
// window has OS focus and drops everything when that is none.
export function sendCommand(command: Command): void {
  lmuxWindow.webContents.send("command", command);
}

// node:test's root suite never finishes inside Electron: it ends when the
// event loop drains, which an app's never does. So it prints no summary and
// sets no exit code, and these are what `npm test` reports instead.
let passCount = 0;
let failureCount = 0;
let suiteFinished = false;

type BusTestOptions = {
  name: string;
  body: () => Promise<void>;
};

export function busTest({ name, body }: BusTestOptions): void {
  test(name, async () => {
    try {
      await body();
    } catch (error) {
      failureCount += 1;
      // node:test holds failure detail for the summary it never prints here,
      // so this would otherwise be a bare ✖ with no reason given
      console.error(`\n${name}:`, error);
      throw error;
    }
    passCount += 1;
  });
}

// A regression can end a run on its own: the app closes its window once
// nothing is left to show, which quits it. Without this the process would
// exit 0 in the middle of the suite, having reported nothing at all.
app.on("before-quit", () => {
  if (suiteFinished) {
    return;
  }
  console.error("\nthe app quit before the suite finished");
  app.exit(1);
});

// The suite ends here rather than by returning: nothing else stops an app.
export function endRun(): void {
  suiteFinished = true;
  console.log(`\n${passCount} passed, ${failureCount} failed`);
  let exitCode = 0;
  if (failureCount > 0) {
    exitCode = 1;
  }
  // exit, not quit: the window's close handler asks about running processes,
  // and there is nobody here to answer it
  app.exit(exitCode);
}
