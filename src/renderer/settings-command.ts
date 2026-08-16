// The one Command that touches everything at once: new settings have to
// reach every terminal, every document and every project panel, in every
// workspace, on screen or not.
import { bridge } from "./bridge.ts";
import { getSettings, updateSettings } from "./settings.ts";
import { refreshCodeTheme } from "./monaco.ts";
import { showProjectFile } from "./project-panel.ts";
import { redrawMarkdown } from "./tabs/markdown-tab.tsx";
import { refreshTerminalTabSettings } from "./tabs/terminal-tab.ts";
import { snapshot } from "./snapshot.ts";
import { activeWorkspace, workspaces } from "./workspaces.ts";
import type { Settings } from "../api.ts";

export function applySettings(partial: Partial<Settings>): void {
  const previous = getSettings();
  updateSettings(partial);
  const settings = getSettings();
  // a drawn diagram has the theme and the font baked into its SVG, so
  // it only follows those two by being drawn again
  const redraw =
    settings.theme !== previous.theme ||
    settings.markdownFontFamily !== previous.markdownFontFamily;
  // Monaco's themes are global to the page, so the palette is redefined
  // once here rather than per editor; only the font is per instance.
  refreshCodeTheme();
  for (const workspace of workspaces.values()) {
    const panel = workspace.project;
    if (panel !== undefined) {
      panel.editor?.updateOptions({
        fontFamily: settings.fontFamily,
        fontSize: settings.fontSize,
      });
      if (redraw && panel.file?.markdownMode === "rendered") {
        showProjectFile(panel);
      }
    }
    for (const tab of workspace.tabs.values()) {
      if (tab.kind === "markdown") {
        if (redraw) {
          redrawMarkdown(tab);
        }
        continue;
      }
      refreshTerminalTabSettings({
        tab,
        fit: workspace === activeWorkspace,
      });
    }
  }
  bridge.emitEvent({
    type: "settings-changed",
    settings,
    state: snapshot(),
  });
}
