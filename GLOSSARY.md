# Glossary

The vocabulary of lmux: the terminal-domain terms the app is built on, the
libraries it depends on directly, and the concepts it defines itself. New
concepts get an entry as they land.

## Terminal emulator

A program that draws a grid of characters in a window, sends your keystrokes to
a program (usually a shell), and interprets the bytes coming back (including
invisible control codes) to update the screen. **The terminal emulator does not
understand commands**: it never knows what `ls` means. It only moves bytes and
draws characters. macOS Terminal, iTerm2 and lmux are all terminal emulators.

## Shell

The program that actually interprets your commands. When you type `ls -la` and
press Enter, the shell parses that line, finds the `ls` program, runs it, and
shows you a new prompt when it finishes. On macOS the default shell is **zsh**,
which is what lmux spawns. Terminal emulator and shell are separate programs:
the emulator is the window, the shell is the conversation happening inside it.

## Login shell

A shell started with the `-l` flag, which makes it read your startup files
(`~/.zprofile`, `~/.zshrc` on macOS). lmux spawns shells this way so your PATH,
aliases and prompt look identical to Terminal.app. Without it you get a bare,
unconfigured shell.

## TTY

The kernel's representation of a terminal: a special file (like `/dev/ttys003`)
that a program can read from and write to as if a person were on the other end.
Programs check "am I attached to a TTY?" to decide how to behave: `ls` prints
colors to a TTY but plain text when piped to a file.

## PTY (pseudo-terminal)

A TTY created by software instead of hardware. It is a pair of connected
endpoints: the shell attaches to one end and believes it is a real terminal;
lmux holds the other and plays the human, feeding keystrokes in and reading
output out. A shell launched over an ordinary pipe would think its output was
going to a file: no colors, no line editing, and vim would refuse to run.
`node-pty` is the library that creates PTYs.

## Escape sequences (ANSI codes)

How a shell talks to the terminal beyond plain text. The output stream is mixed
with invisible commands that all start with the ESC byte (27): `ESC[31m` means
"draw the following text in red", `ESC[2J` means "clear the screen", `ESC[H`
means "move the cursor to the top-left". Full-screen programs like vim are
really just fountains of escape sequences. Parsing them correctly is the hardest
part of a terminal emulator; it is the main thing xterm.js does for lmux.

## xterm.js

A JavaScript library that implements the "screen" half of a terminal emulator:
it maintains the character grid, parses escape sequences, draws everything into
the page, and turns your keypresses into the bytes a shell expects. It powers
the terminal in VS Code. It deliberately does **not** run shells; that is lmux's
job, via node-pty.

## Electron: main process and renderer process

An Electron app is two kinds of programs working together. The **main process**
is a Node.js program with full access to your machine: it opens windows and, in
lmux, spawns the shell. Each window runs a **renderer process**: a Chromium
browser page that can show UI but is sandboxed away from your system, like any
web page. The xterm.js screen lives in the renderer; the PTY lives in main. They
are separate operating-system processes and share no memory.

## IPC (inter-process communication)

How the main and renderer processes talk: named messages passed between them
(`ipcMain` / `ipcRenderer` in Electron). Ours carry the per-tab shell protocol
(`shell:spawn`, `shell:write`, `shell:data`, ...) and the command bus (`command`
in, `event` out); the full list is "The boundary" in ARCHITECTURE.md.

## Command / Event

The two halves of lmux's public interface. A **command** is an imperative
request flowing *into* lmux ("open a tab", "type this text"), named in the
imperative mood. An **event** is a fact flowing *out* ("tab 3 opened"), named in
the past tense, and carrying a snapshot of the resulting state. Keeping the two directions as two words (borrowed from the CQRS pattern)
matters because an external driver, like an agent, needs both: send commands,
observe events. One word would muddle which way the arrow points.

## Menu accelerator

A keyboard shortcut attached to an application-menu item (macOS's native way of
owning shortcuts). Accelerators fire *before* the focused web page sees the key,
which cuts both ways: the default menu binds ⌘W to "close window", so a page
could never intercept it for "close tab"; but a menu we define ourselves gets
⌘T/⌘W reliably, even while xterm has keyboard focus. That is why our tab
shortcuts live in main's menu and arrive in the renderer as forwarded events
rather than keystrokes.

## Preload script

A small script that runs inside the renderer *before* the page loads, with
access to both worlds. It exposes a hand-picked API to the page (our
`window.bridge`) so the sandboxed page never gets direct access to Node.js. This
pattern is called **context isolation** and is Electron's security model: the
page can only do what the preload explicitly permits.

## Native module / ABI (why `npm run rebuild` exists)

node-pty contains C++ code compiled into a binary, because creating PTYs
requires operating-system calls JavaScript cannot make. A compiled binary must
match the exact runtime that loads it, and Electron ships its own Node.js whose
**ABI** (application binary interface) differs from the Node on your machine, so
`electron-rebuild` recompiles node-pty against Electron's headers after
installing. Symptom of forgetting this step: the app crashes on launch with "was
compiled against a different Node.js version".

## Monaco

[Monaco](https://microsoft.github.io/monaco-editor/) is the code editor from VS
Code, published as a standalone library. It is the *editor surface* only: it
paints text, highlights it, and provides the interface for things like
go-to-definition, but it brings no workbench (lmux's tabs, layout and command
bus stay lmux's) and no language intelligence of its own. Knowing what a symbol
means, and where it was defined, is a separate job belonging to a language
server.

## Link provider

xterm's hook for making arbitrary terminal text clickable. The emulator has no
idea what a path or URL is; a link provider is asked, per buffer line, "any
links here?" and answers with character ranges and an activate callback. Ours
matches file paths ending in a linked extension (after joining wrapped rows,
since a long path spans several buffer rows), where markdown opens rendered and
code opens in the editor, and `http(s)` URLs, which open in the default browser;
all on Cmd+click. The complementary mechanism is OSC 8, an escape sequence a
program uses to *declare* a hyperlink explicitly; provider-side detection needs
no cooperation from the program, which is why we started there.

## Drag region / hiddenInset

How an app paints its own title bar on macOS. Creating the Electron window with
`titleBarStyle: "hiddenInset"` hides the standard title bar: the traffic lights
remain, drawn by macOS inset over the page, and the page extends to the window's
top edge, free to paint its own strip any color. The CSS property
`-webkit-app-region: drag` then marks an element as a **drag region**: its mouse
events go to the window manager instead of the page, which restores the native
title-bar behaviors (dragging moves the window, double-click zooms it). The
trade is that a drag region's pixels are deaf to the page, so nothing inside one
can react to clicks. Our painted `#title-bar` is exactly this pattern.

## Character cell / grid

A terminal screen is not free-form text; it is a rigid grid of equal-size cells,
one character each. Everything is measured in cells: cursor position, window
size, vim's layout. Consequence: a window's pixel height is rarely an exact
multiple of the cell height, so a leftover strip of a few pixels always exists
past the last row. Terminals hide it by painting it the same color as the
screen.

## Viewport / scrollable element (xterm's layers)

Inside the `.xterm` element xterm stacks two boxes. The **viewport**
(`.xterm-viewport`) is a plain div absolutely positioned to fill the whole
`.xterm` box; xterm's stylesheet paints it black. The **scrollable element**
(`.xterm-scrollable-element`, since xterm v6) wraps the character grid and is
the box the theme's background color is painted on, but it only spans the grid,
cols × rows cells. Whatever the grid does not cover, the inset around it and the
fit remainder past the last row and column, shows the viewport behind it, so
unless the app restyles the viewport, that surround is black no matter what
theme the terminal draws with (our own stylesheet overrides it to the theme
background).

## Resize handle

A narrow draggable separator between two regions. The project panel's inner
handle changes how much horizontal space belongs to the file tree; Left and
Right Arrow provide the same control from the keyboard. This is local layout, so
that width lasts for the panel rather than becoming public state. The sidebar's
handle and the panel's own outer handle are different: they decide how much
window the panes get, so each drag ends as one `update-settings` Command and the
width survives a relaunch.

## Scrollback

The lines that have scrolled off the top of the screen. xterm.js keeps a buffer
of them (1000 lines by default) so you can scroll up, and a `screen` read
reaches back into it.

## OSC (Operating System Command)

The family of escape sequences addressed to the terminal *program* rather than
the screen. Ordinary escape codes do things the hardware did: move the cursor,
color text. OSC sequences (they start with `ESC ]`) ask for things only the
surrounding software can do, and the classic one is the window title:
`ESC ] 0 ; hello BEL` means "call this window *hello*". Configured shells emit
one before every prompt (naming the tab after the current directory), and
programs like vim and ssh set their own while running. The title is therefore
not something the emulator invents; the programs inside announce it, and the
emulator just displays the latest announcement. xterm.js parses the sequence out
of the byte stream and hands us the text as an `onTitleChange` event.

## Docking layout manager

A UI component that owns a region of the page and manages a tree of panes inside
it: each pane has a tab strip, tabs can be dragged to reorder or to another
pane, panes can be split and resized with draggable dividers, and the whole
arrangement can be saved and restored. The pattern is what makes VS Code's
editor area feel the way it does. This project uses
[Dockview](https://dockview.dev): our tab bar and terminal panes are Dockview
"panels". Tabs drag along a strip to reorder, between strips to change group,
and onto a pane's edge to split; window-edge drops and whole-group drags stay
disabled until a feature needs them.

## Tab / tab kind / pane

A **tab** is one selectable item and its content in a workspace layout. A **tab
kind** describes that content: terminal or Markdown. A **pane** is the layout
region displaying one active tab. The project panel is not a tab: it is
workspace state shown beside the panes (see *Project panel / file tab*).

## Workspace

A whole lmux of its own inside the same window: its own pane layout, its own
tabs, its own shells, its own project panel. The sidebar lists them and
switching is one click; only one is on screen at a time, and the ones behind
keep running, so a build left compiling in one workspace is still compiling when
you come back to it. The name comes from tiling window managers and VS Code,
where the same word means "the set of things I'm currently working on"; this
app's version is closest to i3's or macOS's *desktops* (Mission Control spaces):
several independent screens, one visible.

A workspace names itself after its active tab, so the sidebar row and the title
bar say whatever that tab says: the shell's own title (which zsh keeps at
`user@host:cwd`), or a Markdown file's name. Renaming a workspace pins the name
against that, exactly as renaming a tab pins it against the shell; renaming it
to `""` unpins and lets it follow again. A workspace with no tabs falls back to
`Workspace N`.

The mechanic is one docking layout manager instance per workspace, hidden with
`display: none` when it isn't the active one. Nothing is serialized or rebuilt
on a switch, which is what keeps a terminal's scrollback, its running program,
and its cursor position exactly where you left them. The one thing a hidden
workspace can't do is measure itself (a hidden element reports a zero-sized
box), so terminals skip fitting while they're away and re-fit when their
workspace comes forward.

## Workspace root / file tree

A **workspace root** is the stable top directory shown by one workspace's file
tree. The panel derives it, when it is first opened, from a file's Git
repository, or from a terminal's Git repository or current directory. Changing
it is explicit and does not close file tabs. Resolving it to its real path and
refusing to follow symbolic links keeps directory reads inside that boundary.

A **file tree** is the hierarchical view of every directory and file below the
workspace root. The paths are its identities: one path names the same item in the
renderer, the public state and main's filesystem reads.

The tree loads lazily: it reads the root first, then a directory's immediate
children only when a person expands it, so collapsed subtrees cost no filesystem
work, IPC payload or DOM rows. Filesystem events reconcile directories that have
already loaded while preserving their expanded descendants.

## Git state / file decoration

A **file decoration** is the color and trailing badge Git state adds to a file
row. `M`, `A`, `D`, `R`, `C`, `T`, `U`, `!` and `S` mean modified, added,
deleted, renamed, copied, type-changed, untracked, conflicting and submodule.
Ignored paths have only a muted color. Both the filename and badge use VS Code's
corresponding `gitDecoration.*` color. A folder whose descendants have a
propagating change gets a generic colored bubble instead of borrowing one
child's letter.

Status is read against the checked-out commit (`HEAD`), which is not
necessarily the branch named `main`. A file can carry both a staged change in
the index and a later unstaged change in the working tree; like VS Code, lmux
shows the working-tree status when both exist.

## Project panel / file tab

A **project panel** is the workspace's one editor, and the only place files
open. It contains the file tree, a file-tab strip and one Monaco editor, under a
header naming the workspace root folder. It is not a tab: there is exactly one
per workspace, it lives in its own region beside the pane layout, and it cannot
be dragged, split, reordered or moved to another workspace, the same way the
workspace list itself cannot. Opening another file reuses it; files outside the
workspace root are valid file tabs but do not change the tree. Hiding the panel
(its header's ×, ⌘B, or `close-project`) is not closing it: every buffer stays
open behind it, so nothing is asked and nothing is lost.

A **file tab** names one in-memory file buffer inside the project panel. A
single tree click opens a replaceable **preview file tab**. Editing it or
double-clicking its tree item makes it a **pinned file tab**, which remains
until explicitly closed. File tabs can be dragged to reorder them. The file-tab
strip, not Dockview, switches the one Monaco editor between those buffers.

An **untitled file** is a blank buffer that has not been given a disk path.
Double-clicking empty file-tab-strip space creates one named `Untitled`. Its
hidden id distinguishes it from other untitled buffers without changing the
visible title. Its first save is **Save As**, which asks for a disk path and
turns the same buffer into a regular file tab.

A **buffer** is a file's in-memory model: its text, dirty state, undo history,
cursor and scroll position. Switching files keeps each buffer alive. A restart
restores pinned paths from disk, never unsaved buffer contents or the temporary
preview.

## Rendered vs. raw (a markdown tab's two modes)

The same file, shown two ways. *Rendered* is the document: headings as headings,
tables as tables, ```mermaid fences as drawn diagrams. *Raw* is the file's own
text, the characters on disk, in the terminal's font. The toolbar's first button
swaps between them and names the mode it would switch to, the way a play button
names what it will do rather than what is happening. The second button re-reads
the file, since nothing watches the disk: edit a document in one tab, click
Reload in the tab showing it.

A markdown file inside the project panel has the same two faces, per open
buffer. There its raw face is the editor itself, so the way back from rendered
reads *Edit*, and there is no Reload: the rendering draws the buffer as it is in
memory, unsaved edits included. The model stays on the hidden editor while its
rendering shows, which is why dirty state, view state and saving never notice
the swap. The toggle is the `set-file-markdown-mode` Command; each buffer keeps
its mode while open, and a restart brings files back in the editor.

## Dirty (a file buffer's unsaved work)

A file buffer is *dirty* when its model holds text the file on disk does not. It
becomes dirty on the first edit after opening or saving, which also pins a
preview file. A blank untitled buffer starts clean, becomes dirty when it has
content and becomes clean again when emptied. The ● in the file tab says so, and
`dirty` rides on the project's file state so main can guard every kind of close.
Tree badges are separate Git state, so an unsaved edit alone does not create
`M`, while saving a change normally does. A save refuses to overwrite a file
whose mtime changed since it was read, because the alternative is burying work
the disk has and the editor does not.

## Drag-and-drop interception (the one-door rule)

How Dockview stays subordinate to the command bus. A docking library normally
applies a drag itself: you drop a tab, the library mutates its layout, and the
application finds out afterwards. That would make gestures a second write path
around the bus. Dockview instead exposes `onWillDrop`, which fires *before* it
mutates anything and can be cancelled. We cancel every drop, translate it into
the equivalent Command (`move-tab` for strip and pane-center drops, `split-tab`
for pane-edge drops), and dispatch that through `executeCommand`, which performs
the identical move via Dockview's programmatic API (`panel.api.moveTo`). The
gesture becomes just another Command source, the same door as the menus, the
devtools console, and an agent. The hand-built file-tab strip follows the same
rule: a browser drop issues `move-file`, then that Command reorders the buffers.
The one exception is clicking a Dockview tab to activate it: that's focus, not
layout, and the mousedown that activates is the same one that begins a drag, so
activation is applied by Dockview and announced on the bus afterwards as a
`tab-activated` Event.

## Unix domain socket

A socket that lives in the filesystem as a file rather than on a network port.
Two processes on the same machine talk through it exactly as they would over
TCP, but it is never reachable from another machine and never from a web page.
Its access control is the file's own permissions, which is why the API socket is
one: a loopback port is open to every process on the machine and needs a
credential invented to guard it, while a socket file at 0600, in a directory
macOS already keeps at 0700, is restricted to the user who owns it and needs
nothing else.

## JSON-RPC

A convention for calling a function in another process: send an object saying
which `method` and which `params`, get one back carrying either a `result` or an
`error`, matched to the call by the `id` you chose. A message with no `id` is a
*notification*, which is acted on and never answered. It says nothing about how
the bytes travel, so the same messages work over a pipe, a socket, or HTTP. lmux
frames them one per line, which is what MCP over a stream calls for.

## MCP (Model Context Protocol)

The convention an LLM agent uses to discover and call tools someone else wrote.
A server answers `initialize` with what it can do, `tools/list` with each tool's
name, description and a JSON Schema for its arguments, and `tools/call` by
running one. It is JSON-RPC, so a unix socket is a complete transport and `nc
-U` is a complete client: lmux speaks MCP on its socket directly, and there is
no separate server to install. lmux's tool schemas are generated from the same
schema the Command union itself is declared as, so a new Command becomes a new
agent capability with nothing to update by hand.

## Session (what survives a quit)

Everything lmux has open lives in memory, so quitting used to lose it. A
*session* is the smaller, honest description of that: which workspaces existed,
which tabs each held and in what order, which document a markdown tab was
showing and in which mode, and which of them you were looking at. It is not a
snapshot of the state, because most of the state cannot be rebuilt. A shell is
the clearest case: a terminal tab's shell is a live process with its own
children and its own scrollback, and none of that can be brought back from a
file. What a restart can do is start a new shell in a new tab in the same
position, which is why a session records the position and nothing else about a
terminal.
