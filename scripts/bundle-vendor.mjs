// The bundler, and the only thing in the project that needs one.
//
// Most dependencies expose files the browser can load directly. Monaco and
// Pierre Trees use bare specifiers, so only those two are bundled. The app's
// own modules remain one-to-one `tsc` output (ARCHITECTURE.md).
import * as esbuild from "esbuild";
import * as path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function fromRoot(...segments) {
  return path.join(root, ...segments);
}

// Monaco's own entry point, which pulls in the editor and every language
// grammar it ships. The grammars cost about 1.8MB of the total and buy
// every file type at once, which is cheaper than a curated list that is
// wrong the first time somebody opens a .rs file.
const editor = {
  entryPoints: [fromRoot("node_modules/monaco-editor/esm/vs/index.js")],
  outfile: fromRoot("dist/vendor/monaco.js"),
  format: "esm",
};

// Monaco asks for this one in a Worker. It has to be a classic script: a
// module worker would need its imports resolved at runtime, which is the
// problem we are bundling to avoid.
const worker = {
  entryPoints: [
    fromRoot("node_modules/monaco-editor/esm/vs/editor/editor.worker.start.js"),
  ],
  outfile: fromRoot("dist/vendor/editor.worker.js"),
  format: "iife",
};

// The vanilla class only. The package's root also exports React, SSR and
// composition helpers that this panel never imports.
const trees = {
  entryPoints: [
    fromRoot("node_modules/@pierre/trees/dist/render/FileTree.js"),
  ],
  outfile: fromRoot("dist/vendor/trees.js"),
  format: "esm",
};

for (const target of [editor, worker, trees]) {
  await esbuild.build({
    entryPoints: target.entryPoints,
    outfile: target.outfile,
    format: target.format,
    bundle: true,
    minify: true,
    // Monaco's CSS comes out beside the bundle as monaco.css, which
    // index.html links. The icon font is inlined into it rather than emitted
    // as a file: one less artifact to copy into the packaged app, and one
    // less URL for the page's CSP to have an opinion about.
    loader: { ".ttf": "dataurl" },
    logLevel: "warning",
  });
}
