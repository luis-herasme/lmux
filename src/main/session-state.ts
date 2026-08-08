// The last session, on disk. Main's job for the same reason the window's
// geometry is: the file has to be read before there is a page to ask, and
// written while the window is closing.
import { app } from "electron";
import { readFileSync, writeFileSync } from "fs";
import * as path from "path";
import { sessionSchema } from "../session.ts";
import type { Session } from "../session.ts";

export const SESSION_FILE_PATH = path.join(
  app.getPath("userData"),
  "session.json",
);

export function savedSession(): Session | undefined {
  let stored: unknown;
  try {
    // JSON.parse stays inside the try: a half-written file must fail like a
    // missing one
    stored = JSON.parse(readFileSync(SESSION_FILE_PATH, "utf8"));
  } catch {
    return undefined;
  }
  const parsed = sessionSchema.safeParse(stored);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}

export function saveSession(session: Session): void {
  try {
    writeFileSync(SESSION_FILE_PATH, JSON.stringify(session));
  } catch {
    // best effort: a session that fails to save is not worth failing a quit
    // over, and the next launch simply starts fresh
  }
}
