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

**Server-authoritative, single program.** A creator writes one program. It runs on the server as the authority. Clients render and predict, but never run creator logic the server didn't also run. There is no solo-versus-networked fork for the creator to reason about, and no separate client script to keep in sync.

**Split rates.** Simulation and replication are decoupled: physics and per-frame logic advance at sixty ticks per second, while state is replicated to clients at twenty. Both rates are settings rather than constants. Input is tick-indexed rather than wall-clock timestamped, with a bounded validation window — this is what makes prediction reconcilable and input forgery hard.

**Prediction with a clean boundary.** Entity-attached code runs on both machines: authoritative on the server, predicted on the client. Game-level code is server-only. Predicted code has to be deterministic — seeded randomness only, no storage reads, no wall-clock time — and violations surface at load time rather than as desync bugs in a playtest. Reconciliation is engine-owned; creators never write it.

**Rendering** goes through an interface with PixiJS behind it. A future 3D backend is the reason that interface exists, not a promise about next quarter.

**Physics** is Rapier, exposed as capabilities attached to entities rather than as a system creators address directly.

## Taxonomy

Three nouns carry the model, and the distinctions between them are load-bearing.

**Assets** are data — textures, atlases, audio, fonts. Loaded once, shared, referenced by name, immutable.

**Templates** are blueprints authored visually in the panel: a sprite, a collider, behaviors, and sounds, pre-configured together.

**Entities** are live instances in the world.

Capabilities — a physics body, a collider, an animation — attach _to_ entities. They aren't peer objects with independent lifecycles. Behaviors are the primary way code attaches to the world, and a behavior corresponds to a template in the panel, which is what keeps the visual editor and the code view describing the same thing.

Static geometry is inferred rather than declared. An entity with no behaviors and no movement gets baked into merged render and collision batches, replicated once, and excluded from per-tick diffing. A wall, a painted platform, and a decorative tree all receive identical treatment. There is no tilemap, no grid, and no cell addressing anywhere in the API — the panel's authoring tools _produce_ entities, and code only ever sees entities.

## The panel

The panel is Grove's visual editor, and it deliberately absorbs the parts of game development that don't fit into flat statements. Sprite drawing and animation happen there. Asset loading happens there. Template assembly happens there. HUD widgets are placed and data-bound there, so that code sets values by widget name and reacts to presses without ever specifying a position, a size, or a parent.

This split is the reason the code surface can stay block-safe. Layout is nested and spatial; blocks are flat and sequential. Rather than force one to imitate the other, Grove puts layout where layout belongs.

## Conventions

The origin sits at world center with y pointing up, distances are in pixels, and durations are in seconds. State scope is determined by where it's declared rather than by a separate decorator — game-level, per-player, and per-entity state are distinguished by declaration site. Motion is expressed through named verbs like _glide to_ and _fade to_ rather than a general-purpose tweening call; the tween machinery exists internally but isn't part of the public surface, because "glide to" reads as a block and "tween with easing curve" does not.

## Design principles

1. **One program, one mental model.** No solo-versus-networked fork, no client/server split for the creator to hold in their head.
2. **Cut before adding.** Rounds and phases, queue-based concurrency, grid coordinates, and a public tween call were all in earlier drafts and all removed once something simpler covered the real cases.
3. **The panel absorbs complexity.** Layout, placement, loading, and binding live in the visual editor so the code surface stays flat.
4. **Performance properties are not design decisions.** Static geometry is inferred. Reconciliation is automatic. Creators express intent, not optimization.
