import { app, BrowserWindow, ipcMain, shell } from "electron";
import type { BrowserWindowConstructorOptions } from "electron";
import * as path from "path";
import { THEMES, DEFAULT_SETTINGS } from "../theme.ts";
import { killAllShells } from "./shells.ts";
import { savedWindowBounds, saveWindowBounds } from "./window-state.ts";
import { savedSession, saveSession } from "./session-state.ts";
import { sessionFromState } from "../session.ts";
import { confirmKilling } from "./dialogs.ts";
import { lmuxState } from "./bus.ts";
import { installAppMenu } from "./menus.ts";
import "./files.js"; // registers file reads
import "./project-tree.js"; // registers project-tree:read
import "./mcp.js"; // listens on the API socket

// Everything else (file:, and any scheme an OS handler would claim) is
// dropped rather than handed to the OS.
const EXTERNAL_PROTOCOLS = ["http:", "https:", "mailto:"];

function openExternally(url: string): void {
  if (!URL.canParse(url)) {
    return;
  }
  if (!EXTERNAL_PROTOCOLS.includes(new URL(url).protocol)) {
    return;
  }
  shell.openExternal(url);
}

function createWindow(): void {
  const options: BrowserWindowConstructorOptions = {
    width: 900,
    height: 600,
    // default theme's color, since the chosen one lives in localStorage
    backgroundColor: THEMES[DEFAULT_SETTINGS.theme].background,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(import.meta.dirname, "../ipc/preload.cjs"),
    },
  };
  const saved = savedWindowBounds();
  if (saved) {
    options.x = saved.x;
    options.y = saved.y;
    options.width = saved.width;
    options.height = saved.height;
  }
  const browserWindow = new BrowserWindow(options);
  let closeApproved = false;

  browserWindow.on("close", (event) => {
    if (closeApproved) {
      // only once the close is really happening, and the normal bounds, so a
      // zoomed window remembers the size it unzooms to
      saveWindowBounds(browserWindow.getNormalBounds());
      // whatever Event arrived last describes what can honestly be restored
      saveSession(sessionFromState(lmuxState));
      return;
    }
    event.preventDefault();

    const tabIds: number[] = [];
    for (const workspace of lmuxState.workspaces) {
      for (const tab of workspace.tabs) {
        tabIds.push(tab.id);
      }
    }
    // the one question left, and it blocks, so no second close can arrive
    const killingConfirmed = confirmKilling({
      window: browserWindow,
      tabIds,
      action: "Close Window",
    });
    if (!killingConfirmed) {
      return;
    }
    closeApproved = true;
    browserWindow.close();
  });

  browserWindow.on("closed", killAllShells);

  // The page is the app: a navigation would replace the whole UI, shells
  // and all. Links leave through the browser instead.
  browserWindow.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    openExternally(url);
  });
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });

  browserWindow.loadFile(path.join(import.meta.dirname, "../page/index.html"));
}

// The page asks for this once, at boot, before it decides what to open.
ipcMain.handle("session:read", () => {
  const session = savedSession();
  if (session === undefined) {
    return null;
  }
  return session;
});

app.whenReady().then(() => {
  installAppMenu();
  createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});
