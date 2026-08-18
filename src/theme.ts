// The theme palettes and the default settings. Both sides import this;
// CSS gets the values as custom properties via renderer/settings.ts.
import type { Settings } from "./api.ts";

// One complete palette: every theme defines every key, so switching can
// never leave a color behind.
export type Theme = {
  // handed to CSS `color-scheme`, so Chromium's own drawings match
  colorScheme: "dark" | "light";
  // one color for window, page and xterm cells: hides the leftover pixels
  // around the character grid
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  scrollbarThumb: string;
  scrollbarThumbHover: string;
  // darker than the terminal, so the active tab (which shares the
  // terminal's background) reads as connected to it
  tabBarBackground: string;
  tabForeground: string;
  tabActiveForeground: string;
  // always opaque: a translucent line renders differently on every surface
  // and double-darkens where two overlap
  separator: string;
  accent: string;
  gitAddedForeground: string;
  gitModifiedForeground: string;
  gitDeletedForeground: string;
  gitRenamedForeground: string;
  gitUntrackedForeground: string;
  gitIgnoredForeground: string;
  gitStageModifiedForeground: string;
  gitStageDeletedForeground: string;
  gitConflictingForeground: string;
  gitSubmoduleForeground: string;
  // markdown links; VS Code's textLink.foreground values, softer than the
  // accent
  linkForeground: string;
};

export const THEMES = {
  dark: {
    colorScheme: "dark",
    background: "#1e1e1e",
    foreground: "#ffffff",
    cursor: "#ffffff",
    selectionBackground: "rgba(255, 255, 255, 0.3)",
    scrollbarThumb: "rgba(255, 255, 255, 0.25)",
    scrollbarThumbHover: "rgba(255, 255, 255, 0.45)",
    tabBarBackground: "#161616",
    tabForeground: "#8a8a8a",
    tabActiveForeground: "#e6e6e6",
    separator: "#323232",
    accent: "#cccccc", // bright gray
    // https://github.com/microsoft/vscode/blob/main/extensions/git/package.json
    gitAddedForeground: "#81b88b",
    gitModifiedForeground: "#e2c08d",
    gitDeletedForeground: "#c74e39",
    gitRenamedForeground: "#73c991",
    gitUntrackedForeground: "#73c991",
    gitIgnoredForeground: "#8c8c8c",
    gitStageModifiedForeground: "#e2c08d",
    gitStageDeletedForeground: "#c74e39",
    gitConflictingForeground: "#e4676b",
    gitSubmoduleForeground: "#8db9e2",
    linkForeground: "#4daafc", // VS Code Dark Modern
  },
  light: {
    colorScheme: "light",
    background: "#ffffff",
    foreground: "#1e1e1e",
    cursor: "#1e1e1e",
    selectionBackground: "rgba(0, 0, 0, 0.2)",
    scrollbarThumb: "rgba(0, 0, 0, 0.25)",
    scrollbarThumbHover: "rgba(0, 0, 0, 0.45)",
    tabBarBackground: "#ececec",
    tabForeground: "#767676",
    tabActiveForeground: "#1a1a1a",
    separator: "#d0d0d0",
    accent: "#5f5f5f", // the dark theme's gray mirrored: bright gray vanishes on white
    // https://github.com/microsoft/vscode/blob/main/extensions/git/package.json
    gitAddedForeground: "#587c0c",
    gitModifiedForeground: "#895503",
    gitDeletedForeground: "#ad0707",
    gitRenamedForeground: "#007100",
    gitUntrackedForeground: "#007100",
    gitIgnoredForeground: "#8e8e90",
    gitStageModifiedForeground: "#895503",
    gitStageDeletedForeground: "#ad0707",
    gitConflictingForeground: "#ad0707",
    gitSubmoduleForeground: "#1258a7",
    linkForeground: "#005fb8", // VS Code Light Modern
  },
  // https://ethanschoonover.com/solarized
  "solarized-dark": {
    colorScheme: "dark",
    background: "#002b36",
    foreground: "#839496",
    cursor: "#839496",
    selectionBackground: "rgba(131, 148, 150, 0.3)",
    scrollbarThumb: "rgba(147, 161, 161, 0.25)",
    scrollbarThumbHover: "rgba(147, 161, 161, 0.45)",
    tabBarBackground: "#00212b",
    tabForeground: "#657b83",
    tabActiveForeground: "#93a1a1",
    separator: "#073642", // solarized base02, its own highlight tone
    accent: "#268bd2",
    // VS Code's Solarized Dark leaves the Git extension defaults unchanged.
    // https://github.com/microsoft/vscode/blob/main/extensions/git/package.json
    gitAddedForeground: "#81b88b",
    gitModifiedForeground: "#e2c08d",
    gitDeletedForeground: "#c74e39",
    gitRenamedForeground: "#73c991",
    gitUntrackedForeground: "#73c991",
    gitIgnoredForeground: "#8c8c8c",
    gitStageModifiedForeground: "#e2c08d",
    gitStageDeletedForeground: "#c74e39",
    gitConflictingForeground: "#e4676b",
    gitSubmoduleForeground: "#8db9e2",
    linkForeground: "#268bd2", // solarized blue
  },
} satisfies Record<string, Theme>;

type ThemeName = keyof typeof THEMES;

// defaults only: the current values live in renderer/settings.ts
export const DEFAULT_SETTINGS = {
  theme: "dark",
  fontFamily: "Menlo, monospace",
  fontSize: 13,
  uiFontFamily: "system-ui",
  markdownFontFamily: "system-ui",
  markdownFontSize: 14,
  sidebarWidth: 160,
  editorWidth: 520,
} satisfies Settings & { theme: ThemeName };
