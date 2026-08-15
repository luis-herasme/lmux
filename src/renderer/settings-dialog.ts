import { THEMES } from "../theme.ts";
import { getSettings } from "./settings.ts";
import { executeCommand } from "./tabs/index.ts";
import { focusWorkspace } from "./workspaces.ts";
import { requireElement, requireElementOfType } from "./dom.ts";
import type { Settings } from "../api.ts";

const dialog = requireElementOfType("settings-dialog", HTMLDialogElement);
const themeSelect = requireElementOfType("settings-theme", HTMLSelectElement);
const fontFamilyInput = requireElementOfType(
  "settings-font-family",
  HTMLInputElement,
);
const fontSizeInput = requireElementOfType(
  "settings-font-size",
  HTMLInputElement,
);
const uiFontFamilyInput = requireElementOfType(
  "settings-ui-font-family",
  HTMLInputElement,
);
const markdownFontFamilyInput = requireElementOfType(
  "settings-markdown-font-family",
  HTMLInputElement,
);
const markdownFontSizeInput = requireElementOfType(
  "settings-markdown-font-size",
  HTMLInputElement,
);

for (const name of Object.keys(THEMES)) {
  const option = document.createElement("option");
  option.value = name;
  const words: string[] = [];
  for (const word of name.split("-")) {
    words.push(word.charAt(0).toUpperCase() + word.slice(1));
  }
  option.textContent = words.join(" ");
  themeSelect.append(option);
}

function showCurrentSettings(): void {
  const settings = getSettings();
  themeSelect.value = settings.theme;
  fontFamilyInput.value = settings.fontFamily;
  fontSizeInput.value = String(settings.fontSize);
  uiFontFamilyInput.value = settings.uiFontFamily;
  markdownFontFamilyInput.value = settings.markdownFontFamily;
  markdownFontSizeInput.value = String(settings.markdownFontSize);
}

requireElement("settings-button").addEventListener("click", () => {
  showCurrentSettings();
  dialog.showModal();
});

// the schema corrects what it has to, so redisplay what actually stuck
function saveSettings(settings: Partial<Settings>): void {
  executeCommand({
    type: "update-settings",
    settings,
  });
  showCurrentSettings();
}

themeSelect.addEventListener("change", () => {
  saveSettings({ theme: themeSelect.value });
});

fontFamilyInput.addEventListener("change", () => {
  saveSettings({ fontFamily: fontFamilyInput.value });
});

fontSizeInput.addEventListener("change", () => {
  saveSettings({ fontSize: Number(fontSizeInput.value) });
});

uiFontFamilyInput.addEventListener("change", () => {
  saveSettings({ uiFontFamily: uiFontFamilyInput.value });
});

markdownFontFamilyInput.addEventListener("change", () => {
  saveSettings({ markdownFontFamily: markdownFontFamilyInput.value });
});

markdownFontSizeInput.addEventListener("change", () => {
  saveSettings({ markdownFontSize: Number(markdownFontSizeInput.value) });
});

requireElement("settings-done").addEventListener("click", () => {
  dialog.close();
});

dialog.addEventListener("close", () => {
  focusWorkspace();
});
