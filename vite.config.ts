// The page's build: Vite resolves what it imports — packages by name, their
// CSS, Monaco's worker — and writes the bundle the window loads. Everything
// outside src/renderer is `tsc`'s (ARCHITECTURE.md).
import { defineConfig } from "vite";
// Compiles style.css: the utilities the page actually uses, found by reading
// the sources @source names there.
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss()],
  root: "src/renderer", // index.html, beside the modules it pulls in
  // The window loads the page off disk, so every URL in the output has to be
  // relative to the page rather than to a site root.
  base: "./",
  build: {
    outDir: "../../dist/page", // dist/renderer is tsc's
    emptyOutDir: true,
    sourcemap: true,
    // Vite's preload polyfill is an inline script, which the page's CSP
    // refuses. Chromium supports modulepreload natively anyway.
    modulePreload: { polyfill: false },
  },
  // A classic worker in a file of its own: an inlined one arrives as a
  // blob: URL, which the CSP refuses (see renderer/code.ts).
  worker: { format: "iife" },
});
