// The renderer's build. Vite resolves what the page imports — packages by
// name, their CSS, and Monaco's worker — and writes one bundle for the
// window to load. Everything outside src/renderer is `tsc`'s (ARCHITECTURE.md).
import { defineConfig } from "vite";

export default defineConfig({
  // index.html is the entry, and it sits beside the modules it pulls in
  root: "src/renderer",

  // The window loads the page off disk, not from a server, so every URL in
  // the output has to be relative to the page rather than to a site root.
  base: "./",

  build: {
    // dist/renderer is tsc's output; the page is a build of its own
    outDir: "../../dist/page",
    emptyOutDir: true,
    sourcemap: true,
    // Vite's preload polyfill is an inline script, which the page's CSP
    // refuses. Chromium supports modulepreload natively, so the polyfill has
    // nothing to do here anyway.
    modulePreload: { polyfill: false },
  },

  // A classic worker in a file of its own. A module worker would be fetched
  // as a module from file://, and an inlined one arrives as a blob: URL,
  // which the CSP refuses (see renderer/code.ts).
  worker: { format: "iife" },
});
