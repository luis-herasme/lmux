// Monaco, and the three things it needs before it will run here: a worker it
// can reach, a theme built from ours, and a language guessed from a
// filename. The project tab that uses all this is project-tab.ts.
import { currentTheme, getSettings } from "../settings.ts";
import type * as monacoModule from "monaco-editor";

export type Monaco = typeof monacoModule;

// One name, redefined whenever the palette changes. Monaco's themes are
// global to the page, so every editor follows this one without being told.
const THEME_NAME = "lmux";

// Monaco loads a Worker to do the work that would otherwise block the page.
// Two things about it are worth knowing, both learned the hard way:
//
//   - a Worker does start from a file:// page in Electron, so lmux does not
//     need to be served over a custom protocol to use one;
//   - left to itself Monaco reaches for a blob: URL, which the page's CSP
//     (`default-src 'self'`) refuses. Handing it a real file URL avoids the
//     fallback entirely, so the CSP stays as strict as it was.
//
// Resolved against this module rather than against whoever calls in: this
// file is dist/renderer/tabs/code.js and the worker is in dist/vendor/.
const workerUrl = new URL("../../vendor/editor.worker.js", import.meta.url);

type MonacoEnvironment = {
  getWorker: () => Worker;
};

// The page is loaded fresh for every window, so a module-level promise is
// the whole of the caching: the first caller starts the download and every
// later one waits on the same one.
let loading: Promise<Monaco> | undefined;

export function loadMonaco(): Promise<Monaco> {
  if (loading !== undefined) {
    return loading;
  }
  loading = importMonaco();
  return loading;
}

// 4MB of editor and language grammars, fetched when the first project tab opens
// rather than at boot: a terminal that never shows a file should not pay for
// one.
async function importMonaco(): Promise<Monaco> {
  const environment: MonacoEnvironment = {
    getWorker: () => new Worker(workerUrl, { type: "classic" }),
  };
  Reflect.set(self, "MonacoEnvironment", environment);
  // @ts-expect-error no declaration file beside the bundle; the types come
  // from the monaco-editor package above, the values from here
  const monaco: Monaco = await import("../../vendor/monaco.js");
  // the console door: an agent (or a driver) can reach the editors through
  // Monaco's own registry, the way window.lmux is the command door
  Reflect.set(self, "monaco", monaco);
  defineTheme(monaco);
  return monaco;
}

// Chrome from THEMES; token colors from Monaco's own base theme.
//
// That split is the same one the markdown view already makes, where the
// document's surface is ours and the code inside a fence is highlight.js's
// vs2015 — which is to say VS Code's palette either way. Colors left out
// here are inherited, so the editor is never half-themed.
function defineTheme(monaco: Monaco): void {
  const theme = currentTheme();
  let base: monacoModule.editor.BuiltinTheme = "vs";
  if (theme.colorScheme === "dark") {
    base = "vs-dark";
  }
  monaco.editor.defineTheme(THEME_NAME, {
    base,
    inherit: true,
    rules: [],
    colors: {
      "editor.background": theme.background,
      "editor.foreground": theme.foreground,
      "editorCursor.foreground": theme.cursor,
      "editorGutter.background": theme.background,
      "editorLineNumber.foreground": theme.tabForeground,
      "editorLineNumber.activeForeground": theme.tabActiveForeground,
      "editorWidget.background": theme.tabBarBackground,
      "editorWidget.border": theme.separator,
    },
  });
  // Applied as well as defined, and needed on every redefinition: Monaco
  // compares themes by identity, so a redefined palette only reaches the
  // editors when the new definition is selected again.
  monaco.editor.setTheme(THEME_NAME);
}

// Called when settings change. Does nothing until Monaco is loaded, which is
// correct: there is no editor to re-theme, and loading 4MB to repaint
// nothing would be worse than doing nothing.
export function refreshCodeTheme(): void {
  if (loading === undefined) {
    return;
  }
  loading.then(defineTheme);
}

// Monaco knows which extensions and filenames belong to each of the
// languages it ships; it just does not expose the lookup. `plaintext` is
// always registered, so an unknown file still opens.
type LanguageForPathOptions = {
  monaco: Monaco;
  filePath: string;
};

export function languageForPath({ monaco, filePath }: LanguageForPathOptions): string {
  const fileName = filePath.slice(filePath.lastIndexOf("/") + 1).toLowerCase();
  const extension = fileName.slice(fileName.lastIndexOf("."));
  for (const language of monaco.languages.getLanguages()) {
    // a language may declare whole filenames (Dockerfile, Makefile), or
    // extensions, or both, and a missing list is not an empty one
    let filenames = language.filenames;
    if (!filenames) {
      filenames = [];
    }
    for (const candidate of filenames) {
      if (candidate.toLowerCase() === fileName) {
        return language.id;
      }
    }
    let extensions = language.extensions;
    if (!extensions) {
      extensions = [];
    }
    for (const candidate of extensions) {
      if (candidate.toLowerCase() === extension) {
        return language.id;
      }
    }
  }
  return "plaintext";
}

export type CodeEditorOptions = {
  monaco: Monaco;
  container: HTMLElement;
};

export function createCodeEditor({
  monaco,
  container,
}: CodeEditorOptions): monacoModule.editor.IStandaloneCodeEditor {
  const settings = getSettings();
  return monaco.editor.create(container, {
    model: null,
    theme: THEME_NAME,
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    // the pane is a Dockview panel, which resizes without telling us
    automaticLayout: true,
  });
}
