# Grove

A 2D multiplayer game platform for students, roughly elementary through high school. Younger creators build with blocks; older ones write TypeScript against the same API. There is no rewrite at the boundary — the blocks _are_ the TypeScript, rendered differently.

## Why this exists

Scratch is learnable but caps out fast, and its multiplayer story is essentially nonexistent. Roblox is powerful but drops a twelve-year-old into Luau, client/server boundaries, and lifecycle race conditions on day one. Grove aims at the gap: easy enough for a middle schooler to ship a game, powerful enough to build almost any 2D game, with a continuous upgrade path instead of a cliff.

## The three tiers

The same API is exposed at three levels of ceremony. A creator moves up a tier without abandoning what they already know.

| Tier                      | Surface                                                                 | Who                       |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------- |
| **Blocks**                | A drag-and-drop palette over the beginner subset of the API             | Elementary / early middle |
| **Simplified TypeScript** | The same members, typed, with the block-safe constraints still enforced | Middle / early high       |
| **Raw TypeScript**        | Full API, arbitrary expressions, creator-defined abstractions           | High school and up        |

The beginner subset follows three rules that make round-tripping between code and blocks possible: flat statements only, no positional or layout arguments, and no arithmetic buried inside call arguments. A whitelist of typed value-returning helpers covers the cases where a value genuinely needs computing, rather than opening the full expression grammar to the block parser.

## Architecture

**Server-authoritative, with a declared client side.** The world simulation runs on the server as the authority; clients render and predict it. There is no solo-versus-networked fork for the creator to reason about.

All creator code lives in a script, and a script declares two things in its header: **where it runs** and **what it's attached to**. Where it runs is the base class — `ServerScript` for authority, `ClientScript` for one person's screen, `SyncedScript` for gameplay the server owns and the client re-produces locally so it feels immediate. What it's attached to is a type parameter: `<Entity>`, `<Player>`, `<Game>`, `<Camera>`, or `<HUDScreen>`. So `SyncedScript<Entity>` is a coin that can be collected, and `ClientScript<HUDScreen>` is a shop menu.

Those two axes are deliberately separate words. Fusing them — one class that meant "entity-attached and predicted," another that meant "session-scoped and server-only" — made whole categories of ordinary code unspellable: a server-only loot roll on an entity, a per-player wallet as its own small class, camera smoothing that reads the local viewport.

Client code has no authority at all. It reads replicated state and, when it needs something to actually happen, calls `request()`, which a `ServerScript`'s `@onRequest` handler validates. Server-to-client is implicit replication; client-to-server is always an explicit, checked request. That asymmetry is the security model, and it's small enough to fit in a sentence.

**Split rates.** Simulation and replication are decoupled: physics and per-frame logic advance at sixty ticks per second, while state is replicated to clients at twenty. Both rates are settings rather than constants. Input is tick-indexed rather than wall-clock timestamped, with a bounded validation window — this is what makes prediction reconcilable and input forgery hard.

**Prediction with a clean boundary.** A `SyncedScript` runs on both machines from one source: authoritative on the server, re-produced on the client. That costs determinism — seeded randomness only, no storage reads, no wall-clock time — and violations surface at load time rather than as desync bugs in a playtest. A `ServerScript` is exempt because there's no second copy to agree with, and it's the only place storage and leaderboards are readable. A `ClientScript` is exempt too, and pays for it by having no authority: the same load-time pass rejects any attempt to write authoritative state from one. Reconciliation is engine-owned; creators never write it.

**Rendering** goes through an interface with PixiJS behind it. A future 3D backend is the reason that interface exists, not a promise about next quarter.

**Physics** is Rapier, exposed as capabilities attached to entities rather than as a system creators address directly.

## Taxonomy

**Five objects carry the model**, all engine-owned and none subclassed: `Entity` (a live body in the world), `Player` (identity), `Camera` (one player's view), `Asset` (immutable loaded data — a texture, a clip, an audio buffer), and `Game` (the session _and_ the world — it owns the entities, holds the build-time bounds, and is what `spawn` and `find` are called on). Four of the five are script hosts; `Asset` isn't, because nothing needs to attach behavior to it. There is no `Scene`: a container that could hold no state a `Game` couldn't was one object wearing two names.

Two nearby distinctions are load-bearing. A **template** is a panel-authored blueprint — a sprite, a collider, scripts, and sounds pre-configured together — spawned by name, and it is data rather than a class. An **asset** is the data a template points at. Both are things creators pick rather than write, and earlier drafts blurred them together and then produced code referencing classes that don't exist.

**Capabilities** — a collider, an animation, a renderable — attach _to_ an entity as leaf data. They aren't peer objects with independent lifecycles, and they aren't code. **Scripts** are how code attaches, to any of the five hosts, and a script corresponds to something the panel can point at, which is what keeps the visual editor and the code view describing the same thing.

Static geometry is inferred rather than declared. An entity with no scripts gets baked into merged render and collision batches, replicated once, and excluded from per-tick diffing. A wall, a painted platform, and a decorative tree all receive identical treatment. There is no tilemap, no grid, and no cell addressing anywhere in the API — the panel's authoring tools _produce_ entities, and code only ever sees entities.

## The panel

The panel is Grove's visual editor, and it deliberately absorbs the parts of game development that don't fit into flat statements. Sprite drawing and animation happen there. Asset loading happens there. Template assembly happens there. HUD widgets are placed and data-bound there, so that code sets values by widget name and reacts to presses without ever specifying a position, a size, or a parent — layout stays in the panel even though the code reacting to it now runs on the client.

This split is the reason the code surface can stay block-safe. Layout is nested and spatial; blocks are flat and sequential. Rather than force one to imitate the other, Grove puts layout where layout belongs.

## Conventions

The origin sits at world center with y pointing up, distances are in pixels, and durations are in seconds. State scope is determined by what a script is attached to rather than by a separate decorator — global, per-player, and per-entity state are distinguished by the host in the class header, and the value is hoisted onto that host, so `@serverState coins` on a player script reads as `player.coins` everywhere. That one decorator also covers durability: a server-owned property is persisted against its host automatically, so there is no separate `@persist` to remember. Motion is expressed through named verbs like _glide to_ and _fade to_ rather than a general-purpose tweening call; the tween machinery exists internally but isn't part of the public surface, because "glide to" reads as a block and "tween with easing curve" does not.

## Design principles

1. **One program, one mental model — and one seam, declared where it pays for itself.** No solo-versus-networked fork. Gameplay is `SyncedScript` and the creator never learns the word "client"; the split becomes visible only when hiding it would make a game feel worse, and then it's one word in a class header. It's a ceiling feature: the block tier can't express it, and a beginner writing `when 'play-again' pressed` never learns it's there.
2. **Two axes, two words.** Where code runs and what it's attached to are separate declarations, because every attempt to fuse them made some ordinary combination unspellable.
3. **Cut before adding.** Rounds and phases, queue-based concurrency, grid coordinates, and a public tween call were all in earlier drafts and all removed once something simpler covered the real cases.
4. **The panel absorbs complexity.** Layout, placement, loading, and binding live in the visual editor so the code surface stays flat.
5. **Performance properties are not design decisions.** Static geometry is inferred. Reconciliation is automatic. Creators express intent, not optimization.
