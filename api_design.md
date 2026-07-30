There are 4 layers of the base API:

- Objects — entity/sprite, camera, scene, asset, sound instance
- Capabilities — physics body, collider, animation, tags that attach to objects
- Scripts — creator-authored logic classes that attach to objects
- Time & causality — the loop, delta time, timers, tweens, and the unified event system
- Platform — input devices, storage, networking/multiplayer, audio output

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

**Single program, server-authoritative.** All creator code runs on the server. Clients run the engine viewer — rendering, interpolation, input capture, and movement prediction. Creators never write client code in the MVP.

**State tiers**

| Tier          | Owner  | Replication                 | Creator-visible                                     |
| ------------- | ------ | --------------------------- | --------------------------------------------------- |
| Authoritative | server | to all clients, auto-diffed | `@state`, entities, wrappers                        |
| Per-player    | server | to one client               | camera, `scope`/`for` options, per-player vars      |
| Client-local  | client | never                       | interpolation, particles, prediction — engine-owned |

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

**Prediction and reconciliation.**

Entity `Script` code runs on **both** machines — authoritatively on the server, speculatively on the client — from the same source. The creator writes one program and never learns the word "client."

The dividing line is mechanical and engine-enforced:

| Runs where                  | What                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------- |
| Predicted (client + server) | entity `Script` handlers, `BaseMovement.tick` and its stages, collision                |
| Server only                 | `Game` handlers, `@onPlayerJoin` / `Leave`, storage, leaderboards, scoped/secret state |

Reconciliation is engine-owned and invisible: the server sends state plus the last input sequence it processed; the client rewinds to that state, replays its unacknowledged inputs, and lands at a corrected present. There are no creator-facing rollback hooks in MVP.

**Determinism is a hard requirement.** Prediction only works if client and server produce identical results from identical inputs; divergence surfaces as rubber-banding. Inside predicted handlers:

- Fixed timestep only — never derive behavior from wall-clock time or frame count.
- Seeded `random` only. `Math.random` is a load-time error in predicted code.
- Consistent entity iteration order, engine-guaranteed.
- No storage reads, no leaderboard reads, no access to state the client does not hold.
- No client-local display values — `camera.viewport` depends on window size and aspect ratio, so every client holds a _different_ one. This is the mirror of the bullet above: the client does hold it, which is exactly the problem.

Violations are rejected at load time, not at runtime. The block tier cannot express any of them, so beginners never encounter this.

**Reconnection.** A dropped client keeps predicting locally while the server holds its state for a grace period before firing `@onPlayerLeave`; on reconnect, authoritative state wins and the avatar snaps back. Clients stop accepting input after ~1s of silence so players don't accumulate long stretches of ghost gameplay.

**Run modes.** One code path, three deployments:

| Mode          | Server                  | Network | Players                                   |
| ------------- | ----------------------- | ------- | ----------------------------------------- |
| Networked     | remote process          | yes     | join over time                            |
| Local co-op   | same process (loopback) | no      | 1–N on one machine, separate binding sets |
| Single player | same process (loopback) | no      | one, synthesized at start                 |

Local modes skip serialization and prediction entirely — but handler order and the `player` object are identical, so a game written for one runs in all three.

---

## 2. Coordinates

- **Origin at world center, y-up, units = pixels.** Matches Scratch and math class. One-way door; fixed before launch.
- **Screen space** is a separate concept, never mixed with world space. HUD elements anchor by name (`'top-left'`, `'top-center'`, …) or a separate coordinate system.
- **Z exists from day one** in the data model (`Vec3`, `z` defaults to 0), reserved for the 3D backend. This is the 3D escape hatch.
- **Draw order is `Entity.layer`, not `position.z`.** Layering is render state, not simulation state: `position` is written by `move()` every tick, interpolated between replication frames, and read by `distanceTo`/`moveToward`/`near`/collider bounds. A draw layer is an ordinal that snaps, so it gets its own field and z stays a real spatial axis.

---

## 3. Objects

### 3.1 Entity

The base world object: transform, identity, lifecycle, scene membership, tags. A **Sprite** is an entity with a renderable capability. Cameras, trigger zones, and empty group nodes are entities without one.

```ts
entity.setPosition(x, y)           // instant position (chainable setter)
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
entity.position / .rotation / .scale / .opacity
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

### 3.2 Player

**Player is identity; the avatar is a body.** The test is respawn: anything that should _not_ reset when you die belongs on Player — score, inventory, team, bindings, persistence. Anything about a body in a scene — movement, collisions, animation — belongs on a script attached to the avatar.

There is **always** a Player class. Creators who define one get theirs; creators who don't get `BasePlayer` unchanged. There is no "custom player" code path.

```ts
class Player extends BasePlayer {
    @state coins = 0; // per-player scope — see §6.1
    @state team = 'red';

    @onStart // this player joined
    async setup(ctx) {
        this.coins = (await this.storage.get('coins')) ?? 0;
    }

    @onEnd // this player left
    async save(ctx) {
        await this.storage.set('coins', this.coins);
    }
}
```

Inherited from `BasePlayer`:

```ts
player.name / player.index;
player.avatar; // the owned entity
player.camera; // per-player, defaults to follow(avatar)
player.cursor; // see §7.1
player.input; // bindings, see §7
player.storage; // per-player persistence
player.spawn() / player.spectate() / player.respawn();
player.avatar.movement; // the attached movement type; speed and its own knobs live here
```

Movement mechanics are **not** properties of Player. `player.avatar.movement` is where they live — `maxSpeed` on the base, and everything genre-specific (`walkSpeed`, `jumpStrength`, `gravity`, `dashDistance`) declared by the attached movement subclass and reached the same way. Player is identity, and a jump height is not identity — see §4.2.

**Registration is panel mapping**, exactly like scripts: the Player prefab points at a class. No export-scanning magic, visible in the editor, and it extends to multiple player types later without a new concept.

**Player vs. Game handlers.** `@onStart` on Player is "this player joined"; `@onPlayerJoin` on Game is "the roster changed." Per-player setup goes on Player; orchestrator decisions (do we have enough players to begin?) go on Game.

**Moving a predicted avatar is a special case.** The client is simulating the avatar locally, so an instant server-side reposition must invalidate that prediction or the player rubber-bands. Use `avatar.teleportTo(x, y)` — it sends a prediction reset and reads as a hard cut. And `await avatar.glideTo(...)` disables the avatar's input for the duration and restores it after, so cutscenes don't fight the player.

Panel settings: movement class (a prebuilt class, see §4.1), auto-checkpoint, camera follow/zoom/bounds. Speed, jump height, gravity and similar knobs belong to whichever movement type is attached, not to Player — a top-down avatar has no jump to configure.

### 3.3 Camera

```ts
camera.follow(entity);
camera.zoom = 2;
camera.shake(strength, duration);
camera.bounds = zone; // constraint — where it may travel
camera.viewport; // observation — what it sees right now (readonly)
camera.moveTo(x, y); // instant
await camera.glideTo(x, y, 1); // smooth pan
await camera.zoomTo(1.5, 0.5);
```

Default behavior requires no code. Multiple cameras are per-player by construction; split-screen is a platform concern, not a creator one.

**`bounds` constrains, `viewport` observes.** The two are both `Bounds` and both on `Camera`, so the distinction is worth stating: `bounds` is an input the creator writes to leash the camera to the level; `viewport` is an engine-computed output describing the world-space rect currently on screen. You cannot write `viewport` — you move the camera or change `zoom` and it follows. The viewport is normally contained by `bounds`, and enforcing that containment is precisely what the leash does.

`viewport` exists because the alternative is creator arithmetic over screen size, `zoom`, and aspect ratio to answer ordinary questions — is this entity off-screen, where do I spawn something just out of view, what does the minimap frame. That is design rule 3: reaching for `Math.*` to compute something common means a primitive is missing.

**It is not readable from predicted code.** Viewport size depends on the client's window, so two players on different aspect ratios hold different values — reading it inside a `Script` would desync (§1). It is a `Game`-handler read, and the load-time determinism check rejects it in the predicted window alongside `Math.random`. The block tier cannot express it, so beginners never meet the restriction.

### 3.4 Scene

```ts
scene.load(name); // panel-authored level; awaited
scene.create(); // empty world
scene.spawn(template, x, y); // eager; returns Entity
scene.find({ tag }); // returns a real array
scene.stream({ ahead, behind, next }); // see §8
scene.bounds;
```

The scene is the container that owns all entities, receives the loop, and scopes queries and events. A "background" is a low-`layer` sprite inside it, not a scene property.

### 3.5 Game

The orchestrator. Owns global state and win conditions. Ambient world access via `this.scene`, `this.players`, `this.random` — `ctx` carries only event-specific data.

```ts
game.players; // real array
game.pause() / game.resume(); // local modes only; no-op when networked
```

### 3.6 Session & players

**The framing rule: `@onStart` builds the world; players are a stream that arrives afterward.**

This is the one rule that collapses the two situations creators worry about — "a networked game that starts with nobody in it" and "a game that starts with players already present" — into a single code path. They differ only in _when_ the first player arrives, which is an engine timing detail:

|                | `@onStart`              | first player                   |
| -------------- | ----------------------- | ------------------------------ |
| Networked      | world built, no players | seconds or minutes later       |
| Local / single | world built, no players | immediately after, synthesized |

Consequences, all normative:

- **`@onStart` must not assume any player exists.** Anything player-dependent belongs in `@onPlayerJoin`.
- **`@onPlayerJoin` is optional.** The panel-configured Player prefab spawns the avatar and attaches its camera automatically. A solo platformer needs no join handler at all.
- **`@onStart` is awaited before any join is released**, so when join handlers run, the world exists.

Once the player limit is reached, when the next player joins the instance, we'll create a new server instance + game, calling the game's `@onStart`.

**No rounds, no phases, no session state machine.** The engine provides events and nothing else. "Waiting for players," "round in progress," "game over," ready-up, spectating, and rematches are game-specific mechanics, and every game answers them differently — so they are ordinary creator state:

```ts
class Tag extends Game {
    @state playing = false;

    @onPlayerJoin
    join(ctx) {
        if (this.playing) ctx.player.spectate();
        else ctx.player.spawn();
        if (this.players.length >= 2) this.begin();
    }

    begin() {
        if (this.playing) return;
        this.playing = true;
        this.scores.reset();
        for (const p of this.players) p.spawn();
    }
}
```

A `@state` boolean or string is the whole mechanism. It replicates to clients automatically, so HUD widgets can bind to it, and it costs the engine nothing.

**What this trades away**, stated plainly so it isn't rediscovered later:

- `Scoreboard.reset()` is a manual call. There is no automatic per-round reset.
- The engine does not gate input by game state. A creator who wants frozen players between rounds sets `movement.enabled = false` themselves.
- There is no engine-supplied `winner`, no idempotent `endRound`. A creator's own win check needs its own guard — see the concurrency rules in §5.6.

**Panel settings:** `maxPlayers`, `simRate`, `sendRate`. `maxPlayers: 1` also drives editor behavior — no multi-pane test view, no share link.

### 3.7 Dialogue

Any entity can display a bubble. This is the smallest possible dialogue primitive and deliberately not a dialogue _system_.

```ts
entity.say('Hello!'); // persists until cleared or replaced
await entity.say('Watch out!', 2); // auto-clears after 2s; awaitable
entity.think('Hmm...'); // thought-bubble variant
entity.say('Psst', { for: player }); // only this player sees it
entity.clearSay();
```

**Semantics**

- Bubble text is **replicated state on the entity**, not a fire-and-forget effect. A player joining mid-sentence sees the bubble that is currently up.
- One bubble per entity. A second `say` replaces the first.
- The engine owns placement: anchored above the entity, flipped or nudged to stay on screen, following the entity as it moves. Creators never position a bubble.
- Bubbles clear automatically when the entity is destroyed or its scene unloads.
- The duration form is awaitable, so conversations are straight-line code:
    ```ts
    await npc.say('Take this sword.', 2);
    await hero.say('Thanks!', 1);
    ```
- Text length is capped (engine constant). Longer strings truncate rather than producing an unbounded bubble.

**Moderation.** Any bubble containing text that did not come from the creator's source — player names, chat input, stored strings — is filtered before display. This is engine-enforced and not optional, since bubbles are the easiest path to putting arbitrary text on another child's screen.

**Blocks:** three blocks — say, say-for-seconds, think — matching Scratch's vocabulary exactly.

**Not in MVP:** dialogue trees, branching choices, player-selectable responses, portrait/nameplate dialogue boxes, typewriter reveal. Those are UI-layout features and are UI-layout features beyond §12. `say` covers the overwhelming majority of school-project dialogue on its own.

---

## 4. Capabilities

Attached to entities, not peer objects. MVP set:

| Capability   | Purpose                    | Notes                                                              |
| ------------ | -------------------------- | ------------------------------------------------------------------ |
| `renderable` | sprite/texture             | makes an entity a "sprite"                                         |
| `movement`   | turns input into motion    | **predicted**; a `BaseMovement` subclass, see §4.1                 |
| `collider`   | bounding box, trigger flag | authored in panel; contacts read via `entity.getTouching()` (§5.4) |
| `animation`  | spritesheet clips          | driven by movement state; see §4.2                                 |

```ts
entity.movement.enabled = false; // stops steering; gravity still applies
entity.movement.speed; // READ: how fast it is going, px/sec
entity.movement.maxSpeed = 900; // the base's one ceiling
entity.movement.walkSpeed = 300; // Platformer's own knob
entity.movement.jump(); // Platformer's own verb, over impulse()
```

`velocity`, `intent`, `enabled`, `speed`, `maxSpeed`, and `blocked` are the whole base surface. Anything else a creator touches on movement — `walkSpeed`, `jumpStrength`, `aimAngle`, `dashesLeft` — is declared by the attached subclass, so it exists exactly when that genre's movement is attached.

Post-MVP: circle/polygon colliders, joints, pathfinding.

### 4.1 Movement

**Movement is a class to extend, not a setting to pick.** There is no `MovementMode` union and no engine-level notion of a genre. `BaseMovement` owns one body's motion for the tick: it holds the entity it drives and that entity's owning player, turns intent into velocity, and integrates. It is **abstract** — only concrete subclasses attach, so there is no inert-body case to document and no half-configured default to inherit.

**One write channel.** Velocity is the only representation of motion — px/sec, mutable, the single thing position is derived from. Earlier drafts had three channels in three unit systems (`move()` in px/tick, `setVelocity()` in px/sec, `impulse` in mass-dependent units) with no stated precedence, which made `move(300, 0)` and `setVelocity(300, 0)` differ by 60× behind identically-shaped signatures. Everything a subclass does is now a write to `velocity` or a write to `intent`.

```ts
abstract class BaseMovement {
    entity; // the body this drives; entity.owner is the player

    velocity; // px/sec, post-collision; mutable, replicated
    intent; // -1..1 per axis; direction, not speed; replicated
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

    setIntent(x, y, z?); // (B) steer an unowned body
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
        this.velocity.x = intent.x * this.walkSpeed; // instant, no inertia
        this.velocity.y = intent.y * this.walkSpeed;
    }
}
```

```ts
class SideViewMovement extends BaseMovement {
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
        this.velocity.x = this.approach(this.velocity.x, target, rate * dt);
    }

    applyForces(dt) {
        super.applyForces(dt); // drain wind, conveyors
        if (!this.grounded) this.velocity.y -= this.gravity * dt;
    }

    @onEvent('jump')
    jump() {
        if (this.grounded) this.velocity.y = this.jumpStrength; // assign, don't add
    }
}
```

Four things that shape is buying:

- **`intent` is normalized by the engine before `readIntent` returns it**, so the un-normalized diagonal — where holding two directions makes you 1.41× faster — is fixed once for every prebuilt class and every user subclass rather than in each one's arithmetic. The old `* this.speed * dt` spread across seven of them was also the `Math.*` smell design rule 3 warns about.
- **`speed` is a reading, not a knob.** `velocity.length()` is what an animation config compares against and what a creator means by "how fast is it going." Locomotion speed is the subclass's own field, because a platformer's walk speed, a car's top gear, and a fish's swim rate are not the same quantity and the base cannot define one. See §3.2 for what this changes.
- **`impulse` and `addForce` are different physics, so they are different methods.** A jump is a discrete Δvelocity and must never be dt-scaled or it varies with `simRate`; wind is a continuous acceleration that must be. Collapsing them into one additive call is the bug where a bounce pad feels different at 30 Hz than at 60. `addForce` accumulates, so two overlapping wind zones sum rather than fighting over the last write.
- **`grounded` is a getter over `blocked.down`**, not tracked state. Nothing can forget to update it, and there is no `@state` to replicate — `blocked` already arrives with velocity.

**`intent` is a Vec3, not a return value, because two writers need it.** For an owned body the engine fills it from the panel-mapped move axes each tick, so a movement type reads continuous input without naming an action. For an unowned one — an AI chaser, a conveyor, a possessed crate — a script calls `movement.setIntent(x, y)` and the same subclass drives it unchanged. Overriding `readIntent` is for non-axis sources: a cursor angle, a patrol waypoint, a modal control scheme.

**Discrete input reaches a movement type through `@onEvent`**, exactly as it does on a `Script` — a movement subclass is an event target like any other class in §5. That is why `tick` takes only `dt`: continuous input is already `intent`, and a jump is an event, so there is no `actions` object to thread through four hook signatures. It also means the jump lives in a method a subclass can override by name.

**There is no collision hook, and `move()` is not overridable.** The engine sweeps, slides, writes position, corrects velocity for what it hit, and sets `blocked`. A subclass reacts to `blocked` on the following tick rather than intercepting resolution mid-step — an override there is the single easiest way to make client and server disagree, since it runs inside the predicted window with the physics engine's intermediate state. Landing logic, wall-jump detection, and squash-on-impact all read `blocked`.

**`enabled = false` suppresses intent only.** `readIntent` yields zero; stages 2–4 still run. Gravity keeps pulling, a running player decelerates through their own friction instead of halting in midair, and nothing teleports. That is the between-rounds freeze §3.6 asks for. A hard freeze is `stop()` then `enabled = false`.

**Tick order is spec, not implementation.** `movement.tick` runs before scripts' `@onUpdate`, so a handler reading `velocity` or `blocked` sees this tick's resolved values rather than last tick's. With determinism as a hard requirement (§1), leaving that order to the implementation would make it a desync source.

**`SideViewMovement`, `TopDownMovement`, `TopDownFacingMovement` and the rest are platform-authored prebuilt classes, not API surface a creator designs against.** They ship as concrete `BaseMovement` subclasses in the same drawer as `Inventory` and `Leaderboard` (§13) — a creator picks one in the panel and never writes the class. That is what keeps the base small: adding an eighth genre is a new prebuilt class, not a new union member and not a new engine branch.

**Naming is deliberate: a movement class is named for a camera perspective, not for a genre.** `SideViewMovement` handles gravity, jumping and side-to-side running; `TopDownMovement` handles eight-way walking with no gravity. There is no class called `Platformer` and none called `TopDown`. Those are _genres_, and a genre is a whole game — a scrolling level, coins, a scoreboard, a respawn rule — of which movement is one part. What we ship for a genre is a **starter**: sample code a creator copies and edits, like the three games in `examples/`. Naming the class after the perspective keeps the two from being mistaken for each other, and keeps a creator from importing `Platformer` and finding nothing there.

The distinction has bitten us already. An earlier draft of this section wrote its examples as `class Platformer extends BaseMovement`, which reads as a shipped class named `Platformer` and invites `extends Platformer` in creator code. Sample games written against that draft did exactly that: they subclassed a genre name to change two numbers. Almost every real use is a knob, not a subclass —

```ts
// tuning the prebuilt class: the common case
const movement = player.avatar.movement as SideViewMovement;
movement.walkSpeed = 300;
movement.jumpStrength = 560;
```

— and a subclass is for a genuinely new mechanic (a double jump, a wall slide), not for a value the panel already exposes. **When illustrating a prebuilt class, show the knob first and the subclass second**, or the examples teach the rarer path as the default.

**Reaching the attached class from code needs a cast today**, since `entity.movement` is typed as the `Movement` alias (`BaseMovement`) and only the panel knows which subclass is really attached. That is a real wart: the knobs a creator most wants — `walkSpeed`, `jumpStrength` — live on the subclass, so the ordinary case pays for a cast. Options are to make `Entity` generic over its movement type, to let the panel emit a typed accessor per avatar prefab, or to accept the cast as the text-tier price of panel attachment. Unresolved; the block tier never sees it, because a block reads "set walk speed" off a dropdown of the attached class's own knobs.

Attachment is panel mapping, exactly like scripts and the Player class — the avatar prefab points at a movement class. `entity.setMovement(SideViewMovement)` is the code path for the rare dynamic case, and it takes a concrete subclass since the base is abstract.

**A prebuilt class is extended by overriding one stage, not by re-implementing the tick.** A kid adding a double jump to `SideViewMovement` overrides the verb that owns the decision:

```ts
class DoubleJump extends SideViewMovement {
    @state jumpsLeft = 2;

    applyForces(dt) {
        super.applyForces(dt);
        if (this.grounded) this.jumpsLeft = 2;
    }

    jump() {
        if (this.jumpsLeft === 0) return;
        this.velocity.y = this.jumpStrength;
        this.jumpsLeft--;
    }
}
```

No `super.tick()` to sequence, no double-firing from a shared `pressed('jump')` read, and the override is the same shape whether the parent is `BaseMovement` or a five-deep subclass chain. **Every prebuilt class is therefore held to a convention:** each mechanic gets its own small overridable verb (`jump`, `dash`, `aim`), and no hook reads an action a verb also reads.

**Decorators are inherited, and an override does not re-register.** `DoubleJump` never writes `@onEvent('jump')` — it inherits the parent's registration and replaces the method body, so the action fires once and runs the subclass's version. This is the normal prototype-override rule, but it is worth stating because the alternative (re-declaring the decorator in the child) is the natural guess and would double-register the handler. A subclass that wants _both_ behaviors calls `super.jump()`.

**Facing, gravity, and jump are still absent from the base.** Each is genre-specific: a 4-direction facing enum is wrong for a twin-stick shooter aiming at a cursor angle. A subclass that needs one declares it with `@state`, which both replicates it and makes it available to the panel's animation config (§4.2). What moved _onto_ the base is only `blocked` — the collision result no subclass can compute for itself. `entity.getTouching()` (§5.4) does not substitute for it: that reports _who_ is overlapping, while `blocked` reports _which side stopped the body_, and a subclass cannot derive the second from the first without the resolution data the engine keeps to itself. There is still no raycast. `grounded` was previously specified as `@state` on `SideViewMovement` with nothing able to set it.

**Determinism applies.** Movement runs predicted on client and server, so every stage obeys the same rules as any `Script` handler: fixed timestep, seeded `random` only, no storage reads (§1). Reading `actions` is safe by construction — input is tick-indexed, so a replay during reconciliation sees the same values. `intent` is replicated for the same reason: a server-set standing order has to survive the client's replay.

**3D.** `velocity`, `intent`, and `impulse` are already `Vec3` with an optional `z`; the stage list, `speed`, and `approach` are dimension-free. `blocked` gains forward/back. What stays 2D is the cardinal sugar — `pushUp`/`pushLeft` blocks over `impulse()` — which reads well as a block and is a prebuilt class's business, not the base's.

### 4.2 Animation

Three distinct things share the word "animation." Keeping them separate is what makes the API small:

| Kind                    | What changes                     | Replication                               |
| ----------------------- | -------------------------------- | ----------------------------------------- |
| **Frame animation**     | which spritesheet frame is shown | derived client-side; free                 |
| **Transform animation** | position / rotation / scale      | replicated state (motion verbs, movement) |
| **Effect**              | particles, flashes, squash       | cosmetic, fire-and-forget (`playEffect`)  |

**Default: no code.** A prefab's animation config maps movement state to clips in the panel. It always has `velocity` and `blocked` from the base, plus whatever `@state` the attached movement subclass declares — so the conditions available depend on the movement type, which is what makes the mapping genre-appropriate without the engine knowing any genres. A side-view config reads `grounded` because `SideViewMovement` derives it from `blocked.down`:

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

**Direction of dependency:** animation reads from movement, never the reverse. Root motion, animation-driven hitboxes, and frame data are out of scope (see §15). The escape hatch is ordinary code: disable movement, `await` the clip, re-enable.

**Blocks:** three blocks total — play, play-looping, stop. The automatic case needs none.

---

## 5. Events

Decorators are **sugar over an imperative core**. Decorator arguments must be static (tags, action names, asset keys). Runtime subscription uses `entity.on(...)`.

### 5.1 Lifecycle & loop

```ts
@onStart          // Game: world setup, awaited before any join is released.
                  //   Must not assume any player exists (§3.6)
                  // Player: this player joined
                  // Script: entity created
@onUpdate         // every simulation tick (default 60 Hz); ctx.dt in seconds
@onEnd            // Player: this player left
                  // Script: entity destroyed
```

One rule, three classes: `@onStart` means "the thing this class represents came into existence." Game-level roster concerns stay on `@onPlayerJoin`.

Prefer declarative forms over `@onUpdate` where one exists — `every(2, ...)`, `moveToward`, `@onEnter`, `camera.follow`. Two hundred entities each running a handler 60×/sec is the one performance cliff a creator can walk off unaided.

### 5.2 Players

```ts
@onPlayerJoin     // ctx.player — optional; avatar and camera spawn without it
@onPlayerLeave    // ctx.player — best-effort only; never the primary save path
```

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
- **No collider means an empty array**, never `null` — there is no null case to check, matching `scene.find`.
- **Order is engine-stable.** Determinism (§1) requires consistent iteration order, so the array is safe to read inside predicted code.
- **Static entities are reported individually**, even though §8.1 bakes them into merged collision geometry. The baking is a performance property and stays invisible (design rule: performance properties are not design decisions).
- **It is a real array**, so `.filter`/`.map`/`for..of` work — same contract as `scene.find`.

**Relationship to `blocked`.** They answer different questions and both are needed. `blocked` is directional and about _resolution_ — which side stopped me. `getTouching` is identity-bearing and about _overlap_ — who is there. A platformer's `grounded` stays `blocked.down`; _what_ am I standing on is `getTouching()`.

**Blocks:** one block — `isTouching(tag)`, a boolean reporter matching Scratch's "touching ⟨ ⟩?" exactly. `getTouching()` returns an array, which the block tier has no vocabulary for (§13 forbids array indexing), so it stays text-tier only.

### 5.5 Pointer

```ts
@onClick                 // this entity clicked; ctx.player = who clicked
@onHoverEnter            // ctx.player — never fires on touch devices
@onHoverExit             // ctx.player
```

### 5.6 Context object

`ctx` carries **only event data**: `ctx.player`, `ctx.other`, `ctx.value`, `ctx.data`, `ctx.from`, `ctx.dt`, `ctx.alive`. World access is ambient (`this.scene`, `this.game`, `this.player`). Long-lived async handlers must respect `ctx.alive`; `sleep` and the timed motion verbs auto-cancel when their entity dies.

**`ctx.data` is the payload channel** (§5.8). It is always an object — `{}` for engine events that carry none — so a handler indexes it without a null check, and it is read-only, since a handler mutating it could otherwise signal back to the sender or to handlers dispatched after it. That would be a second, invisible communication path alongside the return value, and one that behaves differently under prediction than in a local run.

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

The corollary is an asymmetry worth knowing: a handler on the **Game** class has one instance, so `ignore` there serializes across all players. That is usually right for orchestrator actions and wrong for per-player ones — which class a handler lives on changes its runtime behavior.

**Panel is the default, code overrides** (rule 5). Blocks get a checkbox on the hat block; text gets `{ concurrency: ... }`. Both compile to the same dispatcher flag, so block-built and text-built games behave identically.

**Why there is no `queue` mode.** `ignore` cannot emulate it — they are opposites, one dropping the event and one guaranteeing it eventually runs. It is cut anyway because "must not overlap _and_ must not drop" is real but narrow, and its uses are already served: sequential dialogue is successive `await entity.say(...)` calls, sequential flourishes are `playEffect` (fire-and-forget, no conflict), and input buffering needs a time window rather than an unbounded queue — deferred to a purpose-built setting (§15). An unbounded queue also has the nastiest failure mode of the candidates considered: a mashing player builds a backlog and the game keeps responding for seconds after they stop.

**Cancellation.** A handler whose entity is destroyed is cancelled at its next await point, so any loop containing an await terminates on its own. `ctx.alive` is only needed for loops with no awaitable call in them — and a fully synchronous infinite loop stalls the tick, which an engine watchdog aborts with a creator-visible error rather than hanging the server.

### 5.8 Sending events

An entity is addressable. `send` fires a named event at **that entity's** handlers — the `@onEvent` methods on its scripts and on its movement type:

```ts
enemy.send('damage', { amount: 10 }); // fire and continue
await door.send('open'); // wait for the handlers to finish
this.entity.send('respawn'); // an entity can address itself
```

```ts
class Enemy extends Script {
    @state health = 3;

    @onEvent('damage')
    hurt(ctx) {
        this.health -= ctx.data.amount;
        if (this.health <= 0) this.entity.destroy();
    }
}
```

**This is direct address, not a broadcast.** There is no game-wide event bus in the MVP, and that is the whole design decision. A bus needs a subscription registry, a delivery-order rule, and an answer for handlers on entities that no longer exist — and it invites the pattern where the way to find out what handles an event is to grep the project. `send` has a receiver in the call, so the reader of `enemy.send('damage')` knows where to look. Fan-out is an ordinary loop over `scene.find` or `game.players`, which stays visible at the call site:

```ts
for (const e of this.scene.find({ tag: 'enemy', near: { of: blast, within: 200 } })) {
    e.send('damage', { amount: 25 });
}
```

**Dispatch is synchronous; the promise is for sequencing.** Every matching handler is invoked before `send` returns and runs up to its first `await`. A handler with no `await` in it — the common case, and the only case the block tier can express — has therefore _finished_ by the time the next line runs, so its `@state` writes are immediately readable:

```ts
crate.send('break'); // no await
crate.alive; // already false if the handler destroyed it
```

The returned promise settles once every handler has run to completion, so `await enemy.send('damage')` is how you wait out a handler that itself awaits — a hit reaction that glides and flashes before you check whether the enemy died. Both forms deliver identically; `await` only changes what _you_ do next. This is the same shape as the timed motion verbs (§9.1), where calling without `await` is equally valid.

There is no return value. A handler answers by writing `@state` the sender can read, which keeps the block tier — where nothing returns — expressible, and keeps a multi-handler send from needing a rule about whose answer wins.

**Payload semantics**

- The payload is an object of named values, and it arrives **unwrapped** as `ctx.data`: `send('damage', { amount: 10 })` reads as `ctx.data.amount`. One flat object of labeled slots is exactly what the block tier can render, and it matches how `SoundOptions` and `HudTarget` already work.
- **Plain values and references only** — numbers, strings, booleans, `Vec3`, `Entity`, `Player`, and arrays/objects of those. No functions and no closures: a payload has to survive being replayed by the client's reconciliation and being sent from a `Game` handler, and a closure captures scope that only exists on one machine. Rejected at load time where it is statically visible.
- **Omitting the payload gives `{}`**, never `undefined` — same no-null-case rule as `getTouching` and `scene.find`.
- The payload is a **message, not shared state.** The receiver sees a read-only view; nothing a handler writes to `ctx.data` reaches the sender. State that outlives the event is `@state`.

**Determinism.** `send` is predicted, like the code around it. Called from a `Script` or a movement type it runs on the client and the server from the same source, so the event needs no replication at all — both machines send it themselves, on the same tick, in the same order (§1). Called from a `Game` handler it runs server-side only, and its effects reach clients as ordinary state replication. This is why the payload restriction exists: whatever crosses a `send` must be reproducible on the client from data the client already holds.

**Edge cases**, stated so they aren't guessed at:

- **Sending to a dead entity is a no-op** that resolves. Projectile-hits-already-destroyed-enemy is the ordinary case, not an error to handle.
- **An entity with no handler for the name is also a no-op.** Sends are addressed by name, and requiring a receiver would make every send site know the target's script list.
- **Multiple handlers for one name all fire**, in attachment order (engine-stable, per §1). A script and the movement type can both answer `'damage'`.
- **Concurrency defaults to `ignore`**, matching a key press: a send is instantaneous, and overlapping invocations on one instance are almost always the bug (§5.7). Override per handler as usual.
- **Recursion is bounded.** A send chain that re-enters the same handler is cut off at an engine depth limit with a creator-visible error, the same way the tick watchdog handles a synchronous infinite loop.
- **Names share the namespace with panel actions.** The panel rejects a send name that collides with a declared action, so `@onEvent('jump')` never has two unrelated sources.

**Blocks:** one block — send ⟨event⟩ to ⟨target⟩ with labeled payload slots — plus the existing `@onEvent` hat, which needs no change: the payload reads as a `ctx.data` reporter in the same shape as `ctx.value`.

---

## 6. State & data

### 6.1 Variables

**One decorator. Scope is determined by the class you declare it on** — there is no `@playerState`, no scope argument, nothing to choose.

```ts
class Game extends BaseGame {
    @state timeLeft = 60; // global — one value, replicated to everyone
}

class Player extends BasePlayer {
    @state coins = 0; // per-player — one per player, replicated to that player
}

class Goblin extends Script {
    @state health = 3; // per-entity — one per instance
}

class SideViewMovement extends BaseMovement {
    @state coyoteTime = 0; // per-entity — the movement type's own state (§4.1)
}
```

| Declared on             | Scope                         | Replicated to                                           |
| ----------------------- | ----------------------------- | ------------------------------------------------------- |
| `BaseGame` subclass     | one value for the whole game  | everyone                                                |
| `BasePlayer` subclass   | one value per player          | that player                                             |
| `Script` subclass       | one value per entity instance | everyone (scoped entities: their owner)                 |
| `BaseMovement` subclass | one value per entity instance | everyone; also readable by the panel's animation config |

Declaration site and access site agree: `@state coins` on Player is read as `player.coins`. This is what removes `Map`, ID keys, and null checks from creator code — a player object _is_ the identity, and the variable is a real typed property on it.

`@persist` composes with `@state` on any class to mark a value as checkpointed by the platform.

### 6.2 Wrappers

Each wrapper hides a data structure **and** its platform plumbing. MVP set is capped at six; more go to an advanced drawer.

```ts
new Leaderboard({ order, persist }); // sorted, persistent across sessions
new Storage(player); // key/value, persistent
new Countdown(seconds); // server-ticked, replicated, fires @onEnd
new Team(name); // player grouping; scores, spawns
```

```ts
scores.add(1); // defaults to the acting player in a player-context handler
scores.add(1, player); // explicit
scores.of(player);
scores.top(3);
scores.reset();
```

### 6.3 Persistence

Declarative and automatic: `@persist` / `persist: true` marks state as checkpointed by the platform. `Storage` is the explicit escape hatch. Leave handlers are never the primary save path.

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
- **Cursor position arrives as tick-indexed input**, like actions, and is rate-limited independently of `sendRate` (default 20 Hz). It is not replicated at simulation rate; aiming that must feel frame-tight belongs to a predicted script reading the local cursor.
- **`over` is engine-computed** using the same collider data as collisions, respecting `layer` order. It is `null` over empty space.
- **Touch devices have no hover.** On touch, `position` follows the last touch point, `isDown` is true while touching, `over` is only non-null during a touch, and `@onHoverEnter`/`@onHoverExit` never fire. Games that depend on hover must have a touch fallback; the panel warns when hover events exist in a game published to mobile.
- **Determinism:** cursor is client-owned input, so predicted scripts may read the local player's cursor but not another player's.

**Blocks:** four blocks — cursor x, cursor y, when I am clicked, when cursor touches me — matching Scratch's "mouse x / mouse y / when this sprite clicked" vocabulary.

---

## 8. Assets, prefabs & world building

**Asset** = data (texture, atlas, audio buffer, font). Loaded once, shared, referenced by string key, immutable.
**Prefab** = a panel-authored, pre-configured entity: sprite + collider + scripts + sounds.
**Entity** = a live instance in the world.

**"Template" is overloaded three ways, and this doc has to keep them apart.** All three are things a creator picks rather than writes, which is why the word drifted onto all of them — but they are different artifacts with different lifetimes, and conflating them produces code that references classes we do not ship:

| Sense              | What it is                                                                  | Named by                    | Example                                          |
| ------------------ | --------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------ |
| **Prefab**         | A configured entity, spawnable by key                                       | string                      | `scene.spawn('coin', x, y)`                      |
| **Prebuilt class** | A real class we ship, attached in the panel and reachable in code           | identifier                  | `SideViewMovement`, `Inventory`, `Leaderboard`   |
| **Starter**        | Pre-written sample code for a genre — a whole small game, copied and edited | prose only, never an import | "the platformer starter", "the top-down starter" |

Only the middle row is API surface. A prefab is data, and a starter is example code that gets copied into the creator's own project — neither is something code can name. Use **prefab**, **prebuilt class**, and **starter** in preference to "template"; where this doc still says "template" unqualified, it means prefab.

Loading is a panel/preload concern. `scene.spawn('coin', x, y)` is synchronous and always safe.

### 8.1 Static geometry

Levels are built from ordinary entities. Entities with no scripts and no movement capability are **inferred static** by the engine and baked into merged render batches and merged collision geometry; they replicate once on spawn and are excluded from per-tick diffing.

This is genre-neutral — a wall, a painted platform, a hand-drawn rock, and a decorative tree get identical treatment. There is no tilemap, no grid, and no cell addressing in the API. Panel authoring tools (freeform placement now; brush/shape tools later) are UI features that _produce_ static entities; code only ever sees entities.

`static` is never set by creators. It is a performance property, not a design decision.

### 8.2 Regions

Named rectangles/polygons authored in the panel. They eliminate coordinate math:

```ts
random.pointIn('sky')
scene.find({ in: 'arena' })
@onEnter('lava-pit')
```

### 8.3 Generation & streaming

Panel-authored **chunk prefabs** are the only supported path: a designer builds a level segment visually, code stitches segments together. Power users compose chunks with raw TS (loops, `random.*`, their own noise functions) — the engine provides no procgen system beyond `spawn` and `stream`.

```ts
scene.stream({
    ahead: 2400,
    behind: 1600,
    next: () => random.pick(['chunk-flat', 'chunk-gap', 'chunk-spikes']),
});
```

Engine owns: frontier/tail computation across **all** players, reclaim, and snapshot sizing. Generated entities are auto-tagged and auto-static.

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

`tween(entity, props, seconds, easing)` is their **shared implementation and the advanced escape hatch only**. It is not in the block palette, not in the beginner docs, and not counted against the palette budget. It exists for properties the named verbs don't cover and for animating custom `@state` numbers. Do not re-expose it in the palette.

Everything built once for `tween` is inherited by every verb:

- **Cancellation** — in-flight motion aborts when its entity is destroyed or its scene unloads; pending awaits resolve silently. A cancelled tween leaves the property at its current value, not the target.
- **Awaitability** — resolves on completion; calling without `await` runs it in the background and is equally valid.
- **Easing** — one implementation, optional trailing argument, panel default.
- **Replication** — mutates replicated state at simulation rate, broadcast at replication rate; clients interpolate. Defined once, so every verb is smooth automatically.
- **Conflict resolution** — two timed motions on the same property: last one wins, cancelling the first.

**Keep the verb list closed.** Each new verb costs a palette slot. Anything beyond this set belongs in the advanced drawer or is a `playEffect` cosmetic rather than a state tween.

`await` is legal in every handler (all handlers are async by default) and is inserted automatically by the block→code generator. The awaitable surface is deliberately tiny: `sleep`, the motion verbs, `scene.load`, storage reads, and `entity.send` (§5.8 — where the await is for sequencing, since delivery has already happened).

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

---

## 12. HUD & UI

**The constraint that shapes this whole section:** layout is inherently nested, and §13 forbids nesting. The resolution is that creators never write layout at all. Widgets are **authored and positioned in the panel**; code only _binds data_ to them and _reacts to presses_. Nothing in the API takes a position, a size, or a parent.

### 12.1 Model

- A **widget** is a named element placed in the panel: a text label, a bar, an icon, a button, a timer.
- Placement is a **named anchor** plus panel-authored offset within it — never coordinates in code.
- Widgets are **per-player by default**. Every player has their own HUD instance; scoping is automatic, not a parameter.
- Widgets are **screen space**, never world space. Bubbles above entities are §3.7's job, not the HUD's.

Anchors: `top-left`, `top-center`, `top-right`, `middle-left`, `center`, `middle-right`, `bottom-left`, `bottom-center`, `bottom-right`.

### 12.2 Binding data

The primary mechanism is **declarative binding, set in the panel**: a label is bound to a `@state` name on any class and updates automatically when that value changes. No code, no polling, no `@onUpdate`.

For values the panel can't express, code sets them by widget name:

```ts
hud.text('score', 'Coins: 12'); // (B)
hud.number('score', 12); // (B)
hud.bar('health', 0.4); // (B) 0..1
hud.icon('powerup', 'star'); // (B)
hud.show('winBanner') / hud.hide('winBanner'); // (B)
hud.timer('clock', countdown); // binds to a Countdown wrapper
```

Every call targets the current player context by default; an explicit `{ for: player }` overrides:

```ts
hud.text('status', 'You are it!', { for: tagged });
hud.text('status', 'Run!', { forAllExcept: tagged });
```

### 12.3 Interacting with UI

Buttons are named in the panel and fire by name — the same pattern as actions and regions, so there is one mental model for "something happened to a named thing":

```ts
@onPress('play-again')     // ctx.player = who pressed it
@onPress('team-red')
```

```ts
hud.enable('play-again') / hud.disable('play-again'); // (B)
```

**Press feedback is client-local and immediate.** Hover states, press animations, and disabled styling render instantly without a round trip; only the _consequence_ is authoritative. This is why buttons are viable in a server-authoritative model where free-form UI would not be — a discrete press tolerates one round trip, a drag or a scroll does not.

**Cursor interaction with HUD** uses `cursor.screenPosition`; `cursor.over` reports world entities only. HUD widgets consume clicks before they reach the world, so a button over a sprite does not also click the sprite.

**Touch:** buttons work; hover states never fire (§7.1). Panel-authored buttons have a minimum tap target enforced by the editor.

### 12.4 Deliberate omissions

No containers, rows, columns, flex, grids, scroll views, text input fields, drag-and-drop, or nested widgets. Those require layout, which requires nesting, which breaks the block tier — and free-form UI interaction (dragging, scrolling, typing) needs client-side logic, which is post-MVP (§15). Inventory screens, crafting menus, skill trees, and card hands are therefore out of reach in the MVP; that is a known and accepted genre hole.

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

**Pronoun vocabulary (fixed, exhaustive for MVP):**

| Meaning           | Text              | Block                           |
| ----------------- | ----------------- | ------------------------------- |
| acting player     | `ctx.player`      | "the player who pressed ⟨jump⟩" |
| collision partner | `ctx.other`       | "what I touched"                |
| my owner          | `this.player`     | "my player"                     |
| this entity       | `this.entity`     | "me"                            |
| last spawned      | `it`              | "it"                            |
| all players       | `this.players`    | "everyone"                      |
| who sent it       | `ctx.from`        | "who sent it"                   |
| a payload value   | `ctx.data.amount` | "⟨amount⟩ from the event"       |

Kids never construct a player reference. Player-context handlers default their target to the acting player.

**Palette budget:** ~40 core blocks, organized as Objects / Capabilities / Events & Time / Platform, with an advanced drawer beyond that. Every public beginner method costs one palette slot — this is the enforcement mechanism for a light API.

We will also have a drawer of prebuilt classes. These are features like the first-class wrapper objects (`Inventory`, `Leaderboard`, etc) and the movement classes (`SideViewMovement`, `TopDownMovement`, `TopDownFacingMovement`, …) that subclass `BaseMovement` (§4.1). A creator picks one from the drawer and configures it in the panel; the class is only visible if they open it to extend it. New genres ship here, not as API surface.

The full TS spec is in `@api_design.md`
