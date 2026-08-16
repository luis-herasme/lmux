import { commandSchema } from "../api.ts";
import { bridge } from "./bridge.ts";
import { applyCssVariables } from "./settings.ts";
import {
  executeCommand,
  handleShellData,
  readScreen,
  removeTab,
  restoreSession,
} from "./tabs/index.ts";
import { drawChrome, openRenameDialog } from "./chrome.tsx";
import "./edge-resize.js";
// Last, which is why it is imported here rather than linked in index.html:
// the stylesheets above are xterm's and Dockview's, and ours overrides them.
import "./style.css";

applyCssVariables();
// the window's furniture, before anything asks it to change: an empty
// sidebar under a title bar, and no dialog open
drawChrome();

bridge.onCommand(executeCommand);
bridge.onShellData(handleShellData);
bridge.onScreenRead(({ readId, request }) => {
  bridge.answerScreenRead({
    readId,
    result: readScreen(request),
  });
});
bridge.onShellExit(removeTab);
bridge.onRenameRequest((id) => {
  openRenameDialog({
    kind: "tab",
    id,
  });
});
bridge.onWorkspaceRenameRequest((id) => {
  openRenameDialog({
    kind: "workspace",
    id,
  });
});

// The console is a caller from outside our own compiled code, so this door
// checks what it is handed, and says so rather than doing nothing when the
// answer is no. The page's own affordances call executeCommand directly,
// where the compiler has already checked it.
Reflect.set(window, "lmux", {
  command: (command: unknown) => {
    executeCommand(commandSchema.parse(command));
  },
});

const session = await bridge.readSession();
if (session && session.workspaces.length > 0) {
  await restoreSession(session);
} else {
  executeCommand({ type: "new-workspace" });
}
