# @grove/player

The game surface: the canvas a session mounts onto, addressed at the authority that runs it.

It holds no authority and validates nothing about the world — admission, request checking and ticket
verification all belong to the authority a session is addressed at. What it owns is the three things
a session cannot compose for itself in a browser: a renderer over a real canvas, the frame loop that
drives it, and the device that turns pointer and key events into input. Depends on engine packages
only, so it can be mounted by the editor and by the player origin alike.

## What a mount does

The renderer first, then the dial — the session is handed a renderer, so one that is not up yet is
one it cannot be given. Every await is guarded by an `AbortSignal` rather than a flag, because a
dial resolves on its own schedule and StrictMode mounts twice: an abandoned dial closes its own
socket, and a renderer torn down mid-`init` is destroyed by the init path rather than by a cleanup
that ran before there was anything to destroy.

The ticket rides the WebSocket **subprotocol**, as `grove.ticket.<token>`. A browser cannot set a
header on `new WebSocket(url)`, and a url reaches access logs, proxy traces and `Referer`.

`project` is required rather than optional. The authority compares `projectId` and `projectHash`
before it allocates a `Player`, and only the bundle hash has an empty-string escape — a session
declaring nothing there is refused by every world that declares a project.

The creator's code is **not** fetched here. The authority names it in the `Welcome`, and the session
fetches, bounds, hashes and verifies it before evaluating a byte; this surface supplies the source
that does it. So what decides which code runs is the world a player actually joined.

`design` is a prop for the same reason `project` is: the reference stage a game's interface was
authored against is a project setting, and a stage sized to something else puts every widget in the
wrong place. The renderer is built before the socket, so it cannot be read off the `Welcome`. No
build publishes a project's own yet, so `DESIGN_STAGE` is exported here as the one number the whole
platform shares — the editor's preview and the player origin must size their stage identically or a
widget placed against one lands somewhere else in the other.

## What a host is told

`onReady` when the session goes live. `onRefused` with a reason and a line written for a reader —
the wire's `version`, `full` and `identity`, plus `ticket` for a refusal that happens at the upgrade
and never becomes an envelope, `bundle` for code that would not load, and `unreachable` for a socket
that never opened. A reason token this build has no wording for is reported as `unreachable` rather
than mapped to whichever case happened to be last.

`createRenderer` and `connect` are seams a test substitutes; a host passes neither.

`background` defaults to **white**, not the renderer's own black. A game with no art yet draws
nothing, and on black that is indistinguishable from a stage that never came up — which is the one
thing somebody pressing Play needs to be able to tell apart. Like `design` it is a prop rather than a
constant, because it wants to be a project setting once a manifest carries one.

## The default control scheme

`moveX`/`moveY` are the engine's fixed, panel-mapped move axes — `BaseMovement.fillIntent` reads
them every tick, and no creator script binds them. `GamePlayer` is what supplies WASD and the arrow
keys onto those two axes, for the same reason it supplies the renderer and the frame loop: a session
cannot compose these for itself in a browser, and a game with a movement class needs them to be
anything but inert. A game's own actions — the ones `@onEvent` names — are unaffected; this is the
one control scheme every such game gets, not a general bindings API.

## A world in this page

`@grove/player/preview` is a **subpath, not the root**, and deliberately: it reaches
`@platform/glue/world`, and a deployed player origin has no business carrying a Sim. Only the editor
imports it.

`bootPreview` takes an authored manifest and the classes an `attach` names, and answers a
`GameAuthority` of kind `local`. Inside it is a real `GameInstance` over a real `Sim` — the same one
`@grove/game-instance` runs in Rust — so what a preview shows is the world a deployed session would
show, less the socket between them. One module graph serves both halves here, so the entries carry
every location and each side is filtered to its own: handing the session a `ServerScript` would let
an `attach` reach code no client tick runs.

It declares no bundle, because there is nothing to fetch: the classes are already in the page, and
`GamePlayer`'s local branch is handed them rather than told where to look. `open()` builds a
loopback pair and gives the world its end **first** — a join frame that arrived at an authority not
yet listening is one nothing ever answers.

The clock is the preview's own rather than `GameInstance.start()`'s, because `start()` owns an
interval it offers no way back to and a stage with a Pause button needs one. `pause` stops the world
without closing it: sessions stay up, pairs stay open, and `resume` carries on from the tick it
stopped at. `dispose` ends the world — that is the page being done with the preview, not one session
leaving, so a creator who reloads the stage reaches the same authority again.
