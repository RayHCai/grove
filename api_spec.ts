// Game Platform — MVP API surface
// Origin at world center, y-up, pixels. Durations in seconds.
// Sim 60 Hz (simRate), replication 20 Hz (sendRate). Input is tick-indexed.
// Entity/Script/Movement run predicted on client + server; Game handlers are server-only.
// Predicted code must be deterministic: seeded random only, no storage, no wall-clock,
// no client-local display values (camera.viewport differs per client).
// (B) = in the block palette (beginner tier).

declare module '@platform/engine' {
    // ─── primitives ────────────────────────────────────────────────

    interface Vec3 {
        x: number;
        y: number;
        z: number;
    }

    // TODO: bound in world or entity space? How are bounds defined?
    interface Bounds {
        left: number;
        right: number;
        top: number;
        bottom: number;
    }

    type Easing = 'linear' | 'ease' | 'easeIn' | 'easeOut' | 'bounce';

    // Panel-side only — never referenced from code.
    type HudAnchor =
        | 'top-left'
        | 'top-center'
        | 'top-right'
        | 'middle-left'
        | 'center'
        | 'middle-right'
        | 'bottom-left'
        | 'bottom-center'
        | 'bottom-right';

    // ─── math ──────────────────────────────────────────────────────

    // Scalars only; Entity/Camera helpers live under motion helpers below.

    function clamp(value: number, min: number, max: number): number; // (B)
    function lerp(a: number, b: number, t: number): number;

    interface Random {
        seed(n: number): void; // shareable/daily levels, reproducible debugging
        between(min: number, max: number): number; // (B)
        pick<T>(list: T[]): T; // (B)
        chance(probability: number): boolean; // (B)
        pointIn(region: string): Vec3; // (B) panel-authored region
    }

    const random: Random;

    // ─── time ──────────────────────────────────────────────────────

    function sleep(seconds: number): Promise<void>; // (B)
    function every(seconds: number, fn: () => void): () => void; // (B) auto-cancels with entity
    function after(seconds: number, fn: () => void): () => void; // (B)

    // ─── input ─────────────────────────────────────────────────────

    // Bindings are panel-authored and per-player. Actions double as the network protocol.
    interface InputBindings {
        rebind(action: string, bindings: string[]): void;
        addBinding(action: string, binding: string): void;
        getBindings(action: string): string[];
        resetBindings(action?: string): void;
        setContext(context: string): void; // action groups; resolves conflicts
    }

    // This tick's input for the owning player. Tick-indexed and replay-safe — same
    // answer on client and server, which is what makes reconciliation work.
    // Consumed by BaseMovement.readIntent / accelerate.
    interface ActionState {
        held(action: string): boolean; // down as of this tick
        pressed(action: string): boolean; // went down on this tick
        released(action: string): boolean; // came up on this tick
        axis(action: string): number; // -1..1
    }

    // ─── attachments ───────────────────────────────────────────────

    // Leaf capabilities. Present on an Entity only if its prefab configures them.

    // Geometry and flags only; contact identity comes from Entity.getTouching.
    interface Collider {
        enabled: boolean;
        isTrigger: boolean; // fires enter/exit instead of blocking
        readonly bounds: Bounds; // see Bounds TODO
    }

    // The per-entity animator, not one clip — same shape as movement. Clips stay
    // panel-authored resources referenced by key, like prefabs and regions.
    // Mapping is panel-authored and one-way: it reads velocity, blocked, and any
    // @state the movement subclass exposes, never the reverse.
    // TODO: per animation, or only the currently playing one?
    interface Animation {
        speed: number;

        // On screen now, override included: a running play() clip, else the state
        // machine's pick. '' when nothing plays — never null.
        readonly clip: string;
    }

    // ─── entity ────────────────────────────────────────────────────

    interface SayOptions {
        for?: Player; // per-player scope; omitted = everyone sees it
    }

    // "Sprite" in blocks and beginner docs.
    class Entity {
        readonly id: string;
        readonly owner: Player | null; // null for non-player entities

        position: Vec3;
        rotation: number; // degrees
        scale: number;
        opacity: number; // 0..1
        // TODO: generalize for 3D. position.z would work but affects math functions.
        layer: number; // draw order in 2D; position.z is reserved for the 3D backend

        // instant motion
        setPosition(x: number, y: number): this; // (B) chainable eager setter
        moveBy(dx: number, dy: number): this; // (B)
        moveToward(target: Entity | Vec3, speed: number): this; // (B)
        faceToward(target: Entity | Vec3): this; // (B)
        distanceTo(target: Entity | Vec3): number; // (B)

        // timed motion — awaitable; -To suffix = absolute, bare verb = relative
        glideTo(x: number, y: number, seconds: number, easing?: Easing): Promise<void>; // (B)
        glideBy(dx: number, dy: number, seconds: number, easing?: Easing): Promise<void>; // (B)
        fadeTo(opacity: number, seconds: number): Promise<void>; // (B)
        fadeIn(seconds: number): Promise<void>; // (B)
        fadeOut(seconds: number): Promise<void>; // (B)
        growTo(scale: number, seconds: number): Promise<void>; // (B)
        spin(degrees: number, seconds: number): Promise<void>; // (B)
        spinTo(degrees: number, seconds: number): Promise<void>; // (B)

        // hierarchy
        attachTo(parent: Entity): this; // (B) position becomes local to parent
        detach(): this; // (B) keeps world position
        readonly parent: Entity | null;
        readonly children: Entity[];

        // tags — a set, not a field
        tag(name: string): this; // (B) adds
        untag(name: string): this; // (B)
        hasTag(name: string): boolean; // (B)
        readonly tags: string[];

        // capabilities — prefab-configured; movement is the attached BaseMovement subclass
        movement?: Movement;
        collider?: Collider;
        animation?: Animation;

        // Attach in code (panel attachment is the default path). Concrete
        // subclasses only — BaseMovement is abstract.
        setMovement(movement: new () => BaseMovement): this;

        // Pull-based counterpart to @onCollide: "are we touching" vs "we just
        // touched" — am I still on the button, how many enemies are in my aura.
        // Filters the contact set BaseMovement.move already wrote this tick, so a
        // per-tick call costs what reading blocked costs.
        //
        // Blocking and trigger colliders both count; isTrigger decides whether you
        // were stopped, not whether you are touching. Excludes self and own
        // parent/children. Empty array / false without a collider — never null.
        // Order is engine-stable. Static entities are reported individually despite
        // being baked into merged collision geometry.
        getTouching(tag?: string): Entity[]; // real array — .filter/.map/for..of work
        isTouching(tag?: string): boolean; // (B) the block-tier spelling

        // visibility and effects
        show(): this; // (B)
        hide(): this; // (B)
        play(clip: string, opts?: { loop?: boolean }): Promise<void>; // (B) frame animation
        stopAnimation(): this; // (B)
        playEffect(name: string, opts?: { loop?: boolean }): this; // (B) cosmetic, client-side

        // dialogue — replicated, one bubble per entity, engine-placed
        say(text: string, opts?: SayOptions): this; // (B) persists
        say(text: string, seconds: number, opts?: SayOptions): Promise<void>; // (B) auto-clears
        think(text: string, opts?: SayOptions): this; // (B)
        think(text: string, seconds: number, opts?: SayOptions): Promise<void>;
        clearSay(): this; // (B)

        // lifecycle
        destroy(): void; // (B) cascades to attached children
        readonly alive: boolean;

        // scripts — many per entity; the base is not abstract, so any subclass fits
        addScript(script: new () => Script): this;

        // runtime event subscription — imperative core beneath the decorators
        on(event: string, handler: (ctx: Ctx) => void): () => void;

        // Direct-address counterpart to on(): fire `event` at THIS entity's handlers
        // — its scripts' and its movement's @onEvent methods. Not a broadcast; there
        // is no game-wide bus in MVP.
        //
        // Dispatch is synchronous: every handler runs to its first await before send
        // returns, so an await-free handler has already finished and its @state
        // writes are visible on the next line. The returned promise settles once
        // every handler finishes, making await a sequencing tool rather than a second
        // delivery mode.
        //
        //   this.entity.send('damage', { amount: 10 });         // fire, don't wait
        //   await door.send('open');                            // wait for it to finish
        //
        // Payload lands on ctx.data unchanged and unwrapped: plain values plus
        // Entity/Player references only, no functions or closures. Omitted payload
        // gives ctx.data = {}, never undefined.
        //
        // Predicted, so it obeys the header: from a Script or Movement it runs on
        // client and server alike and needs no replication, since both machines send
        // it themselves. From a Game handler it runs server-side only and reaches
        // clients as ordinary state replication. Dead entity = no-op that resolves.
        // See spec §5.8.
        send(event: string, payload?: Record<string, unknown>): Promise<void>; // (B)
    }

    // ─── movement ──────────────────────────────────────────────────

    // A class to extend, not a fixed set of options. SideViewMovement,
    // TopDownMovement and the rest are platform-authored subclasses shipped in the
    // panel's drawer; the engine has no notion of a "mode". They are named for a
    // camera perspective, never a genre: there is no `Platformer` class, because a
    // platformer is a whole game and movement is one part of it. Genre code ships
    // as a starter — sample code a creator copies — not as a class to extend.
    // Genre state (gravity, jump, aim angle, dash) belongs to the subclass; only what
    // no subclass could compute for itself lives here.
    //
    // One instance wraps one body and owns its motion for the tick. Abstract, so
    // there is no inert body and no half-configured default to inherit.
    //
    // ONE write channel: velocity (px/sec, world units, mutable) is the only
    // representation of motion and the only thing position derives from. No
    // displacement setter, no second unit system, so "set it" and "add to it" cannot
    // disagree by a factor of simRate. A subclass writes velocity or intent.
    //
    // Predicted on client AND server — obey the header's determinism rules. Discrete
    // input arrives via @onEvent, continuous input as intent, so there is no actions
    // parameter to thread.
    abstract class BaseMovement {
        // Assigned by the engine on attach. Owning player, if any, is entity.owner.
        readonly entity: Entity; // the body being driven

        // Live, mutable, both replicated: velocity so clients can animate and
        // interpolate, intent so a server-set standing order (AI, conveyor) survives
        // the client's replay.
        velocity: Vec3; // px/sec, post-collision
        intent: Vec3; // -1..1 per axis; the direction this entity wants to move, not speed

        enabled: boolean; // (B) see "enabled" below — not a freeze

        // velocity.length(), px/sec — a read, not a knob. Locomotion speed is the
        // subclass's own field, since "how fast do I walk" is genre-specific.
        readonly speed: number;

        // Ceiling on total velocity, px/sec. Panel default, code overrides. The one
        // non-genre-specific limit: every body needs a bound physics can trust.
        maxSpeed: number;

        // Which side stopped the body, written by the engine in move(). The one
        // collision result no subclass could compute for itself, which is why it
        // lives on the base — a platformer's grounded is a getter over blocked.down.
        // Read it on the tick AFTER resolution; there is no collision hook.
        //
        // Directional and about resolution, unlike Entity.getTouching, which is
        // identity-bearing and about overlap. A trigger collider never sets blocked.
        readonly blocked: { up: boolean; down: boolean; left: boolean; right: boolean };

        // ── the tick ────────────────────────────────────────────────
        // Sealed: this order IS the prediction contract, so overriding is a load-time
        // error rather than a subtle desync. The hooks below are the whole extension
        // vocabulary.
        //
        //   1. accelerate(readIntent(), dt)   intent -> velocity
        //   2. applyForces(dt)                gravity, friction, drained forces
        //   3. clampSpeed()                   maxSpeed
        //   4. move(dt)                       engine: sweep, slide, write
        //                                     position, correct velocity, set blocked
        //
        // Runs before scripts' @onUpdate, so handlers see this tick's resolved values.
        tick(dt: number): void;

        // ── public writes ───────────────────────────────────────────

        // Steer an unowned body — an AI chaser, a possessed crate. Owned bodies get
        // intent from their player's move axes automatically. Decomposed and
        // normalized: one block with x/y slots, no vector literal.
        setIntent(x: number, y: number, z?: number): void; // (B)

        // Discrete velocity change, px/sec, never dt-scaled — jump, knockback, bounce
        // pad. Mass-free, so a tuned value transfers between bodies. Public because
        // external force comes from @onCollide scripts, which are predicted. 2D
        // subclasses wrap this as jump() and cardinal pushes.
        impulse(x: number, y: number, z?: number): void;

        // Continuous force, px/sec². Accumulates across callers and drains in
        // applyForces, so overlapping wind zones sum instead of fighting.
        addForce(x: number, y: number, z?: number): void;

        stop(): void; // (B) zero velocity and intent

        // ── hooks ───────────────────────────────────────────────────

        // The only required override: how this genre turns direction into velocity.
        // Instant (top-down) vs accelerated (ice, cars) vs air-vs-ground (platformer)
        // is most of the difference between movement types.
        protected abstract accelerate(intent: Vec3, dt: number): void;

        // Where the body wants to go. Defaults to this.intent, which the engine fills
        // from the panel-mapped move axes for an owned body. Override to read a cursor
        // angle, a patrol waypoint, a modal control scheme.
        protected readIntent(): Vec3;

        // Everything that moves the body unasked. Default drains the addForce
        // accumulator; a platformer adds gravity/friction here and calls super.
        protected applyForces(dt: number): void;

        // Default clamps total velocity to maxSpeed. Override for terminal fall speed
        // or per-axis limits.
        protected clampSpeed(): void;

        // Frame-rate-independent move-toward-a-number: the primitive under every
        // acceleration and friction curve. Protected keeps the arithmetic out of the
        // beginner tier.
        protected approach(current: number, target: number, rate: number): number;

        // Engine-owned, not overridable: sweeps along velocity, slides on contacts,
        // writes position, corrects velocity, sets blocked. No collision hook — a
        // subclass reacts to blocked next tick rather than intercepting resolution,
        // which is what keeps client and server in step.
        private move(dt: number): void;
    }

    // `enabled = false` suppresses intent only: readIntent yields zero, stages 2-4
    // still run. Gravity keeps pulling, a running player decelerates through their own
    // friction instead of halting midair, nothing teleports. This is the
    // between-rounds freeze in spec §3.6; hard freeze is stop() then enabled = false.

    // Alias for the attached subclass; the engine substitutes the prefab's.
    //
    // TODO: this is BaseMovement, so the knobs a creator actually reaches for —
    // walkSpeed, jumpStrength — need a cast:
    //   (avatar.movement as SideViewMovement).walkSpeed = 300
    // Only the panel knows which subclass is attached. Make Entity generic over it,
    // emit a typed accessor per avatar prefab, or accept the cast? See design §4.1.
    type Movement = BaseMovement;

    // ─── camera ────────────────────────────────────────────────────

    class Camera {
        zoom: number;

        // Constraint, not observation: where the camera MAY travel. Written by the
        // creator, null = unconstrained. Contrast viewport below.
        bounds: Bounds | string | null; // region name or explicit bounds

        // Observation, not constraint: the world-space rect this camera sees right
        // now — engine-computed from position, zoom, and the client's window, so it is
        // aspect-correct without arithmetic. Normally contained by bounds, which is
        // what the leash enforces. Per-player and private, like the rest of Camera.
        //
        // Depends on a client-reported window size, so it is readable from Game
        // handlers (server-only) but NOT from predicted code — two clients with
        // different aspect ratios would diverge. See header.
        readonly viewport: Bounds;

        follow(target: Entity | null): this; // (B) defaults to the owning player's avatar
        moveTo(x: number, y: number): this; // (B)
        shake(strength: number, seconds: number): this; // (B)

        glideTo(x: number, y: number, seconds: number, easing?: Easing): Promise<void>; // (B)
        zoomTo(zoom: number, seconds: number, easing?: Easing): Promise<void>; // (B)
    }

    // ─── player ────────────────────────────────────────────────────

    // Position is state; clicks are ordinary actions (mouse:left is a binding).
    // Per-player and private — one player's cursor is invisible to others.
    interface Cursor {
        readonly position: Vec3; // (B) world space, via this player's camera
        readonly screenPosition: Vec3; // screen space, for HUD hit-testing
        readonly over: Entity | null; // (B) engine-computed, layer-ordered; null on empty space
        readonly isDown: boolean; // (B) mirror of the primary click action
        visible: boolean; // hide the OS cursor for custom reticles
        setIcon(icon: 'crosshair' | 'hand' | 'default' | string): void;
        lock(): void; // pointer lock; relative movement only
        unlock(): void;
        // touch: position follows last touch, over is non-null only during a touch,
        // hover events never fire
    }

    // Creators subclass this; not subclassing yields BasePlayer unchanged.
    // Registration is panel mapping: the Player prefab points at a class.
    // Player is identity, the avatar is a body — if it survives respawn, it goes here.
    class BasePlayer {
        readonly id: string;
        readonly name: string;
        readonly index: number;
        readonly avatar: Entity;
        readonly camera: Camera;
        readonly cursor: Cursor;
        readonly input: InputBindings;
        readonly storage: Storage; // wrapper declared under data wrappers

        spawn(): void; // (B)
        spectate(): void; // (B)
        respawn(): void; // (B) to last checkpoint

        teleportTo(x: number, y: number): void; // hard cut; resets client prediction

        // @state here is per-player and typed:
        //   class Player extends BasePlayer { @state coins = 0 }  ->  player.coins
    }

    // Alias for the creator-defined subclass; the engine substitutes theirs.
    type Player = BasePlayer;

    // ─── scene ─────────────────────────────────────────────────────

    interface FindQuery {
        tag?: string;
        in?: string; // panel-authored region name
        near?: { of: Entity | Vec3; within: number };
    }

    interface StreamOptions {
        ahead: number;
        behind: number;
        next: () => string; // returns a chunk prefab key
    }

    class Scene {
        readonly bounds: Bounds;
        readonly entities: Entity[];

        load(name: string): Promise<void>; // (B) panel-authored level
        create(): Promise<void>; // empty world

        spawn(prefab: string, x?: number, y?: number): Entity; // (B) eager
        find(query: FindQuery): Entity[]; // real array — .filter/.map/for..of work

        stream(opts: StreamOptions): void; // engine owns frontier, reclaim, snapshot size
    }

    // ─── game ──────────────────────────────────────────────────────

    // Creators subclass this. @state declared here is global.
    class BaseGame {
        readonly scene: Scene;
        readonly players: Player[];
        readonly random: Random;

        pause(): void; // (B) local run modes only
        resume(): void; // (B)
    }

    type Game = BaseGame;

    // ─── script ────────────────────────────────────────────────────

    // Where creator logic for an entity lives: pickups, enemies, hazards, doors,
    // projectiles, avatar attack/health. Not a capability — Collider, Animation and
    // BaseMovement are engine-provided; a script is code the creator wrote. Attached
    // to a prefab in the panel, or via entity.addScript(). Runs on both machines —
    // authoritative on the server, predicted on the client — so it must be
    // deterministic (see header).
    //
    // Many per entity, and nothing to override — no prescribed tick, no abstract
    // member. Everything a subclass uses is either injected below or declared by the
    // subclass with a decorator. Contrast BaseMovement: one per entity, with a fixed
    // staged pipeline. Hence no Base prefix and no alias: unlike Game, Player and
    // Movement, there is no single creator subclass for the engine to substitute.
    //
    //   class Coin extends Script {
    //       @onCollide('player')
    //       collect(ctx: Ctx) {
    //           ctx.player!.coins += 1;   // @state on the Player subclass
    //           this.entity.destroy();
    //       }
    //   }
    class Script {
        readonly entity: Entity;
        readonly player: Player | null; // owner of this.entity, if any
        readonly game: Game;
        readonly scene: Scene;
    }

    // ─── events ────────────────────────────────────────────────────

    // Default per event type: 'ignore' for input/click/update, 'concurrent' for
    // collision. Locking is per script instance. No 'queue' mode — see spec §5.7.
    type Concurrency = 'concurrent' | 'ignore' | 'restart';

    // Which edge of a sustained event fires the handler. Inputs have all three;
    // instantaneous events (creator-sent via entity.send) only ever fire 'press'.
    type EventPhase = 'press' | 'release' | 'hold';

    interface HandlerOptions {
        concurrency?: Concurrency;
        on?: EventPhase; // default 'press'
    }

    // ctx carries ONLY event data. World access is ambient via this.scene / this.game.
    interface Ctx {
        player?: Player; // acting player
        other?: Entity; // collision partner
        value?: number; // axis actions, -1..1
        dt: number; // seconds since last tick
        alive: boolean; // false once the owning entity dies

        // The send() payload, unwrapped: send('damage', { amount: 10 }) reads as
        // ctx.data.amount. Always an object — {} for events carrying no payload
        // (input, collision, lifecycle), so a handler never null-checks it.
        // Read-only: writing to it does not reach the sender or other handlers.
        data: Readonly<Record<string, unknown>>;

        // The entity that called send(), when there was one. null for engine events
        // and for a send() from a Game handler. `other` stays the collision partner
        // and is never overloaded with this.
        from?: Entity | null;
    }

    // Decorator arguments must be static: tags, action names, prefab keys.
    // Handlers are async by default and re-enter unless given a concurrency mode.

    // ONE event decorator. The argument says WHAT to listen for, opts.on says WHICH
    // EDGE. Phase is never a separate decorator: a bare @onRelease would be a no-op
    // alone and ambiguous when stacked on two @onEvents.
    //
    // The event name is one of three kinds, told apart by its namespace prefix:
    //
    //   'jump'          panel-defined action  — rebindable, per-player, the default
    //   'keys:KeyW'     platform device event — physical code, NOT rebindable
    //   'damage'        creator-sent          — delivered by entity.send()
    //
    // Prefer bare action names. A device literal opts out of the binding layer:
    // input.rebind cannot reach it, per-player binding sets do not apply, and two
    // local co-op players on one keyboard both fire the same handler. The panel warns
    // when a published game contains one (same mechanism as the mobile hover warning,
    // spec §7.1). Device codes are PHYSICAL positions, never characters — 'keys:KeyW'
    // is the left-ring-finger key on any layout.
    //
    // Creator-sent events are addressed, not broadcast: entity.send(name, payload)
    // reaches that entity's own handlers, and the payload arrives as ctx.data. Names
    // are creator-chosen and share the namespace with panel actions, so the panel
    // rejects a send name that collides with a declared action. Only 'press' fires —
    // a send is instantaneous, so 'release' and 'hold' are a load-time error on a
    // handler for a creator-sent name.
    //
    //   class Enemy extends Script {
    //       @state health = 3;
    //
    //       @onEvent('damage')
    //       hurt(ctx: Ctx) {
    //           this.health -= ctx.data.amount as number;
    //           if (this.health <= 0) this.entity.destroy();
    //       }
    //   }
    //
    //   // from a sword script, on the entity it hit:
    //   ctx.other!.send('damage', { amount: 10, from: this.entity });

    // @onStart: Game = world created | Player = this player joined | Script = entity created
    // @onEnd:   Player = this player left | Script = entity destroyed
    function onStart(target: unknown, key: string): void;
    function onUpdate(target: unknown, key: string): void; // every simulation tick (60 Hz)
    function onEnd(target: unknown, key: string): void;

    function onPlayerJoin(target: unknown, key: string): void; // optional — avatar spawns without it
    function onPlayerLeave(target: unknown, key: string): void; // best-effort; not a save path

    function onEvent(event: string, opts?: HandlerOptions): MethodDecorator;

    // Sugar over onEvent — each sets opts.on and nothing else. Text tier only; the
    // block tier renders one hat with action and phase dropdowns, so these cost no
    // palette slots. Canonical spelling in docs and blocks is @onEvent(action, { on:
    // ... }); these exist because release/hold handlers read better with the phase in
    // the name.
    function onEventRelease(event: string, opts?: HandlerOptions): MethodDecorator;
    function onEventHold(event: string, opts?: HandlerOptions): MethodDecorator; // per tick; ctx.value

    function onCollide(tag: string, opts?: HandlerOptions): MethodDecorator; // ctx.other
    function onEnter(region: string): MethodDecorator;
    function onExit(region: string): MethodDecorator;

    function onClick(target: unknown, key: string): void; // ctx.player = who clicked
    function onHoverEnter(target: unknown, key: string): void; // never fires on touch
    function onHoverExit(target: unknown, key: string): void;

    // ─── state ─────────────────────────────────────────────────────

    // One decorator. Scope follows the class it is declared on:
    //   BaseGame subclass     -> global, replicated to everyone
    //   BasePlayer subclass   -> per-player, replicated to that player
    //   Script subclass       -> per-entity instance
    //   BaseMovement subclass -> per-entity instance; a movement type's own
    //                            state (aim, dash, coyote)
    function state(target: unknown, key: string): void;
    function persist(target: unknown, key: string): void; // composes with @state

    // ─── data wrappers ─────────────────────────────────────────────

    // Each hides a data structure AND its platform plumbing. Capped at six for MVP.
    // Dependency order: Countdown needs nothing, Storage is what BasePlayer reaches
    // back for, the rest are keyed by Player.

    class Countdown {
        constructor(seconds: number);
        readonly remaining: number;
        start(): void; // (B)
        pause(): void; // (B)
        reset(seconds?: number): void; // (B)
        // fires @onEnd on reaching zero
    }

    class Storage {
        constructor(player?: Player);
        get(key: string): Promise<unknown>; // (B)
        set(key: string, value: unknown): Promise<void>; // (B)
        delete(key: string): Promise<void>;
    }

    class Scoreboard {
        constructor();
        add(amount: number, player?: Player): void; // (B) defaults to acting player
        set(amount: number, player?: Player): void; // (B)
        of(player: Player): number; // (B)
        top(n: number): Player[]; // (B)
        reset(): void; // (B) manual — no automatic round reset
    }

    class Leaderboard {
        constructor(opts?: { order?: 'high' | 'low'; persist?: boolean });
        submit(score: number, player?: Player): void; // (B)
        of(player: Player): number; // (B)
        top(n: number): Array<{ player: Player; score: number }>; // (B)
        rankOf(player: Player): number; // (B)
    }

    class Inventory {
        constructor(player: Player);
        add(item: string, count?: number): void; // (B)
        remove(item: string, count?: number): void; // (B)
        has(item: string): boolean; // (B)
        count(item: string): number; // (B)
        clear(): void;
    }

    class Team {
        constructor(name: string);
        readonly name: string;
        readonly players: Player[];
        add(player: Player): void; // (B)
        remove(player: Player): void;
        has(player: Player): boolean; // (B)
    }

    // ─── motion helpers ────────────────────────────────────────────

    // The math that takes a body or camera rather than a scalar.

    function oscillate(entity: Entity, axis: 'x' | 'y', amount: number, seconds: number): void; // (B)
    function orbit(entity: Entity, center: Entity | Vec3, radius: number, speed: number): void; // (B)

    // Escape hatch and shared implementation under every named motion verb above.
    // NOT in the block palette, NOT in beginner docs.
    function tween(
        target: Entity | Camera | object,
        props: Record<string, number>,
        seconds: number,
        easing?: Easing,
    ): Promise<void>;

    // ─── audio ─────────────────────────────────────────────────────

    interface SoundHandle {
        stop(): void;
        volume: number;
    }

    interface SoundOptions {
        at?: Entity | Vec3; // positional
        for?: Player; // per-player scope
        volume?: number;
        loop?: boolean;
    }

    const sound: {
        play(asset: string, opts?: SoundOptions): SoundHandle; // (B)
        stopAll(): void;
        volume: number;
    };

    const music: {
        play(asset: string, opts?: { loop?: boolean; fade?: number }): SoundHandle; // (B)
        stop(fade?: number): void; // (B)
        volume: number;
    };

    // ─── hud ───────────────────────────────────────────────────────

    // Widgets are authored, positioned, and data-bound in the panel. Code never
    // passes a position, size, or parent — layout requires nesting, which the block
    // tier forbids. Every call is per-player by default.

    interface HudTarget {
        for?: Player;
        forAllExcept?: Player;
    }

    const hud: {
        text(widget: string, value: string, target?: HudTarget): void; // (B)
        number(widget: string, value: number, target?: HudTarget): void; // (B)
        bar(widget: string, fraction: number, target?: HudTarget): void; // (B) 0..1
        icon(widget: string, asset: string, target?: HudTarget): void; // (B)
        timer(widget: string, countdown: Countdown, target?: HudTarget): void;
        show(widget: string, target?: HudTarget): void; // (B)
        hide(widget: string, target?: HudTarget): void; // (B)
        enable(widget: string, target?: HudTarget): void; // (B)
        disable(widget: string, target?: HudTarget): void; // (B)
    };

    // Buttons are named in the panel and fire by name. Press feedback (hover, press
    // animation, disabled styling) is client-local and immediate; only the
    // consequence is authoritative.
    function onPress(widget: string): MethodDecorator; // ctx.player = who pressed

    // Not in MVP: containers, rows/columns/flex/grid, scroll views, text input,
    // drag-and-drop, nested widgets. See spec §12.4.
}
