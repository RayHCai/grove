# @grove/editor

The game editor: it opens the signed-in creator's game out of the games bucket, saves it, and
compiles it here into a local version of the game.

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
   fetched from `GET /v1/games/:gameId/files/<path>`. A game with nothing saved is seeded from a
   template **in memory** and left unsaved: opening an editor is not a reason to write to somebody's
   game, so the first save is the creator's. A game that was saved before it had a manifest is given
   one, from the default template's settings and the classes its own code declares.

`Boot` starts this once — a ref guards it, because StrictMode's paired effects would otherwise make
a second game for a creator who had none. A session that lapsed between step 1 and step 2 is the
platform's sign-in again; anything else is a message and a Try again.

## The files

| Module                      | Holds                                                                    |
| --------------------------- | ------------------------------------------------------------------------ |
| `src/api/client.ts`         | every call to `@grove/api`, and the CSRF token the last one handed back  |
| `src/boot/platform.ts`      | where the platform is, and the way back to this page after a sign-in     |
| `src/workspace/files.ts`    | a draft, its media type, and what a save still owes the service          |
| `src/workspace/session.ts`  | opening a game, what a save sends, and the reload a conflict forces      |
| `src/workspace/autosave.ts` | the three triggers that save without being asked                         |
| `src/workspace/templates/`  | what a game with nothing in it opens as                                  |
| `src/creator/`              | the globals a creator writes against, and each template's own sources    |
| `src/project/files.ts`      | the same files as the tree the explorer lists                            |
| `src/project/prelude.ts`    | the engine names, and the import a compile puts back above a file        |
| `src/project/scripts.ts`    | which classes the code declares, where each runs and what it attaches to |
| `src/project/manifest.ts`   | the manifest as a file in the game, and the digest that stamps it        |
| `src/project/compile.ts`    | one local version: emit, stamp, and check the way a build would          |
| `src/project/link.ts`       | those modules evaluated here, as the classes a world attaches            |
| `src/run/LocalStage.tsx`    | a world booted in this tab, and the session mounted against it           |

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

`project.json` is a file like any other — saved, published and read by a build — but it is not the
creator's to type, so the explorer does not list it, no tab opens on it and the compiler is not
given it. The settings gear is what writes it.

A **template** is a record under `src/workspace/templates/`: an id, a name, the files it seeds and
the manifest that describes them. A second one is a file beside `top-down.ts` and a line in the
list, and nothing downstream branches on which a game came from — seeding reads the manifest's
`scriptModules` off the template's own sources, so a template cannot declare a class it does not
have. The one there now is a player who walks in four directions, drawn as a black square on a white
stage — `public/avatar-square.svg`, served by this app at a relative url, because `project.assets` is
not something any panel writes yet and art a creator brought would be art with no way to change it.

## What a creator writes

A Grove script carries **no imports**. `src/creator/globals.d.ts` declares every name
`@platform/engine` exports as a global and the workbench is handed that, along with the engine's own
built declarations under `node_modules/@platform/*` paths it resolves them from — so `ServerScript`,
`@onPlayerJoin` and `Ctx` are typed, complete and reachable by writing them. The compile puts the
import back, above the module, naming only what the file used: `src/project/prelude.ts` is that
list, typed as `keyof typeof Engine`, so an export the engine renames fails this package's typecheck
instead of somebody's game. A name the file declares itself is left out of it — a creator's own
`Storage` shadows the engine's, and importing both would be one module declaring one name twice.

The declarations are checked as a program of their own: `tsconfig.creator.json` compiles
`src/creator/**` — the globals and every template's sources — against the real engine with no DOM
library, which is also how the workbench compiles them. Two engine names, `Storage` and `Animation`,
collide with that library's outright, and a game is not a page.

A creator's file declares its scripts by extending a base class, which is what
`src/project/scripts.ts` reads back into the manifest: `ServerScript`, `ClientScript` and
`SyncedScript` give the location and take the host as their type argument, a movement is
entity-hosted and synced whatever it is written as, and a class extending another of the project's
own inherits both. A class that reaches no engine base is not a script at all. One that reaches a
base and names no host is a fault the console pane prints, because the manifest is what refuses an
illegal attachment and it cannot do that without knowing what the script attaches to.

## Saving

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
ignores any wording set with it. The autosave is what actually protects work; the dialog is the
backstop.

## The compile, and what it builds

Play compiles the game inside the editor, and nothing is deployed for it.

The compiler is the one already in the workbench. `src/editor/monaco.ts` keeps a model per project
file rather than only the one on screen — a program is all of its files, so a file with no model is
an unresolved import in every other one — and `emit()` asks Monaco's TypeScript worker for the
JavaScript each one lowers to, plus what the checker said about it. It compiles to **ES2022**:
TypeScript emits a standard decorator verbatim for a target that claims to have them, and no browser
does, so an `@onStart` at `ESNext` would reach a run unlowered. A wrong type still compiles to
something that runs and is printed as a warning; a broken parse stops the run, because the
JavaScript beside it cannot be trusted — and a manifest stamped over it would claim classes the file
no longer has.

`src/project/compile.ts` makes one **local version** out of that: the modules with their imports put
back, and the manifest the gear wrote with the two parts a build derives stamped onto it — the
classes the code declares, and a SHA-256 over the manifest and every source beside it. It is then
checked with `@platform/project`'s own `validate`, so a game whose attachment names a script a
rename took away is refused here in the same words a build would use. What changed is written back
into `project.json`, because a publish builds what the last save froze.

A version that declares scripts is a **world**, and a world plays on the stage described below. A
game of plain TypeScript — no script class, no engine name — is not a world and runs in the sandbox
instead, from `src/main.ts`. Which of the two a game is is the whole of what Play branches on.

### A world, in this page

`src/run/LocalStage.tsx` stands one up. It is reached through `React.lazy`, and is the only module
here that imports the engine, the sim or the renderer at run time — several megabytes a creator
writing their first line has no use for, in a chunk nobody who never presses Play downloads.

`src/project/link.ts` is what turns a compile into classes. The emitted modules are text and a world
instantiates constructors, so each module is given a URL of its own and handed to the browser's own
loader, dependency-first — a blob's contents are fixed when it is made, so a module's URL has to
exist before the one importing it can name it, and a cycle is refused rather than half-linked. The
hidden `@platform/engine` import is pointed at a generated module that reads the engine **this page
already holds** off a one-shot global: a module fetched by URL cannot resolve through this app's
bundle, and a second engine would be a second set of base classes, of which a world would recognise
one. `console` is exported from that same module and injected into any file that reaches the name,
which is what makes the declarations a creator writes against true — their logging lands in the
console pane rather than the devtools drawer.

`bootPreview` from `@grove/player/preview` does the rest: a real `GameInstance` over a real `Sim` —
the same one `@grove/game-instance` runs in Rust — with the classes filtered per side, and a
loopback pair standing in for the socket. `GamePlayer` mounts against that exactly as it mounts
against a deployed box; the authority union is the only thing that differs, which is the point of it
being a union. Nothing is fetched and nothing is deployed: there is no bundle to name, because the
classes are already here.

One page holds one world, because the engine keeps its runtime in a single module-level slot. Every
boot and teardown is queued through one chain, which is also what makes StrictMode's
mount-teardown-mount safe: the abandoned boot finishes and is disposed before the next begins.
Pause stops the world's clock without closing it — the session stays up, its pair stays open, and
resuming carries on from the tick it stopped at. **Full page** has nothing to open: a world runs in
this tab, so it says so and plays on the stage.

### A sandbox, for plain TypeScript

`src/run/document.ts` puts that output into one self-contained document and `src/run/host.ts` hands
it to a frame as `srcdoc`. Nothing in there is fetched: the frame is sandboxed **without**
`allow-same-origin`, so it has an origin of its own and can reach no storage, no cookie and no DOM
of the editor's — which is also why the harness is inlined as text (`?raw`) rather than bundled as a
module the frame would have to fetch under CORS.

`src/run/harness.js` is the only code in there that is not the creator's. It links the modules into
blob URLs the same way `link.ts` does, and carries its own copy of both that and the console
rendering rather than importing either: it is inlined as text, so it can import nothing at all. It
forwards `console` and every uncaught error to the console pane, and it gates
`requestAnimationFrame` and the timers: a page cannot be suspended, but its clock can, so Pause
holds every frame the game asked for and Resume hands them over. Stop drops the document, which is
what ends a run.

A sandboxed run shows in the play pane's stage, full screen from the button in its corner, or
**Full page** in a window of its own — the same document in the same sandbox, with a relay passing
its console back to the editor that opened it.

### What local play does not do yet

**Nothing draws.** The world runs, the session reaches `live`, input reaches it, and the default
template's avatar is a real sprite over a real asset (a plain 200 from this app's own `public/`).
None of that shows up: a full pixel scan of the canvas after Play, keys held or not, is uniformly the
stage's background colour — no body, nothing — while a draw-call count on the same frame is in the
thousands with no GL error. Pixi is genuinely rendering every frame; nothing the client mirrors ever
gives it anything to draw. That pairs with the next paragraph and is very likely one root cause: the
client side of a local preview does not seem to run its own dispatch/mirror pass past the join
handshake at all. The stage grounds itself in white rather than the renderer's own black for exactly
this reason — an empty stage and a stage that never came up should not look the same.

**Handlers on the client half.** Server-located code runs: a join handler fires, an avatar spawns, a
movement attaches, and `@onStart` and `@onUpdate` on the avatar's synced scripts fire — on the
server. Neither fired on the **client** in a preview, for a synced script attached through a
template's `scripts` or for the movement `setMovement` attaches. That is engine-side rather than
editor-side (`packages/client`'s mirror/bridge is the suspect; `packages/client/tests/mirror.test.ts`
proves the same logic correct in isolation) and wants its own investigation — this is the actual
blocker to seeing anything move locally today, not a missing asset or a missing key binding.

**What does work today.** `GamePlayer` binds WASD and the arrow keys onto `moveX`/`moveY` — the
engine's fixed move axes — by default, so a game with a movement class has something driving it the
moment a session goes live; that part is server-verified (the movement's own `@onUpdate` fires) even
though its effect is not yet visible.

## The shell

- **The shell.** `src/shell/EditorShell.tsx` holds the frame and its state: which side panel is
  open, the authoring mode, the open files and which is in front, the run state, and the console.
  The top bar is the `<header>` (the wordmark, the game in the wordmark's own face, what a save
  last did, Save, and who is signed in), the rail is `<nav aria-label="Editor">`, the panels are
  `<aside>`s kept mounted and hidden while closed, and `<main>` is the workspace.
- **The explorer.** `src/explorer/ExplorerPanel.tsx` names the game and lists it as an ARIA tree
  (`src/explorer/FileTree.tsx`): folders disclose, files open in the editor. New file, Import and
  Delete are the three things that change the set.
- **The settings panel.** `src/settings/SettingsPanel.tsx` is the manifest a creator sets: how many
  may play, the two rates, and the world's extent. It sits at the foot of the rail because it is the
  project's own dialog rather than another view of the game's files. A field commits only while it
  holds a value the format accepts — a half-typed number is a thing to be in the middle of typing,
  not one to write into somebody's game — and what the code declares is reported there and never
  typed, because a compile stamps it.
- **The editor pane.** `src/editor/EditorPane.tsx` is a tab per open file over
  `src/editor/CodeEditor.tsx`, which hosts Monaco. `monaco-editor` is reached through
  `src/editor/monaco.ts` alone; no other module imports it. `src/editor/tabs.ts` is the strip's own
  reducer: opening a file already on it selects it, and closing the active one falls to its
  neighbour.
- **The play pane.** `src/player/PlayPane.tsx` is the run controls and a status word over a 16:9
  stage holding either the sandboxed frame or a stage the shell hands it — one or the other, never
  both, since leaving the frame mounted under a live world would keep the last run's document alive
  behind it. What is done to the stage rather than to the game sits in its corner as two icons:
  full page, then full screen. What a compile built is reported in the console pane beside it: one
  line for the version, and the problems that stopped it.
- **The console pane.** `src/console/ConsolePane.tsx` prints what a run wrote, oldest first, each
  line marked with its level, and keeps the last 500 — a game in a loop writes faster than anyone
  reads.
- **The layout.** `src/styles/editor.css` is the viewport-height frame: the 4px tilestrip, the 40px
  top bar, the 40px rail, the panel and the workspace, with 1px `--pg-border` dividers on a `--pg-bg`
  field and every pane a `Panel` with a 32px header. It also opens by restating the kit's control
  metrics a fifth smaller on `:root` — `--pg-ctl-*`, `--pg-icon`, `--pg-field-*` and `--pg-text` —
  because this screen carries a rail, a panel, two panes and a console where a site page carries one
  column; nothing here is scaled by a transform. The rail's views stack from the top and its foot
  holds the settings gear with the theme toggle under it. The workspace grid carries 8px of padding
  and 8px gaps; the editor pane fills the left column and the right column stacks the play pane over
  the console. `<main>` is the query container and the grid inside it stacks the editor over the side
  column at 704px of container width and below. A panel slides in from the rail; at a 1032px viewport
  and below it overlays the workspace with a shadow, and at 384px and below it stretches over it edge
  to edge, so the workspace is `inert` while it is open there. Every padding and gap between the
  chrome and the panes is 4, 8, 12 or 16px, and every colour comes from a `--pg-*` token.

## Running it

Consumers resolve `@grove/ui` from its built `dist` (`pnpm --filter @grove/ui build`), so
`pnpm --filter @grove/editor dev` builds it first and then serves on port 5176. `index.html` loads
Nunito and Press Start 2P and sets `data-theme` on `<html>` before the first paint from the stored
`grove:theme` preference, falling back to `prefers-color-scheme`; `ThemeProvider` owns it from
there.

Against `@grove/api` for real — signing in and saving — wants Postgres and an S3-compatible
bucket up too, which is a lot of infrastructure for trying out a game. `pnpm --filter @grove/editor
try` (`try.html` → `src/try.tsx`) mounts the same workbench against the in-memory `fakeApi` the test
suite itself is built on: no network, a game seeded from the default template, and nothing that
outlives the tab. It is dev-only — `vite build` never sees it, since the default build has one entry,
`index.html`, and `try.html` is a second file `vite build` was never told about.
