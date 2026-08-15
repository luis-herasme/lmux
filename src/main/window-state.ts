// Where the window was last time. Renderer settings live in localStorage;
// this one is main's, because main creates the window before any page
// exists to ask.
import { app, screen } from "electron";
import type { Rectangle } from "electron";
import * as path from "path";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "./json-file.ts";

const STATE_FILE_PATH = path.join(app.getPath("userData"), "window.json");

const boundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  // a window smaller than this is a mistake, not a preference
  width: z.number().int().min(400),
  height: z.number().int().min(300),
});

// A display can be unplugged between runs, which would restore the window
// onto a desktop that no longer exists.
function isOnAScreen(bounds: Rectangle): boolean {
  for (const display of screen.getAllDisplays()) {
    const area = display.workArea;
    const overlapsAcross =
      bounds.x < area.x + area.width && bounds.x + bounds.width > area.x;
    const overlapsDown =
      bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
    if (overlapsAcross && overlapsDown) {
      return true;
    }
  }
  return false;
}

export function savedWindowBounds(): Rectangle | undefined {
  const parsed = boundsSchema.safeParse(readJsonFile(STATE_FILE_PATH));
  if (!parsed.success) {
    return undefined;
  }
  if (!isOnAScreen(parsed.data)) {
    return undefined;
  }
  return parsed.data;
}

export function saveWindowBounds(bounds: Rectangle): void {
  writeJsonFile(STATE_FILE_PATH, bounds);
}
