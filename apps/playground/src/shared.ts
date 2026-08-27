// The app's own contract between its two halves: the browser bundle and the Node server process.
//
// It is deliberately dependency-free, because the two halves are compiled by different projects —
// `tsconfig.json` for the browser, `tsconfig.server.json` for Node — and this is the one file both
// include. `project.ts` is included by both too, but it imports `@platform/project` for its branded
// ids; keeping those out of here is what lets a test read a constant without a module graph.

/** Pressed on `mouse:0`; in the lobby the server answers by planting a leaf. */
export const ACTION_SPAWN = 'spawn';

/** An axis carrying the click's world y, biased by {@link AIM_BIAS}. */
export const ACTION_AIM_Y = 'aimY';

/** Pressed on `keys:KeyC`; the server destroys every leaf, for everyone. Lobby only. */
export const ACTION_CLEAR = 'clear';

/**
 * Held on WASD; both ends run the same script and move the avatar.
 *
 * Two axes, not one: a leaf drifts across the stage at whatever height the round dropped it, so an
 * avatar that could only move left and right would be able to reach one height out of the world's
 * whole extent — and the `bonus` band would be somewhere it could never stand.
 */
export const ACTION_LEFT = 'left';
export const ACTION_RIGHT = 'right';
export const ACTION_UP = 'up';
export const ACTION_DOWN = 'down';

/** Device codes the bindings resolve against. */
export const CODE_SPAWN = 'mouse:0';
export const CODE_AIM_Y = 'cursor:y';
export const CODE_CLEAR = 'keys:KeyC';
export const CODE_LEFT = 'keys:KeyA';
export const CODE_RIGHT = 'keys:KeyD';
export const CODE_UP = 'keys:KeyW';
export const CODE_DOWN = 'keys:KeyS';

/**
 * Added to the aim axis before it goes on the wire, and taken off on arrival.
 *
 * A value of exactly 0 is read as a neutral axis and dropped by the client's quantizer before it
 * has ever sent one, which would silently swallow the first click on the stage's centre line. The
 * bias keeps every legal world y clear of zero; it cancels out on both sides and means nothing.
 */
export const AIM_BIAS = 1000;

export function encodeAim(worldY: number): number {
    return worldY + AIM_BIAS;
}

export function decodeAim(value: number): number {
    return value - AIM_BIAS;
}

/**
 * The bindings this stage plays under.
 *
 * Structurally assignable to `@platform/client`'s `Binding` without importing it, so the Node half
 * can state the same contract the browser sends under.
 */
export type StageBinding =
    | { kind: 'button'; code: string; action: string }
    | { kind: 'axis'; code: string; action: string };

export const BINDINGS: StageBinding[] = [
    { kind: 'button', code: CODE_SPAWN, action: ACTION_SPAWN },
    { kind: 'button', code: CODE_CLEAR, action: ACTION_CLEAR },
    { kind: 'button', code: CODE_LEFT, action: ACTION_LEFT },
    { kind: 'button', code: CODE_RIGHT, action: ACTION_RIGHT },
    { kind: 'button', code: CODE_UP, action: ACTION_UP },
    { kind: 'button', code: CODE_DOWN, action: ACTION_DOWN },
    // A plain axis rather than `cursorY`: the value is already world space by the time the device
    // emits it, and `cursorY` would quantize it against a viewport it no longer measures.
    { kind: 'axis', code: CODE_AIM_Y, action: ACTION_AIM_Y },
];

/** The leaf itself, drawn the same for everyone. */
export const LEAF_TEMPLATE = 'leaf';
export const LEAF_ASSET = 'leaf';
export const LEAF_URL = '/leaf.png';

/** The badge parented above each leaf, tinted to say whose harvest it is worth triple. */
export const MARKER_ASSET = 'marker';
export const MARKER_URL = '/marker.png';
export const MARKER_PIXELS = { width: 8, height: 8 } as const;

/**
 * One tint per player slot.
 *
 * Colour is the only per-entity marker this wire can carry — a transform diff holds position,
 * rotation, scale, opacity and layer and nothing else — so the tint rides the TEMPLATE, and a
 * template per slot is what makes it per player. The badge is drawn from a white sprite rather than
 * the leaf, because a tint MULTIPLIES: `leaf.png` is green, so a red tint would return mud instead
 * of red. Eight hues, well separated on a dark stage, and {@link MAX_PLAYERS} is eight for that
 * reason — two players sharing a colour would make the ripe-for badge unreadable.
 */
export const PLAYER_TINTS = [
    0x52b788, // green
    0x64b5f6, // blue
    0xffb74d, // amber
    0xe5645c, // red
    0xba68c8, // violet
    0x4dd0e1, // cyan
    0xfff176, // yellow
    0xf06292, // pink
] as const;

/** Tabs, not people — a refresh under the same `?player=` id rejoins as the same player. */
export const MAX_PLAYERS = PLAYER_TINTS.length;

/** The slot a player's index falls in, wrapped so the palette may be shorter than `maxPlayers`. */
export function tintSlot(playerIndex: number): number {
    const n = PLAYER_TINTS.length;
    return (((playerIndex % n) + n) % n) | 0;
}

/** The template a given player's badge spawns under. */
export function markerTemplate(playerIndex: number): string {
    return `${MARKER_ASSET}-${tintSlot(playerIndex)}`;
}

export function tintFor(playerIndex: number): number {
    return PLAYER_TINTS[tintSlot(playerIndex)]!;
}

/** The same tint as CSS, for the swatch that tells a tab which leaves are ripe for it. */
export function tintCss(playerIndex: number): string {
    return `#${tintFor(playerIndex).toString(16).padStart(6, '0')}`;
}

/**
 * The avatar: one per connected tab, owned by that player, and the only thing here either end predicts.
 *
 * `'player'` is the name core's roster spawns an avatar under, so naming the template this is what lets
 * `player.spawn()` mint it with no roster configuration at all.
 */
export const AVATAR_TEMPLATE = 'player';

/** The shadow the avatar template mints beneath itself — a template subtree, not a runtime spawn. */
export const AVATAR_SHADOW_TEMPLATE = 'player-shadow';

/**
 * The winner's crown: declared mid-session rather than at boot.
 *
 * A template nothing has spawned yet needs no manifest entry, so this one is announced through
 * `declareVisuals` the first time a round is won — which is the path a later joiner's `Welcome`
 * and a connected peer's `manifest` envelope have to agree about.
 */
export const CROWN_TEMPLATE = 'crown';

/**
 * The ids the two halves name each other's script classes by.
 *
 * The wire's `attach` op carries one of these, never a class name: this app's browser half is
 * minified by Vite and its Node half is not, so `klass.name` agrees across the two only by accident.
 * Both registries are keyed by these, which is why there is one table and not one per template.
 */
export const SCRIPT_RUNNER = 'runner';
export const SCRIPT_RULES = 'rules';
export const SCRIPT_CLICKER = 'clicker';
export const SCRIPT_PROFILE = 'profile';
export const SCRIPT_HARVESTER = 'harvester';
export const SCRIPT_LEAF = 'leaf-script';
export const SCRIPT_LOBBY = 'lobby-screen';

/** World units one held tick moves the avatar. Constant, so both ends land on the same number. */
export const AVATAR_STEP = 4;

/**
 * Where an avatar stands, how large it draws, and how wide its harvest reach is.
 *
 * `marker.png` is 8x8, so {@link AVATAR_SCALE} is what makes the body 40 world px across — the same
 * width as the collider `Harvester` gives it. A sprite narrower than its own reach reads as leaves
 * being caught out of thin air.
 */
export const AVATAR_Y = -200;
export const AVATAR_HALF = 20;
export const AVATAR_SCALE = 5;

/**
 * Where a player's avatar starts, spread across the stage so no two spawn inside each other.
 *
 * Derived from {@link WORLD} rather than a fixed step: a fixed one put the last slot past the right
 * edge, and `teleportTo` does not clamp.
 */
export function avatarX(slot: number): number {
    const usable = WORLD.right - WORLD.left - 2 * AVATAR_HALF;
    return WORLD.left + AVATAR_HALF + (usable * (tintSlot(slot) + 0.5)) / MAX_PLAYERS;
}

/** `leaf.png` on disk, declared so the renderer's cull bounds match the art. */
export const LEAF_PIXELS = { width: 16, height: 16 } as const;

/**
 * How large a leaf draws, half the box it is caught through, and how fast it crosses.
 *
 * All three are shared: the authority makes the box a collider an avatar harvests through and moves
 * it at that speed, and the browser hit-tests a click against the same box — offset by the distance
 * the sprite is drawn behind, since it draws one send interval late. A ripened leaf grows, so the
 * browser scales the box by whatever the wire says the sprite's scale now is.
 */
export const LEAF_SCALE = 3;
export const LEAF_HALF = 22;
export const LEAF_SPEED = 240;

/** The tag the drift pass advances, which excludes each leaf's parented badge. */
export const LEAF_TAG = 'leaf';

/** What this app is, on the handshake. Both halves read it from here, which is the whole point. */
export const PROJECT_ID = 'grove-playground';

/**
 * The build of the contract in this file, bumped by hand when it changes incompatibly.
 *
 * A tab left open across a `dev` restart holds the old bundle, and the constants here — action
 * names, templates, script ids, tints, the world extent, the match rules — are what both ends agree
 * on. A mismatch used to show up as leaves drawn in the wrong place; now the server refuses the join
 * and the tab says to reload. It reaches the wire as the manifest's `contentHash`.
 */
export const PROJECT_HASH = '3';

/** The authoritative world, and the stage the browser draws it on. */
export const WORLD = { left: -480, right: 480, top: 270, bottom: -270 } as const;
export const DESIGN = { width: 960, height: 540 } as const;

/**
 * The two named rectangles the round is played across.
 *
 * `bonus` ripens a leaf that drifts through it, worth double to whoever harvests it; `compost` is
 * the strip a leaf nobody caught wilts into. Both are `@onEnter`/`@onExit` on the leaf, which is
 * what makes them regions rather than an `x >` test in the drift pass.
 */
export const REGION_BONUS = 'bonus';
export const REGION_COMPOST = 'compost';

export const BONUS_BOUNDS = { left: -140, right: 140, top: 270, bottom: -270 } as const;
export const COMPOST_BOUNDS = { left: 400, right: 480, top: 270, bottom: -270 } as const;

/** How long a round runs, and how long its result stays up before the lobby returns. */
export const ROUND_SECONDS = 45;
export const RESULTS_SECONDS = 8;

/** Seconds between the leaves the round drops. Deterministic — `game.random` picks the height. */
export const LEAF_INTERVAL = 0.9;

/** What a leaf is worth: walked into, ripened in `bonus`, badged for you, or merely clicked. */
export const HARVEST_POINTS = 2;
export const RIPE_MULTIPLIER = 2;
export const BADGE_BONUS = 3;
export const POP_POINTS = 1;

/** How many names the results screen ranks. */
export const BOARD_SIZE = 5;

/** The phases a match moves through. Rounds are the game's, not the engine's. */
export type MatchPhase = 'lobby' | 'playing' | 'results';

/**
 * The `@serverState` field names the HUD bridge reads back off the mirror.
 *
 * They are constants because the browser reads them from a host record by name — the field is
 * written by a `ServerScript` the browser never links, so a typo would read `undefined` forever
 * rather than failing to compile.
 */
export const STATE_PHASE = 'phase';
export const STATE_SECONDS_LEFT = 'secondsLeft';
export const STATE_READY_COUNT = 'readyCount';
export const STATE_PLAYER_COUNT = 'playerCount';
export const STATE_WINNER = 'winnerName';
export const STATE_WASTED = 'wasted';
export const STATE_ROUND = 'round';
export const STATE_SCORES = 'scores';
export const STATE_BOARD = 'board';

/**
 * Player-hosted, and so replicated only to the player it belongs to.
 *
 * `slot` is the palette seat the rules assigned, NOT `player.index`: core allocates indices from a
 * counter a leave never lowers, so after eight tabs have come and gone a ninth would take index 8
 * and share both a hue and a spawn point with whoever still holds index 0.
 */
export const STATE_READY = 'ready';
export const STATE_LIFETIME = 'lifetimeLeaves';
export const STATE_BEST = 'bestRound';
export const STATE_SLOT = 'slot';

/** Entity-hosted, on a leaf: set while it is inside `bonus`. */
export const STATE_RIPE = 'ripe';
/** Entity-hosted, on a leaf: the tint slot its badge carries, so the client can read it back. */
export const STATE_BADGE_SLOT = 'badgeSlot';

/**
 * The HUD widgets and screens this game writes.
 *
 * A widget name is the event name of an `@onPress` dispatch, so these are the one vocabulary the
 * browser's buttons and the authority's handlers share.
 */
export const WIDGET_READY = 'ready';
export const WIDGET_PHASE = 'phase';
export const WIDGET_CLOCK = 'clock';
export const WIDGET_SCORE = 'score';
export const WIDGET_LIFETIME = 'lifetime';
export const WIDGET_BEST = 'best';
export const WIDGET_WASTED = 'wasted';
export const WIDGET_WINNER = 'winner';
/** This tab's palette seat, so the swatch beside the score reads the same number the sprite is tinted with. */
export const WIDGET_SLOT = 'slot';

/** One widget per ranked row, so the results table travels through the HUD like everything else. */
export function rankWidget(row: number): string {
    return `rank-${row}`;
}

export const SCREEN_LOBBY = 'lobby';
export const SCREEN_RESULTS = 'results';

/** Where the game server listens, and what a browser dials when nothing overrides it. */
export const DEFAULT_GAME_PORT = 5174;

export function defaultGameUrl(hostname: string): string {
    return `ws://${hostname}:${DEFAULT_GAME_PORT}`;
}
