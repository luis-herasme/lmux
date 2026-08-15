import { executeCommand, getTabTitle, focusWorkspace } from "./tabs/index.ts";
import { workspaces } from "./workspaces.ts";
import { requireElement, requireElementOfType } from "./dom.ts";

const dialog = requireElementOfType("rename-dialog", HTMLDialogElement);
const input = requireElementOfType("rename-input", HTMLInputElement);
const heading = requireElement("rename-heading");

type RenameTarget = {
  kind: "tab" | "workspace";
  id: number;
};

let target: RenameTarget = {
  kind: "tab",
  id: -1,
};

export function openRenameDialog({ kind, id }: RenameTarget): void {
  let currentName: string | undefined;
  if (kind === "tab") {
    heading.textContent = "Rename Tab";
    currentName = getTabTitle(id);
  }
  if (kind === "workspace") {
    heading.textContent = "Rename Workspace";
    currentName = workspaces.get(id)?.name;
  }
  if (currentName === undefined) {
    return;
  }
  target = {
    kind,
    id,
  };
  dialog.returnValue = "";
  input.value = currentName;
  dialog.showModal();
  input.select();
}

requireElement("rename-cancel").addEventListener("click", () => {
  dialog.close();
});

dialog.addEventListener("close", () => {
  if (dialog.returnValue === "rename") {
    if (target.kind === "tab") {
      executeCommand({
        type: "set-tab-title",
        id: target.id,
        title: input.value.trim(),
      });
    }
    if (target.kind === "workspace") {
      executeCommand({
        type: "rename-workspace",
        id: target.id,
        name: input.value.trim(),
      });
    }
  }
  focusWorkspace();
});
