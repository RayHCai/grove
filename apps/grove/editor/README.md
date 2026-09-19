# @grove/editor

The game editor: it opens the signed-in creator's game out of the games bucket, saves and publishes
it, and runs it locally in a sandboxed frame.

`@grove/api` is the only service it talks to, at `VITE_API_URL` (`http://localhost:4000` by
default), always with the cookie — the API is a different origin, so every call is
`credentials: 'include'` and the editor origin is one of the two the API lets send them.

**No password ever reaches this origin.** Signing in is the platform's, and somebody the service
does not recognise is sent there rather than asked for one.

## Arriving

A creator signs in on the platform and clicks through to the editor. Nothing is handed over on the
way: the API set the session cookie on **its own** origin, and the platform and this editor are two
subdomains of one site, so the browser carries it here by itself. Reading it is one round trip —
`GET /v1/auth/session` — because the cookie is `HttpOnly` and no script on this origin can touch it.
That is what keeps it out of reach of everything this app compiles and runs.

Somebody the service does not recognise is sent to the platform: `VITE_PLATFORM_URL`
(`http://localhost:5175` by default) at `/sign-in?return=`, carrying this page's own address so
signing in lands back where it started. Nothing of the session rides on that URL in either
direction.

A tab that has already been sent once says so instead of going again. Without that, a platform that
sends somebody back without a session and an editor that sends them away without one bounce forever,
and neither ever says why.

## The first load

Behind one loading screen, `src/boot/Boot.tsx` answers three questions, because any of them failing
leaves nothing worth rendering a workbench around:

1. **Who is signed in.** The cookie, as above.
2. **Which game.** The newest of `GET /v1/games`, or one made with `POST /v1/games` for a creator
   who owns none.
3. **What is in it.** `GET /v1/games/:gameId/workspace` names each path the game holds, and each is
   fetched from `GET /v1/games/:gameId/files/<path>`. A game with nothing saved is seeded from
   `src/workspace/template.ts` **in memory** and left unsaved: opening an editor is not a reason to
   write to somebody's game, so the first save is the creator's.

`Boot` starts this once — a ref guards it, because StrictMode's paired effects would otherwise make
a second game for a creator who had none. A session that lapsed between step 1 and step 2 is the
platform's sign-in again; anything else is a message and a Try again.

## The files

| Module                      | Holds                                                                   |
| --------------------------- | ----------------------------------------------------------------------- |
| `src/api/client.ts`         | every call to `@grove/api`, and the CSRF token the last one handed back |
| `src/boot/platform.ts`      | where the platform is, and the way back to this page after a sign-in    |
| `src/workspace/files.ts`    | a draft, its media type, and what a save still owes the service         |
| `src/workspace/session.ts`  | opening a game, what a save sends, and the reload a conflict forces     |
| `src/workspace/autosave.ts` | the three triggers that save without being asked                        |
| `src/project/files.ts`      | the same files as the tree the explorer lists                           |

A **draft** is what this origin owns; what the service holds is a key in a bucket, overwritten in
place. Text and bytes are exclusive: the code editor opens the first, and an asset is carried rather
than edited.

What a save still owes is kept as two sets of **paths** — written to, and removed — rather than as a
dirty flag. A path in neither is one nobody touched, which is what makes a save the size of the file
being typed in instead of the size of the game. A file made and removed between two saves is dropped
from both sets rather than sent as a delete: the service never heard of it, and naming it would be
asking to remove whatever is at that path already.

A **folder** is not a thing a game stores — it is what the slashes in a path mean — so the tree is
derived on every render rather than kept beside the files and edited in step with them. Folders sort
above files and each side alphabetically.

## Saving, and what a publish does first

A save carries the text of every source written to, the path of every asset uploaded beside it, and
the paths removed. An asset's bytes go straight to the bucket through a presigned PUT and never pass
through `@grove/api` at all: the ticket is asked for, the bytes are sent with no cookie on the
request, and only then does the save name the path — because the service refuses a save naming an
asset that never landed, an upload that failed has to fail before the save rather than as one that
half-committed.

A save names the revision it started from, so a second editor that claimed it first is a `409`. The
answer to that is to reload and say so, not to retry: there is no set here to merge into, and saving
over it would be one creator silently overwriting the other.

Nothing has to be pressed. A save goes a second and a half after the last keystroke, at a thirty-
second ceiling for somebody who never pauses, and on `visibilitychange` when the tab goes away —
that last one through `fetch(keepalive)`, which is the whole of what makes a request leave a closing
tab. `beforeunload` is cancelled while anything is unsaved, which shows the browser's own dialog and
ignores any wording set with it. Signing out saves first, because it is the exit `beforeunload` never
sees. The autosave is what actually protects work; the dialog is the backstop.

A publish saves what changed and then asks for a build. The two are one button because a publish
builds the manifest the last save froze: publishing without saving would build the version before
this one. It answers with the task a creator's editor then watches.

## The local run

Play compiles and runs the game inside the editor, and nothing is deployed for it.

The compiler is the one already in the workbench. `src/editor/monaco.ts` keeps a model per project
file rather than only the one on screen — a program is all of its files, so a file with no model is
an unresolved import in every other one — and `emit()` asks Monaco's TypeScript worker for the
JavaScript each one lowers to, plus what the checker said about it. A wrong type still compiles to
something that runs and is printed as a warning; a broken parse stops the run, because the
JavaScript beside it cannot be trusted.

`src/run/document.ts` puts that output into one self-contained document and `src/run/host.ts` hands
it to a frame as `srcdoc`. Nothing in there is fetched: the frame is sandboxed **without**
`allow-same-origin`, so it has an origin of its own and can reach no storage, no cookie and no DOM
of the editor's — which is also why the harness is inlined as text (`?raw`) rather than bundled as a
module the frame would have to fetch under CORS.

`src/run/harness.js` is the only code in there that is not the creator's. It links the modules into
blob URLs dependency-first, because a module's own URL has to exist before the one importing it can
name it — and that is why a cycle is refused there rather than hanging. It forwards `console` and
every uncaught error to the console pane, and it gates `requestAnimationFrame` and the timers: a
page cannot be suspended, but its clock can, so Pause holds every frame the game asked for and
Resume hands them over. Stop drops the document, which is what ends a run.

A run shows in the play pane's stage, full screen from the button in its corner, or **Full page** in
a window of its own — the same document in the same sandbox, with a relay passing its console back
to the editor that opened it.

## The shell

- **The shell.** `src/shell/EditorShell.tsx` holds the frame and its state: which side panel is
  open, the authoring mode, the open files and which is in front, the run state, and the console.
  The top bar is the `<header>` (the wordmark, the game, what a save last did, Save, Publish, who is signed in
  and the way out), the rail is `<nav aria-label="Editor">`, the panels are `<aside>`s kept mounted and
  hidden while closed, and `<main>` is the workspace.
- **The explorer.** `src/explorer/ExplorerPanel.tsx` names the game and lists it as an ARIA tree
  (`src/explorer/FileTree.tsx`): folders disclose, files open in the editor. New file, Import and
  Delete are the three things that change the set.
- **The editor pane.** `src/editor/EditorPane.tsx` is a tab per open file over
  `src/editor/CodeEditor.tsx`, which hosts Monaco. `monaco-editor` is reached through
  `src/editor/monaco.ts` alone; no other module imports it. `src/editor/tabs.ts` is the strip's own
  reducer: opening a file already on it selects it, and closing the active one falls to its
  neighbour.
- **The play pane.** `src/player/PlayPane.tsx` is the run controls and a status word over a 16:9
  stage holding the sandboxed frame.
- **The console pane.** `src/console/ConsolePane.tsx` prints what a run wrote, oldest first, each
  line marked with its level, and keeps the last 500 — a game in a loop writes faster than anyone
  reads.
- **The layout.** `src/styles/editor.css` is the viewport-height frame: the 4px tilestrip, the 48px
  top bar, the 48px rail, the panel and the workspace, with 1px `--pg-border` dividers on a `--pg-bg`
  field and every pane a `Panel` with a 40px header. The workspace grid carries 12px of padding and
  12px gaps; the editor pane fills the left column and the right column stacks the play pane over the
  console. `<main>` is the query container and the grid inside it stacks the editor over the side
  column at 880px of container width and below. A panel slides in from the rail; at a 1288px viewport
  and below it overlays the workspace with a shadow, and at 480px and below it stretches over it edge
  to edge, so the workspace is `inert` while it is open there. Every padding and gap between the
  chrome and the panes is 4, 8, 12 or 16px, and every colour comes from a `--pg-*` token.

## Running it

Consumers resolve `@grove/ui` from its built `dist` (`pnpm --filter @grove/ui build`), so
`pnpm --filter @grove/editor dev` builds it first and then serves on port 5176. `index.html` loads
Nunito and Press Start 2P and sets `data-theme` on `<html>` before the first paint from the stored
`grove:theme` preference, falling back to `prefers-color-scheme`; `ThemeProvider` owns it from
there.
