import { ipcMain } from "electron";
import { execFile } from "child_process";
import * as os from "os";
import * as path from "path";
import * as pty from "node-pty";
import type { ShellDataMessage, ShellSizeMessage } from "../inter-process-communication/bridge.ts";

const shells = new Map<number, pty.IPty>();

let shellPath = process.env.SHELL;
if (!shellPath) {
  shellPath = "/bin/zsh";
}
// A PTY reports the program currently in its foreground. While that is the
// shell we spawned, the tab is idle; any other name is something running.
const SHELL_NAME = path.basename(shellPath);

ipcMain.on("shell:spawn", (event, size: ShellSizeMessage) => {
  const shell = pty.spawn(shellPath, ["-l"], {
    name: "xterm-256color",
    cols: size.cols,
    rows: size.rows,
    cwd: os.homedir(),
  });
  shells.set(size.id, shell);

  const page = event.sender;

  shell.onData((data: string) => {
    if (page.isDestroyed()) {
      return;
    }
    const message: ShellDataMessage = {
      id: size.id,
      data,
    };
    page.send("shell:data", message);
  });

  shell.onExit(() => {
    shells.delete(size.id);
    if (page.isDestroyed()) {
      return;
    }
    page.send("shell:exited", size.id);
  });
});

ipcMain.on("shell:write", (_event, message: ShellDataMessage) => {
  shells.get(message.id)?.write(message.data);
});

ipcMain.on("shell:resize", (_event, size: ShellSizeMessage) => {
  shells.get(size.id)?.resize(size.cols, size.rows);
});

ipcMain.on("shell:kill", (_event, id: number) => {
  shells.get(id)?.kill();
});

// A tab's shell cwd, asked of the OS at call time (lsof on the PTY's
// process): works with any shell, no shell configuration needed.
export function getShellCwd(id: number): Promise<string | undefined> {
  const shell = shells.get(id);
  if (!shell) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    execFile(
      "lsof",
      ["-a", "-p", String(shell.pid), "-d", "cwd", "-F", "n"],
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        for (const line of stdout.split("\n")) {
          if (line.startsWith("n")) {
            resolve(line.slice(1));
            return;
          }
        }
        resolve(undefined);
      },
    );
  });
}

export function runningProcessNames(tabIds: number[]): string[] {
  const names: string[] = [];
  for (const id of tabIds) {
    const shell = shells.get(id);
    if (!shell) {
      continue;
    }
    // node-pty answers with whatever the program was invoked as, which for
    // the shell we spawn is the path we handed it: measured "/bin/zsh"
    // against a SHELL_NAME of "zsh", so every idle tab read as busy. The
    // name is also what the message wants to show.
    const name = path.basename(shell.process);
    if (name === SHELL_NAME) {
      continue;
    }
    names.push(name);
  }
  return names;
}

export function killAllShells(): void {
  for (const shell of shells.values()) {
    shell.kill();
  }
}
