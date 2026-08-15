// The last session, on disk. Main's job for the same reason the window's
// geometry is: the file has to be read before there is a page to ask, and
// written while the window is closing.
import { app } from "electron";
import * as path from "path";
import { sessionSchema } from "../session.ts";
import type { Session } from "../session.ts";
import { readJsonFile, writeJsonFile } from "./json-file.ts";

export const SESSION_FILE_PATH = path.join(
  app.getPath("userData"),
  "session.json",
);

export function savedSession(): Session | undefined {
  const parsed = sessionSchema.safeParse(readJsonFile(SESSION_FILE_PATH));
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}

export function saveSession(session: Session): void {
  writeJsonFile(SESSION_FILE_PATH, session);
}
