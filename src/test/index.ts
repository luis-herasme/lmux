// Electron holds the ready event until its entry module has finished
// evaluating, so a top-level `await app.whenReady()` anywhere in this file's
// import graph deadlocks: the app waits for the module, the module waits for
// the app. Everything therefore lives in a module imported after ready,
// where top-level await is free.
import { app } from "electron";

app
  .whenReady()
  .then(() => import("./suite.ts"))
  .catch((error) => {
    // a boot that throws must not leave the app sitting there quietly
    console.error(error);
    app.exit(1);
  });
