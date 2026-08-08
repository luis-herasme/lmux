// The door an agent drives lmux through. MCP is JSON-RPC over a stream, and
// a unix domain socket is a stream, so `nc -U` is a complete client: no
// adapter process, no dependency, and the tools below are generated from
// the same Command union the compiler checks our own code against.
import { app } from "electron";
import * as net from "net";
import * as path from "path";
import { chmodSync, unlinkSync } from "fs";
import { z } from "zod";
import { commandSchema, screenRequestSchema } from "../api.ts";
import { lmuxState, readScreen, runCommand } from "./bus.ts";

// Beside session.json and window.json, in a directory macOS already keeps
// at 0700; the chmod below is what makes that true on its own terms.
export const SOCKET_PATH = path.join(app.getPath("userData"), "api.sock");

// What a client sends. A message with no `id` is a notification: it is
// acted on and never answered.
// `params` stays unchecked here so a request with the wrong ones is
// answered with an error rather than dropped, which would hang its caller.
const messageSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

type Message = z.infer<typeof messageSchema>;

const initializeSchema = z.object({
  protocolVersion: z.string(),
});

const toolCallSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

// The whole public API, in the shape MCP wants it: an object with one
// property, because a tool's input schema must be an object and a Command
// is a union.
const commandArgumentsSchema = z.object({
  command: commandSchema,
});

const TOOLS = [
  {
    name: "command",
    description:
      "Drive lmux, the terminal emulator this shell may be running inside. " +
      "One Command per call: open, close, activate, move, split and rename " +
      "tabs; type into a tab's shell; open a markdown document or a file in " +
      "the code editor; create, " +
      "switch and rename workspaces; change settings. Answers with lmux's " +
      "whole state once the command settled, so the id of a tab you just " +
      "opened comes back in the reply. Where `id` is optional it means the " +
      "active tab. Tab ids are unique across workspaces, group ids only " +
      "within one. `write` types into the shell exactly as a keyboard " +
      "would, so text needs a trailing newline to run. A new tab's shell " +
      "takes about a second to start, and text typed before then waits in " +
      "the terminal and runs when it does: read the screen again rather " +
      "than writing again, or the command runs twice. A terminal's own tab " +
      "id is $LMUX_TAB_ID in its environment.",
    inputSchema: z.toJSONSchema(commandArgumentsSchema, { io: "input" }),
  },
  {
    name: "state",
    description:
      "lmux's whole state: every workspace, the tabs it holds in visual " +
      "order, its pane layout, and which tab and workspace are active. " +
      "Takes no arguments. For starting cold, since the command tool " +
      "already answers with the state it produced.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "screen",
    description:
      "What a tab is showing, as lines of text with the escape sequences " +
      "already interpreted: exactly the characters a human sees in that " +
      "pane. Reads up from the bottom, so the default is the newest output; " +
      "ask for more `rows` to reach back into scrollback. A tab running a " +
      "full-screen program (vim, htop) answers with that program's painted " +
      "screen and `alternate: true`, and has no scrollback behind it. A " +
      "markdown or code tab answers with the path it shows rather than any " +
      "text, since the file on disk is that text.",
    inputSchema: z.toJSONSchema(screenRequestSchema, { io: "input" }),
  },
];

// JSON-RPC says a response carries exactly one of these.
type Answer = { result: unknown } | { error: { code: number; message: string } };

// Every tool answers with its own result as JSON, so the types in api.ts are
// the documentation and a screen's lines survive as lines.
function answered(value: unknown): Answer {
  return {
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify(value, null, 2),
        },
      ],
    },
  };
}

// A refused argument is the caller's mistake, not a broken connection, so it
// comes back as a tool result they can read and correct.
function refusal(message: string): Answer {
  return {
    result: {
      content: [
        {
          type: "text",
          text: message,
        },
      ],
      isError: true,
    },
  };
}

async function answerMessage(message: Message): Promise<Answer> {
  switch (message.method) {
    case "initialize": {
      // Nothing here behaves differently by version, so it speaks whichever
      // the client asked for and there is no dated string to go stale.
      const parsed = initializeSchema.safeParse(message.params);
      let protocolVersion = "2025-06-18";
      if (parsed.success) {
        protocolVersion = parsed.data.protocolVersion;
      }
      return {
        result: {
          protocolVersion,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "lmux",
            version: app.getVersion(),
          },
        },
      };
    }
    case "tools/list": {
      return {
        result: {
          tools: TOOLS,
        },
      };
    }
    case "tools/call": {
      const call = toolCallSchema.safeParse(message.params);
      if (!call.success) {
        return {
          error: {
            code: -32602,
            message: "a tool call needs a name",
          },
        };
      }
      if (call.data.name === "state") {
        return answered(lmuxState);
      }
      if (call.data.name === "screen") {
        const parsed = screenRequestSchema.safeParse(call.data.arguments);
        if (!parsed.success) {
          return refusal(z.prettifyError(parsed.error));
        }
        // A read that never came back means a page that stopped answering,
        // which the caller can neither fix nor wait out.
        try {
          return answered(await readScreen(parsed.data));
        } catch (error) {
          if (error instanceof Error) {
            return refusal(error.message);
          }
          return refusal("the screen could not be read");
        }
      }
      if (call.data.name !== "command") {
        return {
          error: {
            code: -32602,
            message: `no such tool: ${call.data.name}`,
          },
        };
      }
      const parsed = commandArgumentsSchema.safeParse(call.data.arguments);
      if (!parsed.success) {
        return refusal(z.prettifyError(parsed.error));
      }
      return answered(await runCommand(parsed.data.command));
    }
    default: {
      // Clients probe for capabilities we never declared (prompts,
      // resources); the spec's answer to those is this, not a dropped
      // connection.
      return {
        error: {
          code: -32601,
          message: `no such method: ${message.method}`,
        },
      };
    }
  }
}

type HandleLineOptions = {
  line: string;
  socket: net.Socket;
};

async function handleLine({ line, socket }: HandleLineOptions): Promise<void> {
  let received: unknown;
  try {
    received = JSON.parse(line);
  } catch {
    // nothing to answer to: a line that is not JSON carries no id either
    return;
  }
  const message = messageSchema.safeParse(received);
  if (!message.success) {
    return;
  }
  if (message.data.id === undefined) {
    return;
  }
  const answer = await answerMessage(message.data);
  socket.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: message.data.id,
      ...answer,
    }) + "\n",
  );
}

// A socket file outlives the process that made it, so a crash leaves one
// behind that listen() would refuse to replace.
try {
  unlinkSync(SOCKET_PATH);
} catch {
  // nothing left behind, which is the normal case
}

const server = net.createServer((socket) => {
  let buffered = "";
  // MCP frames on newlines, so a message is whatever arrived before one; a
  // chunk can hold several, or half of one.
  socket.on("data", (chunk) => {
    buffered += chunk.toString();
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim() === "") {
        continue;
      }
      // Nothing above rejects today, but an unhandled rejection is a dead
      // app in Node, and one client's bad line must not be that.
      handleLine({
        line,
        socket,
      }).catch((error) => {
        console.error("the API socket dropped a message:", error);
      });
    }
  });
  // a client that hangs up mid-request is ordinary, and unhandled here
  // would take the app down with it
  socket.on("error", () => {
    socket.destroy();
  });
});

server.on("error", (error) => {
  console.error("lmux is running without its API socket:", error.message);
});

server.listen(SOCKET_PATH, () => {
  chmodSync(SOCKET_PATH, 0o600);
});

app.on("will-quit", () => {
  server.close();
});
