import { THEMES } from "../theme.ts";
import { getSettings } from "./settings.ts";
import { executeCommand, focusActiveTab } from "./tabs/index.ts";
import { requireElement } from "./dom.ts";

const dialogElement = requireElement("settings-dialog");
if (!(dialogElement instanceof HTMLDialogElement)) {
  throw new Error("#settings-dialog is not a <dialog>");
}
const dialog: HTMLDialogElement = dialogElement;
const themeSelectElement = requireElement("settings-theme");
if (!(themeSelectElement instanceof HTMLSelectElement)) {
  throw new Error("#settings-theme is not a <select>");
}
const themeSelect: HTMLSelectElement = themeSelectElement;
const fontFamilyInputElement = requireElement("settings-font-family");
if (!(fontFamilyInputElement instanceof HTMLInputElement)) {
  throw new Error("#settings-font-family is not an <input>");
}
const fontFamilyInput: HTMLInputElement = fontFamilyInputElement;
const fontSizeInputElement = requireElement("settings-font-size");
if (!(fontSizeInputElement instanceof HTMLInputElement)) {
  throw new Error("#settings-font-size is not an <input>");
}
const fontSizeInput: HTMLInputElement = fontSizeInputElement;
const uiFontFamilyInputElement = requireElement("settings-ui-font-family");
if (!(uiFontFamilyInputElement instanceof HTMLInputElement)) {
  throw new Error("#settings-ui-font-family is not an <input>");
}
const uiFontFamilyInput: HTMLInputElement = uiFontFamilyInputElement;
const markdownFontFamilyInputElement = requireElement(
  "settings-markdown-font-family",
);
if (!(markdownFontFamilyInputElement instanceof HTMLInputElement)) {
  throw new Error("#settings-markdown-font-family is not an <input>");
}
const markdownFontFamilyInput: HTMLInputElement = markdownFontFamilyInputElement;
const markdownFontSizeInputElement = requireElement(
  "settings-markdown-font-size",
);
if (!(markdownFontSizeInputElement instanceof HTMLInputElement)) {
  throw new Error("#settings-markdown-font-size is not an <input>");
}
const markdownFontSizeInput: HTMLInputElement = markdownFontSizeInputElement;

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

themeSelect.addEventListener("change", () => {
  executeCommand({
    type: "update-settings",
    settings: { theme: themeSelect.value },
  });
  showCurrentSettings();
});

fontFamilyInput.addEventListener("change", () => {
  executeCommand({
    type: "update-settings",
    settings: { fontFamily: fontFamilyInput.value },
  });
  showCurrentSettings();
});

fontSizeInput.addEventListener("change", () => {
  executeCommand({
    type: "update-settings",
    settings: { fontSize: Number(fontSizeInput.value) },
  });
  showCurrentSettings();
});

uiFontFamilyInput.addEventListener("change", () => {
  executeCommand({
    type: "update-settings",
    settings: { uiFontFamily: uiFontFamilyInput.value },
  });
  showCurrentSettings();
});

markdownFontFamilyInput.addEventListener("change", () => {
  executeCommand({
    type: "update-settings",
    settings: { markdownFontFamily: markdownFontFamilyInput.value },
  });
  showCurrentSettings();
});

markdownFontSizeInput.addEventListener("change", () => {
  executeCommand({
    type: "update-settings",
    settings: { markdownFontSize: Number(markdownFontSizeInput.value) },
  });
  showCurrentSettings();
});

requireElement("settings-done").addEventListener("click", () => {
  dialog.close();
});

dialog.addEventListener("close", () => {
  focusActiveTab();
});
