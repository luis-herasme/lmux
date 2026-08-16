// Send Commands, assert on the state that comes back. The architecture was
// built for this: executeCommand is the one place state changes, and every
// Event carries a full snapshot, so a case needs no DOM knowledge except
// where the state deliberately holds none (a terminal's fitted size, a
// document's scroll position), which is what the probes in the area files
// are for.
//
// The cases share one live app and leave workspaces, tabs and open files
// behind for each other, so the import order below is the order they run in,
// and endRun exits the app, so it waits for every suite before it does.
import { endRun } from "./harness.ts";
import { commandBus } from "./command-bus.ts";
import { markdownDocuments } from "./markdown-documents.ts";
import { projectPanel } from "./project-panel.ts";
import { projectTree } from "./project-tree.ts";
import { projectFiles } from "./project-files.ts";
import { busRefusals } from "./refusals.ts";
import { mcpSocket } from "./mcp-socket.ts";
import { linkMatching } from "./terminal-links.ts";
import { gitStatusParsing } from "./git-decorations.ts";

await commandBus;
await markdownDocuments;
await projectPanel;
await projectTree;
await projectFiles;
await busRefusals;
await mcpSocket;
await linkMatching;
await gitStatusParsing;
endRun();
