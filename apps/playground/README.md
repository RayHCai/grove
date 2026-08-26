# @platform/playground

A server-authoritative harness over the whole stack. One `@platform/server` process holds the world;
every open tab is a `@platform/client` session reaching it over a real WebSocket. Click the stage to
spawn a leaf — it enters off the left edge at the height you clicked, tumbles across, and is
destroyed once it clears the right edge. **Every tab sees every other tab's leaves**, and each leaf
carries a coloured badge naming the tab that spawned it.

Every tab also gets an **avatar**, moved with `A` / `D`. It is the one thing here a tab simulates for
itself: the client predicts its own avatar ahead of the server and rewinds it whenever the server
disagrees, so the keys answer on the frame they are pressed rather than a round trip later. Leaves
are nobody's to predict — they are drawn one send interval behind and interpolated between the poses
the server sent, which is what keeps them smooth without a faster wire.

```bash
pnpm --filter @platform/playground dev        # http://localhost:5173, game server on :5174
pnpm --filter @platform/playground test       # the drift rule, and a whole session over loopback
```

`dev` compiles the server project and then starts Vite, which spawns the server as a child process
and kills it on exit. The packages are consumed from their `dist/`, so `pnpm build` at the repo root
must have run at least once.

## Two halves, two compilers

```
src/                       the browser bundle — Vite, oxc, DOM
├── main.tsx               React root, StrictMode
├── App.tsx                chrome around one <Stage/>
├── Stage.tsx              the canvas pane, the HUD, zoom
├── use-renderer.ts        renderer lifecycle: init, assets, teardown. No frame loop.
├── use-game.ts            dial -> GameClient -> the frame that drives it
├── stage-input.ts         the device seam, and the screen -> world conversion
├── Inspector.tsx          polled render-tree panel over inspect()
├── NetPanel.tsx           polled session panel over client.stats()
├── shared.ts              the contract BOTH halves compile against, palette included
├── synced/                compiled by tsc, RUN BY BOTH — the browser imports dist/synced/
│   └── runner.ts          the avatar's movement, and the only thing either end predicts
└── server/                the Node process — tsc, NodeNext, no DOM
    ├── main.ts            the composition root: GameServer + a ws listener
    ├── config.ts          what this world is, apart from how it is hosted
    ├── game.ts            the authoritative game
    └── leaf.ts            PURE: the drift rule. No entity, no runtime, no socket.

public/
├── leaf.png               16x16 pixel-art sprite, nearest-filtered
└── marker.png             8x8 white disc — white so a tint returns the tint
```

`src/server` and `src/synced` are a project of their own (`tsconfig.server.json`) and are excluded
from the browser's. They have to be: core's scripts are written with TC39 standard decorators, and
**`tsc` is the only tool in this repo that lowers them** — Vite's oxc transform emits them verbatim
and the runtime then refuses to parse the file. This is the same split `packages/server` uses for its
own decorated fixtures.

That split is what `src/synced` is named for. `runner.ts` runs on **both** ends — the authority
simulates it, and each client replays it over its own avatar — but the browser imports the lowered
`dist/synced/runner.js`, not the source, which is why `dev` compiles the server project first.

## Where authority actually sits

A click is not a spawn. It is an input frame:

1. `stage-input.ts` converts the pointer to world space — `getBoundingClientRect` then
   `renderer.screenToWorld` — and emits it as an axis **ahead of** the button, so the server has
   folded this tick's aim before it dispatches the press that reads it.
2. `Clicker`, attached per player at join, counts the press and caches the aim.
3. On the same tick's update pass, `Clicker` spawns the leaf; `Rules` drifts every leaf and reaps
   the ones that crossed.
4. The spawn, the reparent and the transforms drain onto the wire and arrive at **every** tab, where
   `RenderBridge` turns them into renderer nodes.

Nothing in `src/*.tsx` owns an entity, a node id or a clock.

Movement takes the same path with one extra step. `Rules.join` spawns the avatar through
`player.spawn()`, which **owns** it to that player — and ownership is what puts it in that client's
predicted scope and what makes the server reap it when the tab closes. `Runner` is attached on both
ends: by `game.ts` on the authority, and by `use-game.ts`'s `scripts` table on the client, keyed by
the template it spawned from. Held `A` / `D` therefore moves the avatar locally on the tick it is
pressed, and the authority arrives at the same number a round trip later. A tab predicts **only** its
own avatar: another tab's moves when an envelope says so.

## Five things worth knowing

- **The renderer lives in a ref, never in state**, and the client owns the frame. `GameClient.frame`
  drains the socket, advances the tick clock, flushes input, pushes transforms and calls `render()`
  — so `use-renderer` deliberately has no loop of its own, or every frame would present twice.
- **Textures are loaded before the session starts.** A sprite whose texture arrives after its node
  was created is never repointed, and the client's bridge starts its manifest load without awaiting
  it — so every leaf already in the world at join would draw a placeholder for the rest of the
  session. `use-renderer`'s `onReady` resolves that first.
- **Leaves are spawned unowned.** The server destroys every entity whose `ownerId` matches a
  departing player, so an owned leaf would vanish from every other tab the moment the tab that
  spawned it closed.
- **Zoom goes through `GameClientOptions.camera`.** The client pushes the camera every frame
  unconditionally, so a `setCamera` from a change handler is reverted before it is seen. The
  resolver reads a ref, because the options object is captured once.
- **The owner badge is a template, not a colour field.** A transform diff carries position,
  rotation, scale, opacity and layer and nothing else, so per-entity colour has to ride the
  template — the server declares one badge template per player slot, differing only in `tint`, and
  spawns under the clicker's. The badge is drawn from a white sprite rather than the leaf because a
  tint MULTIPLIES: `leaf.png` is green, so a red tint would return mud instead of red.
- **Spawn and exit track the server's `bounds`, not a tab's viewport.** The authority cannot follow
  N windows, so `DESIGN` is set to match `WORLD`: under `fit` with letterboxing a tab's stage is
  exactly those bounds, and every tab enters a leaf at the same world x whatever its window size.

## The panels

Both poll rather than read per frame, because `inspect()` and `stats()` both allocate and neither
publishes a change event — reading them per frame would make the debugger the most expensive thing
on screen.

- **inspector** — surfaces with their roots in draw order, the node tree, and a detail pane per node.
  Each leaf's parented badge is what makes inheritance visible: its `resolved pos` tracks its parent
  while its `rotation` stays 0, which is why it rides upright over a tumbling leaf.
- **session** — the tick the server has depicted, the tick this tab stamps input with, the round trip
  between them, and the lead the clock holds so input lands on time. The three silent-failure
  counters only appear when they are nonzero.

Culling shows up at **zoom 2x or 4x**: zooming shrinks the world viewport, so a leaf still travelling
between the old edges falls outside the new ones and the `cull` flag lights up.

## Configuration

| Variable        | Where              | Default                 |
| --------------- | ------------------ | ----------------------- |
| `GAME_PORT`     | the Node process   | `5174`                  |
| `VITE_GAME_URL` | the browser bundle | `ws://<page host>:5174` |

`src/server/config.ts` holds the rest: `simRate` 60, `sendRate` 20, `maxPlayers` 16, and the world's
bounds. The send rate is the package default: the client draws everything it does not predict one
send interval behind and interpolates between the two poses either side of that moment, so a leaf
moved by a server script is smooth at 20 broadcasts a second on a 144 Hz display.

## Not a library

This package emits no `dist` types for consumption and is imported by nothing. `dist/client` is
Vite's; `dist/server` is `tsc`'s, which is why Vite is pointed at a subdirectory — `emptyOutDir`
empties whatever it is aimed at.
