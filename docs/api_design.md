There are 4 layers of the base API:

- Objects — the six fundamental ones (`Entity`, `Player`, `Camera`, `Asset`, `Game`, `HUD`), plus sound instances
- Capabilities — collider, animation, renderable: leaf attachments on an object, not peer objects
- Scripts — creator-authored logic classes that attach to objects. **All creator code is a script.**
- Time & causality — the loop, delta time, timers, tweens, and the unified event system
- Platform — input devices, storage, networking/multiplayer, audio output

The second and third layers are the whole of what "attaches to" an object: a capability is engine-provided and configured, a script is code the creator wrote.

Libraries:

- Pixi.js for 2D renderer
- Rapier for physics
- Custom thin layer over regular web API for audio

## 0. Design rules

Every decision below follows from five rules. When a future API question comes up, answer it with these.

1. **Blocks are the floor, TS is the ceiling.** Anything a kid can build in blocks must round-trip to readable TS. Anything in the beginner text tier must be expressible as flat block statements.
2. **Flat statements, no nested expressions.** Arguments are literals, dropdowns, or pronouns — never computed values. If an API forces nesting, it needs a flatter spelling.
3. **Verbs, not arithmetic.** If a creator writes `Math.*` to do something common, a primitive is missing.
4. **Describe intent; the engine owns the lifecycle.** Replication, prediction, persistence, culling, and cleanup are never creator concerns.
5. **Panel = defaults, code = override.** Anything authorable visually is authored visually first.

---

## 1. Execution model

**Server-authoritative, three execution sites.** Simulation is authoritative on the server. Presentation is not, and pretending otherwise costs a round trip on every hover. So the program has three execution sites, and **the base class a script extends names which one it runs at** — one word in the `extends` clause, checked at load time.

| Site       | Base class     | Runs on                          | What lives there                                                    | Trust               |
| ---------- | -------------- | -------------------------------- | ------------------------------------------------------------------- | ------------------- |
| **Client** | `ClientScript` | the owning player's machine only | screens, HUD, menus (§12), camera feel, cosmetic effects            | none; advisory only |
| **Synced** | `SyncedScript` | client _and_ server, one source  | gameplay: collision, damage, pickups, movement — the default        | server's copy wins  |
| **Server** | `ServerScript` | the server process only          | orchestration, `@onRequest`, storage, leaderboards, roster, scoping | authoritative       |

The middle row is the one that was already here; what changed is that it is now spelled out loud rather than inferred from which class a handler happened to land on. The word "predicted" is gone in favor of **synced**, because prediction is the client half of a two-sided arrangement and the creator needs to hold both: **the server runs it authoritatively, and the client re-produces it from the same inputs.** Naming only the client half made the base class sound like an optimization rather than a contract.

The top row is the one this design added: **client code is written by the creator and never runs on the server.** A hover state, a scroll offset, a highlighted menu row, and a tooltip are not facts about the game world; they are facts about one person's screen. Replicating them is wrong on latency and wrong on ownership.

### 1.1 Location and host

**Every line of creator code lives in a script, and a script declares two things.** The location, above, is the base class. The **host** — what the script is attached to — is a type parameter:

```ts
class Coin extends SyncedScript<Entity> {} // gameplay on a body
class Wallet extends ServerScript<Player> {} // authoritative per-player state
class Shop extends ClientScript<HUDScreen> {} // a menu
```

The location decides trust. The host decides `@serverState` scope (§6.1) and which lifecycle `@onStart` means. They are **orthogonal, and both are declared** — which is the substance of this revision. The previous design fused them into one word each: `Script` meant "entity-attached _and_ predicted", `Game` meant "session-scoped _and_ server-only", `UI` meant "screen-attached _and_ client-only". Every combination the fusion forbade turned out to be something creators wanted, and none had a spelling:

| Wanted                                 | Before                                                                      | Now                    |
| -------------------------------------- | --------------------------------------------------------------------------- | ---------------------- |
| A loot roll on an entity, server-only  | `@onRequest` abuse, or a `Game` handler reaching for the entity             | `ServerScript<Entity>` |
| Per-player coins, persisted            | `@serverState` on the one `BasePlayer` subclass — all player state, or none | `ServerScript<Player>` |
| A muzzle flash on the local screen     | impossible — no client-side entity code                                     | `ClientScript<Entity>` |
| Camera lookahead that reads `viewport` | impossible — `Camera` accepted no code                                      | `ClientScript<Camera>` |
| Shared rules the client can predict    | impossible — `Game` was server-only by fiat                                 | `SyncedScript<Game>`   |

The grid, with the cells that don't exist called out:

|               | `ServerScript`      | `ClientScript`          | `SyncedScript`         |
| ------------- | ------------------- | ----------------------- | ---------------------- |
| **Entity**    | loot, damage checks | local cosmetics         | gameplay — the default |
| **Player**    | coins, persistence  | local prefs, own HUD    | predicted own-player   |
| **Game**      | the orchestrator    | music, screen switching | shared rules (rarely)  |
| **Camera**    | cutscenes           | camera feel             | **error**              |
| **HUDScreen** | **error**           | menus and HUD           | **error**              |

`SyncedScript<Camera>` and `SyncedScript<HUDScreen>` are load-time errors for the same reason: a camera and a screen are one player's presentation, so there is no authoritative copy to reconcile against, and "synced" would be a lie. `ServerScript<HUDScreen>` is an error because a screen only exists on a client. Three cells, one sentence each — the price of the grid is small and it is stated rather than discovered.

**`HUD` is a fundamental object but not a host** (§12.1), which is the one place the two lists come apart in the other direction. There is nothing to attach to a HUD that a `ClientScript<Game>` could not hold: a script wants either a screen's lifecycle or the session's, and `hud` is ambiently reachable from both.

**`BaseScript` is not extendable directly.** It names a host but no location, so the engine could not decide where to run it; the load-time error points at the three concrete bases. It exists to declare `host` and as the type `addScript` accepts.

**`host` is its only member**, and that is a deliberate narrowing from four. `H` already types it: on a `SyncedScript<Entity>` the compiler knows `this.host.destroy()` and `this.host.velocity` are valid, and on a `ServerScript<Game>` it knows `this.host.spawn()` is. Once that is true, the other three members were each solving a different problem, and none of them well:

- **`entity` was an alias.** `H` types `host`, so `this.entity` was a shorter spelling and a second name for one thing. The `never`-on-other-hosts typing bought nothing `H` did not already give — `this.host.destroy()` on a `<Game>` script is a compile error either way.
- **`player` was four expressions behind one name** — the host on a Player host, `host.owner` on an Entity, `host.player` on a Camera or HUDScreen, `null` on a Game. Worse, `ClientScript` redeclared it as the _local_ player, so on a `ClientScript<Entity>` attached to an unowned rock `this.player` silently meant "whoever is watching" rather than "my owner", with the same type and no error at the switch. Now the owner is written `this.host.owner` where it is read, and the local player is `this.localPlayer` on a `ClientScript` — client-only, so it stays a member there, since on the server "local" names nothing.
- **`game` is ambient** (§3.4). It was never reachable through the host anyway.

What remains is one narrowing, on `BaseMovement`: it declares `player` non-null, because attachment to an unowned entity is a load-time error (§4.1) and the alternative is `this.host.owner!` in every subclass.

**Movement is a script, not a fourth thing.** `BaseMovement` is `SyncedScript<Entity>` with a sealed tick (§4.1). Everything §5 says about scripts — `@onEvent`, `@serverState`, `ctx`, concurrency, decorator inheritance — applies to it unchanged, which is a simplification the old design paid for twice.

**State tiers**

| Tier          | Owner  | Replication                 | Creator-visible                                                           |
| ------------- | ------ | --------------------------- | ------------------------------------------------------------------------- |
| Authoritative | server | to all clients, auto-diffed | `@serverState`, entities, wrappers                                        |
| Per-player    | server | to one client               | per-player `@serverState`, scoped entities, `for` on `sound`              |
| Client        | client | never                       | `ClientScript` fields, camera, cursor, viewport, interpolation, particles |

The third tier used to read "engine-owned." It is now the tier creators write in.

**Crossing the boundary — the two directions are deliberately not symmetric.** That asymmetry _is_ the security model, and it is small enough to state in two sentences.

**Server → client is state replication, and it is implicit.** A `@serverState` value changes; every client holding it sees the new value at the next `sendRate` tick. Client code reads those replicas as ordinary properties. There is no subscribe call, no message type, and nothing for the creator to declare — a HUD that shows `game.timeLeft` is written by reading `game.timeLeft`.

**Client → server is a request, and it is always explicit.** A `ClientScript` calls `request(name, payload)`; an `@onRequest(name)` handler on a `ServerScript` decides what it means and whether it is allowed. This is the _only_ path from client code into authoritative state. A `ClientScript` cannot assign to `@serverState`, cannot call a mutating wrapper method, and cannot move an entity — those are load-time errors, not runtime surprises.

```ts
class Shop extends ClientScript<HUDScreen> {
    @onPress('buy-sword')
    buy() {
        this.pending = true; // client field: grey the button out NOW
        request('buy', { item: 'sword' }); // ask the server
    }
}
```

```ts
class Shopkeeper extends ServerScript<Game> {
    @onRequest('buy')
    buy(ctx) {
        const cost = PRICES[ctx.data.item as string];
        if (cost === undefined) return; // unknown item — drop it
        if (ctx.player.coins < cost) return; // can't afford — drop it
        ctx.player.coins -= cost; // @serverState; replicates back
        ctx.player.inventory.add(ctx.data.item as string);
    }
}
```

Note what the server handler does with a bad request: nothing. `ctx.player` is engine-supplied and unforgeable, `ctx.data` is untrusted input, and the handler is the validation site. A creator who forgets to check `coins` has written a free-items bug — which is a real cost of this model and the reason `@onRequest` is a separate decorator from `@onEvent`. Making the trust boundary a distinct word means a reviewer, a linter, and a fourteen-year-old can all see where it is. It now has a second marker: the enclosing class says `ServerScript`.

**Requests have no return value**, matching `send` (§5.8). The answer arrives as replicated `@serverState`, which the client script is already reading. This keeps one story for "how does the client learn things" and removes the question of what a request returns when the handler rejects it.

**Ticks: simulation rate and replication rate are separate.**

| Rate        | Default | Panel setting            | What it governs                          |
| ----------- | ------- | ------------------------ | ---------------------------------------- |
| Simulation  | 60 Hz   | `simRate`: 20 / 30 / 60  | `@onUpdate`, movement, collision, timers |
| Replication | 20 Hz   | `sendRate`: 10 / 20 / 30 | how often state diffs are broadcast      |

Simulation is cheap (arithmetic over a few hundred entities); replication is expensive (bandwidth × players). Precision genres need simulation granularity, not snapshot frequency, so raising `simRate` gets most of the benefit at a fraction of the hosting cost. Clients render at display rate and interpolate between the last two snapshots. Creators never see frame counts or tick numbers; all durations are in seconds.

**Tick-indexed input — no wall-clock timestamps.**

Client and server agree on a tick counter via a clock-sync handshake at join, refreshed periodically. Every input is tagged with the tick it occurred on and a sequence number:

```
{ action: 'jump', tick: 4821, seq: 337 }
```

The server holds arrivals in a small jitter buffer and applies each input **at its intended tick**, so a player's timing is judged on the tick they actually pressed, independent of ping. This is what makes rhythm and other timing-based genres viable.

This is not client-trusted timing. A tick index outside a bounded window around the server's current tick is clamped or dropped, so the claim is verifiable rather than accepted. Contrast wall-clock timestamps, which are unverifiable and produce the "shot me after I got behind cover" class of unfairness.

### 1.2 Prediction and reconciliation

A `SyncedScript` runs on **both** machines from the same source: authoritatively on the server, re-produced on the client from the same tick-indexed inputs. The creator writes one program, and for everything in the world simulation they still never learn the word "client."

The base class is the dividing line, and it is engine-enforced. `SyncedScript` is the default for gameplay precisely because the creator does not have to think about which machine anything runs on — declaring the location once, in the class header, is the whole of the thinking.

**A synced script's reach depends on its host**, which is worth stating because it decides how much a determinism slip costs:

| Host     | Re-produced on                     | Note                                                                  |
| -------- | ---------------------------------- | --------------------------------------------------------------------- |
| `Entity` | every client that holds the entity | the common case; scoped entities only on their owner                  |
| `Player` | that player's own client only      | no other client holds their state, so there is nothing else to re-run |
| `Game`   | every client                       | widest blast radius — prefer `ServerScript` for orchestration         |

Reconciliation is engine-owned and invisible: the server sends state plus the last input sequence it processed; the client rewinds to that state, replays its unacknowledged inputs, and lands at a corrected present. There are no creator-facing rollback hooks in MVP.

**Determinism is a hard requirement** for `SyncedScript`, and it is the price of the middle row. Client and server must produce identical results from identical inputs; divergence surfaces as rubber-banding. Inside a synced script:

- Fixed timestep only — never derive behavior from wall-clock time or frame count.
- Seeded `random` only. `Math.random` is a load-time error.
- No `Math.sin`, `Math.pow`, `**`, or any other implementation-approximated function — the spec permits two engines to differ in the last bits, so `@platform/math` supplies deterministic replacements. The full list and the safe set are §11.2.
- Consistent entity iteration order, engine-guaranteed.
- No storage reads, no leaderboard reads, no access to state the client does not hold.
- No client-local display values — `camera.viewport` depends on window size and aspect ratio, so every client holds a _different_ one. This is the mirror of the bullet above: the client does hold it, which is exactly the problem.

Violations are rejected at load time, not at runtime. The block tier cannot express any of them, so beginners never encounter this.

**A `ServerScript` is exempt**, because there is no second copy to agree with. It is therefore the only place that may read `Storage` and `Leaderboard`. When a synced script needs one of those reads, the answer is to move that decision into a `ServerScript` — which is now an ordinary refactor of one word in the header rather than a redesign.

**A `ClientScript` is exempt too**, and that exemption is the point of separating it. It may hold a scroll offset, read `camera.viewport`, call `Math.random` for a sparkle, and branch on window size — none of which a synced script may do. It buys that freedom by having no authority: nothing it writes leaves the machine.

**The check runs in the other direction on a `ClientScript`**, and that is the enforcement mechanism for the trust boundary. Inside one it is a load-time error to declare `@serverState`, assign to a hoisted `@serverState` property, call a mutating wrapper method (`Scoreboard.add`, `Inventory.remove`, `Leaderboard.submit`), spawn or destroy an entity, or write any entity transform. Reads are unrestricted. One rule, stated as creators will meet it: **client code reads the world and asks; it never tells.**

The exception, unchanged from the previous design, is `Camera` — a `ClientScript` may write it, because a camera is presentation rather than authoritative state (§3.3).

**Reconnection.** A dropped client keeps predicting locally while the server holds its state for a grace period before firing `@onPlayerLeave`; on reconnect, authoritative state wins and the avatar snaps back. Clients stop accepting input after ~1s of silence so players don't accumulate long stretches of ghost gameplay.

**Run modes.** One code path, two deployments:

| Mode      | Server                  | Network | Players                   |
| --------- | ----------------------- | ------- | ------------------------- |
| Networked | remote process          | yes     | N, join over time         |
| Local     | same process (loopback) | no      | one, synthesized at start |

Local mode skips serialization and prediction entirely — but handler order and the `player` object are identical, so a game written for one runs in both.

**Local mode has a server; what it does not have is a server deployment.** The client speaks to a real, co-located server across a real transport — nothing is client-authoritative — so the only thing local mode drops is the process to stand up and the port to dial.

**There is no local co-op mode.** N players on one machine would need per-local-player binding sets and N views into one canvas, which is a renderer capability that does not exist; it is also the one topology that forks local from networked, because the predicted set would be several players' entities in a single ownership scope. A second player joins over the network.

---

## 2. Coordinates

- **Origin at world center, y-up, units = pixels.** Matches Scratch and math class. One-way door; fixed before launch.
- **Screen space** is a separate concept, never mixed with world space. HUD widgets anchor by name (`'top-left'`, `'top-center'`, …) or a separate coordinate system, and no HUD call takes a coordinate (§12.1).
- **Z exists from day one** in the data model (`Vec3`, `z` defaults to 0), reserved for the 3D backend. This is the 3D escape hatch.
- **Draw order is `Entity.layer`, not `position.z`.** Layering is render state, not simulation state: `position` is written by `move()` every tick, interpolated between replication frames, and read by `distanceTo`/`moveToward`/`near`/collider bounds. A draw layer is an ordinal that snaps, so it gets its own field and z stays a real spatial axis.

---

## 3. Objects

**Six fundamental objects, and the list is closed:**

| Object   | What it is                  | Host? | Notes                                 |
| -------- | --------------------------- | ----- | ------------------------------------- |
| `Entity` | a live body in the world    | yes   | "sprite" in blocks; §3.1              |
| `Player` | one person's identity       | yes   | §3.2                                  |
| `Camera` | one player's view           | yes   | client-owned presentation; §3.3       |
| `Asset`  | immutable loaded data       | no    | texture, audio, clip, font; §3.5      |
| `Game`   | the session _and_ the world | yes   | owns entities, holds the bounds; §3.4 |
| `HUD`    | one player's interface      | no    | owns the screens; client-only; §12.1  |

**All six are engine-owned and none is subclassed.** This is the second half of the revision, and it is what the script grid bought. Previously three of them were creator-subclassed base classes — `BaseGame`, `BasePlayer`, and (through `UI`) the screen — which produced three problems the grid removes:

- **One class per object, for everything.** All of a game's per-player state lived in the single `Player` subclass, so coins, team, bindings, and a minigame's ammo count shared one file. Scripts are many-per-host, so each concern gets its own small class.
- **A `Base`/alias pair per object.** `BasePlayer` + `type Player = BasePlayer`, `BaseGame` + `type Game`, plus the engine substituting the creator's subclass behind the alias. Six aliases and a substitution rule, all to let creators add fields to objects the engine owns. Now `Player` is just `Player`.
- **Location baked into the object.** Subclassing `BaseGame` meant server-only; there was no way to attach client code to a camera or server code to an entity. §1.1 has the table of what that cost.

`Asset` and `HUD` are the two non-hosts, for opposite reasons. Nothing attaches to an asset because an asset has no behavior — it is data. Nothing attaches to a HUD because there is exactly one per player and its lifetime is the session's, so a script that wanted it would be a `ClientScript<Game>` (§12.1). Everything that would once have attached to a `Scene` — level rules, spawn logic, streaming — is session-scoped and attaches to `Game`, which is now the world itself (§3.4).

**`HUDScreen` is a host but not a fundamental object** (§12.2). It is panel-authored layout data, like a template or a region, and its widgets are reached by name through `hud.*` rather than as objects in code. It earns hostship because a menu needs somewhere to keep client state, not because it is a thing the world model contains. `HUD` is the object; a screen is a named region of it.

### 3.1 Entity

The base world object: transform, identity, lifecycle, tags. A **Sprite** is an entity with a renderable capability. Trigger zones and empty group nodes are entities without one.

```ts
entity.setPosition(x, y)           // instant position (chainable setter)
entity.setRotation(degrees)        // instant, absolute
entity.rotateBy(degrees)           // instant, relative
entity.setScale(scale)
entity.moveBy(dx, dy)              // instant, relative
entity.moveToward(target, speed)
entity.faceToward(target)
entity.distanceTo(target)
entity.attachTo(parent)            // transform hierarchy; child coords become local
entity.detach()                    // keeps world position
entity.tag('coin')  /  entity.hasTag('coin')  /  entity.untag('coin')
entity.show() / entity.hide()
entity.say(text) / entity.think(text)   // speech bubble; see §3.7
entity.playEffect(name, { loop })  // cosmetic, client-side, fire-and-forget
entity.destroy()                   // cascades to attached children
entity.owner                       // Player | null
entity.position / .rotation / .scale   // readonly — written by the setters above
entity.opacity / .layer                // plain fields
entity.getTouching(tag?)           // Entity[] — who I overlap right now; see §5.4
entity.isTouching(tag?)            // boolean — the block-tier spelling
entity.send(event, payload?)       // fire an event at this entity; see §5.8
```

**Timed motion verbs** — these take a duration in seconds and are awaitable (see §9):

```ts
await entity.glideTo(x, y, 1); // absolute target
await entity.glideBy(dx, dy, 1); // relative
await entity.fadeTo(0, 0.5); // or fadeOut() / fadeIn()
await entity.growTo(2, 0.5);
await entity.spin(360, 1); // relative
await entity.spinTo(90, 1); // absolute
```

**Naming convention (mechanical, so it can be guessed):** a `-To` suffix means an absolute target; the bare verb means a relative delta. `setPosition`/`moveBy` are instant; every timed verb names its duration.

Chained setters are **eager**: `spawn()` returns a live entity, `.setPosition()` and `.tag()` are ordinary setters returning `this`. There is no builder type.

**The transform is readonly, and `Vec3` is readonly component-wise.** `position`, `rotation` and `scale` are reads; every write is a named setter. The engine sees each one as a call, which is what lets it mark the transform dirty for the renderer, invalidate client prediction on a synced avatar, and replicate — none of which a bare `entity.position.x = 5` could trigger, and that assignment is the one a creator would reach for first. Sealing the field alone would not have been enough: `position` would still hand out a mutable vector, so the guarantee has to reach the vector type. `Vec3` becomes a value rather than a handle, which also means a position read stays valid after the body moves instead of aliasing live engine state. Object literals still satisfy it, so `moveToward({ x, y, z })` is unaffected.

`opacity` and `layer` stay plain fields. They are render settings rather than motion: nothing derives from them, they are not predicted, and `layer` is an ordinal that snaps (§3.1). The same line divides `camera.position` from `camera.zoom` (§3.3) and `velocity` from `maxSpeed` (§4.1).

### 3.2 Player

**Player is identity; the avatar is a body.** The test is respawn: anything that should _not_ reset when you die belongs on Player — score, inventory, team, bindings, persistence. Anything about a body in the world — collisions, animation — belongs on a script attached to the avatar.

`Player` is engine-owned and never subclassed. Per-player logic and state are **Player-hosted scripts**, many per player, one per concern:

```ts
class Wallet extends ServerScript<Player> {
    @serverState coins = 0; // per-player scope — see §6.1

    @onStart // this player joined
    async setup() {
        this.coins = (await this.host.storage.get('coins')) ?? 0;
    }

    @onEnd // this player left
    async save() {
        await this.host.storage.set('coins', this.coins);
    }
}
```

**`@serverState` is hoisted onto the host**, so declaring `coins` on a Player-hosted script is what makes `player.coins` readable everywhere — the same access site the old `BasePlayer` subclass produced. That hoisting is load-bearing: `ctx.player.coins` in a collision handler on a coin, and the §5.8 contract that a handler answers by writing state its sender reads, both depend on it. Two scripts on one host declaring the same name is a load-time error.

Splitting one subclass into several scripts is the point. A team shooter's player state is a wallet, a team membership, an ammo count, and a rebind menu; those have different lifetimes, different locations (the rebind menu is a `ClientScript`), and no reason to share a file:

```ts
class Loadout extends ServerScript<Player> {
    @serverState ammo = 30;
}
class Prefs extends ClientScript<Player> {
    volume = 0.8;
} // plain field, never replicated
```

Inherent to `Player`, and not creator-extensible:

```ts
player.name / player.index;
player.avatar; // the owned entity
player.camera; // per-player, defaults to follow(avatar)
player.cursor; // see §7.1
player.input; // bindings, see §7
player.storage; // per-player persistence
player.spawn() / player.spectate() / player.respawn();
player.movement; // the attached movement type; speed and its own knobs live here
```

**Movement is Player-only**, and this is the exception to the paragraph above: it is the one thing about a body reached through a Player accessor, because a movement class turns one player's input into one body's motion and a body with no player driving it has no use for it. A patrolling guard or a homing missile moves from an ordinary script with §3.1's verbs. There is no `entity.movement`; the class is still hosted by the avatar, and only the accessor lives here — see §4.1 for why the two differ.

Mechanics are still **not** properties of Player: `player.movement.maxSpeed` on the base, and everything genre-specific (`walkSpeed`, `jumpStrength`, `gravity`, `dashDistance`) declared by the attached subclass and reached the same way. Player is identity, and a jump height is not identity, so it goes one level down — see §4.1.

**Attachment is panel mapping**, exactly like entity scripts: the Player template lists the scripts to attach, and it is the template the editor's tray starts with (§8.1). Anything dropped on it is attached to every player at load time. `player.addScript(Wallet)` is the code path, and it attaches to the one player named — no export-scanning magic, and no substitution rule, because `Player` is a real engine class with no alias to substitute.

**Player-hosted vs. Game-hosted.** `@onStart` on a Player-hosted script is "this player joined"; `@onPlayerJoin` on a Game-hosted `ServerScript` is "the roster changed." Per-player setup goes on the former; orchestrator decisions (do we have enough players to begin?) on the latter.

**Moving a synced avatar is a special case.** The client is re-producing the avatar's motion locally, so an instant server-side reposition must invalidate that or the player rubber-bands. Use `avatar.teleportTo(x, y)` — it sends a prediction reset and reads as a hard cut. And `await avatar.glideTo(...)` disables the avatar's input for the duration and restores it after, so cutscenes don't fight the player.

Panel settings: movement class (a prebuilt class, see §4.1), auto-checkpoint, camera follow/zoom/bounds. Movement is on the Player template's settings for the same reason the accessor is on Player — it is a per-player choice, and one game does not mix two schemes. Speed, jump height, gravity and similar knobs belong to whichever movement type is attached, not to Player — a top-down avatar has no jump to configure.

### 3.3 Camera

```ts
camera.follow(entity);
camera.zoom = 2;
camera.shake(strength, duration);
camera.bounds = zone; // constraint — where it may travel
camera.viewport; // observation — what it sees right now (readonly)
camera.position; // readonly — written by moveTo/glideTo/follow
camera.moveTo(x, y); // instant
await camera.glideTo(x, y, 1); // smooth pan
await camera.zoomTo(1.5, 0.5);
```

Default behavior requires no code. Multiple cameras are per-player by construction; split-screen is a platform concern, not a creator one.

**`bounds` constrains, `viewport` observes.** The two are both `Bounds` and both on `Camera`, so the distinction is worth stating: `bounds` is an input the creator writes to leash the camera to the level; `viewport` is an engine-computed output describing the world-space rect currently on screen. You cannot write `viewport` — you move the camera or change `zoom` and it follows. The viewport is normally contained by `bounds`, and enforcing that containment is precisely what the leash does.

`viewport` exists because the alternative is creator arithmetic over screen size, `zoom`, and aspect ratio to answer ordinary questions — is this entity off-screen, where do I spawn something just out of view, what does the minimap frame. That is design rule 3: reaching for `Math.*` to compute something common means a primitive is missing.

**It is not readable from a `SyncedScript`.** Viewport size depends on the client's window, so two players on different aspect ratios hold different values — reading it in synced code would desync (§1.2). The load-time determinism check rejects it alongside `Math.random`. The block tier cannot express it, so beginners never meet the restriction.

**It is freely readable from a `ClientScript`**, which is its natural home: "is this entity off-screen", "where is this world position on screen" are questions about one player's view, asked by the code drawing that player's screen. Camera itself is client-owned for the same reason — `follow`, `zoom`, `shake`, and the pan verbs affect one player's presentation and were always per-player. A `ClientScript` may call them; this is the one exception to "client code never writes," and it holds because the camera is not authoritative state. A `ServerScript` retains access for cutscenes.

**Camera is a host**, which is new, and `ClientScript<Camera>` is the answer to a category of code that had nowhere to live. Camera _feel_ — lookahead that leads the player's velocity, a deadzone, a shake on landing, a zoom that eases out when you run — is per-player presentation that needs its own small pile of state and wants to read `viewport`. Under the previous design that state had no home: it could not be `@serverState` (per-player presentation isn't authoritative), could not be a `Script` field (predicted code can't read `viewport`), and a `UI` class was attached to a screen rather than a camera.

```ts
class Lookahead extends ClientScript<Camera> {
    lead = 0.25; // seconds of velocity to lead by — a plain client field

    @onUpdate // display rate, like all client scripts
    frame() {
        const p = this.host.player; // whose view this is — Camera carries it
        this.host.moveTo(
            p.avatar.position.x + p.movement.velocity.x * this.lead,
            this.host.position.y,
        );
    }
}
```

`ServerScript<Camera>` is legal and is where a cutscene lives — a server-driven pan that every client must see identically. `SyncedScript<Camera>` is a load-time error: there is no authoritative camera to reconcile against, so "synced" would describe nothing. `@serverState` on a Camera-hosted script is likewise rejected, pointing at plain fields.

### 3.4 Game

**The Game is the session and the world — one object.** It owns every entity, receives the loop, scopes queries and events, holds the bounds, and is where orchestration and global `@serverState` live. Engine-owned, never subclassed, and there is exactly one — so the class is `abstract` and the instance is an ambient `game`, a module const like `hud`, `random`, and `assets`. Access is `game.spawn`, `game.find`, `game.players`, `game.random`, from any host and any location. `ctx` carries only event-specific data.

**Ambient rather than a member on `BaseScript`**, which is the §1.1 argument seen from this side: every script needs the world, but only a Game-hosted script has the Game as its `host`. A `this.game` member existed to paper over that, and the alternative — a `.game` back-pointer on `Entity`, `Player`, `Camera`, and `HUDScreen` — adds four edges to delete one member. A const makes world access read identically everywhere and costs one reserved name.

Writes are still location-checked, just at load time rather than by the type. `game.spawn`, `destroy`, `pause`, and `resume` from a `ClientScript` are load-time errors pointing at `request()` — the same enforcement `hud`, `request`, and `@serverState`-on-a-`ClientScript` already rely on. What is lost is the compile-time read-only view a `ClientScript`-declared `game` member could carry; that is the honest price of going ambient, and it buys consistency with the rest of the ambient surface.

```ts
game.spawn(template, x, y); // eager; returns Entity
game.find({ tag }); // returns a real array
game.entities; // real array — everything alive
game.bounds; // the whole world's extent; build-time, readonly
game.players; // real array
game.pause() / game.resume(); // local modes only; no-op when networked
```

```ts
class Rules extends ServerScript<Game> {
    @serverState timeLeft = 60; // global — one value, replicated to everyone

    @onStart
    begin() {
        /* ... */
    }
}
```

**`Scene` is gone, and this is what deleting it means.** There used to be a sixth object between `Game` and the entities: a container that owned them, received the loop, scoped queries, and carried `load`, `create`, `spawn`, `find`, `bounds`, and `stream`. It was never a host, for a reason the previous design stated plainly and then declined to act on — every candidate for a Scene-hosted script is session-scoped, so `<Scene>` and `<Game>` would have been the same scope under two names. That argument does not stop at hostship. If the two objects cannot hold distinguishable state, they are one object, and the split was costing:

- **Two names for one scope, in every creator's code.** `scene.find` and `game.players` are both "ask the world a question," and a creator had to remember which noun each lived under. Now there is one: `game`.
- **A container with no second instance.** Nothing in MVP can produce two scenes at once, so `game.scene` was a field that always held the same value — an indirection every call paid for and no code ever branched on.
- **A lifecycle question with no good answer.** `load()` and `create()` implied a world that could be swapped at runtime, which forced "is it loaded yet," "what happens to entities across a load," and "which bounds are current" into an API whose whole appeal is that `spawn` is always safe.

**The bounds are fixed at build time.** `game.bounds` is the panel-authored extent of the world, readonly, and known before `@onStart` runs — the same treatment assets already get (§3.5). That is what lets `load()` disappear entirely rather than move onto `Game`: there is one world, it is built before any code runs, and no creator call brings it into existence. `camera.bounds` leashes to it and `find({ in })` resolves regions inside it.

**Prefer `ServerScript<Game>` for orchestration.** `SyncedScript<Game>` is legal, and it is right for a shared rule the client genuinely needs to predict — a timer the HUD must count down smoothly, a scoring rule that gates a local effect. But a Game-hosted synced script re-produces on _every_ client, so a determinism slip in one has the widest blast radius in the API (§1.2), and orchestration mostly reads storage and rosters anyway, which synced code may not. `ClientScript<Game>` is the session-scoped client slot: background music, screen switching, "which menu is up".

A "background" is a low-`layer` sprite in the world, not a property of anything.

**What this costs.** Multi-level games lose the spelling they had. A game with three levels does not call `game.load('level-2')`; it either ships as three games, or builds all three regions into one world's bounds and moves the player between them (`avatar.teleportTo`, §3.2). That is a real narrowing, and it is the one to revisit first if multi-world games turn out to matter — reintroducing a load verb on `Game` is a smaller change than reintroducing a `Scene` object, which is part of why this shape is the right one to start from.

### 3.5 Asset

**An asset is immutable loaded data** — a texture, an atlas, an audio buffer, a font, an animation clip, an effect. Loaded once by the panel, shared, referenced by key. It is fundamental because code needs to _ask things about_ one:

```ts
assets.get('hero-idle').width; // how wide is this sprite
assets.get('theme').duration; // how long is this track
assets.all('audio'); // real array
```

The alternative is a creator hard-coding `32` because they know the sprite is 32 wide, which breaks silently when the artist redraws it — design rule 3, and the same argument that put `camera.viewport` in the API.

**Every API that takes an asset takes either a key or an `Asset`.** The string form is block-safe: a dropdown of panel-loaded keys, one slot, no expression. The object form is what text-tier code holds once it has asked a question. `sound.play('coin')` and `sound.play(assets.get('coin'))` are the same call.

**An asset is not a template and not a host.** A template is a configured entity, spawned by string key through `game.spawn` — assets are the data a template points at (§8 keeps templates, prebuilt classes and starters apart). Nothing attaches to an asset because an asset has no behavior; a script on a texture would have no lifecycle and no state worth having.

**Loading stays in the panel.** `assets` is read-only: there is no `assets.load`, because loading is a preload concern the panel owns (design rule 5) and a `load()` in code reintroduces the "is it ready yet" question that `game.spawn` being always-safe exists to remove. `loaded` is exposed for the panel's own progress UI and for the rare streamed-audio case, not as something creator code is expected to branch on.

### 3.6 Session & players

**The framing rule: `@onStart` builds the world; players are a stream that arrives afterward.**

This is the one rule that collapses the two situations creators worry about — "a networked game that starts with nobody in it" and "a game that starts with players already present" — into a single code path. They differ only in _when_ the first player arrives, which is an engine timing detail:

|                | `@onStart`              | first player                   |
| -------------- | ----------------------- | ------------------------------ |
| Networked      | world built, no players | seconds or minutes later       |
| Local / single | world built, no players | immediately after, synthesized |

Consequences, all normative:

- **A Game-hosted `@onStart` must not assume any player exists.** Anything player-dependent belongs in `@onPlayerJoin`, or in a Player-hosted script's own `@onStart`.
- **`@onPlayerJoin` is optional.** The panel-configured Player template spawns the avatar, attaches its camera, and attaches its scripts automatically. A solo platformer needs no join handler at all.
- **Joins release once Game `@onStart` reaches its first `await`**, not once it finishes. So the synchronous part of world setup is guaranteed to have run before anyone arrives, and anything after an `await` is not.

**That last rule replaces "awaited to completion", which could not work.** Waiting for the whole handler deadlocks the obvious code: `await sleep(1)` inside `@onStart` needs ticks to elapse, the loop supplies those ticks, and the loop had not started because it was waiting on `@onStart`. The engine therefore starts the tick counter and the loop at the _beginning_ of `@onStart` and proceeds at the first `await` — which is §5.8's existing dispatch rule ("every handler runs to its first `await`") applied to a lifecycle handler rather than a new mechanism.

The consequence a creator can hit, stated plainly: **a player's `@onStart` may run before the Game's has finished.** So world construction — spawning the level, seeding `@serverState`, registering timers — belongs _before_ the first `await` in a Game-hosted `@onStart`, and only sequencing belongs after it. A handler with no `await` in it, which is the common case and the only one the block tier can express, has fully finished before any join and is unaffected.

Once the player limit is reached, when the next player joins the instance, we'll create a new server instance + game, calling the Game-hosted `@onStart` handlers.

**No rounds, no phases, no session state machine.** The engine provides events and nothing else. "Waiting for players," "round in progress," "game over," ready-up, spectating, and rematches are game-specific mechanics, and every game answers them differently — so they are ordinary creator state:

```ts
class Tag extends ServerScript<Game> {
    @serverState playing = false;

    @onPlayerJoin
    join(ctx) {
        if (this.playing) ctx.player.spectate();
        else ctx.player.spawn();
        if (game.players.length >= 2) this.begin();
    }

    begin() {
        if (this.playing) return;
        this.playing = true;
        this.scores.reset();
        for (const p of game.players) p.spawn();
    }
}
```

A `@serverState` boolean or string is the whole mechanism. It replicates to clients automatically, so HUD widgets can bind to it, and it costs the engine nothing.

**What this trades away**, stated plainly so it isn't rediscovered later:

- `Scoreboard.reset()` is a manual call. There is no automatic per-round reset.
- The engine does not gate input by game state. A creator who wants frozen players between rounds sets `player.movement.enabled = false` themselves.
- There is no engine-supplied `winner`, no idempotent `endRound`. A creator's own win check needs its own guard — see the concurrency rules in §5.6.

**Panel settings:** `maxPlayers`, `simRate`, `sendRate`. `maxPlayers: 1` also drives editor behavior — no multi-pane test view, no share link.

### 3.7 Dialogue

Any entity can display a bubble. This is the smallest possible dialogue primitive and deliberately not a dialogue _system_.

```ts
entity.say('Hello!'); // persists until cleared or replaced
await entity.say('Watch out!', 2); // auto-clears after 2s; awaitable
entity.think('Hmm...'); // thought-bubble variant
entity.clearSay();
```

**Semantics**

- Bubble text is **replicated state on the entity**, not a fire-and-forget effect. A player joining mid-sentence sees the bubble that is currently up.
- One bubble per entity. A second `say` replaces the first.
- Bubble text is capped at 200 characters. It is replicated state, so an unbounded string is a per-tick broadcast of whatever the game can be talked into saying.
- The engine owns placement: anchored above the entity, flipped or nudged to stay on screen, following the entity as it moves. Creators never position a bubble.
- Bubbles clear automatically when the entity is destroyed.
- The duration form is awaitable, so conversations are straight-line code:
    ```ts
    await npc.say('Take this sword.', 2);
    await hero.say('Thanks!', 1);
    ```
- Text length is capped (engine constant). Longer strings truncate rather than producing an unbounded bubble.

**There is no per-player bubble.** A `for` option was cut for the same reason it was cut from `hud` (§12.3): it made the engine name one client. The difference is that bubbles are replicated entity state, so the local-branch replacement does not apply — the option was genuinely load-bearing, and cutting it costs the whisper. That trade is still right, because the option contradicted all three semantics above at once: the slot becomes one bubble per entity _per player_, replacement turns ambiguous when a scoped and an unscoped bubble are both live, and mid-join replication has to be resolved per viewer. A private message is per-player `@serverState` read by a HUD widget, which is where directed text already belongs.

**Moderation.** Any bubble containing text that did not come from the creator's source — player names, chat input, stored strings — is filtered before display. This is engine-enforced and not optional, since bubbles are the easiest path to putting arbitrary text on another child's screen.

**Blocks:** three blocks — say, say-for-seconds, think — matching Scratch's vocabulary exactly.

**Not in MVP:** dialogue trees, branching choices, player-selectable responses, portrait/nameplate dialogue boxes, typewriter reveal. Those are UI-layout features and are UI-layout features beyond §12. `say` covers the overwhelming majority of school-project dialogue on its own.

---

## 4. Capabilities

Attached to entities, not peer objects. MVP set:

| Capability   | Purpose                    | Notes                                                              |
| ------------ | -------------------------- | ------------------------------------------------------------------ |
| `renderable` | sprite/texture             | makes an entity a "sprite"                                         |
| `collider`   | bounding box, trigger flag | authored in panel; contacts read via `entity.getTouching()` (§5.4) |
| `animation`  | spritesheet clips          | driven by movement state; see §4.2                                 |

**Movement is not on this list any more**, and it is not on `Entity` at all. It used to be a capability, and that was a category error twice over. First, a collider and an animator are engine-provided leaf data, while a movement type is a class with creator-overridable methods, `@serverState`, and `@onEvent` handlers — a script in everything but name. It is now literally one: `BaseMovement extends SyncedScript<Entity>` (§4.1). Second, the capabilities on this list are things _any_ entity may have, and movement is not: it is the machinery that turns a player's held keys into a body's velocity, so it belongs to players only. The accessor is `player.movement` (§3.2), and `entity.movement` does not exist.

```ts
player.movement.enabled = false; // stops steering; gravity still applies
player.movement.speed; // READ: how fast it is going, px/sec
player.movement.maxSpeed = 900; // the base's one ceiling
player.movement.walkSpeed = 300; // PlatformerMovement's own knob
player.movement.jump(); // PlatformerMovement's own verb, over impulse()
```

`velocity`, `intent`, `enabled`, `speed`, `maxSpeed`, and `blocked` are the whole base surface. Anything else a creator touches on movement — `walkSpeed`, `jumpStrength`, `aimAngle`, `dashesLeft` — is declared by the attached subclass, so it exists exactly when that genre's movement is attached.

Post-MVP: circle/polygon colliders, joints, pathfinding.

### 4.1 Movement

**Movement is a class to extend, not a setting to pick.** There is no `MovementMode` union and no engine-level notion of a genre. `BaseMovement` owns one body's motion for the tick: it turns intent into velocity and integrates. It is **abstract** — only concrete subclasses attach, so there is no inert-body case to document and no half-configured default to inherit.

**It is for players and nothing else.** A movement class is the input-to-locomotion pipeline, and every part of it says so: `intent` is filled from the panel-mapped move axes, discrete moves arrive as bound actions through `@onEvent`, and prediction and reconciliation exist at all because a person is holding the keys and must see the result this frame. A patrolling guard has no bindings to read and nothing to predict, so the machinery is inert weight on it. Attachment is therefore legal only on a player's avatar, and attaching to an unowned entity is a load-time error pointing at the motion verbs instead.

**Non-player bodies move from an ordinary script.** A chaser calls `moveToward` in `@onUpdate`; a platform `glideTo`s between two points; a projectile calls `setPosition`/`moveBy`. That is a `SyncedScript<Entity>` of a few lines, using §3.1's verbs, and it needs no `intent` and no reconciliation. What such a body gives up is real: gravity, `maxSpeed` clamping, and collision sliding with `blocked`. Falling crates and physics puzzles are the case this hurts, and MVP's answer is that they integrate a fall speed of their own and `moveBy` it each tick — a plain script field, since an entity without movement has no `velocity` to write. If that recurs often enough to matter, the fix is a prebuilt `Falling` script in the drawer (§13) — not re-opening `BaseMovement` to every entity to serve it.

**It is a `SyncedScript<Entity>` with a sealed tick, and nothing more.** That is the framing this revision fixes. `entity` and `host` are inherited from `BaseScript`, `@onEvent('jump')` works because a movement class is an event target like any other script, `@serverState coyoteTime` scopes per entity because the host is `Entity`, and the determinism rules apply because the location is synced. Previously each of those had to be asserted separately for movement, with a paragraph explaining that a movement type behaves "exactly as it does on a `Script`" — five such assertions collapse into one `extends`.

**Player-only did not change the host, only the accessor.** The host is still the avatar, because everything in the tick is about a body: `@serverState` scopes per entity, `blocked` comes from that body's collision resolution, and the animation config reads that body's `velocity` (§4.2). What moved is the name a creator types — `player.movement`, not `entity.movement` — and `this.player` inside a movement class is never null, since the host always has an owner. `BaseMovement` is the one place that still declares a `player` member for exactly that reason (§1.1). Rehosting on `Player` was the alternative and is worse: it would make `coyoteTime` per-player state about a body, and leave the animation config reaching across `host.avatar` for every condition it reads.

**One write channel.** Velocity is the only representation of motion — px/sec, the single thing position is derived from, and written through `setVelocity`. Earlier drafts had three channels in three unit systems (`move()` in px/tick, `setVelocity()` in px/sec, `impulse` in mass-dependent units) with no stated precedence, which made `move(300, 0)` and `setVelocity(300, 0)` differ by 60× behind identically-shaped signatures. Everything a subclass does is now `setVelocity`, `setIntent`, `impulse`, or `addForce`.

```ts
abstract class BaseMovement extends SyncedScript<Entity> {
    // host (the avatar) inherited from BaseScript; player declared here, non-null

    velocity; // px/sec, post-collision; readonly, replicated
    intent; // -1..1 per axis; direction, not speed; readonly, replicated
    enabled; // suppresses intent only — see below

    speed; // READ-ONLY: velocity.length(), px/sec
    maxSpeed; // ceiling on total velocity, px/sec
    blocked; // { up, down, left, right } — written by the engine

    tick(dt) {
        // SEALED — this order is the prediction contract
        this.accelerate(this.readIntent(), dt); // intent -> velocity
        this.applyForces(dt); // gravity, friction, drained forces
        this.clampSpeed(); // maxSpeed
        this.move(dt); // engine: sweep, slide, write position,
    } // correct velocity, set blocked

    setVelocity(x, y, z?); // the one write behind every velocity change
    setIntent(x, y, z?); // (B) override the player's own steering
    impulse(x, y, z?); // discrete Δvelocity, px/sec, never dt-scaled
    addForce(x, y, z?); // continuous, px/sec², accumulates; drained per tick
    stop(); // (B) zero velocity and intent

    protected abstract accelerate(intent, dt); // the only required override
    protected readIntent(); // default: this.intent
    protected applyForces(dt); // default: drain the force accumulator
    protected clampSpeed(); // default: clamp to maxSpeed
    protected approach(cur, target, rate); // shared accel/friction primitive
    private move(dt); // engine-owned; not overridable, no collision hook
}
```

**The hook list is the extension vocabulary.** A subclass overrides hooks, never the tick. Every genre difference lands in a named place: input response in `accelerate`, gravity and friction in `applyForces`, terminal velocity in `clampSpeed`. `accelerate` is the only `abstract` member, so the minimum viable movement type is one method.

```ts
class TopDownMovement extends BaseMovement {
    walkSpeed = 300; // its own knob — `speed` is a reading

    accelerate(intent, dt) {
        // instant, no inertia
        this.setVelocity(intent.x * this.walkSpeed, intent.y * this.walkSpeed);
    }
}
```

```ts
class PlatformerMovement extends BaseMovement {
    walkSpeed = 260;
    gravity = 1400;
    jumpStrength = 520;
    acceleration = 2600;
    friction = 3000;

    get grounded() {
        return this.blocked.down;
    } // derived, not tracked

    accelerate(intent, dt) {
        const target = intent.x * this.walkSpeed;
        const rate = intent.x !== 0 ? this.acceleration : this.friction;
        const vx = this.approach(this.velocity.x, target, rate * dt);
        this.setVelocity(vx, this.velocity.y); // y is gravity's, not ours
    }

    applyForces(dt) {
        if (!this.grounded) this.addForce(0, -this.gravity); // px/sec², dt-scaled
        super.applyForces(dt); // drains gravity, wind, conveyors
    }

    @onEvent('jump')
    jump() {
        // assign, don't add — a held jump never compounds
        if (this.grounded) this.setVelocity(this.velocity.x, this.jumpStrength);
    }
}
```

Four things that shape is buying:

- **`intent` is normalized by the engine before `readIntent` returns it**, so the un-normalized diagonal — where holding two directions makes you 1.41× faster — is fixed once for every prebuilt class and every user subclass rather than in each one's arithmetic. The old `* this.speed * dt` spread across seven of them was also the `Math.*` smell design rule 3 warns about.
- **`speed` is a reading, not a knob.** `velocity.length()` is what an animation config compares against and what a creator means by "how fast is it going." Locomotion speed is the subclass's own field, because a platformer's walk speed, a car's top gear, and a fish's swim rate are not the same quantity and the base cannot define one. See §3.2 for what this changes.
- **`impulse` and `addForce` are different physics, so they are different methods.** A jump is a discrete Δvelocity and must never be dt-scaled or it varies with `simRate`; wind is a continuous acceleration that must be. Collapsing them into one additive call is the bug where a bounce pad feels different at 30 Hz than at 60. `addForce` accumulates, so two overlapping wind zones sum rather than fighting over the last write.
- **`grounded` is a getter over `blocked.down`**, not tracked state. Nothing can forget to update it, and there is no `@serverState` to replicate — `blocked` already arrives with velocity.

**`velocity` is readonly, so a subclass writes it through `setVelocity`.** This is §3.1's rule reaching the one place that writes motion most often, and here it pays for itself twice. Velocity is replicated and predicted: the engine has to know it changed to send it and to reconcile against it, and a component assignment inside `accelerate` is invisible. It also forces the axis a hook is _not_ responsible for to be written out — `accelerate` passing `this.velocity.y` through says on the page that vertical motion belongs to gravity, which is exactly the confusion behind a platformer whose jump gets eaten by its own horizontal acceleration. The cost is that a one-axis change names both; `setVelocity` is decomposed rather than vector-taking for the same reason `setIntent` and `impulse` are, so it stays one block with x/y slots and no vector literal.

That is also why `PlatformerMovement` applies gravity with `addForce(0, -gravity)` instead of touching `velocity.y`: the force channel already exists for continuous acceleration, it is dt-scaled once in the drain rather than at each call site, and two sources of downward pull (gravity plus a magnet) sum instead of overwriting each other. `addForce` must precede `super.applyForces(dt)`, which is what drains the accumulator.

**`intent` is a Vec3, not a return value, because two writers need it.** The engine fills it from the panel-mapped move axes each tick, so a movement type reads continuous input without naming an action. A script writes it when something other than the player should be steering — a cutscene walk, a tractor beam, an ice slide that ignores held keys — via `movement.setIntent(x, y)`, and the same subclass drives it unchanged. That second writer is why it is state rather than a return value; it is a narrower case now that the AI chaser and the conveyor have moved out to their own scripts, but it is the case that made `enabled` a soft freeze and a scripted path possible at all. Overriding `readIntent` is for non-axis input sources: a cursor angle, a modal control scheme.

**Discrete input reaches a movement type through `@onEvent`**, which now needs no explaining: a movement class is a `SyncedScript`, and every script is an event target (§5). That is why `tick` takes only `dt` — continuous input is already `intent`, and a jump is an event, so there is no `actions` object to thread through four hook signatures. It also means the jump lives in a method a subclass can override by name.

**There is no collision hook, and `move()` is not overridable.** The engine sweeps, slides, writes position, corrects velocity for what it hit, and sets `blocked`. A subclass reacts to `blocked` on the following tick rather than intercepting resolution mid-step — an override there is the single easiest way to make client and server disagree, since it runs inside the synced window with the physics engine's intermediate state. Landing logic, wall-jump detection, and squash-on-impact all read `blocked`.

**`enabled = false` suppresses intent only.** `readIntent` yields zero; stages 2–4 still run. Gravity keeps pulling, a running player decelerates through their own friction instead of halting in midair, and nothing teleports. That is the between-rounds freeze §3.6 asks for. A hard freeze is `stop()` then `enabled = false`.

**Tick order is spec, not implementation.** `movement.tick` runs before scripts' `@onUpdate`, so a handler reading `velocity` or `blocked` sees this tick's resolved values rather than last tick's. With determinism as a hard requirement (§1), leaving that order to the implementation would make it a desync source.

**`TopDownMovement`, `PlatformerMovement` and the rest are platform-authored prebuilt classes, not API surface a creator designs against.** They ship as concrete `BaseMovement` subclasses in the same drawer as `Inventory` and `Leaderboard` (§13) — a creator picks one in the panel and never writes the class. That is what keeps the base small: adding an eighth genre is a new prebuilt class, not a new union member and not a new engine branch. MVP ships two, `TopDownMovement` and `PlatformerMovement`, which between them cover the overwhelming majority of school projects.

**The `Movement` suffix is load-bearing.** `PlatformerMovement` handles gravity, jumping and side-to-side running; `TopDownMovement` handles eight-way walking with no gravity. There is no class called `Platformer` and none called `TopDown`, because those are _genres_ — a genre is a whole game (a scrolling level, coins, a scoreboard, a respawn rule) of which movement is one part. What we ship for a genre is a **starter**: sample code a creator copies and edits. The suffix keeps the two from being mistaken for each other, and keeps a creator from importing `Platformer` and finding nothing there.

An earlier draft named these for the camera perspective instead — `SideViewMovement` for the platformer one — on the theory that a perspective is narrower than a genre. That went too far in the other direction: a creator building a platformer does not think "I need side-view movement," they think "I need platformer movement," and the indirection cost a lookup on every use for no gain the suffix wasn't already providing. `PlatformerMovement` names the mechanic set (gravity, ground friction, a jump verb) rather than the projection, and the suffix already carries the "this is one part, not the game" distinction. The lesson generalizes: **name a prebuilt class after what a creator would call the thing they need, with a suffix that says which part of it this is.**

**Almost every real use is a knob, not a subclass.** Sample games written against an earlier draft subclassed the movement class to change two numbers, because the draft's examples led with the subclass:

```ts
// tuning the prebuilt class: the common case
const movement = player.movement as PlatformerMovement;
movement.walkSpeed = 300;
movement.jumpStrength = 560;
```

A subclass is for a genuinely new mechanic (a double jump, a wall slide), not for a value the panel already exposes. **When illustrating a prebuilt class, show the knob first and the subclass second**, or the examples teach the rarer path as the default.

**Reaching the attached class from code needs a cast today**, since `player.movement` is typed as the `Movement` alias (`BaseMovement`) and only the panel knows which subclass is really attached. That is a real wart: the knobs a creator most wants — `walkSpeed`, `jumpStrength` — live on the subclass, so the ordinary case pays for a cast. It is the same shape as the hoisted-`@serverState` typing question in §6.1 — in both cases the panel knows what is attached and the type system does not — so one answer should cover both: `Entity`/`Player` generic over what they host, panel-emitted typed accessors per template, or accept the cast as the text-tier price of panel attachment. Unresolved; the block tier never sees it, because a block reads "set walk speed" off a dropdown of the attached class's own knobs.

Attachment is panel mapping, exactly like every other script — the Player template in the tray (§8.1) points at a movement class, which the engine attaches to that player's avatar at load time. It is one slot rather than a list, since a body has one movement class; that is the only way the tray treats movement differently from any other script. `player.setMovement(PlatformerMovement)` is the code path for the rare dynamic case (a swap on entering a vehicle, a mode change mid-round), and it takes a concrete subclass since the base is abstract. There is no `entity.setMovement`.

**A prebuilt class is extended by overriding one stage, not by re-implementing the tick.** A kid adding a double jump to `PlatformerMovement` overrides the verb that owns the decision:

```ts
class DoubleJump extends PlatformerMovement {
    @serverState jumpsLeft = 2;

    applyForces(dt) {
        super.applyForces(dt);
        if (this.grounded) this.jumpsLeft = 2;
    }

    jump() {
        if (this.jumpsLeft === 0) return;
        this.setVelocity(this.velocity.x, this.jumpStrength);
        this.jumpsLeft--;
    }
}
```

No `super.tick()` to sequence, no double-firing from a shared `pressed('jump')` read, and the override is the same shape whether the parent is `BaseMovement` or a five-deep subclass chain. **Every prebuilt class is therefore held to a convention:** each mechanic gets its own small overridable verb (`jump`, `dash`, `aim`), and no hook reads an action a verb also reads.

**Decorators are inherited, and an override does not re-register.** `DoubleJump` never writes `@onEvent('jump')` — it inherits the parent's registration and replaces the method body, so the action fires once and runs the subclass's version. This is the normal prototype-override rule, but it is worth stating because the alternative (re-declaring the decorator in the child) is the natural guess and would double-register the handler. A subclass that wants _both_ behaviors calls `super.jump()`.

**Facing, gravity, and jump are still absent from the base.** Each is genre-specific: a 4-direction facing enum is wrong for a twin-stick shooter aiming at a cursor angle. A subclass that needs one declares it with `@serverState` — per-entity, since the host is `Entity` — which both replicates it and makes it available to the panel's animation config (§4.2). What moved _onto_ the base is only `blocked` — the collision result no subclass can compute for itself. `entity.getTouching()` (§5.4) does not substitute for it: that reports _who_ is overlapping, while `blocked` reports _which side stopped the body_, and a subclass cannot derive the second from the first without the resolution data the engine keeps to itself. There is still no raycast.

**Determinism applies**, and now by inheritance rather than by assertion: `BaseMovement` is a `SyncedScript`, so every stage obeys §1.2's rules — fixed timestep, seeded `random` only, no storage reads. Reading input is safe by construction, since input is tick-indexed and a replay during reconciliation sees the same values. `intent` is replicated for the same reason: a server-set standing order has to survive the client's replay.

**3D.** `velocity` and `intent` are already `Vec3`, and `setVelocity`, `setIntent` and `impulse` already take an optional `z`; the stage list, `speed`, and `approach` are dimension-free. `blocked` gains forward/back. What stays 2D is the cardinal sugar — `pushUp`/`pushLeft` blocks over `impulse()` — which reads well as a block and is a prebuilt class's business, not the base's.

### 4.2 Animation

Three distinct things share the word "animation." Keeping them separate is what makes the API small:

| Kind                    | What changes                     | Replication                               |
| ----------------------- | -------------------------------- | ----------------------------------------- |
| **Frame animation**     | which spritesheet frame is shown | derived client-side; free                 |
| **Transform animation** | position / rotation / scale      | replicated state (motion verbs, movement) |
| **Effect**              | particles, flashes, squash       | cosmetic, fire-and-forget (`playEffect`)  |

**Default: no code.** An avatar template's animation config maps movement state to clips in the panel. It always has `velocity` and `blocked` from the base, plus whatever `@serverState` the attached movement subclass declares — so the conditions available depend on the movement type, which is what makes the mapping genre-appropriate without the engine knowing any genres. This works because movement is hosted by the avatar, so the config reads state on the same entity it animates. A non-avatar template has no movement to key off and maps clips to its own scripts' `@serverState` instead. A platformer config reads `grounded` because `PlatformerMovement` derives it from `blocked.down`:

| Condition         | Clip   |
| ----------------- | ------ |
| stopped, grounded | `idle` |
| moving, grounded  | `run`  |
| airborne, rising  | `jump` |
| airborne, falling | `fall` |

A top-down movement type exposes no `grounded`, so those rows simply aren't offered; its config keys off velocity direction instead. Facing/flip is likewise the movement subclass's business — it declares whatever facing representation its genre needs (a 4-way enum, an 8-way one, a cursor angle) and the panel binds clips to that. A creator who only moves entities never touches animation at all.

**Explicit control**, for clips the state machine can't infer:

```ts
entity.play('attack'); // one-shot; yields back to the state machine
entity.play('celebrate', { loop: true });
entity.stopAnimation(); // return to automatic
entity.animation.speed = 2;
entity.animation.clip; // READ: what is on screen now, '' if nothing
```

`play()` **overrides** the state machine temporarily and returns control automatically when a one-shot completes. Creators never re-trigger `idle` by hand. `animation.clip` reports whichever regime is live, so a script can tell an override from a derived pick without tracking it itself.

**Networking rule.** Derived animation costs nothing: clients compute idle/run/jump from replicated velocity and `grounded` at render framerate, so animation stays smooth between snapshots. Explicit `play()` sends one small event. Frame indices are never replicated.

**Direction of dependency:** animation reads from movement, never the reverse. Root motion, animation-driven hitboxes, and frame data are out of scope. The escape hatch is ordinary code: disable movement, `await` the clip, re-enable.

**Blocks:** three blocks total — play, play-looping, stop. The automatic case needs none.

---

## 5. Events

**Decorators are the only way to declare a handler.** There is no runtime `subscribe`/`on` call, so decorator arguments must be static (tags, action names, asset keys) and a host's handler set is fully known from the scripts attached to it before the world runs. That is what pays for load-time rejection of location violations (§5.9), stable dispatch order in synced code, and handlers that cannot outlive their host. A reaction that needs to be conditional branches inside the handler; a reaction that needs to be added later is an `addScript` (§8.1). Note that this survives `addScript` intact: the class and its decorators are still source, so what is deferred is _which host_ gets that handler set, never _what_ the handler set is. Every decorator in this section works on all three script locations; where behavior differs by location it is called out.

### 5.1 Lifecycle & loop

**`@onStart` and `@onEnd` mean "my host came into existence / stopped existing."** One rule, five hosts — which is the same rule as before, now with the host named in the class header instead of inferred from which base class was extended:

| Host        | `@onStart`                                                                               | `@onEnd`                   |
| ----------- | ---------------------------------------------------------------------------------------- | -------------------------- |
| `Entity`    | entity created                                                                           | entity destroyed           |
| `Player`    | this player joined                                                                       | this player left           |
| `Game`      | world setup — joins release at its first `await`; must not assume a player exists (§3.6) | session ended              |
| `Camera`    | session start                                                                            | session end                |
| `HUDScreen` | `hud.open(name)` — screen opened                                                         | `hud.close(name)` — closed |

```ts
@onUpdate         // every simulation tick (default 60 Hz); ctx.dt in seconds
                  // on a ClientScript: display rate instead — see §12.2
```

Game-level roster concerns stay on `@onPlayerJoin`, not `@onStart`.

Prefer declarative forms over `@onUpdate` where one exists — `every(2, ...)`, `moveToward`, `@onEnter`, `camera.follow`. Two hundred entities each running a handler 60×/sec is the one performance cliff a creator can walk off unaided.

### 5.2 Players

```ts
@onPlayerJoin     // ctx.player — optional; avatar and camera spawn without it
@onPlayerLeave    // ctx.player — best-effort only; never the primary save path
```

Both are roster events, so both are **Game-hosted `ServerScript` only** — a load-time error anywhere else. On a Player-hosted script they would be indistinguishable from `@onStart`/`@onEnd`, and the roster is authoritative, so a client's view of it is not a thing to hang a handler on.

### 5.3 Input

```ts
@onEvent('jump')                    // press (default)
@onEvent('jump', { on: 'release' })
@onEvent('moveX', { on: 'hold' })   // every tick while held; ctx.value for axes
```

**One decorator; the argument says what, `on` says which edge.** Phase is never its own decorator — a bare `@onRelease` means nothing on its own, silently degrades to a working press handler if it is dropped or misordered, and has no defined scope when stacked on two `@onEvent`s. `@onEventRelease` / `@onEventHold` exist as thin wrappers that set `on` and nothing else, for text-tier readability; the canonical spelling is the option, and the block tier renders one hat with two dropdowns either way.

**The event name has three kinds, told apart by namespace prefix:**

| Spelling      | Kind                 | Rebindable             |
| ------------- | -------------------- | ---------------------- |
| `'jump'`      | panel-defined action | yes — the default path |
| `'keys:KeyW'` | platform device      | no                     |
| `'damage'`    | creator-sent (§5.8)  | n/a — instantaneous    |

Actions map to bindings; bindings never appear in code. See §7.

A device literal is a deliberate escape hatch, not a shortcut: it opts out of the binding layer entirely, so `input.rebind` cannot reach it, per-player binding sets do not apply, and two local co-op players sharing a keyboard both fire the same handler. The panel warns when a published game contains one, the same way it warns about hover events on mobile (§7.1). Device codes are **physical positions, never characters** — `'keys:KeyW'` is the left-ring-finger key on AZERTY too. Character-level input is text entry, which is out of scope for MVP.

Creator-sent events are delivered by `entity.send(name, payload)` — see §5.8. Release and hold are meaningless for these: an instantaneous event only ever fires `press`, and asking for another phase on a creator-sent name is a load-time error rather than a handler that never runs.

### 5.4 Collision

```ts
@onCollide('player')     // by tag; ctx.other = the other entity
@onEnter('zone-name')    // trigger regions
@onExit('zone-name')
```

We will add bounding box support in the platform's panels. We allow them to be drawn, or have some algorithm auto-detect.

**Contacts are readable, not only dispatchable.** The decorators above are edge-triggered — they answer _"we just touched."_ A creator also needs _"we are touching"_, and that question has no good spelling in an events-only model:

```ts
entity.getTouching(); // Entity[] — everything overlapping me this tick
entity.getTouching('enemy'); // filtered by tag
entity.isTouching('lava'); // boolean; the block-tier spelling
```

The cases the event form serves badly are ordinary ones: _am I still standing on the pressure plate_, _how many enemies are inside my aura right now_, _is anything under me before I drop the platform_. Each is a question about the present state of the world, and answering it with `@onEnter`/`@onExit` means the creator maintains a shadow copy of the contact set — adding on enter, removing on exit, and getting it wrong when an entity is destroyed mid-overlap without ever firing its exit. That bookkeeping is exactly what design rule 4 says the engine owns.

**Why this is not the `@onUpdate` performance cliff.** The engine's collision step already computes the contact set each tick to produce `blocked` and to dispatch `@onCollide`. `getTouching` filters that existing list; it does not run an overlap test. So it costs what reading `blocked` costs, and the §5.1 warning against polling still stands on its own terms — prefer `@onCollide` when you want the _edge_, and reach for `getTouching` when you genuinely want the _level_. The two are not substitutes.

**Semantics**, since a contact query has several defensible readings and creators should not have to guess:

- **Both collider kinds count.** `isTrigger` decides whether you were _stopped_, not whether you are _touching_. A trigger volume appears in `getTouching` and never in `blocked`.
- **Self, parent, and children are excluded.** A body overlaps its own hierarchy by construction, and reporting that is noise in every case we could find.
- **No collider means an empty array**, never `null` — there is no null case to check, matching `game.find`.
- **Order is engine-stable.** Determinism (§1.2) requires consistent iteration order, so the array is safe to read inside a synced script.
- **Static entities are reported individually**, even though §8.2 bakes them into merged collision geometry. The baking is a performance property and stays invisible (design rule: performance properties are not design decisions).
- **It is a real array**, so `.filter`/`.map`/`for..of` work — same contract as `game.find`.

**Relationship to `blocked`.** They answer different questions and both are needed. `blocked` is directional and about _resolution_ — which side stopped me. `getTouching` is identity-bearing and about _overlap_ — who is there. A platformer's `grounded` stays `blocked.down`; _what_ am I standing on is `getTouching()`.

**Blocks:** one block — `isTouching(tag)`, a boolean reporter matching Scratch's "touching ⟨ ⟩?" exactly. `getTouching()` returns an array, which the block tier has no vocabulary for (§13 forbids array indexing), so it stays text-tier only.

**Historical spatial queries: `asSeen`.** A shot fired at what the client saw a send interval ago must be judged against the world as it stood then, not as it stands now — otherwise a target who was under the crosshair when the trigger was pulled is missed because they moved 50ms later, and no amount of prediction fixes it. The spatial queries that resolve against other entities — `find({ near })`, `getTouching`, a future raycast — take an optional `asSeen` flag:

```ts
@onRequest('shoot')
resolve(ctx) {
    const hits = game.find({ near: ctx.data.aim as Vec3, within: 5, asSeen: true });
    for (const e of hits) e.send('damage', { amount: 10 });
}
```

Present-tense is the default and covers every non-shot case. The flag pulls the view tick from the dispatch context, clamps to an engine constant `maxRewindMs` (~250ms), and validates the client's reported tick against the server's own latency estimate for that connection — so no tick arithmetic reaches creator code, and a client cannot claim it saw the world an hour ago. The name is a placeholder; the block tier likely renders this as a panel toggle on the hat rather than a visible argument, matching design rule 5.

**Load-time errors.** `asSeen` on any query in a `SyncedScript` — the ring is server-only, and reading from it in synced code would desync (§1.2). `asSeen` from a handler with no view tick — a `@onUpdate`, a `@onCollide`, a `@onStart` — because "as seen" needs a viewing client, and defaulting to "now" would silently produce a present-tense answer under a name that promised otherwise. Both point at `@onRequest`, which is the input-originated handler that carries a usable tick.

**Reads happen in the past; writes always happen in the present.** The mechanism is one-directional: a query reads a captured buffer and leaves the live simulation running. Nothing can write into a capture, and the flag exists only on the read verbs. See core DESIGN §3 for the invariant and the ring implementation.

### 5.5 Pointer

```ts
@onClick                 // this entity clicked; ctx.player = who clicked
@onHoverEnter            // ctx.player — never fires on touch devices
@onHoverExit             // ctx.player
```

### 5.6 Context object

`ctx` carries **only event data**: `ctx.player`, `ctx.other`, `ctx.value`, `ctx.data`, `ctx.from`, `ctx.dt`, `ctx.alive`. The host is `this.host`; the world is the ambient `game` (§3.4). Long-lived async handlers must respect `ctx.alive`; `sleep` and the timed motion verbs auto-cancel when their host dies.

**`this.host` is the only member `BaseScript` declares** — see §1.1 for why the `entity`, `player`, and `game` members that used to sit beside it are gone.

**`ctx.data` is the payload channel** (§5.8). It is always an object — `{}` for engine events that carry none — so a handler indexes it without a null check, and it is read-only, since a handler mutating it could otherwise signal back to the sender or to handlers dispatched after it. That would be a second, invisible communication path alongside the return value, and one that behaves differently in a synced script than in a local run.

`ctx.from` is the sender entity when there was one. It is deliberately **not** folded into `ctx.other`: `other` means "the entity I collided with", and a damage event sent by a projectile that has already been destroyed would quietly make that word mean something else. Two names, two meanings, both nullable in the cases where they don't apply.

### 5.7 Concurrency

Handlers are async, so a handler can be re-entered before the previous invocation finishes. The canonical break: `@onEvent('attack')` with `await sleep(0.5)` intended as a cooldown fires overlapping attacks when the key is mashed — the code reads correct and only fails under fast input. Since the engine supplies no idempotent round/win methods, every guard is the creator's.

**Three modes:**

| Mode         | Behavior                                                           | Use                                                           |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| `concurrent` | dispatch always                                                    | independent invocations                                       |
| `ignore`     | drop the event if this instance's handler is running               | cooldowns, double-click protection                            |
| `restart`    | cancel the running invocation at its next await point, start fresh | re-aiming, restarting an animation, "go to the newest target" |

```ts
@onEvent('attack', { concurrency: 'ignore' })
@onEvent('aim',    { concurrency: 'restart' })
```

**Defaults are per event type**, because "should this serialize" is a property of the event, not something a creator should reason about in the common case:

| Event                               | Default      | Reason                                                                                                                    |
| ----------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| input `press` / `release`           | `ignore`     | one player, one key — overlap is almost always the bug                                                                    |
| input `hold`                        | `ignore`     | fires every tick while held; would stack 60 copies/sec                                                                    |
| creator-sent (`send`)               | `ignore`     | same reasoning as a press; a send is instantaneous                                                                        |
| `@onUpdate`                         | `ignore`     | a handler slower than a tick must not accumulate                                                                          |
| `@onClick`, `@onPress`              | `ignore`     | a double-click must not double-buy                                                                                        |
| `@onCollide`, `@onEnter`, `@onExit` | `concurrent` | each invocation concerns a _different_ other entity; locking would silently drop the second coin touched on the same tick |

**Locking is per instance, not per method.** The lock lives on the object that owns the invocation — one `Avatar` script instance per avatar, so player 1's cooldown gates only player 1. Attaching it to the method definition instead is the natural lazy implementation and produces a bug invisible in single-player testing: player 1 attacking blocks player 2.

The corollary is an asymmetry worth knowing: a **Game-hosted** script has one instance, so `ignore` there serializes across all players. That is usually right for orchestrator actions and wrong for per-player ones — the host a handler is declared under changes its runtime behavior. An Entity- or Player-hosted script has one instance per entity or per player, which is what makes per-player cooldowns work without the creator arranging anything.

**Panel is the default, code overrides** (rule 5). Blocks get a checkbox on the hat block; text gets `{ concurrency: ... }`. Both compile to the same dispatcher flag, so block-built and text-built games behave identically.

**Why there is no `queue` mode.** `ignore` cannot emulate it — they are opposites, one dropping the event and one guaranteeing it eventually runs. It is cut anyway because "must not overlap _and_ must not drop" is real but narrow, and its uses are already served: sequential dialogue is successive `await entity.say(...)` calls, sequential flourishes are `playEffect` (fire-and-forget, no conflict), and input buffering needs a time window rather than an unbounded queue — deferred to a purpose-built setting. An unbounded queue also has the nastiest failure mode of the candidates considered: a mashing player builds a backlog and the game keeps responding for seconds after they stop.

**Cancellation.** A handler whose host is destroyed is cancelled at its next await point, so any loop containing an await terminates on its own. `ctx.alive` is only needed for loops with no awaitable call in them — and a fully synchronous infinite loop stalls the tick, which an engine watchdog aborts with a creator-visible error rather than hanging the server.

### 5.8 Sending events

An entity is addressable. `send` fires a named event at **that entity's** handlers — the `@onEvent` methods on every script attached to it, including an avatar's movement class:

```ts
enemy.send('damage', { amount: 10 }); // fire and continue
await door.send('open'); // wait for the handlers to finish
this.host.send('respawn'); // an entity can address itself
```

```ts
class Enemy extends SyncedScript<Entity> {
    @serverState health = 3;

    @onEvent('damage')
    hurt(ctx) {
        this.health -= ctx.data.amount;
        if (this.health <= 0) this.host.destroy();
    }
}
```

**This is direct address, not a broadcast.** There is no game-wide event bus in the MVP, and that is the whole design decision. A bus needs a subscription registry, a delivery-order rule, and an answer for handlers on entities that no longer exist — and it invites the pattern where the way to find out what handles an event is to grep the project. `send` has a receiver in the call, so the reader of `enemy.send('damage')` knows where to look. Fan-out is an ordinary loop over `game.find` or `game.players`, which stays visible at the call site:

```ts
for (const e of game.find({ tag: 'enemy', near: { of: blast, within: 200 } })) {
    e.send('damage', { amount: 25 });
}
```

**Dispatch is synchronous; the promise is for sequencing.** Every matching handler is invoked before `send` returns and runs up to its first `await`. A handler with no `await` in it — the common case, and the only case the block tier can express — has therefore _finished_ by the time the next line runs, so its `@serverState` writes are immediately readable:

```ts
crate.send('break'); // no await
crate.alive; // already false if the handler destroyed it
```

The returned promise settles once every handler has run to completion, so `await enemy.send('damage')` is how you wait out a handler that itself awaits — a hit reaction that glides and flashes before you check whether the enemy died. Both forms deliver identically; `await` only changes what _you_ do next. This is the same shape as the timed motion verbs (§9.1), where calling without `await` is equally valid.

There is no return value. A handler answers by writing `@serverState` the sender can read, which keeps the block tier — where nothing returns — expressible, and keeps a multi-handler send from needing a rule about whose answer wins.

**Payload semantics**

- The payload is an object of named values, and it arrives **unwrapped** as `ctx.data`: `send('damage', { amount: 10 })` reads as `ctx.data.amount`. One flat object of labeled slots is exactly what the block tier can render, and it matches how `SoundOptions` already works.
- **Plain values and references only** — numbers, strings, booleans, `Vec3`, `Entity`, `Player`, and arrays/objects of those. No functions and no closures: a payload has to survive being replayed by the client's reconciliation and being sent from a Game-hosted script, and a closure captures scope that only exists on one machine. Rejected at load time where it is statically visible.
- **Omitting the payload gives `{}`**, never `undefined` — same no-null-case rule as `getTouching` and `game.find`.
- The payload is a **message, not shared state.** The receiver sees a read-only view; nothing a handler writes to `ctx.data` reaches the sender. State that outlives the event is `@serverState`.

**`send` runs at the location of its caller**, like the code around it. From a `SyncedScript` it runs on client and server from the same source, so the event needs no replication at all — both machines send it themselves, on the same tick, in the same order (§1.2). From a `ServerScript` it runs server-side only, and its effects reach clients as ordinary state replication. From a `ClientScript` it reaches only that machine's client-side handlers, and cannot reach authoritative state — which is the trust boundary doing its job rather than a special case for `send`. This is why the payload restriction exists: whatever crosses a `send` must be reproducible on the client from data the client already holds.

**Edge cases**, stated so they aren't guessed at:

- **Sending to a dead entity is a no-op** that resolves. Projectile-hits-already-destroyed-enemy is the ordinary case, not an error to handle.
- **An entity with no handler for the name is also a no-op.** Sends are addressed by name, and requiring a receiver would make every send site know the target's script list.
- **Multiple handlers for one name all fire**, in attachment order (engine-stable, per §1). On an avatar, two scripts and the movement type can all answer `'damage'`.
- **Handlers at a location the sending machine isn't run don't fire there.** A `ServerScript`'s `@onEvent('damage')` runs only on the server, so a client re-producing a synced `send('damage')` dispatches to the synced handlers it holds and not to the server-only one — which the server runs itself, on the same tick. This is the one place the grid shows up in `send`, and it falls out of §1: each handler runs where its own class says it runs.
- **Concurrency defaults to `ignore`**, matching a key press: a send is instantaneous, and overlapping invocations on one instance are almost always the bug (§5.7). Override per handler as usual.
- **Recursion is bounded.** A send chain that re-enters the same handler is cut off at an engine depth limit with a creator-visible error, the same way the tick watchdog handles a synchronous infinite loop.
- **Names share the namespace with panel actions.** The panel rejects a send name that collides with a declared action, so `@onEvent('jump')` never has two unrelated sources.

**Blocks:** one block — send ⟨event⟩ to ⟨target⟩ with labeled payload slots — plus the existing `@onEvent` hat, which needs no change: the payload reads as a `ctx.data` reporter in the same shape as `ctx.value`.

### 5.9 Receiving requests

`@onRequest(name)` is the server-side entry point for client code (§1, §12.6). It is the **only** one, and it is a separate decorator from `@onEvent` for exactly that reason: the trust boundary should be a word you can search for.

```ts
class Roster extends ServerScript<Game> {
    @onRequest('ready')
    ready(ctx) {
        ctx.player.isReady = true; // @serverState; replicates back
        if (game.players.every((p) => p.isReady)) this.begin();
    }
}
```

**Where it may be declared: on a `ServerScript`, and nowhere else.** That is now the whole rule, on any host — `<Game>` for session and roster actions, `<Player>` for a request about the asker (spend my coins, change my loadout), `<Entity>` when it concerns one entity (a shopkeeper NPC), `<Camera>` if a client asks for a server-driven cutscene. On a `ClientScript` it is a load-time error, because that would be a client handling its own request. On a `SyncedScript` it is a load-time error, because a client cannot predict a decision whose whole purpose is to be checked.

**This replaces a three-clause rule with one word**, and the simplification is worth noting because it is representative. The previous design had to say: declarable on `Game`; also on `Script`; not on `UI`; not on `BaseMovement`; and — the awkward part — **"a request handler always runs server-only, even on a `Script`,"** an explicit carve-out from "`Script` code is predicted," with the load-time determinism pass treating one method body differently from its siblings in the same class. A creator reading a `Script` had to know that one decorator changed which machine a method ran on. Now the location is declared on the class, `@onRequest` never overrides it, and the class that may hold one is named `ServerScript`. Nothing about the trust boundary changed; the number of rules describing it went from five to one.

A corollary: a server-only decision _about_ an entity now has a home whether or not a client asks for it. `ServerScript<Entity>` covers both the requested case (`@onRequest('buy')` on a shopkeeper) and the unrequested one (a loot roll that reads storage on death) with the same class, where previously the second had no legal spelling and got written as an `@onRequest` nobody sent.

**`ctx` for a request:** `ctx.player` is the requesting player, engine-supplied and unforgeable. `ctx.data` is the payload, read-only and **untrusted** — this is the one `ctx.data` in the API that came from outside the program. `ctx.from` is `null`; there is no sending entity.

**Semantics**, stated so they are not guessed at:

- **No return value**, matching `send`. The answer is replicated `@serverState`.
- **Concurrency defaults to `ignore`**, per instance, matching a press (§5.7). Note the §5.7 asymmetry applies with force here: a Game-hosted handler has one instance, so `ignore` serializes across all players. For a per-player action that is usually wrong — declare `concurrent`, or move the handler to a `ServerScript<Player>`, which has one instance per player and is the better fit for a per-player request anyway.
- **An unhandled request name is dropped silently** on the server and logged to the creator's dev console. A client asking for something the game does not implement is the ordinary case during development, not an error worth crashing on.
- **Rate limits are engine-owned** and per (player, name). Exceeding them drops the request; it never queues.
- **Requests are validated by the creator.** The engine guarantees identity and rate, nothing about meaning. The panel's linter flags an `@onRequest` handler that writes `@serverState` without reading `ctx.player` or any guard, because "forgot to check" is the predictable failure and it should be caught in the editor.

**Blocks:** none. Requests are text-tier only (§12.8).

---

## 6. State & data

### 6.1 Variables

**One decorator. Scope is the host of the script you declare it on** — there is no `@playerState`, no scope argument, nothing to choose. The location decides trust; the host decides scope.

**The name says where the value lives: on the server.** `@serverState` declares a property the server owns, replicates, _and_ persists — a decorated value is checkpointed by the platform and comes back on the next session without the creator asking. There is no second decorator for durability, because "authoritative" and "survives the session" turned out to be the same set of values in every game we wrote.

```ts
class Rules extends ServerScript<Game> {
    @serverState timeLeft = 60; // global — one value, replicated to everyone
}

class Wallet extends ServerScript<Player> {
    @serverState coins = 0; // per-player — one per player, replicated to that player
}

class Goblin extends SyncedScript<Entity> {
    @serverState health = 3; // per-entity — one per instance
}

class PlatformerMovement extends BaseMovement {
    @serverState coyoteTime = 0; // per-entity — movement is Entity-hosted (§4.1)
}
```

| Host          | Scope                         | Replicated to                                                                          | Persisted as           |
| ------------- | ----------------------------- | -------------------------------------------------------------------------------------- | ---------------------- |
| `<Game>`      | one value for the whole game  | everyone                                                                               | one game record        |
| `<Player>`    | one value per player          | that player                                                                            | that player's record   |
| `<Entity>`    | one value per entity instance | everyone (scoped entities: their owner); also readable by the panel's animation config | that instance's record |
| `<Camera>`    | **not permitted**             | camera is client-owned presentation — use a plain field                                | —                      |
| `<HUDScreen>` | **not permitted**             | — use a plain field; see §12.2                                                         | —                      |

Two changes from the previous table, both consequences of splitting host from location:

- **The `BaseMovement` row is gone**, because movement is Entity-hosted like any other entity script. It used to need its own row to say "per-entity instance, and also visible to the animation config" — the second half is true of all Entity-hosted `@serverState`, and always was. Note that this hoists onto the _avatar_, so `coyoteTime` is `player.avatar.coyoteTime` even though the movement class itself is reached as `player.movement`: the accessor is a Player-side convenience (§3.2) and does not move the host.
- **The last two rows are the trust boundary showing up in the state model.** A `ClientScript` may not declare `@serverState` on any host, since there is no scope in which replicating a client's belief would be correct; that is a property of the _location_. Camera and `HUDScreen` additionally reject it from _any_ location, because they are one player's presentation and a per-camera authoritative value is a contradiction. So `ServerScript<Camera>` may hold a cutscene's own fields, but not replicated ones.

**`@serverState` is hoisted onto the host**, which is what keeps declaration site and access site in agreement: `@serverState coins` on a Player-hosted script is read as `player.coins` from anywhere. This is what removes `Map`, ID keys, and null checks from creator code — a player object _is_ the identity, and the variable is a real property on it.

Hoisting is load-bearing rather than cosmetic. `ctx.player.coins += 1` inside a coin's collision handler, and the §5.8 rule that a handler answers by writing `@serverState` its sender reads, both require that the value live on the host and not on the script instance that declared it. Inside the declaring script `this.coins` is that same value, not a copy.

Two rules follow, both load-time:

- **Names are unique per host.** Two scripts on one player both declaring `coins` is an error, not a merge and not a shadow. This is the cost of hoisting, and it is the right trade: the alternative is `player.scripts.wallet.coins`, which is nesting the block tier cannot express and a lookup every read pays for.
- **Persistence is not opt-in.** Every `@serverState` property is checkpointed on the host it hoisted onto; there is no `@persist` to remember, and no way to declare authoritative state that silently evaporates. A value that genuinely should not outlive the session is a plain field on the server script — which is also the value that did not need replicating.

**Typing the hoisted property is unresolved**, and it is the same open question as the movement cast in §4.1: only the panel knows which scripts are attached to which host, so `player.coins` is well-typed inside `Wallet` and untyped through a plain `Player` reference. The candidate answers are the same three — make `Player`/`Entity` generic over what they host, have the panel emit typed accessors per template, or accept the cast. Whichever we pick should cover both cases; they are one problem wearing two hats. The block tier is unaffected, since a block reads "player's ⟨coins⟩" off a dropdown the panel populates.

### 6.2 Wrappers

Each wrapper hides a data structure **and** its platform plumbing. MVP set is capped at six; more go to an advanced drawer.

```ts
new Leaderboard({ order, persist }); // sorted, persistent across sessions
new Storage(player); // key/value, persistent
new Countdown(seconds, onZero?); // server-ticked, replicated; onZero fires at 0
new Team(name); // player grouping; scores, spawns
```

**The four stateful wrappers — `Scoreboard`, `Leaderboard`, `Inventory`, `Team` — share an exported base, `StatefulWrapper`.** A field holding one is authoritative _without_ a `@serverState` decorator, because the wrapper's own methods mark the replication channel; the base is what makes "is this field replicated state" an `instanceof` rather than a class-name list, and what a creator subclass inherits its marking from. The base declares three engine-only members — `bind(record, fieldName)` (called by wiring, throws if bound twice), `serialize`, and `restore` — which supply the identity a wrapper lacks when it is constructed as a field initializer, before any host exists. `Countdown` and `Storage` stay outside it: a countdown is derived from its clock, and `Storage` is the key-value escape hatch rather than replicated state. Creator code never calls the three engine members; it only sees the domain methods. See core DESIGN §4.

**`Countdown` takes an optional `onZero` callback** rather than firing `@onEnd`. `@onEnd` is a _host_ lifecycle decorator ("my host stopped existing"), and a `Countdown` is not a host, so `new Countdown(s, onZero)` is how a creator reacts to it reaching zero (core DESIGN §4).

```ts
scores.add(1); // defaults to the acting player in a player-context handler
scores.add(1, player); // explicit
scores.of(player);
scores.top(3);
scores.reset();
```

### 6.3 Persistence

Declarative and automatic, with nothing to declare: **`@serverState` _is_ the persistence mechanism.** The decorator that makes a value authoritative is the same one that makes it durable, so the platform checkpoints every server-owned property against its host — game, player, or entity instance — and restores it on the next session. `persist: true` on `Leaderboard` remains, because a leaderboard is a wrapper rather than a decorated property.

`Storage` is the explicit escape hatch, for values that want a key rather than a property: blobs, large records, anything read on demand instead of replicated continuously. Leave handlers are never the primary save path.

---

## 7. Input & actions

Actions are **named intents**, bound to devices in the panel and rebindable at runtime. Actions are also the network protocol — clients send `{player, action, value}`, not keycodes.

```ts
{ moveX: ['keys:KeyA/KeyD', 'gamepad:leftStickX'],   // axis, -1..1
  jump:  ['Space', 'gamepad:a'] }                    // button
```

```ts
player.input.rebind('jump', ['KeyK']);
player.input.addBinding('jump', 'gamepad:b');
player.input.getBindings('jump'); // for creator-built settings screens
player.input.resetBindings('jump');
input.setContext('menu' | 'gameplay'); // action groups; resolves conflicts
```

Bindings are **per-player** (local co-op works) and persist through the storage layer automatically.

### 7.1 Cursor

Every player has a cursor. Position is a _state_ the game can read; clicks are ordinary **actions** (`mouse:left` is just another binding), so there is no separate click API.

```ts
player.cursor.position; // Vec3, world space — what games almost always want
player.cursor.screenPosition; // Vec3, screen space — for HUD hit-testing
player.cursor.over; // Entity | null — what it is hovering
player.cursor.isDown; // convenience mirror of the primary click action
player.cursor.visible = false; // hide the OS cursor (custom reticle games)
player.cursor.setIcon('crosshair' | 'hand' | assetKey);
player.cursor.lock(); // pointer lock; relative movement only
player.cursor.unlock();
```

Entity-level events cover the common cases without touching coordinates at all:

```ts
@onClick          // this entity was clicked; ctx.player = who clicked
@onHoverEnter     // ctx.player
@onHoverExit      // ctx.player
```

**Semantics**

- **World space is the default.** `position` is already projected through that player's camera, so a creator never converts between spaces or accounts for zoom and scroll.
- **Cursor is per-player and private by default.** One player's cursor is not visible to others. Sharing it (drawing games, co-op pointing) means spawning an entity that follows it — an explicit, replicated choice.
- **Cursor position arrives as tick-indexed input**, like actions, and is rate-limited independently of `sendRate` (default 20 Hz). It is not replicated at simulation rate; aiming that must feel frame-tight belongs to a synced script reading the local cursor.
- **`over` is engine-computed** using the same collider data as collisions, respecting `layer` order. It is `null` over empty space.
- **Touch devices have no hover.** On touch, `position` follows the last touch point, `isDown` is true while touching, `over` is only non-null during a touch, and `@onHoverEnter`/`@onHoverExit` never fire. Games that depend on hover must have a touch fallback; the panel warns when hover events exist in a game published to mobile.
- **Determinism:** cursor is client-owned input, so a synced script may read the local player's cursor but not another player's. A `ClientScript` reads `this.localPlayer.cursor` without restriction — it is on the machine that owns it, and `screenPosition` is exactly what HUD hit-testing needs.

**Blocks:** four blocks — cursor x, cursor y, when I am clicked, when cursor touches me — matching Scratch's "mouse x / mouse y / when this sprite clicked" vocabulary.

---

## 8. Assets, templates & world building

**Asset** = data (texture, atlas, audio buffer, font, clip, effect). Loaded once, shared, referenced by string key, immutable. A first-class object — see §3.5 for why, and for the key-or-object rule every asset-taking API follows.
**Template** = a panel-authored, pre-configured entity: sprite + collider + scripts + sounds. Data, not a class; spawned by string key.
**Entity** = a live instance in the world.

**Three artifacts are picked rather than written, and this doc has to keep them apart.** That shared quality is why one word kept drifting across all three — but they are different artifacts with different lifetimes, and conflating them produces code that references classes we do not ship:

| Kind               | What it is                                                                  | Named by                    | Example                                          |
| ------------------ | --------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------ |
| **Template**       | A configured entity, spawnable by key                                       | string                      | `game.spawn('coin', x, y)`                       |
| **Prebuilt class** | A real class we ship, attached in the panel and reachable in code           | identifier                  | `PlatformerMovement`, `Inventory`, `Leaderboard` |
| **Starter**        | Pre-written sample code for a genre — a whole small game, copied and edited | prose only, never an import | "the platformer starter", "the top-down starter" |

Only the middle row is API surface. A template is data, and a starter is example code that gets copied into the creator's own project — neither is something code can name. **"Template" means the first row and only the first row** — a configured entity spawned by key. The other two are always **prebuilt class** and **starter**, never "template".

Loading is a panel/preload concern. `game.spawn('coin', x, y)` is synchronous and always safe.

### 8.1 The template tray

**The editor shows a tray of templates beneath the game window**, and it is deliberately the same affordance as Scratch's sprite list: a strip of thumbnails, one per template in the game, where selecting one loads its configuration — sprite, collider, animation config, sounds, scripts — into the inspector. The position is doing work. A creator's attention is on the running game, and templates are what they reach for next, so the two sit adjacent rather than one behind a navigation step. What the tray edits is exactly the first row of the table above: data, spawned by key.

**It auto-populates with the Player template.** A new project has one template in the tray before the creator does anything, and it is the avatar. That is not a starter's doing — it falls out of §3.6, where the engine spawns the avatar, attaches its camera, and attaches its scripts with no join handler written. Those defaults have to live on a template that exists from the first frame, so the tray shows it, and pressing play in an empty project gives a controllable body. Every other template is the creator's.

That also settles what the tray is a view of. It lists templates, so the Player template appears there and `Camera`, `Game`, and `HUDScreen` do not — those are single objects with inspectors of their own, not things a creator spawns copies of.

**Attaching a script to a template is a drop, and that is the primary path** (design rule 5). The two paths are not alternatives so much as different scopes:

| Path                                     | What it attaches to                 | Wired                                           |
| ---------------------------------------- | ----------------------------------- | ----------------------------------------------- |
| **Drop the script on a template** (tray) | every instance ever spawned from it | at load time, before any `@onStart` runs        |
| **`host.addScript(Class)`**              | the one live host the call names    | on the call; `@onStart` has run when it returns |

**Anything on a template is connected automatically at load time.** The engine reads each template's script list when the world is built and attaches an instance of every class on it to every entity spawned from it, before `@onStart` runs anywhere. There is no registration call, no import-for-side-effect, and no export scanning (§3.2). The tray is the manifest, and it is a manifest a creator can _see_ — "why is this script running" is answered by selecting the template rather than by grepping the project for a subscribe call, which is the same argument that kept `send` a direct address instead of a bus (§5.8).

**This is what §5's load-time guarantees rest on.** The set of script _classes_ is the project's source, so it is known before the world runs whichever path attached them: every location check in the grid (§1.1), every determinism violation (§1.2), and every `@serverState` name collision (§6.1) is decided at load time either way. What the tray adds is that the common case is statically known _per host_ too, so the panel can tell a creator that two scripts on the `coin` template both declare `health` before they press play. `addScript` cannot be checked that early, so a collision it would introduce is reported when the call runs.

Semantics for `addScript`, stated so they aren't guessed at:

- **It affects one host, never the template.** `coin.addScript(Sparkle)` sparkles that coin; the next `game.spawn('coin')` has no sparkle. There is deliberately no code path that edits a template — a template is panel-authored data, and a runtime API that rewrote it would make "what does this template do" unanswerable from the editor.
- **`@onStart` runs during the call**, since the host already exists. This is the one place `@onStart` reads as "my script came into existence" rather than "my host did" (§5.1). It is the meaning a creator wants; an initializer that silently never fired would be worse.
- **Adding a class the host already has is a no-op.** A second instance would declare the same `@serverState` names on one host, which §6.1 makes an error — so a no-op is what keeps `addScript` safe to call from a handler that may run twice.
- **The location grid still applies**, decided by the added script's own base class. A `ClientScript` added from client code runs locally and stays local. Adding a `SyncedScript` or `ServerScript` from a `ClientScript` is a load-time error like every other client-side write (§1.2): it would be a client injecting simulation.
- **A synced `addScript` reaches both machines by construction**, since synced code runs on client and server from the same source and both add it on the same tick. A branch guarding one has to be deterministic like any other synced branch.
- **Removal is not in MVP.** There is no `removeScript`. A behavior that turns off is a flag the script reads, or `enabled` on a movement class; a script whose lifetime is genuinely shorter than its host's is rare enough to wait for a real case.

**Blocks:** none, and that is the point. The tray is where a beginner attaches behavior — pick the template, drop the script — so the block tier needs no attachment vocabulary at all. `addScript` is text-tier only.

### 8.2 Static geometry

Levels are built from ordinary entities. Entities with no scripts at all — movement included, since movement is a script — are **inferred static** by the engine and baked into merged render batches and merged collision geometry; they replicate once on spawn and are excluded from per-tick diffing. Folding movement into the script model makes this test simpler than it was: one condition instead of two. A moving platform is not static because it carries the script that moves it (§4.1), which is the same condition and needs no special case.

This is genre-neutral — a wall, a painted platform, a hand-drawn rock, and a decorative tree get identical treatment. There is no tilemap, no grid, and no cell addressing in the API. Panel authoring tools (freeform placement now; brush/shape tools later) are UI features that _produce_ static entities; code only ever sees entities.

`static` is never set by creators. It is a performance property, not a design decision.

### 8.3 Regions

Named rectangles/polygons authored in the panel. They eliminate coordinate math:

```ts
random.pointIn('sky')
game.find({ in: 'arena' })
@onEnter('lava-pit')
```

### 8.4 Generation & streaming

Panel-authored **chunk templates** are the only supported path: a designer builds a level segment visually, code stitches segments together. Power users compose chunks with raw TS (loops, `random.*`, their own noise functions) — the engine provides no procgen system beyond `spawn`.

**Streaming is a script, not an engine feature.** `scene.stream({ ahead, behind, next })` is gone along with `Scene`. A game that generates its world as the player advances writes an ordinary Game-hosted script that spawns ahead of the frontier and destroys behind the tail — the same way Unity leaves chunk streaming to a MonoBehaviour rather than owning it:

```ts
class Terrain extends ServerScript<Game> {
    chunks = ['chunk-flat', 'chunk-gap', 'chunk-spikes'];
    width = 800; // panel knob
    @serverState frontier = 0;

    @onUpdate
    step() {
        const lead = Math.max(...game.players.map((p) => p.avatar.position.x));

        while (this.frontier < lead + 2400) {
            game.spawn(random.pick(this.chunks), this.frontier, 0);
            this.frontier += this.width;
        }

        for (const c of game.find({ tag: 'chunk' })) {
            if (c.position.x < lead - 1600) c.destroy();
        }
    }
}
```

That is a dozen lines a creator can read, tune, and break the rules of — a boss chunk every tenth spawn, a difficulty ramp, a chunk that depends on the previous one's exit height. The engine's version could express none of those: `next: () => string` handed back a key and nothing else, and `ahead`/`behind` were the only knobs.

**What the engine gives up, and what it keeps.** It stops owning frontier/tail computation across all players — the script does that, and the `Math.max` above is the creator's own decision about what "the frontier" means with several players spread out. It keeps the two properties that actually needed engine support: entities spawned with no scripts are still auto-static and baked (§8.2), and per-player snapshot sizing is still engine-owned, because both are performance properties rather than design decisions. Those were the load-bearing halves of `stream`; the loop was not.

The cost is that an endless runner is no longer three lines, and a creator who writes the loop badly (spawning every tick, never destroying) has a leak the old API prevented by construction. The mitigation is §13's drawer: a prebuilt `ChunkStreamer` script with `ahead`/`behind`/`chunks` as panel knobs, which is the same convenience without the engine concept — and which a creator can open and edit, unlike `scene.stream`.

`random` is **seeded** (`random.seed(n)`), enabling shareable/daily levels and reproducible debugging.

---

## 9. Time

```ts
await sleep(seconds);
every(seconds, fn); // repeating timer; auto-cancels with entity
after(seconds, fn);
await entity.glideTo(x, y, 1); // timed motion is awaitable; see §9.1
```

Durations are in **seconds** everywhere in the public API.

### 9.1 Timed motion and `tween`

The public surface is the closed set of named verbs listed in §3.1 and §3.3 — `glideTo`, `glideBy`, `fadeTo`, `fadeOut`, `fadeIn`, `growTo`, `spin`, `spinTo`, `camera.glideTo`, `camera.zoomTo`. Each is one block with literal slots.

`tween(entity, props, seconds, easing)` is their **shared implementation and the advanced escape hatch only**. It is not in the block palette, not in the beginner docs, and not counted against the palette budget. It exists for properties the named verbs don't cover and for animating custom `@serverState` numbers. Do not re-expose it in the palette.

Everything built once for `tween` is inherited by every verb:

- **Cancellation** — in-flight motion aborts when its entity is destroyed; pending awaits resolve silently. A cancelled tween leaves the property at its current value, not the target.
- **Awaitability** — resolves on completion; calling without `await` runs it in the background and is equally valid.
- **Easing** — one implementation, optional trailing argument, panel default.
- **Replication** — mutates replicated state at simulation rate, broadcast at replication rate; clients interpolate. Defined once, so every verb is smooth automatically.
- **Conflict resolution** — two timed motions on the same property: last one wins, cancelling the first.

**Keep the verb list closed.** Each new verb costs a palette slot. Anything beyond this set belongs in the advanced drawer or is a `playEffect` cosmetic rather than a state tween.

`await` is legal in every handler (all handlers are async by default) and is inserted automatically by the block→code generator. The awaitable surface is deliberately tiny: `sleep`, the motion verbs, storage reads, and `entity.send` (§5.8 — where the await is for sequencing, since delivery has already happened).

**State animation vs. cosmetic effect:** timed motion verbs mutate replicated state at simulation rate (clients smooth it). Purely visual flourishes use `playEffect` and never touch the network.

---

## 10. Audio

```ts
sound.play('coin')                             // everyone
sound.play('coin', { at: entity })             // positional
sound.play('coin', { for: player })            // per-player scope
music.play('theme', { loop: true, fade: 1 })
sound.stop(handle) / sound.volume = 0.5
```

Asset vs. instance split: `play()` returns a handle representing one playback.

---

## 11. Math primitives

No creator should compute a coordinate. Beginner surface:

```ts
random.between(a, b) / random.pick(list) / random.chance(0.3) / random.pointIn(region);
entity.distanceTo(target) / entity.faceToward(target) / entity.moveToward(target, speed);
oscillate(entity, 'y', amount, seconds); // replaces Math.sin
orbit(entity, center, radius, speed);
clamp(v, min, max) / lerp(a, b, t);
```

`Vec2`/`Vec3` exist in the text tier and underpin everything, but block-facing operations always have a decomposed or directional spelling (a prebuilt class's `pushUp(420)`, separate x/y slots).

### 11.1 `packages/math`

**Everything pure lives in `@platform/math`, and nothing else does.** The creator-facing import is unaffected — `clamp` and `Vec3` are reached from `@platform/engine` like the rest of the API, because a creator has one import and the tier ladder does not need a second one. The split is internal, and it is about which package a line of arithmetic is written and tested in. Pure is not the same as creator-facing: the storage primitives that live here too — generation-packed handles, `SlotTable`, the typed-array growth helpers, `finiteOr`/`positiveOr` — are engine-internal and deliberately absent from `@platform/engine`'s re-export.

**The test is whether a declaration mentions an engine object or panel-authored data.** If it does not, it is math:

| In `@platform/math`                                                            | Stays in the engine packages                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `Vec3`, `Bounds`, and their operations                                         | `Entity.distanceTo`, `faceToward`, `moveToward`                    |
| `clamp`, `lerp`, `approach`                                                    | `oscillate`, `orbit`, `tween`                                      |
| `Easing` and the curve for each name                                           | the timed motion verbs that take an easing                         |
| the seeded generator: `seed`, `between`, `pick`, `chance`                      | `random.pointIn`, which resolves a region name first               |
| viewport arithmetic — position + zoom + window size → `Bounds`                 | `camera.viewport`, which knows the window size                     |
| generation-packed handles, the slot table and its freelist, typed-array growth | `EntityTable`/`NodeStore` lifecycle, and the SoA stores they index |

The right-hand column is what makes the left-hand column a package rather than a file. Each entry on the right takes an `Entity` or a `Camera`, writes replicated state, and gets cancelled when its host dies — so it is engine lifecycle wrapped around a curve, and the curve is the part that moved. `oscillate` keeps its `every`-tick bookkeeping and hands the sine to math. This is the same shape as the `blocked`/`getTouching` division in §5.4: the interesting boundary is not "is it geometry" but "does it own anything."

Three reasons this is worth a package boundary rather than a `math.ts` in `core`:

- **Determinism is a property of arithmetic** (§1.2). A synced script diverges because two machines computed different numbers, so the easing tables, the force accumulator drain, and above all the seeded generator are exactly the code a desync gets traced to. Isolating them means the determinism-critical surface is a package a reader can hold in their head, and one whose tests do not need a world, a clock, or a network to run.
- **It is the leaf of the package graph.** `@platform/math` depends on nothing — not on `core`, which owns `Entity`. Every other package may depend on it, including `core`, `renderer` (viewport and layout arithmetic), `server` (collision resolution), and `client` (interpolation between snapshots). Interpolation is the case that settles it: the client tweens between two snapshots using the same `lerp` the server's tween verbs advance with, and a shared `lerp` is the reason those two agree.
- **Design rule 3 needs somewhere to put its answers.** "If a creator writes `Math.*` to do something common, a primitive is missing" is a rule that generates functions, and they accumulate — `approach` arrived with `BaseMovement`, `viewport` with `Camera`. A named home means adding one is a decision about math rather than a decision about which engine package to wedge it into.

**Blocks are unaffected.** `clamp` and `lerp` are already in the palette (`clamp` at beginner tier) and stay there; a block does not know which package generated its slot, and the palette budget in §13 counts the same either way.

### 11.2 `Math` is not deterministic, so math replaces it

§1.2 makes determinism a hard requirement for `SyncedScript` and then names one violation: `Math.random`. That list was too short. **ECMA-262 leaves the transcendental functions implementation-approximated**, so two V8 versions — or the same version on two architectures — may return results differing in the last bits. That is not a hypothetical: a client and server disagreeing by one ULP on a bullet's angle diverges visibly within a second of compounding, and it surfaces as rubber-banding a creator cannot debug and we cannot reproduce.

`Math.random` is a different failure and the easier one. It is not approximated; it is genuinely unseeded, so the two machines were never going to agree. The seeded stream (§8.4) already replaces it.

**The approximated set, all of which `@platform/math` must implement:**

| Group         | Members                                        |
| ------------- | ---------------------------------------------- |
| Trigonometric | `sin` `cos` `tan` `asin` `acos` `atan` `atan2` |
| Hyperbolic    | `sinh` `cosh` `tanh` `asinh` `acosh` `atanh`   |
| Exp / log     | `exp` `expm1` `log` `log1p` `log2` `log10`     |
| Power / other | `pow` `cbrt` `hypot`                           |

**What stays safe, so the ban is narrow rather than a blanket.** The arithmetic operators and every function that reduces to an exact IEEE-754 operation agree bit-for-bit on every target: `abs`, `sign`, `min`, `max`, `floor`, `ceil`, `round`, `trunc`, `fround`, and `sqrt` — which is correctly rounded and a hardware instruction everywhere we run. So the seed-sprint and battle-royale samples reaching for `Math.max`, `Math.min`, `Math.floor` and `Math.ceil` are fine as written; the two `Math.cos`/`Math.sin` calls in `shot.ts` are the kind of line this section exists to catch.

**Three notes that decide whether the rule actually holds:**

- **`**` is `Math.pow`.** Banning the method while `x ** 2` compiles catches nothing, and the operator is the spelling a creator reaches for. Both are linted.
- **`hypot` is approximated even though `sqrt` is not**, which is the one entry that looks like it should be safe. Implement it as `sqrt(x*x + y*y)` — deterministic, and faster than the built-in. The honest cost: the built-in scales its inputs to avoid intermediate overflow, and this does not. For world coordinates in pixels the squares are nowhere near the exponent limits, so the trade is free at our magnitudes and would not be for a physics engine in SI units.
- **Only a handful are load-bearing.** `sin`, `cos`, `atan2`, `pow`, `exp` and `log` cover what games ask for. The rest are either derivable from those (`tan`, `log2`, `log10`, the hyperbolics) or absent from the palette entirely — so "implement 22 functions" is really "implement six carefully and derive the others", and an unused entry may simply be missing until something needs it.

**Enforcement is the same two-tier story as the rest of §1.2.** The load-time pass rejects an approximated call inside a `SyncedScript`; the linter flags it project-wide with the `@platform/math` replacement in the message, since a `ServerScript` calling `Math.sin` is legal but is usually a creator who did not mean to opt out of the shared implementation. A `ClientScript` is exempt like it is for `Math.random` (§1.2) — nothing it computes leaves the machine.

**Blocks never meet this.** No palette block emits a transcendental call; `oscillate` and `orbit` (§11) exist precisely so a beginner never writes `Math.sin`, which is design rule 3 having already answered this question for the block tier.

---

## 12. HUD & UI

**UI runs on the client**, as `ClientScript<HUDScreen>`. This was the first place the client/server boundary was drawn, because UI is where hiding it cost the most: a menu that waits a round trip to highlight a row feels broken, and no amount of prediction fixes it. It is no longer the _only_ place — §1.1's grid opens the client side to entities, players and cameras too — but it is still the case that motivates the whole arrangement.

Two things are still true from the previous design and are load-bearing: **layout stays in the panel**, because layout is nested and §13 forbids nesting; and **widgets are named**, because a name is what a block can hold. What changes is that the code reacting to those widgets runs locally, may hold its own private state, and may respond instantly.

### 12.1 Model

**`HUD` is a fundamental object** (§3), one per player, reached as `hud` from any `ClientScript`. It owns two things: the always-on widget layer, and every panel-authored `HUDScreen`, which it opens and closes.

- A **widget** is a named element placed in the panel: a text label, a bar, an icon, a button, a timer, a list.
- A **`HUDScreen`** is a named set of widgets in a layout — a pause menu, a shop, an inventory, or the always-on gameplay overlay. Many per player; the `HUD` holds them all.
- Placement is a **named anchor** plus panel-authored offset within it — never coordinates in code.
- Widgets are **per-player by construction** now, not by convention: `hud` resolves to the local player's HUD, so there is no other player to accidentally address.
- Widgets are **screen space**, never world space. Bubbles above entities are §3.7's job, not the HUD's.

Anchors: `top-left`, `top-center`, `top-right`, `middle-left`, `center`, `middle-right`, `bottom-left`, `bottom-center`, `bottom-right`.

**Why `HUD` is an object and not a bare namespace.** It was a module-level object literal of nine widget verbs, and two questions had no answer: which screen `hud.text('title', …)` addressed when two screens both had a `title`, and how anything opened a screen it was not already hosted on. Making the HUD an object answers both in one place — it is the namespace widget names are unique within, and it is the thing that holds the screen list. That is design rule 3 read backwards: the creator was going to reach for a manager, so the manager is named.

**Why `HUDScreen` and not `Screen`.** `Screen` reads as the display, and there is one display but many of these. `Panel` is the obvious alternative and is taken (a panel is the editor). The prefix also makes the pair legible in a class header: `ClientScript<HUDScreen>` says what kind of thing is being scripted, where `<Screen>` invited the reading that a game has one.

**`HUD` is an object but not a host** (§1.1). A script wants either a screen's lifecycle or the session's, and `hud` is ambiently reachable from both, so a `ClientScript<HUD>` would only ever duplicate `ClientScript<Game>`.

### 12.2 `ClientScript<HUDScreen>`

A screen's logic is a `ClientScript` hosted on a `HUDScreen`, attached to a panel-authored screen the same way an entity script attaches to a template. **There is no `UI` class any more** — a screen is a host and "client" is a location, and once those are separate words the class that was `UI` is just the cell where they meet.

```ts
class Shop extends ClientScript<HUDScreen> {
    selected = 'sword'; // plain field: client-only, never replicated
    pending = false;

    @onPress('sword')
    pickSword() {
        this.selected = 'sword'; // instant; no round trip
    }

    @onPress('buy')
    buy() {
        this.pending = true; // grey the button out immediately
        request('buy', { item: this.selected }); // ask the server
    }

    @onPress('close')
    dismiss() {
        this.host.close(); // the screen closes itself
    }

    @onUpdate
    render() {
        hud.text('cost', `${PRICES[this.selected]} coins`);
        hud.disable('buy', this.pending || this.localPlayer.coins < PRICES[this.selected]);
    }
}
```

Dropping `UI` as its own class removes a concept and gains two:

- **Client code is no longer synonymous with screens.** `UI` was the only client-side class, so any client-local behavior that wasn't about a screen had nowhere to go — camera feel (§3.3), a local-only muzzle flash on an entity, a per-player volume preference. Those are `ClientScript<Camera>`, `<Entity>`, `<Player>`, and they were all impossible.
- **Screens are no longer synonymous with client code.** A `ServerScript<HUDScreen>` is still illegal (a screen exists on one machine), but that is now one stated exception rather than an assumption baked into a class name.

What a screen script reaches:

```ts
this.host; // the HUDScreen — name, visible, open(), close()
this.localPlayer; // always present, always the owner of this screen
game; // ambient; global @serverState, find/read entities, never mutate
```

**A screen's client state dies with the screen.** Closing runs `@onEnd` and discards the instance, so a reopened menu starts fresh — the selection resets, the scroll returns to the top. This is the right default (a shop that remembers last week's highlighted row is a bug more often than a feature) and the escape hatch is ordinary: keep the value on a `ClientScript<Player>`, which lives as long as the session does. Both `open` and `close` are idempotent, so opening an open screen is a no-op rather than a second `@onStart`.

**Plain fields are client state.** No decorator, because there is nothing to declare — a field on a `ClientScript` lives on one machine and dies with its host. `@serverState` on a `ClientScript` is a load-time error on every host: it would mean "replicate this from a client," which is precisely what the trust boundary forbids. The error message points at `request`.

**`@onUpdate` on a `ClientScript` runs at display rate**, not `simRate`, because it is a render pass and its whole job is to be current. This is safe for exactly the reason it was dangerous elsewhere — no replication, no reconciliation, no other machine to agree with. The §5.1 warning against per-tick handlers does not apply; a render loop is what a client script is for. Note this holds for _every_ client script, not just screen-hosted ones, which is what makes `ClientScript<Camera>` a workable place for camera smoothing.

### 12.3 Binding data

Declarative binding is still the primary mechanism and still needs no code: a panel-bound label follows a `@serverState` name and updates when replication delivers a new value.

Code sets values by widget name, as before — but now from the client, so a value derived from local state costs nothing:

```ts
hud.text('score', 'Coins: 12'); // (B)
hud.number('score', 12); // (B)
hud.bar('health', 0.4); // (B) 0..1
hud.icon('powerup', 'star'); // (B)
hud.show('winBanner') / hud.hide('winBanner'); // (B)
hud.enable('buy') / hud.disable('buy'); // (B)
hud.timer('clock', countdown); // binds to a Countdown wrapper
```

**The `for` / `forAllExcept` options are gone**, and their removal is a real simplification rather than a lost feature. They existed because server code had to name which client it was talking to. Client code cannot address another player, so the parameter has no meaning — and the thing creators actually wanted is an ordinary local branch:

```ts
// was: hud.text('status', 'You are it!', { for: tagged })
hud.text('status', this.localPlayer === game.tagged ? 'You are it!' : 'Run!');
```

Server code that needs to push a message to one player's screen writes per-player `@serverState` (§6.1) and lets that player's client script read it. One direction, one mechanism.

**Widget names are unique across the whole HUD, panel-enforced.** This is what keeps the widget verbs on `HUD` rather than on `HUDScreen`: `hud.text('score', 12)` stays one block with one dropdown, and the block tier never learns that screens exist. The cost is that two menus cannot both have a widget literally named `back` — the panel resolves that at authoring time by qualifying the name (`pause-back`), which is a rename in a dropdown rather than a concept in the API. The alternative — per-screen namespaces and a `hud.screen('shop').text(…)` lookup — duplicates all nine verbs onto a second class and adds a two-step resolution rule to pay for a collision the editor can prevent.

Button presses are the one exception, and they scope the other way: see §12.4.

### 12.4 Interacting with UI

Buttons are named in the panel and fire by name, unchanged:

```ts
@onPress('play-again')     // on a ClientScript: local, instant
```

**`@onPress` on a `ClientScript<HUDScreen>` only sees its own screen's buttons.** Widget _writes_ are HUD-wide because the caller names what it means; a _handler_ is passive, so a shop script that fires on the pause menu's button would be a surprise rather than a convenience. On any other client host the name resolves across the whole HUD, since there is no screen to scope to.

**All press feedback is now genuinely local**, because the handler itself is. Hover, press animation, selection, disabled styling, tab switching, and scroll position resolve without touching the network. Only a `request` crosses the wire, and only when the creator writes one.

### 12.5 Screens, and who opens them

The `HUD` owns the screen list, so opening a menu is a call on `hud` and not on the screen — a screen you have not opened yet is not something you hold a reference to:

```ts
hud.open('pause'); // (B) runs the screen's @onStart
hud.close('pause'); // (B) runs @onEnd, discards its client state
hud.closeAll(); // (B)
hud.screen('shop'); // HUDScreen | null — the lookup, open or not
hud.screens; // every authored screen
hud.openScreens; // just the visible ones, bottom to top
```

**This is the API §1.1's "screen switching" cell always implied and never had.** A `ClientScript<Game>` is where "which menu is up" belongs — it is session-scoped client state — and under the previous design it could not reach a screen at all: the only way to obtain one was `this.host`, so a screen could hide itself but nothing could show it.

```ts
class Menus extends ClientScript<Game> {
    @onEvent('pause')
    toggle() {
        if (hud.screen('pause')!.visible) hud.close('pause');
        else hud.open('pause');
    }
}
```

`HUDScreen` keeps `open()` and `close()` as sugar for `hud.open(this.name)`, because a screen closing itself is the common case and `this.host.close()` reads better there than a screen naming itself by string.

**The always-on overlay is a screen too** — the health bar and the score counter live on a `HUDScreen` the panel marks as open at start and which nothing closes. That is a panel flag, not a second kind of container: one rule for what holds widgets, and `hud.*` spans them all without knowing which is which.

This is what unlocks the genres the previous design conceded — inventory screens, crafting menus, skill trees, card hands. A scroll view, a drag, a text field, and a hover-preview are all interactions whose _entire_ implementation is client-local state; they were impossible because there was no client-local place to put state, not because they were hard.

**Cursor interaction with HUD** uses `cursor.screenPosition`; `cursor.over` reports world entities only. HUD widgets consume clicks before they reach the world, so a button over a sprite does not also click the sprite.

**Touch:** buttons work; hover states never fire (§7.1). Panel-authored buttons have a minimum tap target enforced by the editor.

### 12.6 Requests, from the client side

`request(name, payload)` is the whole client→server vocabulary. It is a function, not a method, because there is nothing to address — the destination is always "the server." It is callable from any `ClientScript`, whatever the host — a `ClientScript<Entity>` asking to interact with the entity it is attached to is as legitimate as a menu asking to buy something.

```ts
request('buy', { item: 'sword' });
request('ready');
request('vote', { map: 'castle' });
```

- **No return value.** The answer arrives as replicated `@serverState` (§1). A handler that rejects the request simply changes nothing, and the client sees its optimistic guess corrected on the next snapshot.
- **Payload restrictions match `send`** (§5.8): plain values and `Entity`/`Player` references, no functions or closures.
- **Rate-limited by the engine**, per player, per name. A held-down button cannot flood the server, and a creator does not have to think about it.
- **`ctx.player` on the receiving handler is engine-supplied**, derived from the connection. It cannot be set by the payload, so a client cannot act as another player. Requests are the one place a game is attackable, so this is not left to creator discipline.

### 12.7 Optimistic UI, and being honest about it

The pattern above — set `pending`, fire a request, let replication confirm — is optimistic updating, and it is the standard shape for a responsive client. Two things follow that creators will hit:

**A guess can be wrong.** The server may reject the purchase. Since a client script's own fields are never replicated and never authoritative, correction needs no rollback machinery: the next snapshot overwrites what was being displayed, and the button un-greys. Creators write the optimistic path and the engine supplies the correction by doing nothing special.

**Do not optimistically display authority.** Greying a button while a request is in flight is right. Adding the sword to a locally-drawn inventory list before the server confirms is wrong, and produces the item-flickers-then-vanishes bug. The rule stated for the docs: _show that you asked, not that it worked._

### 12.8 Deliberate omissions

Still out for MVP: creator-authored widget types (the panel's set is fixed), nesting depth beyond one container level, and UI-driven asset loading. Containers, rows, scroll views, and text fields move **in** — they are panel-authored layout with client-local behavior, which is now expressible.

**The location/host grid is a text-tier feature.** The block tier gets `@onPress` and the `hud.*` calls it already had; a client/server distinction is not something a nine-year-old should hold, and the block-safe subset (§13) deliberately cannot express `request` or a `ClientScript`. Blocks that touch UI compile into a panel-generated `ClientScript<HUDScreen>` the creator never opens, and block gameplay compiles into `SyncedScript<Entity>`, which is the right default. A beginner writes one kind of script without knowing it has a kind. This keeps design rule 1 intact where it matters: **the split is a ceiling feature, not a floor feature.**

---

## 13. Block-safe subset

The contract that keeps the ladder intact.

**Must hold for every beginner-tier API:**

- One statement = one block. No nested expressions deeper than a single dropdown or literal.
- Arguments are literals, panel-populated dropdowns, or pronouns.
- No closures, higher-order functions, destructuring, generics, casts, or `private`.
- No `Map`/`Set`/array indexing — wrappers and pronouns instead.
- Options are flat named scalars with defaults, rendered as labeled slots.
- Chains render as stacks using an implicit "it" (last spawned) pronoun; max 4 chained calls in beginner docs.
- No early `return` requirements — use `{ concurrency: 'ignore' }` where races exist (§5.7).
- **No execution-site distinction.** The block tier has one place code runs. `ClientScript`, `ServerScript`, `request`, and `@onRequest` are text-tier only (§12.8); block gameplay compiles into `SyncedScript<Entity>` and UI blocks into a panel-generated `ClientScript<HUDScreen>`, neither of which the creator opens. A beginner writes `@onPress` and `hud.text` exactly as before and never learns that a boundary exists.
- **Attachment has no block.** Scripts reach a template by being dropped on it in the tray (§8.1), which is a gesture rather than a statement, so the block tier spends no palette slot on it and `addScript` is text-tier only.
- **`hud` is the one object reached by a bare name**, and the block tier sees only its verbs, each one statement with a name dropdown: the nine widget setters plus `open`/`close`/`closeAll` for screens (§12.5). `hud.screen(name)`, `hud.screens`, and `hud.openScreens` return objects and are text-tier only — a beginner switches menus with "open ⟨pause⟩" and never holds a screen.

**Pronoun vocabulary (fixed, exhaustive for MVP):**

| Meaning           | Text              | Block                           |
| ----------------- | ----------------- | ------------------------------- |
| acting player     | `ctx.player`      | "the player who pressed ⟨jump⟩" |
| collision partner | `ctx.other`       | "what I touched"                |
| my owner          | `this.host.owner` | "my player"                     |
| this entity       | `this.host`       | "me"                            |
| last spawned      | `it`              | "it"                            |
| all players       | `game.players`    | "everyone"                      |
| who sent it       | `ctx.from`        | "who sent it"                   |
| a payload value   | `ctx.data.amount` | "⟨amount⟩ from the event"       |

Kids never construct a player reference. Player-context handlers default their target to the acting player. The right-hand column is what a block compiles _to_, not what a beginner reads — blocks say "me" and "my player", and the block tier only generates entity-hosted gameplay scripts, so `this.host` is always an `Entity` there and `this.host.owner` is always the avatar's player.

**Palette budget:** ~40 core blocks, organized as Objects / Capabilities / Events & Time / Platform, with an advanced drawer beyond that. Every public beginner method costs one palette slot — this is the enforcement mechanism for a light API. `Asset` costs zero slots: every block that takes an asset takes the string key as a dropdown, and the `Asset` object itself is text-tier only.

We will also have a drawer of prebuilt classes. These are features like the wrapper objects (`Inventory`, `Leaderboard`, etc) and the movement classes (`TopDownMovement`, `PlatformerMovement`) that subclass `BaseMovement` (§4.1). A creator picks one from the drawer and configures it in the panel; the class is only visible if they open it to extend it. New genres ship here, not as API surface.

The full TS spec is in `api_spec.ts`, alongside this file.

---

## 14. Errors and the dev console

**Status: specified, not implemented.** TODO — the runtime behavior below is a contract `@platform/core` owes; today a creator exception has no defined outcome at all.

Several sections already promise a "creator-visible error" — the tick watchdog and the `send` depth limit (§5.7, §5.8), an unhandled request name logged to the dev console (§5.9), a load-time rejection (§1.2). Each was stated where it came up, and none said what actually happens to a game when creator code throws. That gap matters more here than in a professional engine: the person who wrote the handler is twelve, the exception is probably a typo'd property on `ctx.data`, and the wrong answer is a silently dead game or a wall of red text.

### 14.1 A throw is caught at the invocation boundary, never at the tick

**One handler invocation is the unit of failure.** An exception escaping a handler is caught where that handler was invoked, logged, and the rest of the tick proceeds — the other handlers on the event, the other entities, the loop itself. A coin whose `@onCollide` throws must not stop the world; the ninety-nine other coins are unaffected, and the player keeps moving.

The tick is deliberately _not_ the boundary. Wrapping the tick would mean one bad handler takes down input, movement, contacts and every timer for that tick, which converts a local bug into a global stutter and makes the cause much harder to see.

**What is logged**, and it is fixed rather than a format string a creator composes: the script class, the method, the host id, the tick number, the event name, and the stack. Those six answer "which of my scripts, on what, when" — the questions a creator actually has, and the ones a stack trace alone does not answer once decorators and dispatch sit between the throw and the source.

**Repeats are deduplicated.** A handler that throws on `@onUpdate` throws sixty times a second, and an un-deduplicated console is unreadable within a second and hides every _other_ error behind it. Identical errors — same class, method and message — collapse to one entry with a count.

**A handler that throws ~100 consecutive times is disabled**, and the disabling is itself logged as a distinct, prominent message naming the handler. Consecutive is the operative word: any successful invocation resets the counter, so a handler that throws only on a rare input is never disabled. This is a circuit breaker, and the reasoning is that a handler failing every single invocation is broken rather than flaky — it is producing no gameplay and a great deal of overhead, and saying so once loudly beats saying it forever quietly. The threshold is an engine constant, not a creator knob.

### 14.2 Wire and teardown are fatal, because the world is half-built

Two phases are the exception, and the line between them and §14.1 is **whether the engine can describe the state it is left in.**

A handler is a leaf: it either ran or it did not, and the world is coherent either way. **Wiring a script and draining a destroy are not.** A script whose `@serverState` hoisted three of five fields before throwing has a host record that matches no declaration; an entity half-removed from the tag index, the contact set and the renderer is a dangling reference the next tick will read. There is no honest way to continue from either, and continuing anyway produces a second failure somewhere unrelated — which is the failure the creator will report.

So an exception during wire (including a constructor and the `@onStart` that runs inside `addScript`, §8.1) or during the destroy drain (§6 of the core design) **fails the load or aborts the run** with the same six fields plus the phase. In the editor that is a red banner on the affected template; in a published game it is a session that does not start rather than one that corrupts.

The asymmetry is worth stating as a rule, since it generalizes: **catch where the failure is local and the state is coherent; abort where the failure leaves a structure half-mutated.**

### 14.3 The console is a creator surface

The dev console is part of the product, not a debug affordance — for most creators it is the only debugger they will use. Consequences:

- **Messages name creator concepts.** "`Coin.collect` threw on entity 41 at tick 903", never an internal frame or a packed handle.
- **A message is one line with the stack collapsed**, expandable. Sixty collapsed repeats of one error still read as one problem.
- **Load-time errors, runtime throws, and engine warnings are visually distinct**, because they need different reactions: fix before you can run, fix when you can, probably fine.
- **`console.log` from creator code goes to the same place**, with the calling script attributed. A creator's own printf debugging is the most-used feature of any console and should not be second-class.

**Not in MVP:** breakpoints, a stepping debugger, error reporting off the machine, and creator-defined error types. `try`/`catch` is ordinary TypeScript and works; it is text-tier only, since the block tier has no vocabulary for it.
