// Runs with access to both worlds and exposes exactly these capabilities
// to the sandboxed page as window.bridge; nothing else crosses the
// boundary. The Bridge type keeps this and the renderer in sync.
import type { Bridge, ShellDataMessage } from "./bridge.ts";
import { contextBridge, ipcRenderer } from "electron";

const bridge: Bridge = {
  spawnShell: (size) => ipcRenderer.send("shell:spawn", size),
  writeToShell: (message) => ipcRenderer.send("shell:write", message),
  resizeShell: (size) => ipcRenderer.send("shell:resize", size),
  killShell: (id) => ipcRenderer.send("shell:kill", id),
  onShellData: (callback) =>
    ipcRenderer.on("shell:data", (_event, message: ShellDataMessage) =>
      callback(message),
    ),
  onShellExit: (callback) =>
    ipcRenderer.on("shell:exited", (_event, id) => callback(id)),
  onCommand: (callback) =>
    ipcRenderer.on("command", (_event, command) => callback(command)),
  emitEvent: (event) => ipcRenderer.send("event", event),
  showTabMenu: (id) => ipcRenderer.send("tab:menu", id),
  onRenameRequest: (callback) =>
    ipcRenderer.on("tab:rename-request", (_event, id) => callback(id)),
  showWorkspaceMenu: (id) => ipcRenderer.send("workspace:menu", id),
  onWorkspaceRenameRequest: (callback) =>
    ipcRenderer.on("workspace:rename-request", (_event, id) => callback(id)),
  closeWorkspace: (id) => ipcRenderer.send("workspace:close", id),
  readFile: (request) => ipcRenderer.invoke("file:read", request),
  readProjectTree: (request) =>
    ipcRenderer.invoke("project-tree:read", request),
  readProjectTreeGitDecorations: (request) =>
    ipcRenderer.invoke("project-tree:read-git-decorations", request),
  watchProjectTree: (request) =>
    ipcRenderer.invoke("project-tree:watch", request),
  unwatchProjectTree: (request) =>
    ipcRenderer.send("project-tree:unwatch", request),
  onProjectTreeChanged: (callback) =>
    ipcRenderer.on("project-tree:changed", (_event, message: unknown) =>
      callback(message),
    ),
  readSession: () => ipcRenderer.invoke("session:read"),
};

contextBridge.exposeInMainWorld("bridge", bridge);
