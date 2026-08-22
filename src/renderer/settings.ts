import { z } from "zod";
import { THEMES, DEFAULT_SETTINGS } from "../theme.ts";
// The page keeps one link element for code token colors and points it at
// whichever of these two palettes the theme wants (applyCssVariables).
import darkCodeStyleUrl from "highlight.js/styles/vs2015.min.css?url";
import lightCodeStyleUrl from "highlight.js/styles/vs.min.css?url";
import { requireElement } from "./dom.ts";
import type { Theme } from "../theme.ts";
import type { Settings } from "../api.ts";

const STORAGE_KEY = "settings";

// the drag preview clamps to the same bounds this file corrects to
export const MIN_SIDEBAR_WIDTH_PX = 120;
export const MAX_SIDEBAR_WIDTH_PX = 400;

// wide enough for the tree beside a readable editor; the window's own width
// is the ceiling the drag actually runs into
export const MIN_EDITOR_WIDTH_PX = 320;
export const MAX_EDITOR_WIDTH_PX = 1600;

// every font size in the app, terminal and document alike; the dialog's
// number fields carry the same two as their own limits
export const MIN_FONT_SIZE_PX = 8;
export const MAX_FONT_SIZE_PX = 32;

// THEMES has literal keys; lookups use user-supplied strings
const themesByName: Record<string, Theme> = THEMES;

// Corrected, not rejected: a field that fails its checks catches to default.
// Bound to the wire Settings type, so a field added to api.ts without a
// correction here is a compile error rather than a silent drift.
const settingsSchema: z.ZodType<Settings> = z
  .object({
    theme: z
      .string()
      .refine((name) => name in themesByName)
      .catch(DEFAULT_SETTINGS.theme),
    fontFamily: z.string().trim().min(1).catch(DEFAULT_SETTINGS.fontFamily),
    uiFontFamily: z
      .string()
      .trim()
      .min(1)
      .catch(DEFAULT_SETTINGS.uiFontFamily),
    fontSize: z
      .number()
      .transform((size) =>
        Math.min(MAX_FONT_SIZE_PX, Math.max(MIN_FONT_SIZE_PX, Math.round(size))),
      )
      .catch(DEFAULT_SETTINGS.fontSize),
    markdownFontFamily: z
      .string()
      .trim()
      .min(1)
      .catch(DEFAULT_SETTINGS.markdownFontFamily),
    markdownFontSize: z
      .number()
      .transform((size) =>
        Math.min(MAX_FONT_SIZE_PX, Math.max(MIN_FONT_SIZE_PX, Math.round(size))),
      )
      .catch(DEFAULT_SETTINGS.markdownFontSize),
    sidebarWidth: z
      .number()
      .transform((width) =>
        Math.min(
          MAX_SIDEBAR_WIDTH_PX,
          Math.max(MIN_SIDEBAR_WIDTH_PX, Math.round(width)),
        ),
      )
      .catch(DEFAULT_SETTINGS.sidebarWidth),
    editorWidth: z
      .number()
      .transform((width) =>
        Math.min(
          MAX_EDITOR_WIDTH_PX,
          Math.max(MIN_EDITOR_WIDTH_PX, Math.round(width)),
        ),
      )
      .catch(DEFAULT_SETTINGS.editorWidth),
  })
  .catch({ ...DEFAULT_SETTINGS });

let settings: Settings = { ...DEFAULT_SETTINGS };
try {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored !== null) {
    settings = settingsSchema.parse(JSON.parse(stored));
  }
} catch {
}

export function getSettings(): Settings {
  return { ...settings };
}

export function currentTheme(): Theme {
  return themesByName[settings.theme];
}

export function updateSettings(partial: Partial<Settings>): void {
  settings = settingsSchema.parse({
    ...settings,
    ...partial,
  });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // locked storage: the change applies but won't survive a relaunch
  }
  applyCssVariables();
}

// camelCase to kebab-case: tabBarBackground to --tab-bar-background
export function applyCssVariables(): void {
  const values = {
    ...currentTheme(),
    fontFamily: settings.fontFamily,
    uiFontFamily: settings.uiFontFamily,
    markdownFontFamily: settings.markdownFontFamily,
  };
  for (const [key, value] of Object.entries(values)) {
    const cssName =
      "--" + key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
    document.documentElement.style.setProperty(cssName, String(value));
  }
  // set apart from the loop: lengths need their unit, colors and font
  // stacks don't
  document.documentElement.style.setProperty(
    "--sidebar-width",
    `${settings.sidebarWidth}px`,
  );
  document.documentElement.style.setProperty(
    "--editor-width",
    `${settings.editorWidth}px`,
  );
  document.documentElement.style.setProperty(
    "--markdown-font-size",
    `${settings.markdownFontSize}px`,
  );
  let highlightHref = lightCodeStyleUrl;
  if (currentTheme().colorScheme === "dark") {
    highlightHref = darkCodeStyleUrl;
  }
  const highlightCss = requireElement("highlight-css");
  if (highlightCss.getAttribute("href") !== highlightHref) {
    highlightCss.setAttribute("href", highlightHref);
  }
}
