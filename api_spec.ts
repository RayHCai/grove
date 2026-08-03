// Game Platform — MVP API surface
// Origin at world center, y-up, pixels. Durations in seconds.
// Sim 60 Hz, replication 20 Hz. Input is tick-indexed.
//
// Six engine-owned objects, never subclassed: Entity Player Camera Asset Game HUD.
// Game IS the world — owns entities, holds build-time bounds, scopes spawn/find. No
// Scene (§3.4). HUD is one player's whole interface, client-side only (§12).
//
// All creator code lives in a script. Its `extends` clause declares two things:
//   LOCATION (base class)   ServerScript | ClientScript | SyncedScript
//   HOST (type parameter)   <Entity> <Player> <Game> <Camera> <HUDScreen>
//
//   class Pickup extends SyncedScript<Entity> { ... }
//
// Host decides @serverState scope, location decides trust — orthogonal (§5).
//
// ATTACHMENT: panel-primary. A script dropped on a template in the editor tray attaches
// to every instance spawned from it, wired at load time before any @onStart. No
// registration call. host.addScript(Class) is the code path and hits that ONE live host,
// never the template (§8.1).
//
// DETERMINISM for synced code: seeded random only, no storage/leaderboard reads, no
// wall-clock, no client-local values (camera.viewport), engine-guaranteed iteration
// order. ClientScript is exempt but may not write authoritative state. Load-time errors.
//
// Server -> client is implicit @serverState replication; client -> server is always an
// explicit request() answered by @onRequest. That asymmetry is the security model
// (§1, §5.9, §12).
//
// (B) = in the block palette (beginner tier).
// (M) = lives in packages/math, re-exported here. Math names no engine object and no
//       panel data, has no dependencies, and is testable with no world (§11).

declare module '@platform/engine' {
    // ─── primitives ────────────────────────────────────────────────

    interface Vec3 {
        // (M)
        x: number;
        y: number;
        z: number;
    }

    // (M) camera.viewport arithmetic is why math owns geometry, not just scalars.
    // TODO: world or entity space? How are bounds defined?
    interface Bounds {
        left: number;
        right: number;
        top: number;
        bottom: number;
    }

    type Easing = 'linear' | 'ease' | 'easeIn' | 'easeOut' | 'bounce'; // (M)

    // Templates are panel-authored data, spawned by string key. Deliberately no
    // code-reachable Template object: a runtime API that rewrote one would make "what does
    // this template do" unanswerable from the editor (§8.1).

    // Panel-side only — never referenced from code (§12).
    type HUDAnchor =
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

    function clamp(value: number, min: number, max: number): number; // (B) (M)
    function lerp(a: number, b: number, t: number): number; // (M)

    // Seeded stream: client and server draw the same numbers in the same order (§1.2).
    interface Random {
        seed(n: number): void; // (M) daily content, reproducible debugging
        between(min: number, max: number): number; // (B) (M)
        pick<T>(list: T[]): T; // (B) (M)
        chance(probability: number): boolean; // (B) (M)

        // Not (M): resolves a panel-authored region name, then calls math.
        pointIn(region: string): Vec3; // (B)
    }

    const random: Random;

    // ─── time ──────────────────────────────────────────────────────

    function sleep(seconds: number): Promise<void>; // (B)
    function every(seconds: number, fn: () => void): () => void; // (B) auto-cancels with host
    function after(seconds: number, fn: () => void): () => void; // (B)

    // ─── input ─────────────────────────────────────────────────────

    // Bindings are panel-authored and per-player. Actions double as the network protocol.
    interface InputBindings {
        rebind(action: string, bindings: string[]): void;
        addBinding(action: string, binding: string): void;
        getBindings(action: string): string[];
        resetBindings(action?: string): void;
        // TODO: what is this context
        setContext(context: string): void; // action groups; resolves conflicts
    }

    // This tick's input for the owning player. Tick-indexed and replay-safe, which is what
    // makes reconciliation work. Consumed by BaseMovement.readIntent / accelerate.
    interface ActionState {
        held(action: string): boolean; // down as of this tick
        pressed(action: string): boolean; // went down this tick
        released(action: string): boolean; // came up this tick
        axis(action: string): number; // -1..1
    }

    // ─── asset ─────────────────────────────────────────────────────

    // Immutable panel-loaded data, shared and referenced by key. First-class so code can
    // ASK about an asset instead of hard-coding constants (rule 3). Not a template, not a
    // host: no behavior.
    // TODO: do we even need this
    type AssetKind = 'texture' | 'atlas' | 'audio' | 'font' | 'clip' | 'effect';

    class Asset {
        readonly key: string;
        readonly kind: AssetKind;
        readonly loaded: boolean;

        readonly width: number; // textures/atlas frames; 0 otherwise
        readonly height: number;
        readonly duration: number; // audio and clips, seconds; 0 otherwise
    }

    // Every asset-taking API accepts either spelling. The string form is block-safe (a
    // dropdown of panel-loaded keys); the object form is for text-tier code.
    type AssetRef = Asset | string;

    // TODO: why do we have this — could be getAsset/getAssets helpers instead
    const assets: {
        get(key: string): Asset | null; // null for an unknown key
        all(kind?: AssetKind): Asset[]; // real array
    };

    // ─── attachments ───────────────────────────────────────────────

    // Leaf capabilities, not objects. Present on an Entity only if its template configures
    // them. Contrast a script, which is code the creator wrote.

    // Geometry and flags only; contact identity comes from Entity.getTouching.
    interface Collider {
        enabled: boolean;
        isTrigger: boolean; // fires enter/exit instead of blocking
        readonly bounds: Bounds; // see Bounds TODO
    }

    // The per-entity animator, not one clip. Clips are panel-authored assets referenced by
    // key. Mapping is panel-authored and one-way: it reads velocity, blocked and
    // @serverState, never the reverse.
    // TODO: per animation, or only the currently playing one?
    interface Animation {
        speed: number;

        // On screen now: a running play() clip, else the state machine's pick.
        // '' when nothing plays — never null.
        readonly clip: string;
    }

    // ─── entity ────────────────────────────────────────────────────

    // "Sprite" in blocks and beginner docs. The base world object: transform, identity,
    // lifecycle, tags.
    class Entity {
        readonly id: string;
        readonly owner: Player | null; // null for non-player entities

        position: Vec3;
        rotation: number; // degrees
        scale: number;
        opacity: number; // 0..1
        // TODO: generalize for 3D. position.z would work but affects math/distance.
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

        // attachments — template-configured
        collider?: Collider;
        animation?: Animation;

        // Pull-based counterpart to @onCollide — "am I still on the plate" vs "we just
        // touched". Filters the contact set BaseMovement.move already wrote this tick, so a
        // per-tick call is cheap.
        //
        // Blocking and trigger colliders both count; isTrigger decides whether you were
        // stopped, not whether you are touching. Excludes self and own parent/children,
        // engine-stable order, empty array / false without a collider, never null. Static
        // entities are reported individually despite merged geometry.
        getTouching(tag?: string): Entity[]; // real array
        isTouching(tag?: string): boolean; // (B) block-tier spelling

        // visibility and effects
        show(): this; // (B)
        hide(): this; // (B)

        // TODO: check how Scratch/Unity store, load, play and interrupt animations
        play(clip: AssetRef, opts?: { loop?: boolean }): Promise<void>; // (B) frame animation
        stopAnimation(): this; // (B)
        playEffect(name: AssetRef, opts?: { loop?: boolean }): this; // (B) cosmetic, client-side

        // Speech bubbles — replicated, one per entity, engine-placed. No per-player scope: a
        // bubble is entity state everyone sees, so a private message is a HUD widget (§3.7).
        say(text: string): this; // (B) persists
        say(text: string, seconds: number): Promise<void>; // (B) auto-clears
        think(text: string): this; // (B)
        think(text: string, seconds: number): Promise<void>;
        clearSay(): this; // (B)

        // lifecycle
        destroy(): void; // (B) cascades to attached children
        readonly alive: boolean;

        // Scripts — many per entity. The template drop covers every instance (§8.1); this
        // covers THIS entity only and leaves the template untouched.
        //
        // Any Entity-hosted class fits, and its own base class still decides location —
        // adding a Synced or Server script from a ClientScript is a load-time error. Runs
        // @onStart during the call. Re-adding an existing class is a no-op, so it is safe
        // from a handler that may run twice. No removeScript in MVP.
        addScript(script: new () => BaseScript<Entity>): this;

        // NO entity.movement: a movement class drives a player's avatar and nothing else, so
        // the accessor is player.movement. A non-player body uses the motion verbs above
        // from an ordinary script (§4.1).

        // Fire `event` at THIS entity's @onEvent handlers. Direct address, not a broadcast;
        // no game-wide bus in MVP. Also the only runtime path to a handler — no entity.on(),
        // so an entity's handler set is fully known from its attached scripts, which is what
        // lets the engine reject location violations at load time and keep dispatch order
        // stable. Cross-entity reactions go through addScript or @serverState.
        //
        // Dispatch is synchronous — every handler runs to its first await before send
        // returns, so an await-free handler's @serverState writes are visible on the next
        // line. The promise settles once all handlers finish, so await is a sequencing tool,
        // not a second delivery mode.
        //
        //   this.host.send('drain', { amount: 10 });            // fire, don't wait
        //   await door.send('open');                            // wait for it to finish
        //
        // Payload lands unwrapped on ctx.data: plain values plus Entity/Player refs only, no
        // functions or closures. Omitted payload gives {}, never undefined.
        //
        // Runs at the sender's location — from a SyncedScript on both machines, from a
        // ServerScript server-side only, reaching clients as ordinary replication.
        // Location-mismatched handlers are skipped; a dead entity is a no-op that resolves
        // (§5.8).
        send(event: string, payload?: Record<string, unknown>): Promise<void>; // (B)
    }

    // ─── camera ────────────────────────────────────────────────────

    // Per-player and client-owned: presentation only, never authoritative. A ClientScript
    // may write it — the one exception to "client code never writes" — and server code
    // retains access for scripted sequences.
    class Camera {
        readonly player: Player; // whose view this is

        zoom: number;
        position: Vec3;

        // Constraint, not observation: where the camera MAY travel. Creator-written,
        // null = unconstrained.
        bounds: Bounds | string | null; // region name or explicit bounds

        // Observation, not constraint: the world-space rect seen right now, computed from
        // position, zoom and the client's window, so it is aspect-correct for free. Normally
        // contained by bounds.
        //
        // Depends on client-reported window size, so NOT readable from a SyncedScript — two
        // aspect ratios would diverge. Readable from a ServerScript, free from a
        // ClientScript.
        readonly viewport: Bounds;

        follow(target: Player | Entity | null): this; // (B) defaults to the owner's avatar
        moveTo(x: number, y: number): this; // (B)
        shake(strength: number, seconds: number): this; // (B)

        // TODO: what happens if it is already following something?
        glideTo(x: number, y: number, seconds: number, easing?: Easing): Promise<void>; // (B)
        zoomTo(zoom: number, seconds: number, easing?: Easing): Promise<void>; // (B)

        // Camera behaviors — lookahead, deadzone, shake-on-land — are Camera-hosted scripts,
        // naturally ClientScript<Camera> since they may read viewport.
        //
        // Not tray-attached: a camera is one object per player, not a template, so the panel
        // attaches these from the camera's own inspector. Runtime semantics match
        // Entity.addScript.
        addScript(script: new () => BaseScript<Camera>): this;
    }

    // ─── player ────────────────────────────────────────────────────

    // Position is state; clicks are ordinary actions (mouse:left is a binding). Per-player
    // and private — one player's cursor is invisible to others.
    interface Cursor {
        readonly position: Vec3; // (B) world space, via this player's camera
        readonly screenPosition: Vec3; // screen space, for HUD hit-testing
        readonly over: Entity | null; // (B) engine-computed, layer-ordered; null on empty space
        readonly isDown: boolean; // (B) mirror of the primary click action
        visible: boolean; // hide the OS cursor when drawing a custom one
        setIcon(icon: 'crosshair' | 'hand' | 'default' | AssetRef): void;
        lock(): void; // pointer lock; relative movement only
        unlock(): void;
        // touch: position follows last touch, over is non-null only during a touch, hover
        // events never fire
    }

    // Identity, engine-owned and never subclassed. The avatar is a body — if a value
    // survives respawn it belongs on a Player-hosted script, not on the avatar.
    //
    //   class Account extends ServerScript<Player> { @serverState credits = 0 }  ->  player.credits
    class Player {
        readonly id: string;
        readonly name: string;
        readonly index: number;
        readonly avatar: Entity;
        // TODO: if readonly, how is it set? How does this relate to camera.follow — does
        // following set player.camera? Need a setter so a custom Camera subclass can be used
        // per player; when custom cameras are instantiated is unspecified.
        readonly camera: Camera;
        readonly cursor: Cursor;
        readonly input: InputBindings;
        readonly storage: Storage; // wrapper declared under data wrappers

        spawn(): void; // (B)
        // TODO: game-specific logic?
        spectate(): void; // (B)
        // TODO: where is the checkpoint position stored
        respawn(): void; // (B) to last checkpoint

        teleportTo(x: number, y: number): void; // hard cut; resets client prediction

        // The movement class driving this player's avatar. Player-only: it turns one
        // player's input into one body's motion. Still an Entity-hosted script under the
        // hood (host is the avatar) — this is the named accessor the panel's animation config
        // and other scripts reach for.
        //
        // Undefined until a movement class is attached; a spectating or bodiless player has
        // none.
        movement?: Movement;
        // The Player template carries one movement slot, not a list — the only way the tray
        // treats movement differently from any other script (§8.1). This is the code path
        // for a mid-session swap.
        setMovement(movement: new () => BaseMovement): this; // concrete subclasses only

        // The Player template is the default path and the one the tray starts with (§8.1):
        // scripts dropped on it attach to every player at load time, the same mechanism that
        // spawns the avatar and attaches its camera with no join handler (§3.6). This is the
        // code path for THIS player only; semantics match Entity.addScript.
        addScript(script: new () => BaseScript<Player>): this;
    }

    // ─── hud ───────────────────────────────────────────────────────

    // One player's whole interface: exactly one per player, reached as `hud` from any
    // ClientScript (§12.1). Owns the always-on widget layer and every panel-authored
    // HUDScreen.
    //
    // CLIENT-SIDE, always. `hud` resolves to the local player's HUD, so there is no player
    // argument anywhere below. Cross-player messaging is a local branch over per-player
    // @serverState (§12.3). Touching `hud` from a Server or Synced script is a load-time
    // error.
    //
    // Widget verbs live HERE, not on HUDScreen, because a widget name is unique across the
    // whole HUD (panel-enforced) — that keeps `hud.text('score', ...)` one block with no
    // screen lookup. Widgets are authored and positioned in the panel; code never passes a
    // position, size or parent, since layout requires nesting and the block tier forbids it.
    class HUD {
        readonly player: Player; // the local player

        // ── widgets, by name ────────────────────────────────────────
        text(widget: string, value: string): void; // (B)
        number(widget: string, value: number): void; // (B)
        bar(widget: string, fraction: number): void; // (B) 0..1
        icon(widget: string, asset: AssetRef): void; // (B)
        timer(widget: string, countdown: Countdown): void;
        show(widget: string): void; // (B)
        hide(widget: string): void; // (B)
        enable(widget: string, enabled?: boolean): void; // (B) omitted = true
        disable(widget: string): void; // (B)

        // ── screens ─────────────────────────────────────────────────
        // Screens are panel-authored and addressed by name, so `hud.open('pause')` is one
        // block — this is what "screen switching from a ClientScript<Game>" (§1.1) calls.
        //
        // Opening runs the screen's @onStart and its scripts' constructors; closing runs
        // @onEnd and DISCARDS client state, so a menu reopens fresh — keep a value across
        // opens on a Player-hosted script. Both are idempotent.
        open(screen: string): HUDScreen; // (B) returns the now-open screen
        close(screen: string): void; // (B)
        closeAll(): void; // (B)

        // Lookup for an authored screen, open or not — the only way to get a HUDScreen other
        // than this.host. null for an unknown name.
        screen(name: string): HUDScreen | null;
        readonly screens: HUDScreen[]; // every authored screen; real array
        readonly openScreens: HUDScreen[]; // only the visible ones, bottom to top
    }

    // The LOCAL player's HUD. A const, not a member on Player: client code has exactly one
    // HUD it could mean, and `player.hud` would imply you could ask for someone else's.
    const hud: HUD;

    // ─── hud screen ────────────────────────────────────────────────

    // A panel-authored screen: a named set of widgets in a layout — pause menu, shop,
    // inventory, or the always-on gameplay overlay. Engine-owned and never subclassed;
    // creator logic attaches as ClientScript<HUDScreen>, which is where a menu keeps its
    // client state (selection, scroll, pending).
    //
    // The prefix is load-bearing: `Screen` reads as the display, and there are many of these
    // per player but only one display.
    //
    // ClientScript is the only legal location — a screen exists on one machine. Widgets are
    // NOT reachable from here; they are hud.* by name (§12.1).
    class HUDScreen {
        readonly name: string;
        readonly visible: boolean;

        // Sugar for hud.open/close(this.name). A screen closing itself is the common case (a
        // Close button), and `this.host.close()` beats naming yourself.
        open(): void; // (B)
        close(): void; // (B)

        // Panel attachment is the default path; this is the code path. Many per screen.
        //
        // Not tray-attached: a screen is panel-authored layout, so its scripts come from the
        // screen's own inspector. Attached at open, not at load — a screen never opened has
        // no script instances (§12.2).
        addScript(script: new () => BaseScript<HUDScreen>): this;
    }

    // ─── game ──────────────────────────────────────────────────────

    interface FindQuery {
        tag?: string;
        in?: string; // panel-authored region name
        // TODO: which distance metric
        near?: { of: Entity | Vec3; within: number };
    }

    // The session AND the world — one object, because a game has exactly one of each and a
    // second name for the same scope bought nothing (§3.4). Engine-owned and never
    // subclassed; orchestration lives in Game-hosted scripts, which is also where global
    // @serverState is declared.
    //
    // abstract because the engine builds the one instance: `new Game()` is a compile error.
    abstract class Game {
        readonly players: Player[];
        readonly random: Random;

        // Every live entity. The Game owns them, receives the loop, and scopes queries.
        readonly entities: Entity[];

        // The world's extent, FIXED AT BUILD TIME from the panel-authored world — not a
        // runtime value and not writable, which removes "which world am I in" from the API.
        // camera.bounds leashes to it; find({ in }) resolves regions inside it.
        readonly bounds: Bounds;

        // Eager and always safe: the world is built before @onStart and assets are preloaded
        // by the panel, so there is no load step to wait on.
        spawn(template: string, x?: number, y?: number): Entity; // (B)
        find(query: FindQuery): Entity[]; // real array

        // TODO: enforce single player only
        pause(): void; // (B) local run modes only
        resume(): void; // (B)

        // Not tray-attached: there is one Game, so its scripts come from the game's own
        // inspector. Load-time, before @onStart.
        addScript(script: new () => BaseScript<Game>): this;
    }

    // The one Game. A const like hud, random and assets, not a member on BaseScript: every
    // script needs the world, but only a Game-hosted script has it as its host, so reaching
    // it through `host` would work in one row of the §5 grid and fail in four.
    //
    // Writes are location-checked at load time, not by the type: spawn, destroy, pause and
    // resume from a ClientScript are load-time errors pointing at request(). Reads are
    // unrestricted.
    const game: Game;

    // ─── scripts ───────────────────────────────────────────────────

    // Where every line of creator logic lives. Host in the type parameter, location in the
    // base class — those two words are the whole execution model:
    //
    //               ServerScript          ClientScript           SyncedScript
    //   Entity      authoritative checks  local-only cosmetics   interaction — the default
    //   Player      balances, persistence local prefs, own HUD   predicted own-player state
    //   Game        the orchestrator      music, screen switching shared rules (rarely)
    //   Camera      scripted sequences    camera feel            load-time error
    //   HUDScreen   load-time error       menus and HUD          load-time error
    //
    // Camera and HUDScreen reject SyncedScript for the same reason: both are one player's
    // presentation, so there is no authoritative copy to reconcile against. HUDScreen
    // rejects ServerScript because a screen only exists on a client.
    //
    // HUD itself is NOT a host — anything attached to it a ClientScript<Game> could hold,
    // and `hud` is ambiently reachable from both.
    type Host = Entity | Player | Game | Camera | HUDScreen;

    // Never extended directly — it names no location, so the engine could not decide where
    // to run it. Load-time error. Extend one of the three below.
    //
    // ONE member. `host` is the only thing that varies with what a script is attached to,
    // and H is what types it. Everything else is either ambient (game, hud, random, assets)
    // or one step off the host:
    //
    //   this.host.owner      the player, on an Entity host (null on an unowned body)
    //   this.host.player     the player, on a Camera or HUDScreen host
    //   game.spawn/find      the world, from any host
    //   hud.*                the local player's interface, from a ClientScript
    //
    // No `entity` alias (H already types `host`) and no `player` (four different expressions
    // behind one name, and on a ClientScript it silently meant the local player instead of
    // the host's owner). See §5.2.
    abstract class BaseScript<H extends Host = Entity> {
        // The object this script is attached to.
        readonly host: H;
    }

    // Server only, and authoritative. The trust boundary lives here: @onRequest is
    // declarable on this base and no other. Exempt from the determinism rules — no second
    // copy to agree with — so it is the only place that may read storage and leaderboards.
    //
    //   class Account extends ServerScript<Player> {
    //       @serverState credits = 0;                     // -> player.credits
    //
    //       @onStart                                      // this player joined
    //       async load() { this.credits = (await this.host.storage.get('credits')) ?? 0 }
    //   }
    abstract class ServerScript<H extends Host = Entity> extends BaseScript<H> {}

    // Client only, no authority. Screens, menus, HUD, camera feel, cosmetic effects.
    //
    // Plain fields are client state: no decorator, one machine, dies with the host.
    // @serverState here is a load-time error pointing at request(), as is writing
    // authoritative state — entity transforms, mutating wrapper calls, spawn/destroy. Reads
    // are unrestricted, as are Math.random, wall-clock time and camera.viewport.
    //
    //   class Store extends ClientScript<HUDScreen> {
    //       selected = 'lantern';                  // client field, instant
    //       pending = false;
    //
    //       @onPress('buy')
    //       buy() {
    //           this.pending = true;               // grey out NOW
    //           request('buy', { item: this.selected });
    //       }
    //
    //       @onPress('close')
    //       dismiss() { this.host.close(); }       // the screen closes itself
    //
    //       @onUpdate                              // display rate, not simRate
    //       render() {
    //           hud.text('cost', `${PRICES[this.selected]} credits`);
    //           hud.enable('buy', !this.pending);
    //       }
    //   }
    abstract class ClientScript<H extends Host = Entity> extends BaseScript<H> {
        // The owner of this machine, always present. A member rather than ambient because on
        // the server "local" names nothing.
        //
        // NOT the host's owner: on a ClientScript<Entity> attached to an unowned rock,
        // localPlayer is whoever is watching while this.host.owner is null.
        readonly localPlayer: Player;
    }

    // Runs on both machines from one source: the server's run is authoritative, the client
    // re-produces it from the same tick-indexed inputs so the result is on screen
    // immediately, and on disagreement the server wins and the engine reconciles invisibly —
    // no creator-facing rollback hooks. The default for interactive logic, because the
    // creator writes one program and never learns the word "client"; the price is the
    // header's determinism rules, enforced at load time.
    //
    // A Player-hosted synced script re-produces only on that player's client. A Game-hosted
    // one re-produces on every client, multiplying the cost of a determinism slip — prefer
    // ServerScript for orchestration.
    //
    //   class Pickup extends SyncedScript<Entity> {
    //       @onCollide('player')
    //       collect(ctx: Ctx) {
    //           ctx.player!.credits += 1;   // @serverState from a Player-hosted script
    //           this.host.destroy();
    //       }
    //   }
    abstract class SyncedScript<H extends Host = Entity> extends BaseScript<H> {}

    // ─── movement ──────────────────────────────────────────────────

    // A SyncedScript<Entity> with a sealed tick — not a fourth kind of thing, so everything
    // §5 says about scripts applies. One instance wraps one body and owns its motion for the
    // tick; abstract, so there is no half-configured default to inherit.
    //
    // PLAYER-ONLY: the body is always a player's avatar, so the accessor is player.movement
    // (§3.2), and attaching to an unowned entity is a load-time error. A patrolling guard or
    // a conveyor uses the Entity motion verbs instead — this class turns input into
    // locomotion, and an AI has no input.
    //
    // TopDownMovement, PlatformerMovement and the rest are platform-authored subclasses in
    // the panel's drawer; the engine has no notion of a "mode". Style-specific state
    // (gravity, jump, facing, dash) belongs to the subclass — only what no subclass could
    // compute for itself lives here.
    //
    // ONE write channel: velocity (px/sec, world units, mutable) is the only representation
    // of motion and the only thing position derives from, so "set it" and "add to it" cannot
    // disagree by a factor of simRate. A subclass writes velocity or intent; discrete input
    // arrives via @onEvent and continuous input as intent, which is why there is no actions
    // parameter.
    abstract class BaseMovement extends SyncedScript<Entity> {
        // `host` is the avatar being driven, inherited from BaseScript.

        // The avatar's owner. Non-null here and nowhere else on an Entity host, since
        // attaching to an unowned entity is a load-time error. Declared so subclasses do not
        // write `this.host.owner!`.
        readonly player: Player;

        // Live, mutable, both replicated: velocity so clients can animate and interpolate,
        // intent so a server-set standing order (a cutscene walk, a conveyor) survives the
        // client's replay.
        velocity: Vec3; // px/sec, post-collision
        intent: Vec3; // -1..1 per axis; direction, not speed

        enabled: boolean; // (B) see "enabled" below — not a freeze

        // velocity.length(), px/sec — a read, not a knob. Locomotion speed is the subclass's
        // own field, since it is specific to the movement style.
        readonly speed: number;

        // Ceiling on total velocity, px/sec. Panel default, code overrides. The one
        // style-independent limit: every body needs a bound physics can trust.
        maxSpeed: number;

        // Which side stopped the body, written by the engine in move(). The one collision
        // result no subclass could compute for itself — a platformer's grounded is a getter
        // over blocked.down. Read it on the tick AFTER resolution; there is no collision
        // hook.
        //
        // Directional and about resolution, unlike Entity.getTouching, which is
        // identity-bearing and about overlap. A trigger collider never sets blocked.
        readonly blocked: { up: boolean; down: boolean; left: boolean; right: boolean };

        // ── the tick ────────────────────────────────────────────────
        // Sealed: this order IS the prediction contract, so overriding is a load-time error
        // rather than a subtle desync. The hooks below are the whole extension vocabulary.
        //
        //   1. accelerate(readIntent(), dt)   intent -> velocity
        //   2. applyForces(dt)                gravity, friction, drained forces
        //   3. clampSpeed()                   maxSpeed
        //   4. move(dt)                       engine: sweep, slide, write position,
        //                                     correct velocity, set blocked
        //
        // Runs before any script's @onUpdate, so handlers see this tick's resolved values.
        tick(dt: number): void;

        // ── public writes ───────────────────────────────────────────

        // Override the player's own steering — a cutscene walk, a tractor beam, an ice slide
        // that ignores held keys. The engine refills intent from the move axes every tick, so
        // this is a standing order only for the ticks a script keeps writing it. Decomposed
        // and normalized: one block with x/y slots, no vector literal.
        setIntent(x: number, y: number, z?: number): void; // (B)

        // Discrete velocity change, px/sec, never dt-scaled — jump, recoil, bounce pad.
        // Mass-free, so a tuned value transfers between bodies. Public because external force
        // comes from @onCollide handlers, which are synced too. 2D subclasses wrap this as
        // jump() and cardinal pushes.
        impulse(x: number, y: number, z?: number): void;

        // Continuous force, px/sec². Accumulates across callers and drains in applyForces,
        // so overlapping wind zones sum instead of fighting.
        addForce(x: number, y: number, z?: number): void;

        stop(): void; // (B) zero velocity and intent

        // ── hooks ───────────────────────────────────────────────────

        // The only required override: how this style turns direction into velocity. Instant
        // (top-down) vs accelerated (ice, vehicles) vs air-vs-ground (platformer) is most of
        // the difference between movement types.
        protected abstract accelerate(intent: Vec3, dt: number): void;

        // Where the body wants to go. Defaults to this.intent, which the engine fills from
        // the panel-mapped move axes. Override to read a non-axis source: a cursor angle, a
        // modal control scheme.
        protected readIntent(): Vec3;

        // Everything that moves the body unasked. Default drains the addForce accumulator; a
        // platformer adds gravity/friction here and calls super.
        protected applyForces(dt: number): void;

        // Default clamps total velocity to maxSpeed. Override for a terminal descent speed or
        // per-axis limits.
        protected clampSpeed(): void;

        // Frame-rate-independent move-toward-a-number: the primitive under every acceleration
        // and friction curve. Protected keeps the arithmetic out of the beginner tier. A thin
        // forward to the @platform/math function of the same name, tested there against dt
        // sequences rather than through an avatar.
        protected approach(current: number, target: number, rate: number): number;

        // Engine-owned, not overridable: sweeps along velocity, slides on contacts, writes
        // position, corrects velocity, sets blocked. No collision hook — a subclass reacts to
        // blocked next tick rather than intercepting resolution, which keeps client and server
        // in step.
        private move(dt: number): void;
    }

    // `enabled = false` suppresses intent only: readIntent yields zero, stages 2-4 still run.
    // Gravity keeps pulling, a moving body decelerates through its own friction instead of
    // halting midair, nothing teleports. The soft freeze in §3.6; hard freeze is stop() then
    // enabled = false.

    // ── shipped subclasses ──────────────────────────────────────────
    // Picked and configured in the panel; a creator subclasses one only to add a genuinely
    // new behavior (double jump, wall slide), not to change a number. The Movement suffix is
    // load-bearing: `Platformer` alone would name a whole category of experience (§4.1).

    class TopDownMovement extends BaseMovement {
        walkSpeed: number; // its own knob — `speed` is a reading
        protected accelerate(intent: Vec3, dt: number): void; // instant, no inertia
    }

    class PlatformerMovement extends BaseMovement {
        walkSpeed: number;
        gravity: number;
        jumpStrength: number;
        acceleration: number;
        friction: number;

        readonly grounded: boolean; // getter over blocked.down — derived, not tracked

        protected accelerate(intent: Vec3, dt: number): void;
        protected applyForces(dt: number): void;
        jump(): void; // @onEvent('jump'); override to add a double jump
    }

    // Alias for the attached subclass; the engine substitutes the template's.
    //
    // TODO: this is BaseMovement, so the knobs a creator reaches for — walkSpeed,
    // jumpStrength — need a cast:
    //   (player.movement as PlatformerMovement).walkSpeed = 300
    // Only the panel knows which subclass is attached. Same shape as the hoisted
    // @serverState TODO below; one panel-emitted-types answer should cover both. See §4.1.
    type Movement = BaseMovement;

    // ─── events ────────────────────────────────────────────────────

    // Default per event type: 'ignore' for input/click/update, 'concurrent' for collision.
    // Locking is per script instance. No 'queue' mode — see §5.7.
    type Concurrency = 'concurrent' | 'ignore' | 'restart';

    // Which edge of a sustained event fires the handler. Inputs have all three;
    // instantaneous events (creator-sent via entity.send) only ever fire 'press'.
    type EventPhase = 'press' | 'release' | 'hold';

    interface HandlerOptions {
        concurrency?: Concurrency;
        on?: EventPhase; // default 'press'
    }

    // ctx carries ONLY event data. The host is this.host; the world is the ambient `game`.
    interface Ctx {
        player?: Player; // acting player
        other?: Entity; // collision partner
        value?: number; // axis actions, -1..1
        dt: number; // seconds since last tick
        alive: boolean; // false once the owning host dies

        // The send() or request() payload, unwrapped: send('drain', { amount: 10 }) reads as
        // ctx.data.amount. Always an object — {} for events carrying no payload — so a
        // handler never null-checks it. Read-only: writing reaches neither the sender nor
        // other handlers.
        //
        // TRUSTED except in an @onRequest handler, where it crossed the network from a client
        // and must be validated. That is the only untrusted ctx.data.
        data: Readonly<Record<string, unknown>>;

        // The entity that called send(), when there was one. null for engine events, for a
        // send() from a Game-hosted script, and for every @onRequest. `other` stays the
        // collision partner and is never overloaded with this.
        from?: Entity | null;
    }

    // Decorator arguments must be static: tags, action names, template keys. Handlers are
    // async by default and re-enter unless given a concurrency mode.

    // ONE event decorator. The argument says WHAT to listen for, opts.on says WHICH EDGE.
    // Phase is never a separate decorator: a bare @onRelease would be a no-op alone and
    // ambiguous when stacked on two @onEvents.
    //
    // The event name is one of three kinds, told apart by its namespace prefix:
    //
    //   'jump'          panel-defined action  — rebindable, per-player, the default
    //   'keys:KeyW'     platform device event — physical code, NOT rebindable
    //   'drain'         creator-sent          — delivered by entity.send()
    //
    // Prefer bare action names. A device literal opts out of the binding layer —
    // input.rebind cannot reach it, per-player binding sets do not apply, and two local
    // co-op players on one keyboard both fire the same handler — so the panel warns on
    // publish (§7.1). Device codes are PHYSICAL positions, never characters: 'keys:KeyW' is
    // the left-ring-finger key on any layout.
    //
    // Creator-sent names share the namespace with panel actions, so the panel rejects a
    // collision with a declared action. Only 'press' fires — a send is instantaneous, so
    // 'release' and 'hold' are a load-time error here.
    //
    //   class Target extends SyncedScript<Entity> {
    //       @serverState durability = 3;
    //
    //       @onEvent('drain')
    //       reduce(ctx: Ctx) {
    //           this.durability -= ctx.data.amount as number;
    //           if (this.durability <= 0) this.host.destroy();
    //       }
    //   }
    //
    //   // from the script of an entity that made contact:
    //   ctx.other!.send('drain', { amount: 10, from: this.host });

    // @onStart / @onEnd mean "the host came into existence / stopped existing".
    // One rule, five hosts:
    //   Entity = created / destroyed        Camera    = session start / end
    //   Player = joined / left              HUDScreen = opened / closed
    //   Game   = world created / ended
    function onStart(target: unknown, key: string): void;
    function onUpdate(target: unknown, key: string): void; // simRate; display rate on a ClientScript
    function onEnd(target: unknown, key: string): void;

    // Roster changes, not per-player setup. Game-hosted ServerScript only.
    function onPlayerJoin(target: unknown, key: string): void; // optional — avatar spawns without it
    function onPlayerLeave(target: unknown, key: string): void; // best-effort; not a save path

    function onEvent(event: string, opts?: HandlerOptions): MethodDecorator;

    // Sugar over onEvent — each sets opts.on and nothing else. Text tier only; the block tier
    // renders one hat with action and phase dropdowns, so these cost no palette slots.
    // Canonical spelling is @onEvent(action, { on: ... }); these exist because release/hold
    // handlers read better with the phase in the name.
    function onEventRelease(event: string, opts?: HandlerOptions): MethodDecorator;
    function onEventHold(event: string, opts?: HandlerOptions): MethodDecorator; // per tick; ctx.value

    function onCollide(tag: string, opts?: HandlerOptions): MethodDecorator; // ctx.other
    function onEnter(region: string): MethodDecorator;
    function onExit(region: string): MethodDecorator;

    function onClick(target: unknown, key: string): void; // ctx.player = who clicked
    function onHoverEnter(target: unknown, key: string): void; // never fires on touch
    function onHoverExit(target: unknown, key: string): void;

    // ─── state ─────────────────────────────────────────────────────

    // One decorator. Scope follows the HOST of the script it is declared on — location
    // decides trust, host decides scope:
    //   <Game>      -> global, replicated to everyone
    //   <Player>    -> per-player, replicated to that player
    //   <Entity>    -> per-entity instance; also readable by the animation config
    //   <Camera>    -> not permitted; camera is client-owned presentation
    //   <HUDScreen> -> not permitted; use a plain field (ClientScript is client state)
    //
    // The name is the whole contract: the property lives on the SERVER, which owns,
    // replicates and PERSISTS it — every value is checkpointed against its host record and
    // restored next session. There is no @persist, since authoritative and durable are the
    // same set of values; session-only server data is a plain field.
    //
    // HOISTED onto the host, so declaration and access sites agree: `@serverState credits =
    // 0` on a Player-hosted script reads as `player.credits` anywhere, and `this.credits`
    // inside the declaring script is that same value, not a copy. Two scripts on one host
    // declaring the same name is a load-time error.
    //
    // TODO: hoisting is what keeps `ctx.player.credits` and the §5.8 "a handler answers by
    // writing @serverState the sender reads" contract working, but only the panel knows which
    // scripts are attached to which host, so the hoisted property is untyped on a plain
    // `Player` reference today. Same question as the Movement cast above.
    function serverState(target: unknown, key: string): void; // replicated AND persisted

    // ─── data wrappers ─────────────────────────────────────────────

    // Each hides a data structure AND its platform plumbing. Capped at six for MVP.
    // Dependency order: Countdown needs nothing, Storage is what Player reaches back for,
    // the rest are keyed by Player.

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
        reset(): void; // (B) manual — the engine never resets it for you
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

    // The math that takes a body or camera rather than a scalar, so NOT (M): each writes
    // replicated state and is cancelled when its host dies. The pure curve moved to math —
    // sine for oscillate, the circle for orbit, the easing tables for tween — leaving these
    // as the lifecycle around it.

    function oscillate(entity: Entity, axis: 'x' | 'y', amount: number, seconds: number): void; // (B)
    function orbit(entity: Entity, center: Entity | Vec3, radius: number, speed: number): void; // (B)

    // Escape hatch and shared implementation under every named motion verb above. NOT in the
    // block palette, NOT in beginner docs.
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
        play(asset: AssetRef, opts?: SoundOptions): SoundHandle; // (B)
        stopAll(): void;
        volume: number;
    };

    const music: {
        play(asset: AssetRef, opts?: { loop?: boolean; fade?: number }): SoundHandle; // (B)
        stop(fade?: number): void; // (B)
        volume: number;
    };

    // ─── hud interaction ───────────────────────────────────────────

    // The decorator half of HUD/HUDScreen. Buttons are named in the panel and fire by name.
    // On a ClientScript the handler is local, so hover, press animation, selection and
    // disabled styling resolve with no network involvement; only a request() crosses the
    // wire.
    //
    // On a ClientScript<HUDScreen> only presses on THIS screen's buttons fire, which keeps
    // two menus with a `back` button from colliding. On any other client host the widget is
    // resolved across the whole HUD.
    function onPress(widget: string): MethodDecorator; // ctx.player = the local player

    // ─── requests ──────────────────────────────────────────────────

    // The whole client -> server vocabulary. A function, not a method: the destination is
    // always "the server", so there is nothing to address. Callable from any ClientScript,
    // whatever its host.
    //
    // No return value — the answer arrives as replicated @serverState, same as send(), and
    // payload restrictions match it. Engine rate-limits per (player, name); excess is
    // dropped, never queued.
    function request(name: string, payload?: Record<string, unknown>): void;

    // Server-side entry point for the above, and the ONLY one — a separate decorator from
    // @onEvent so the trust boundary is a searchable word.
    //
    // Declarable on a ServerScript and nowhere else: a ClientScript handling its own request
    // is a contradiction, and a SyncedScript cannot predict a decision whose purpose is to be
    // checked. Both are load-time errors.
    //
    // ctx.player is engine-supplied from the connection and unforgeable.
    // ctx.data is the ONLY untrusted ctx.data in the API — validate it.
    // ctx.from is null; there is no sending entity.
    //
    //   class Storekeeper extends ServerScript<Game> {
    //       @onRequest('buy')
    //       buy(ctx: Ctx) {
    //           const cost = PRICES[ctx.data.item as string];
    //           if (cost === undefined) return;                // unknown item
    //           if (ctx.player!.credits < cost) return;        // insufficient balance
    //           ctx.player!.credits -= cost;
    //       }
    //   }
    //
    // Unhandled names are dropped and logged to the dev console. Concurrency defaults to
    // 'ignore' per instance — note a Game-hosted script has ONE instance, so that serializes
    // across all players (§5.9).
    function onRequest(name: string, opts?: HandlerOptions): MethodDecorator;
}
