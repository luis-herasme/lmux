import { ipcMain } from "electron";
import { readFile, realpath, stat } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { getShellCwd } from "./shells.ts";
import type { ReadFileRequest, ReadFileResult } from "../ipc/bridge.ts";

const MAX_FILE_BYTES = 5_000_000; // rendering a huge file would freeze the page

export type ResolveFilePathOptions = {
  filePath: string;
  baseTabId: number | undefined;
};

export type ResolvedFilePath =
  | { path: string }
  | { error: string };

// File reads can begin with a shell-relative path. The canonical result is
// what the caller stores the buffer under.
export async function resolveFilePath({
  filePath,
  baseTabId,
}: ResolveFilePathOptions): Promise<ResolvedFilePath> {
  let resolvedPath = filePath;
  if (resolvedPath.startsWith("~/")) {
    resolvedPath = path.join(os.homedir(), resolvedPath.slice(2));
  }
  if (!path.isAbsolute(resolvedPath)) {
    let base: string | undefined;
    if (baseTabId !== undefined) {
      base = await getShellCwd(baseTabId);
    }
    if (!base) {
      return {
        error: `Can't resolve ${filePath}: the tab's shell directory is unknown`,
      };
    }
    resolvedPath = path.resolve(base, resolvedPath);
  }
  try {
    return { path: await realpath(path.resolve(resolvedPath)) };
  } catch (error) {
    return { error: String(error) };
  }
}

ipcMain.handle(
  "file:read",
  async (_event, request: ReadFileRequest): Promise<ReadFileResult> => {
    const resolved = await resolveFilePath({
      filePath: request.path,
      baseTabId: request.baseTabId,
    });
    if ("error" in resolved) {
      return resolved;
    }
    try {
      const fileStats = await stat(resolved.path);
      if (fileStats.size > MAX_FILE_BYTES) {
        return { error: `${resolved.path} is too large to render` };
      }
      const content = await readFile(resolved.path, "utf8");
      return {
        resolvedPath: resolved.path,
        content,
      };
    } catch (error) {
      return { error: String(error) };
    }
  },
);
