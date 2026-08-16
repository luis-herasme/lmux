// Turning Git's porcelain output into the decoration a file row wears. Pure
// string parsing: no process, no filesystem, no Electron. The git process
// itself, and the directory reads, stay in file-tree.ts, which calls these.
import * as path from "path";
import type { GitDecorationStatus } from "../inter-process-communication/bridge.ts";

const CONFLICTING_GIT_STATUS_PAIRS = new Set([
  "DD",
  "AU",
  "UD",
  "UA",
  "DU",
  "AA",
  "UU",
]);

const STAGED_DECORATIONS = new Map<string, GitDecorationStatus>([
  ["M", "staged-modified"],
  ["A", "added"],
  ["D", "staged-deleted"],
  ["R", "renamed"],
  ["C", "copied"],
]);

const WORKING_TREE_DECORATIONS = new Map<string, GitDecorationStatus>([
  ["M", "modified"],
  ["A", "intent-to-add"],
  ["D", "deleted"],
  ["R", "intent-to-rename"],
  ["T", "type-changed"],
]);

type GitStatusColumns = {
  indexStatus: string;
  workingTreeStatus: string;
};

// Git reports paths with forward slashes whatever the platform; make every
// path the parser sees share that one shape. The tree watcher uses it too.
export function normalizedGitPath(gitPath: string): string {
  let normalizedPath = gitPath.split(path.sep).join("/");
  while (normalizedPath.endsWith("/")) {
    normalizedPath = normalizedPath.slice(0, -1);
  }
  return normalizedPath;
}

function decorationForGitStatus({
  indexStatus,
  workingTreeStatus,
}: GitStatusColumns): GitDecorationStatus | undefined {
  if (CONFLICTING_GIT_STATUS_PAIRS.has(`${indexStatus}${workingTreeStatus}`)) {
    return "conflicting";
  }
  if (indexStatus === "?" && workingTreeStatus === "?") {
    return "untracked";
  }
  if (indexStatus === "!" && workingTreeStatus === "!") {
    return "ignored";
  }
  const workingTreeDecoration = WORKING_TREE_DECORATIONS.get(workingTreeStatus);
  if (workingTreeDecoration !== undefined) {
    return workingTreeDecoration;
  }
  return STAGED_DECORATIONS.get(indexStatus);
}

export function gitDecorationsFromStatusOutput(
  output: string,
): Map<string, GitDecorationStatus> {
  const decorations = new Map<string, GitDecorationStatus>();
  let position = 0;
  while (position < output.length) {
    if (position + 3 > output.length) {
      break;
    }
    const indexStatus = output[position];
    const workingTreeStatus = output[position + 1];
    position += 3;
    const pathEnd = output.indexOf("\0", position);
    if (pathEnd < 0) {
      break;
    }
    const filePath = normalizedGitPath(output.slice(position, pathEnd));
    position = pathEnd + 1;

    if (
      indexStatus === "R" ||
      indexStatus === "C" ||
      workingTreeStatus === "R" ||
      workingTreeStatus === "C"
    ) {
      const originalPathEnd = output.indexOf("\0", position);
      if (originalPathEnd < 0) {
        break;
      }
      position = originalPathEnd + 1;
    }

    const status = decorationForGitStatus({
      indexStatus,
      workingTreeStatus,
    });
    if (status === undefined || filePath.length === 0) {
      continue;
    }
    decorations.set(filePath, status);
  }
  return decorations;
}

type AddSubmoduleDecorationsOptions = {
  output: string;
  decorations: Map<string, GitDecorationStatus>;
};

export function addSubmoduleDecorations({
  output,
  decorations,
}: AddSubmoduleDecorationsOptions): void {
  for (const record of output.split("\0")) {
    if (!record.startsWith("160000 ")) {
      continue;
    }
    const separatorPosition = record.indexOf("\t");
    if (separatorPosition < 0) {
      continue;
    }
    const filePath = normalizedGitPath(record.slice(separatorPosition + 1));
    if (filePath.length === 0) {
      continue;
    }
    decorations.set(filePath, "submodule");
  }
}
