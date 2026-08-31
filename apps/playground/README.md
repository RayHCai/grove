# @platform/playground

**Leaf Harvest** — a complete round-based game for N players, over the whole stack. One
`@platform/server` process holds the world; every open tab is a `@platform/client` session reaching
it over a real WebSocket. Both ends are built from **one authored project file**, `src/project.ts` —
the authority through `@platform/glue`, the browser through `createClient` in
`@platform/engine/host`.

Join, ready up, and the round starts for everyone. Leaves drift in from the left; walk into one to
harvest it, or click one anywhere on the stage to pop it for less. A leaf inside the green band is
**ripe** and worth double; a leaf carrying **your** badge colour is worth three more; a leaf that
reaches the brown strip on the right is composted and counts against nobody. When the clock runs
out the stage clears, everyone spectates, the winner is crowned, and the lobby reopens. Your
lifetime total and best round survive a reload, because each tab dials with a stable `?player=` id
and the server reads that player's saved `@serverState` back before it allocates a `Player`.

```bash
pnpm --filter @platform/playground dev        # http://localhost:5173, game server on :5174
pnpm --filter @platform/playground test       # the pure rules, and a whole match over loopback
```

`dev` compiles the server project and then starts Vite, which spawns the server as a child process
and kills it on exit. The packages are consumed from their `dist/`, so `pnpm build` at the repo root
must have run at least once.

## Controls

| Input     | Does                                                              |
| --------- | ----------------------------------------------------------------- |
| `W A S D` | moves your avatar, on both axes — the one thing this tab predicts |
| click     | pops a leaf for a point during a round; plants one in the lobby   |
| `C`       | clears every planted leaf, for everyone. Lobby only               |
| ready up  | a HUD widget press, which is what starts the round                |

## The game, and the shell that loads it

The game is `src/scripts/`. Nothing in it imports a host file, a registry, a transport or a
renderer — **one package, `@platform/engine`, and its own siblings.** That is the creator surface,
and the boundary is the point of the layout: everything outside `scripts/` is the shell that loads
what is inside it, and could load a different game without changing.

```
src/scripts/                    THE GAME. @platform/engine + these files, and nothing else.
├── globals.ts                  the variables panel: every tunable, name and key. Imports NOTHING.
├── session.ts                  the one capability the host grants, and the game's ask for it
├── state.ts                    reading a replicated field by name, on a client that holds no script
├── game/
│   ├── rules.ts                Rules            → the Game
│   └── slots.ts                which palette seat a player holds, and where it stands them
├── players/
│   ├── clicker.ts              Clicker          → every Player, at the join
│   └── profile.ts              Profile          → every Player, and the only persisted thing
├── templates/
│   ├── avatar/                 what the `player` template carries
│   │   ├── runner.ts           Runner    (synced) — the only thing either end predicts
│   │   └── harvester.ts        Harvester (server) — the collider, and the catch
│   └── leaf/
│       └── leaf.ts             Leaf      (server) — the regions, the click, and the leaf's own maths
└── screens/
    ├── hud.ts                  HudScreen   (client) — the whole interface, once a frame
    └── lobby.ts                LobbyScreen (client) — the ready button's local half
```

```
src/                            THE SHELL. It knows about engines, sockets and React.
├── project.ts                  the authored manifest: settings, regions, assets, templates, scripts
├── hosting.ts                  the address a browser dials. The only other file BOTH compilers see.
├── client-registry.ts          ScriptId → class, for the browser
│
├── main.tsx / App.tsx          React root
├── Stage.tsx                   the canvas pane, the chrome, zoom
├── HudPanel.tsx                the interface, drawn from ClientHUDSink and nothing else
├── use-renderer.ts             renderer lifecycle: init, assets, teardown. No frame loop.
├── use-game.ts                 dial -> createClient -> the frame that drives it
├── hud.ts                      registers the screens, opens the first, and the `ui` clock node
├── stage-input.ts              the device seam, and the screen -> world conversion
├── Inspector.tsx / NetPanel.tsx   polled debug panels
└── server/                     the Node process — tsc, NodeNext, no DOM
    ├── main.ts                 port, save file, identity per socket — then listenOn
    ├── host.ts                 GameInstance over the project, plus the capability it grants
    ├── registry.ts             ScriptId → class, for the authority
    └── visuals.ts              the crown's art, declared mid-session rather than in the manifest
```

**One script per file, foldered by what it attaches to.** `project.ts` names each one as its own
`ScriptModule` with a `path`, an `export`, a `location` and a `host` — so `validate` refuses an
illegal attachment from the file alone, before a module is loaded or a world is built.

**`globals.ts` is the variables panel.** It imports nothing at all, which is what lets a script read
it, the project file describe a world with it, and the browser shell draw a HUD against it, without
any of the three learning about the other two.

**A script reaches another script by importing it.** `Rules` calls `spawnLeaf` and `stepLeaf` from
the leaf's own module rather than restating either. A running _instance_ on another host is
`host.getScript(Class)` — `game.getScript(Rules)` is how a leaf reaches the match it is falling
through, and it answers by exact class identity, so a subclass is not the class asked for.

That makes the import graph cyclic, and `import/no-cycle` is off under `scripts/` for it. It is not a
defect being waved through: `Rules` attaches `Clicker` and `Leaf` asks for `Rules`, and in a hosted
project neither is an import at all — every script is loaded into one namespace and names the others
directly. Files are how this repo spells that, and every edge is inside a method body, so nothing is
read at module-eval time and the cycle has no runtime shape.

**`GameInstance` is the boot order.** `src/server/host.ts` hands `src/project.ts` to
`@platform/glue`, whose constructor validates the file, resolves each attachment's class through the
registry, builds the templates, instantiates the placed world and runs each Game `@onStart` — and
only then will it admit anything, because a joiner's snapshot is the one baseline no later delta
repairs. It listens for nothing on its own, which is what leaves `host.ts` a gap to grant the game
its one capability in, and what lets the session suite drive the same boot over a loopback pair.

**`listenOn` is the deployment.** `src/server/main.ts` hands the booted instance to
`@platform/glue/node`, which owns the listener, the transport it builds per socket, the id each
socket is accepted under, and the order the world and the socket are closed in. What is left in this
app is the three things that are genuinely this deployment's: where it listens, where it saves —
`fileKVStore` over the JSON file `GAME_STATE_FILE` names — and who it believes a socket is. That
last one is resolved from the peer's own query here, which only a toy host would do, and the file
says so where it reads it.

**`createClient` claims the same identity from the same file.** `projectId` and `contentHash` become
the `projectHash` the handshake compares, so a tab left open across a `dev` restart is refused with
`identity` rather than drawn wrongly. Bump `PROJECT_HASH` in `project.ts` when the game changes.

**Two trees, one compiler.** `src/scripts` and `src/server` belong to `tsconfig.server.json` and are
excluded from the browser's. They have to be: scripts are written with TC39 standard decorators, and
**`tsc` is the only tool in this repo that lowers them** — Vite's oxc transform emits them verbatim
and the runtime then refuses to parse the file. The browser therefore imports
`dist/scripts/templates/avatar/runner.js` and `dist/scripts/screens/lobby.js`, never those sources.
`dist/client` is Vite's own output and `emptyOutDir` empties whatever it is aimed at, which is why
the scripts are not emitted there.

`project.ts`, `hosting.ts` and `scripts/globals.ts` are the three files both projects compile. None
carries a decorator, which is what makes that legal — and excluding a directory only drops it from a
project's ROOT file set, so `globals.ts` is still type-checked on the browser side through the
import `project.ts` makes of it.

## Where authority actually sits

A click is not a spawn, and a ready press is not a round.

1. `stage-input.ts` converts the pointer to world space — `getBoundingClientRect` then
   `renderer.screenToWorld` — and emits it as an axis **ahead of** the button, so the server has
   folded this tick's aim before it dispatches the press that reads it.
2. The same press, in canvas pixels this time, goes to `client.entityAt`, and whatever it names is
   sent as `client.pointer('onClick', local)`. That rides the **interaction frame**, not an input
   action: the entity a click landed on is a claim about this tab's own camera, which no authority
   can recompute, so the server checks only that the entity is alive. Picking asks the RENDERER,
   which is what makes it right by construction — the bridge draws everything this tab does not
   predict one send interval behind the pose `rt.transforms` holds, and the renderer holds the pose
   it drew. Testing the simulated pose instead puts the box half a leaf off the art at 240 px/s.
3. `Rules.@onPress('ready')` answers the HUD press the same way — engine-supplied `ctx.player`, no
   frame that could claim to be someone else. When every seated player has readied, the round starts
   for everyone, because `phase` is Game-hosted `@serverState`.
4. During a round the **server** drops the leaves, on an `every` timer, at a height and in a colour
   `game.random` chose — the snapshot-captured PRNG, so a replayed tick draws the same number.
5. `Harvester.@onCollide('leaf')` on each avatar scores and destroys. `Leaf.@onEnter('bonus')`
   ripens; `@onEnter('compost')` wastes.

Nothing in `src/*.tsx` owns an entity, a node id or a clock.

Movement takes the same path with one extra step. `Rules.join` spawns the avatar through
`player.spawn()`, which **owns** it to that player — and ownership is what puts it in that client's
predicted scope and what makes the server reap it when the tab closes. `Runner` rides the Player
template's `scripts` list, so it is attached on both ends: by the template on the authority, and by
the `attach` op the browser resolves through its own registry. Held keys therefore move the avatar
on the tick they are pressed, and the authority arrives at the same number a round trip later. A tab
predicts **only** its own avatar: another tab's moves when an envelope says so.

## The HUD, which has no wire of its own

There is no HUD envelope in the protocol, and there cannot be: a HUD is one client's, so `hud.*`
writes into whichever runtime is current and pushes what changed at that runtime's sink. The
authority's HUD state reaches nobody. What crosses is `@serverState`, and the client-side half that
turns it back into widgets is **a script in the game** — `HudScreen`, a `ClientScript<HUDScreen>`
whose `@onUpdate` the client dispatches at display rate:

```
Rules writes @serverState / a Scoreboard  ->  wire  ->  the mirror's host records
   -> the mirror hoists each field onto the Game or Player facade it belongs to
      -> GameClient.frame calls displayUpdate -> HudScreen.render reads them and calls hud.*
         -> ClientHUDSink collects it and tells React to look again
            -> HudPanel renders client.hud.widgets — it decides layout and nothing else
               -> the ready button calls pressWidget -> InteractionFrame -> Rules.@onPress
```

The hoist is what makes the read work at all. A mirror attaches no `Rules`, so there is no instance
to hold `phase` — the value lives in the host record the envelope filled, and core defines a
read-only accessor for it on the facade as it lands. `game.phase` on the tab that draws it and
`this.phase` on the authority that wrote it are then the same name for the same number.

`src/hud.ts` keeps exactly what a script cannot do: register the screen classes and open the first
one — a hosted project's panel would, and this app has none — and draw the clock node, because
`hud.*` writes widgets and a renderer node is not one.

`LobbyScreen` is the local half of the ready button. It answers the press immediately — the button
says "asked" on the frame it was pressed — and the next authoritative `readyCount` corrects the
label. `HudScreen` opens and closes it, which is a screen deciding which menu is up, and that is
where the decision belongs: the phase is the only input and `render` already reads it every frame.

The switch runs **before** the widget writes in that same `render`, because a screen's `@onStart`
runs inside `hud.open` — opened afterwards, `LobbyScreen`'s static placeholder would overwrite the
authoritative label, and nothing would put it back until `readyCount` next moved.

Nothing in `render` diffs. Writing an unchanged widget is free because `ClientHUDSink` compares
before it notifies — without that, a value written every frame would re-render the interface at the
frame rate to say nothing had changed.

The round clock is the exception that is drawn rather than laid out: one `kind: 'text'` node on the
renderer's `ui` surface, anchored `top-center`. Text is legal only there — a text node on a
camera-transformed surface throws, and world text is an asset instead.

## Five things worth knowing

- **The renderer lives in a ref, never in state**, and the client owns the frame. `GameClient.frame`
  drains the socket, advances the tick clock, flushes input, pushes transforms and calls `render()`
  — so `use-renderer` deliberately has no loop of its own, or every frame would present twice. The
  display-rate script pass is inside that same `frame`, after the socket drain and before the push,
  which is what keeps a widget from being a frame behind the pose drawn beside it.
- **Textures are loaded before the session starts.** A sprite whose texture arrives after its node
  was created is never repointed, and the client's bridge starts its manifest load without awaiting
  it — so every leaf already in the world at join would draw a placeholder for the rest of the
  session. `use-renderer`'s `onReady` resolves that first. The crown is the one template declared
  mid-session, through `declareVisuals`, which the server drains ahead of the send that spawns it.
- **Leaves are spawned unowned.** The server destroys every entity whose `ownerId` matches a
  departing player, so an owned leaf would vanish from every other tab the moment the tab that
  planted it closed. The avatar's shadow is the opposite case: it is minted by the Player template's
  own `children`, inherits its root's owner, and dies with it.
- **Colour rides the template, never a field.** A transform diff carries position, rotation, scale,
  opacity and layer and nothing else, so per-entity colour has to be a template choice — one badge
  template per palette seat, differing only in `tint`. `maxPlayers` is eight for that reason: a
  ninth concurrent player would share a hue and the ripe-for badge would stop meaning anything. The
  badge is drawn from a white sprite rather than the leaf because a tint MULTIPLIES: `leaf.png` is
  green, so a red tint would return mud instead of red.
- **The seat is the rules', not `player.index`.** Core allocates indices from a counter a leave
  never lowers, so after eight tabs have come and gone a ninth takes index 8 — and keying the
  palette off it would hand that tab the hue and the spawn point of whoever still holds index 0.
  `Rules.join` assigns the lowest seat no live player holds and replicates it as player-hosted
  state, which is also where the swatch beside the score reads it from.
- **Spawn and exit track the server's `bounds`, not a tab's viewport.** The authority cannot follow
  N windows, so `DESIGN` is set to match `WORLD`: under `fit` with letterboxing a tab's stage is
  exactly those bounds, and every tab enters a leaf at the same world x whatever its window size.

## The panels

Both poll rather than read per frame, because `inspect()` and `stats()` both allocate and neither
publishes a change event — reading them per frame would make the debugger the most expensive thing
on screen. The HUD is the opposite and subscribes, because its sink does publish one.

- **inspector** — surfaces with their roots in draw order, the node tree, and a detail pane per node.
  Each leaf's parented badge is what makes inheritance visible: its `resolved pos` tracks its parent
  while its `rotation` stays 0, which is why it rides upright over a tumbling leaf. The `ui` surface
  holds the round clock.
- **session** — the tick the server has depicted, the tick this tab stamps input with, the round trip
  between them, the lead the clock holds, and where the predicted world stands. `attach skipped`
  counts the server-located scripts this page was told about and correctly holds no class for — it
  is a census, not a fault. The silent-failure counters only appear when they are nonzero.

Culling shows up at **zoom 2x or 4x**: zooming shrinks the world viewport, so a leaf still travelling
between the old edges falls outside the new ones and the `cull` flag lights up.

## Configuration

| Variable          | Where              | Default                 |
| ----------------- | ------------------ | ----------------------- |
| `GAME_PORT`       | the Node process   | `5174`                  |
| `GAME_STATE_FILE` | the Node process   | `dist/state.json`       |
| `VITE_GAME_URL`   | the browser bundle | `ws://<page host>:5174` |

How the world is built is in `src/project.ts`: `simRate` 60, `sendRate` 20, `maxPlayers` 8, the
world's bounds, and the two regions. How the game is tuned is in `src/scripts/globals.ts`: the
scoring, the round length, the palette, every action and every widget name.

The round length and the results dwell reach `Rules` twice over, and deliberately: `globals.ts`
holds the defaults the class initializes with, and `project.ts` passes the same numbers as **script
props** on the attachment — written between construction and the `@serverState` hoist. That is the
inspector's half of the same value, and it is what makes the attachment, not the module, the last
word on a configured field.

The send rate is the package default: the client draws everything it does not predict one send
interval behind and interpolates between the two poses either side of that moment, so a leaf moved
by a server script is smooth at 20 broadcasts a second on a 144 Hz display.

## Not a library

This package emits no `dist` types for consumption and is imported by nothing. `dist/client` is
Vite's; `dist/scripts` and `dist/server` are `tsc`'s, which is why Vite is pointed at a
subdirectory — `emptyOutDir` empties whatever it is aimed at.
