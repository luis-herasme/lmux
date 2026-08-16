// The renderer's end of the cable. The preload script puts it on the page
// as a global, and this is the one place it is picked up, so every other
// module imports it by name like anything else.
//
// Reflect.get rather than `window.bridge`: the page's globals belong to no
// type the compiler knows about, and the alternative (teaching it about them
// with `declare global`) makes a name that appears from nowhere. Everything
// unchecked about the page is therefore these three lines, and a preload
// that did not run says so here instead of at whichever call happened first.
import type { Bridge } from "../inter-process-communication/bridge.ts";

const installed = Reflect.get(window, "bridge");
if (!installed) {
  throw new Error("window.bridge is missing: the preload script did not run");
}

export const bridge: Bridge = installed;
