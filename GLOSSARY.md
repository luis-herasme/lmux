# Glossary

Terms used in this project, defined for someone new to terminal applications.
This file grows as the project does: every new concept gets an entry.

## Terminal

Originally a physical device: a keyboard and a screen (like the DEC VT100 from
1978) connected to a distant computer by a serial cable. It sent keystrokes down
the wire and displayed the characters that came back. It had no computing power
of its own, hence "dumb terminal". Every piece of software below exists to
imitate this hardware, which is why so much terminal behavior only makes sense
historically.

## Terminal emulator

A program that pretends to be one of those physical terminals. It draws a grid
of characters in a window, sends your keystrokes to a program (usually a
shell), and interprets the bytes coming back (including invisible control
codes) to update the screen. macOS Terminal, iTerm2, and this project are all
terminal emulators. **The terminal emulator does not understand commands**: it
never knows what `ls` means. It only moves bytes and draws characters.

## Shell

The program that actually interprets your commands. When you type `ls -la` and
press Enter, the shell parses that line, finds the `ls` program, runs it, and
shows you a new prompt when it finishes. It's called a "shell" because it's the
layer wrapped around the operating system's core (the kernel). On your Mac the
default shell is **zsh**; bash and fish are other shells. Terminal emulator and
shell are separate programs: the emulator is the window, the shell is the
conversation happening inside it.

## Login shell

A shell started with the `-l` flag, which makes it read your startup files
(`~/.zprofile`, `~/.zshrc` on macOS). We spawn the shell this way so your PATH,
aliases, and prompt look identical to Terminal.app. Without it you'd get a
bare, unconfigured shell.

## TTY

Short for **teletype**, an even older physical terminal that printed on paper.
In Unix the name stuck: a "TTY" is the kernel's representation of a terminal,
a special file (like `/dev/ttys003`) that a program can read from and write to
as if a person were on the other end. Programs check "am I attached to a TTY?"
to decide how to behave: `ls` prints colors to a TTY but plain text when piped
to a file.

## PTY (pseudo-terminal)

A fake TTY created by software instead of hardware. It's a pair of connected
endpoints: the shell attaches to one end and believes it's a real terminal; our
app holds the other end and plays the human, feeding keystrokes in and reading
output out. This is the crucial trick of the whole project: if we launched zsh
with an ordinary pipe instead of a PTY, it would think its output was going to
a file: no colors, no line editing, and vim would refuse to run. `node-pty` is
the library that creates PTYs for us.

## Escape sequences (ANSI codes)

How a shell talks to the terminal beyond plain text. The output stream is mixed
with invisible commands that all start with the ESC byte (27): `ESC[31m` means
"draw the following text in red", `ESC[2J` means "clear the screen", `ESC[H`
means "move the cursor to the top-left". Full-screen programs like vim are
really just fountains of escape sequences. Parsing these correctly is the
hardest part of a terminal emulator; it's the main thing xterm.js does for us.

## xterm.js

A JavaScript library that implements the "screen" half of a terminal emulator:
it maintains the character grid, parses escape sequences, draws everything into
the page, and turns your keypresses into the bytes a shell expects. It powers
the terminal in VS Code. It deliberately does **not** run shells; that's our
job, via node-pty.

## Electron: main process and renderer process

An Electron app is two kinds of programs working together. The **main process**
is a Node.js program with full access to your machine: it opens windows and,
in our app, spawns the shell. Each window runs a **renderer process**: a
Chromium browser page that can show UI but is sandboxed away from your system,
like any web page. Our xterm.js screen lives in the renderer; our PTY lives in
main. They are separate operating-system processes and share no memory.

## IPC (inter-process communication)

How the main and renderer processes talk: named messages passed between them
(`ipcMain` / `ipcRenderer` in Electron). Ours carry the per-tab shell
protocol (`shell:spawn`, `shell:write`, `shell:data`, ...) and the
command bus (`command` in, `event` out); the full list is "The boundary"
in ARCHITECTURE.md.

## Command / Event

The two halves of lmux's public interface (defined in `api.ts`).
A **command** is an imperative request flowing *into* lmux ("open a
tab", "type this text"), named in the imperative mood. An **event** is a
fact flowing *out* ("tab 3 opened"), named in the past tense, and carrying
a snapshot of the resulting state. Keeping the two directions as two words
(borrowed from the CQRS pattern) matters because an external driver, like
an agent, needs both: send commands, observe events. One word would muddle
which way the arrow points.

## Menu accelerator

A keyboard shortcut attached to an application-menu item (macOS's native way
of owning shortcuts). Accelerators fire *before* the focused web page sees
the key, which cuts both ways: the default menu binds ⌘W to "close window",
so a page could never intercept it for "close tab"; but a menu we define
ourselves gets ⌘T/⌘W reliably, even while xterm has keyboard focus. That's
why our tab shortcuts live in main's menu and arrive in the renderer as
forwarded events rather than keystrokes.

## Preload script

A small script that runs inside the renderer *before* the page loads, with
access to both worlds. It exposes a hand-picked API to the page (our
`window.bridge`) so the sandboxed page never
gets direct access to Node.js. This pattern is called **context isolation**
and is Electron's security model: the page can only do what the preload
explicitly permits.

## Native module / ABI (why `npm run rebuild` exists)

Most npm packages are pure JavaScript, but node-pty contains C++ code compiled
into a binary, because creating PTYs requires operating-system calls JavaScript
can't make. Compiled binaries must match the exact version of the runtime that
loads them; the contract between them is called the **ABI** (application
binary interface). Electron ships its own Node.js whose ABI differs from the
Node on your machine, so after installing, `electron-rebuild` recompiles
node-pty against Electron's headers. Symptom of forgetting this step: the app
crashes on launch with an error like "was compiled against a different Node.js
version".

## TypeScript / type checking

JavaScript plus **type annotations**: `(data: string)` declares what kind of
value is allowed, and the TypeScript compiler proves the whole program agrees
with itself before anything runs: pass a number where a string is declared
and it refuses to compile. The types exist only at compile time; the running
program is plain JavaScript with the annotations removed.

## Type stripping

A Node.js feature (since 22.18) that lets Node run `.ts` files directly by
simply *deleting* the type annotations, without reading them. Fast and
dependency-free, but it is not type checking: `const x: number = "hi"` runs
happily. Also note the renderer can never use it: it runs in Chromium, a
browser, which doesn't understand TypeScript at all. That's why this project
compiles with `tsc` (getting real checking in the bargain) instead of relying
on stripping.

## tsc

The official TypeScript compiler. Does two jobs in one pass: **checks** every
type in `src/` (errors stop the build) and **emits** the equivalent plain
JavaScript into `dist/`, one output file per source file. It's the project's
entire build system; `npm start` is just `tsc && electron .`.

## Declaration file (.d.ts) / declare global

A `.d.ts` file contains only types and compiles to nothing; it's how
libraries ship types for the compiler (xterm's packages in node_modules do
this). We don't write our own, and use plain `.ts` modules with explicit
`import type` instead: in a growing codebase, every name should have a
greppable import stating where it comes from.

`declare global` is the same idea in a smaller package: it tells the
compiler that a name exists on the global scope, so `window.bridge` (the
preload puts it there) or `Terminal` (xterm's script tag creates it) can be
used without importing anything. We don't use it either, for the reason
above: whether or not the runtime really has that global, a name nobody
imported is a name a reader cannot trace. A page global is instead read
where it is used, with `Reflect.get`, which returns it untyped; the reading
site checks that it is there, states the type it expects, and exports it.
`renderer/bridge.ts` is that site for the cable, so every other module says
`import { bridge }` like it would for anything else, and a preload that
never ran reports itself rather than failing at the first call.

## Script vs. module

JavaScript files come in two flavors, and a file's flavor decides how values
get in and out of it. A **module** has private scope: nothing leaks out, and
others reach its values with `import`. A **classic script** (loaded with a
plain `<script>` tag) is the older flavor: its top-level declarations land in
a scope shared by every other script on the page; that's why xterm's script
tag makes `Terminal` just *appear* as a global in the renderer. Modules
themselves come in two dialects: **ES modules** (`import`/`export`, the
standard, what this project uses everywhere) and **CommonJS**
(`require()`/`module.exports`, Node's older invention). Our one CommonJS
file is the preload script, because Electron's sandbox demands it: naming it
`preload.cts` makes tsc emit that single file as `.cjs` (CommonJS) while its
source still reads as `import`.

## Bare specifier / bundler

An `import` names its target either by **path** (`"./tabs.js"`,
`"../../node_modules/zod/index.js"`) or by **bare specifier** — just the
package name, `"zod"`. A path the browser can follow on its own; a bare
specifier means nothing to it, because resolving one requires knowing where
packages live and reading each one's `package.json` to see which file the
name points at. Node does that work; browsers do not.

A **bundler** does it ahead of time: it follows every import from an entry
file, resolves each specifier to a real file, and writes the result out as
one file with no imports left to resolve. lmux avoids needing one by loading
libraries that ship browser builds from a relative `node_modules` path, with
one exception: Monaco imports dependencies by bare specifier.
`scripts/bundle-vendor.mjs` bundles Monaco with **esbuild**; everything else,
including all of our own code, is still `tsc` output the browser resolves
itself.

## Web Worker

A second JavaScript thread, with no access to the page's DOM, that talks to
it by passing messages. It exists so that slow work does not freeze the
interface, which for an editor means things like computing a diff or running
a language service. Two rules bit us and are worth knowing: a worker inherits
the page's Content-Security-Policy, and a worker built from a `blob:` URL
counts as a separate source that `default-src 'self'` refuses — so lmux
hands Monaco a real file URL rather than letting it construct a blob.

## Monaco

[Monaco](https://microsoft.github.io/monaco-editor/) is the code editor from
VS Code, published as a standalone library. It is the *editor surface* only:
it paints text, highlights it, and provides the interface for things like
go-to-definition — but it brings no workbench (lmux's tabs, layout and
command bus stay lmux's) and no language intelligence of its own. Knowing
what a symbol means, and where it was defined, is a separate job belonging to
a language server.

## Grammar / tokenizer

What turns a line of source into coloured pieces. A **grammar** is a set of
rules describing which runs of characters are keywords, strings, comments and
so on; running it over text produces **tokens**, each tagged with a type, and
the theme maps those types to colours. Monaco imports a language's grammar
the first time a file needs it, which is why a freshly opened file is briefly
uncoloured: the first paint happens before the grammar arrives, and the text
is repainted when it does. Anything checking that highlighting works has to
wait for that second paint, or it will conclude the editor is broken.

## CSS custom property

A variable in CSS: declared as `--name: value`, read as `var(--name)`.
JavaScript can set one at runtime (`element.style.setProperty`), which makes
it the bridge for handing a script's values to stylesheets, since CSS has no way
to read JavaScript on its own. Ours carry the scrollbar colors from theme.ts
into index.html's styles.

## Link provider

xterm's hook for making arbitrary terminal text clickable. The emulator
has no idea what a path or URL is; a link provider is asked, per buffer
line, "any links here?" and answers with character ranges and an activate
callback. Ours matches `*.md` paths (after joining wrapped rows, since a
long path spans several buffer rows) and opens the file rendered on
Cmd+click. The complementary mechanism is OSC 8, an escape sequence a
program uses to *declare* a hyperlink explicitly; provider-side detection
needs no cooperation from the program, which is why we started there.

## Drag region / hiddenInset

How an app paints its own title bar on macOS. Creating the Electron
window with `titleBarStyle: "hiddenInset"` hides the standard title bar:
the traffic lights remain, drawn by macOS inset over the page, and the
page extends to the window's top edge, free to paint its own strip any
color. The CSS property `-webkit-app-region: drag` then marks an element
as a **drag region**: its mouse events go to the window manager instead
of the page, which restores the native title-bar behaviors (dragging
moves the window, double-click zooms it). The trade is that a drag
region's pixels are deaf to the page, so nothing inside one can react to
clicks. Our painted `#title-bar` is exactly this pattern.

## Character cell / grid

A terminal screen is not free-form text; it's a rigid grid of equal-size
cells, one character each, e.g. 80 columns × 24 rows (the VT100's dimensions,
still the default size everywhere). Everything is measured in cells: cursor
position, window size, vim's layout. Consequence: a window's pixel height is
rarely an exact multiple of the cell height, so a leftover strip of a few
pixels always exists past the last row. Terminals hide it by painting it the
same color as the screen.

## Code - OSS / openvscode-server / Open VSX

Three names that come up around embedding VS Code. **Code - OSS** is the
MIT-licensed open-source codebase behind VS Code; Microsoft's branded "VS
Code" is a proprietary build of it, and the branding plus its extension
marketplace are licensed for official builds only. **openvscode-server** is a
fork of Code - OSS (by Gitpod) that serves the full editor over HTTP so it
runs in any browser, which is what makes it embeddable in our renderer.
**Open VSX** is the vendor-neutral extension registry such forks use instead
of Microsoft's marketplace; it has most popular extensions, minus some
Microsoft-proprietary ones (e.g. Pylance).

## TUI (terminal user interface)

A program whose entire interface is drawn inside a terminal's character grid
using escape sequences: vim, htop, lazygit. The opposite approach to this
app: a TUI lives *inside* a terminal emulator and inherits the grid's limits
(no images, no proportional fonts, no embedded web pages); this app *is* the
terminal emulator, with a full browser page around the grid.

## `<dialog>` element / showModal()

The web platform's built-in modal. Calling `showModal()` on a `<dialog>`
gets you, from the browser engine itself: a dimmable backdrop, a focus trap
(Tab can't wander out), Escape-to-cancel, and `method="dialog"` forms whose
submit closes the dialog carrying a return value. Before it existed, every
app hand-rolled these behaviors (and usually got focus trapping wrong). We
use it for the rename modal; Electron has no *native* text-input dialog,
so an in-window modal is the standard Electron pattern (VS Code's input
boxes are the same idea).

## ResizeObserver

A browser API that calls you back whenever an element's box changes size,
for any reason: window resized, `display` toggled, layout shifted. Each
tab's pane has one, re-fitting its character grid on any change. The
alternative is tracking every *cause* of a size change by hand (a window
listener here, a catch-up call there) and hoping future features remember
to join in: the classic cache-invalidation trap.

## Race condition

A bug where correctness depends on which of two independent things happens to
finish first. Ours: the window loads its page while zsh boots, in parallel.
If zsh's first output arrived before the page was ready to listen, it was
silently lost; the app only worked because zsh is reliably slower. The fix
(spawn the shell only after the page load completes) removes the dependence
on timing entirely. Rule of thumb: "it works because A is slower than B" is
not a design, it's a countdown.

## Scrollback

The lines that have scrolled off the top of the screen. The physical VT100 had
none: text was gone forever. Emulators keep a buffer of them (xterm.js
defaults to 1000 lines) so you can scroll up.

## OSC (Operating System Command)

The family of escape sequences addressed to the terminal *program* rather than
the screen. Ordinary escape codes do things the VT100's hardware did: move
the cursor, color text. OSC sequences (they start with `ESC ]`) ask for things
only the surrounding software can do, and the classic one is the window title:
`ESC ] 0 ; hello BEL` means "call this window *hello*". Try it yourself:
`printf '\e]0;hello\a'`. Configured shells emit one before every prompt
(naming the tab after the current directory), and programs like vim and ssh
set their own while running. The title is therefore not something the emulator
invents; the programs inside announce it, and the emulator just displays the
latest announcement. xterm.js parses the sequence out of the byte stream and
hands us the text as an `onTitleChange` event.

## Docking layout manager

A UI component that owns a region of the page and manages a tree of panes
inside it: each pane has a tab strip, tabs can be dragged to reorder or to
another pane, panes can be split and resized with draggable dividers, and
the whole arrangement can be saved and restored. The pattern is what makes
VS Code's editor area feel the way it does. This project uses
[Dockview](https://dockview.dev): our tab bar and terminal panes are Dockview
"panels". Tabs drag along a strip to reorder, between strips to change
group, and onto a pane's edge to split; window-edge drops and whole-group
drags stay disabled until a feature needs them.

## Workspace

A whole lmux of its own inside the same window: its own pane layout, its
own tabs, its own shells. The sidebar lists them and switching is one click;
only one is on screen at a time, and the ones behind keep running, so a
build left compiling in one workspace is still compiling when you come back
to it. The name comes from tiling window managers and VS Code, where the
same word means "the set of things I'm currently working on"; this app's
version is closest to i3's or macOS's *desktops* (Mission Control spaces):
several independent screens, one visible.

A workspace names itself after its active tab, so the sidebar row and the
title bar say whatever that tab says: the shell's own title (which zsh
keeps at `user@host:cwd`), or a Markdown file's name. Renaming a workspace
pins the name against that, exactly as renaming a tab pins it against the
shell; renaming it to `""` unpins and lets it follow again. A workspace
with no tabs falls back to `Workspace N`.

The mechanic is one docking layout manager instance per workspace, hidden
with `display: none` when it isn't the active one. Nothing is serialized or
rebuilt on a switch, which is what keeps a terminal's scrollback, its
running program, and its cursor position exactly where you left them. The
one thing a hidden workspace can't do is measure itself (a hidden element
reports a zero-sized box), so terminals skip fitting while they're away and
re-fit when their workspace comes forward.

## Workspace root / file tree

A **workspace root** is the stable top directory shown by one workspace's file
tree. The first project tab derives it from a file's Git repository, or from a
terminal's Git repository or current directory. Changing it is explicit and
does not close file tabs. Resolving it to its real path and refusing to follow
symbolic links keeps directory reads inside that boundary.

A **file tree** is the hierarchical view of every directory and file below the
workspace root. The paths are its identities: `src/main/index.ts` names the
same item in the renderer, the public state and main's filesystem reads.

**Lazy loading** means work waits until its result is needed. The file tree
reads the root first, then reads a directory's immediate children only when a
person expands it. Collapsed subtrees therefore cost no filesystem work, IPC
payload or DOM rows. A loaded directory remains cached for the project tab's
lifetime.

## Project tab / file tab

A **project tab** is the workspace's one Dockview tab for files. It contains
the file tree, an inner file-tab strip and one editor. Its title is the
workspace root folder name. Opening another file reuses this project tab;
files outside the workspace root are valid file tabs but do not change the
tree.

A **file tab** names one in-memory file buffer inside the project tab. A
single tree click opens a replaceable **preview file tab**. Editing it or
double-clicking its tree item makes it a **pinned file tab**, which remains
until explicitly closed. The file-tab strip, not Dockview, switches the one
Monaco editor between those buffers.

A **buffer** is a file's in-memory model: its text, dirty state, undo history,
cursor and scroll position. Switching files keeps each buffer alive. A restart
restores pinned paths from disk, never unsaved buffer contents or the temporary
preview.

## Rendered vs. raw (a markdown tab's two modes)

The same file, shown two ways. *Rendered* is the document: headings as
headings, tables as tables, ```mermaid fences as drawn diagrams. *Raw* is
the file's own text, the characters on disk, in the terminal's font. The
toolbar's first button swaps between them and names the mode it would
switch to, the way a play button names what it will do rather than what
is happening. The second button re-reads the file, since nothing watches
the disk: edit a document in one tab, click Reload in the tab showing it.

## Dirty (a file buffer's unsaved work)

A file buffer is *dirty* when its model holds text the file on disk does not.
It becomes dirty on the first edit after opening or saving, which also pins a
preview file. The ● in the file tab and the modified mark in the tree say so,
and `dirty` rides on the project's file state so main can guard every kind of
close. A save refuses to overwrite a file whose mtime changed since it was
read, because the alternative is burying work the disk has and the editor does
not.

## Drag-and-drop interception (the one-door rule)

How Dockview stays subordinate to the command bus. A docking library
normally applies a drag itself: you drop a tab, the library mutates its
layout, and the application finds out afterwards. That would make gestures
a second write path around the bus. Dockview instead exposes `onWillDrop`,
which fires *before* it mutates anything and can be cancelled. We cancel
every drop, translate it into the equivalent Command (`move-tab` for strip
and pane-center drops, `split-tab` for pane-edge drops), and dispatch that
through `executeCommand`, which performs the identical move
via Dockview's programmatic API (`panel.api.moveTo`). The gesture becomes
just another Command source, the same door as the menus, the devtools console,
and the future agent. The one exception is clicking a tab to activate it:
that's focus, not layout, and the mousedown that activates is the same one
that begins a drag, so activation is applied by Dockview and announced on
the bus afterwards as a `tab-activated` Event.

## Mutation testing (why a passing test means anything)

A test that has never failed is a claim, not a check. Mutation testing is
the cheapest way to settle it: break the behaviour on purpose, in the
source, one change at a time, and confirm the test that claims to cover it
turns red. Delete the guard that stops the last workspace from closing, or
the line that restores a document's scroll position, then run the suite. A
case that stays green under its own mutation is testing something other
than what its name says, which is worse than having no case at all, because
it will be believed. The mutations are thrown away afterwards; only the
knowledge that each case bites is kept.

## Unix domain socket

A socket that lives in the filesystem as a file rather than on a network
port. Two processes on the same machine talk through it exactly as they
would over TCP, but it is never reachable from another machine and never
from a web page. Its access control is the file's own permissions, which is
why the API socket is one: a loopback port is open to every process on the
machine and needs a credential invented to guard it, while a socket file at
0600, in a directory macOS already keeps at 0700, is restricted to the user
who owns it and needs nothing else.

## JSON-RPC

A convention for calling a function in another process: send an object
saying which `method` and which `params`, get one back carrying either a
`result` or an `error`, matched to the call by the `id` you chose. A message
with no `id` is a *notification*, which is acted on and never answered.
It says nothing about how the bytes travel, so the same messages work over
a pipe, a socket, or HTTP. lmux frames them one per line, which is what MCP
over a stream calls for.

## MCP (Model Context Protocol)

The convention an LLM agent uses to discover and call tools someone else
wrote. A server answers `initialize` with what it can do, `tools/list` with
each tool's name, description and a JSON Schema for its arguments, and
`tools/call` by running one. It is JSON-RPC, so a unix socket is a complete
transport and `nc -U` is a complete client: lmux speaks MCP on its socket
directly, and there is no separate server to install. lmux's tool schemas
are generated from `commandSchema` in `api.ts`, so a new Command becomes a
new agent capability with nothing to update by hand.

## Session (what survives a quit)

Everything lmux has open lives in memory, so quitting used to lose it. A
*session* is the smaller, honest description of that: which workspaces
existed, which tabs each held and in what order, which document a markdown
tab was showing and in which mode, and which of them you were looking at. It
is not a snapshot of the state, because most of the state cannot be rebuilt.
A shell is the clearest case: a terminal tab's shell is a live process with
its own children and its own scrollback, and none of that can be brought
back from a file. What a restart can do is start a new shell in a new tab in
the same position, which is why a session records the position and nothing
else about a terminal.
