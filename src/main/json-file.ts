import { readFileSync, writeFileSync } from "fs";

export function readJsonFile(filePath: string): unknown {
  try {
    // JSON.parse stays inside the try: a half-written file must fail like a
    // missing one
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

export function writeJsonFile(filePath: string, value: unknown): void {
  try {
    writeFileSync(filePath, JSON.stringify(value));
  } catch {
    // best effort: a state file that fails to save is not worth failing a quit
    // over, and the next launch simply starts fresh
  }
}
