import { ipcMain } from "electron";
import { readFile, stat, writeFile } from "fs/promises";
import * as path from "path";
import * as os from "os";
import { getShellCwd } from "./shells.ts";
import type {
  ReadFileRequest,
  ReadFileResult,
  WriteFileRequest,
  WriteFileResult,
} from "../ipc/bridge.ts";

const MAX_FILE_BYTES = 5_000_000; // rendering a huge file would freeze the page

type ResolveFilePathOptions = {
  filePath: string;
  baseTabId: number | undefined;
};

type ResolvedFilePath =
  | { path: string }
  | { error: string };

// Read and write resolve a path the same way: ~ expands, a relative path
// lands against the shell cwd of the tab that asked, and ".." is collapsed
// so a link can point out of its document's directory.
async function resolveFilePath({
  filePath,
  baseTabId,
}: ResolveFilePathOptions): Promise<ResolvedFilePath> {
  let result = filePath;
  if (result.startsWith("~/")) {
    result = path.join(os.homedir(), result.slice(2));
  }
  if (!path.isAbsolute(result)) {
    let base: string | undefined;
    if (baseTabId !== undefined) {
      base = await getShellCwd(baseTabId);
    }
    if (!base) {
      return {
        error: `Can't resolve ${filePath}: the tab's shell directory is unknown`,
      };
    }
    result = path.resolve(base, result);
  }
  return { path: path.resolve(result) };
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
      const stats = await stat(resolved.path);
      if (stats.size > MAX_FILE_BYTES) {
        return { error: `${resolved.path} is too large to render` };
      }
      const content = await readFile(resolved.path, "utf8");
      return {
        resolvedPath: resolved.path,
        content,
        mtimeMs: stats.mtimeMs,
      };
    } catch (error) {
      return { error: String(error) };
    }
  },
);

ipcMain.handle(
  "file:write",
  async (_event, request: WriteFileRequest): Promise<WriteFileResult> => {
    const resolved = await resolveFilePath({
      filePath: request.path,
      baseTabId: request.baseTabId,
    });
    if ("error" in resolved) {
      return { error: resolved.error };
    }
    try {
      const before = await stat(resolved.path);
      if (before.mtimeMs !== request.expectedMtimeMs) {
        // the file changed after it was read; writing would bury that change
        return {
          error: `${resolved.path} changed on disk since it was opened; it was not overwritten`,
        };
      }
      await writeFile(resolved.path, request.content, "utf8");
      // the write set a new mtime, which the next save guards against
      const after = await stat(resolved.path);
      return { mtimeMs: after.mtimeMs };
    } catch (error) {
      return { error: String(error) };
    }
  },
);
