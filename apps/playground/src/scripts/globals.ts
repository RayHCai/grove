// The variables panel: every number and name the game is tuned by, in one place.
//
// It imports NOTHING — not the engine, not the host, not another script. That is what lets a script
// read it, the project file describe a world with it, and the browser shell draw a HUD against it,
// without any of the three learning about the other two.
//
// A creator edits this file. Everything else in `scripts/` is behaviour.

/** Pressed on `mouse:0`; in the lobby the server answers by planting a leaf. */
export const ACTION_SPAWN = 'spawn';

/** An axis carrying the click's world y, biased by {@link AIM_BIAS}. */
export const ACTION_AIM_Y = 'aimY';

/** Pressed on `keys:KeyC`; the server destroys every planted leaf, for everyone. Lobby only. */
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
 * The bindings this stage plays under.
 *
 * Structurally assignable to `@platform/client`'s `Binding` without importing it, which is what
 * keeps this file free of every package.
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

/** The authoritative extent, and the stage the browser draws it on. They MATCH under `fit`. */
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

export const LEAF_ASSET = 'leaf';
export const LEAF_URL = '/leaf.png';
export const LEAF_PIXELS = { width: 16, height: 16 } as const;

export const MARKER_ASSET = 'marker';
export const MARKER_URL = '/marker.png';
export const MARKER_PIXELS = { width: 8, height: 8 } as const;

/** The leaf itself, drawn the same for everyone. */
export const LEAF_TEMPLATE = 'leaf';

/**
 * The avatar, and the shadow its own template mints beneath it.
 *
 * `'player'` is the name core's roster spawns an avatar under, so naming the template this is what
 * lets `player.spawn()` mint it with no roster configuration at all.
 */
export const AVATAR_TEMPLATE = 'player';
export const AVATAR_SHADOW_TEMPLATE = 'player-shadow';

/**
 * The winner's crown: declared mid-session rather than at boot.
 *
 * A template nothing has spawned yet needs no manifest entry, so this one is announced through
 * `declareVisuals` the first time a round is won.
 */
export const CROWN_TEMPLATE = 'crown';

/**
 * One tint per palette seat.
 *
 * Colour is the only per-entity marker this wire can carry — a transform diff holds position,
 * rotation, scale, opacity and layer and nothing else — so the tint rides the TEMPLATE, and a
 * template per seat is what makes it per player. The badge is drawn from a white sprite rather than
 * the leaf, because a tint MULTIPLIES: `leaf.png` is green, so a red tint would return mud instead
 * of red. Eight hues, well separated on a dark stage, and {@link MAX_PLAYERS} is eight for that
 * reason — two concurrent players sharing a colour would make the ripe-for badge unreadable.
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

/** Concurrent tabs, not people — a refresh under the same id rejoins as the same player. */
export const MAX_PLAYERS = PLAYER_TINTS.length;

/** The seat an index falls in, wrapped so a stray number can never index out of the palette. */
export function tintSlot(slot: number): number {
    const n = PLAYER_TINTS.length;
    return (((slot % n) + n) % n) | 0;
}

/** The template a given seat's badge spawns under. */
export function markerTemplate(slot: number): string {
    return `${MARKER_ASSET}-${tintSlot(slot)}`;
}

export function tintFor(slot: number): number {
    return PLAYER_TINTS[tintSlot(slot)]!;
}

/** The same tint as CSS, for the swatch that tells a tab which leaves are ripe for it. */
export function tintCss(slot: number): string {
    return `#${tintFor(slot).toString(16).padStart(6, '0')}`;
}

/** World units one held tick moves it. Constant, so both ends land on the same number. */
export const AVATAR_STEP = 4;

/**
 * Where it stands, how large it draws, and how wide its harvest reach is.
 *
 * `marker.png` is 8x8, so {@link AVATAR_SCALE} is what makes the body 40 world px across — the same
 * width as the collider `Harvester` gives it. A sprite narrower than its own reach reads as leaves
 * being caught out of thin air.
 */
export const AVATAR_Y = -200;
export const AVATAR_HALF = 20;
export const AVATAR_SCALE = 5;

/**
 * Where a seat's avatar starts, spread across the stage so no two spawn inside each other.
 *
 * Derived from {@link WORLD} rather than a fixed step: a fixed one put the last seat past the right
 * edge, and `teleportTo` does not clamp.
 */
export function avatarX(slot: number): number {
    const usable = WORLD.right - WORLD.left - 2 * AVATAR_HALF;
    return WORLD.left + AVATAR_HALF + (usable * (tintSlot(slot) + 0.5)) / MAX_PLAYERS;
}

/** The tag the drift pass advances, which excludes each leaf's parented badge. */
export const LEAF_TAG = 'leaf';

/**
 * How large a leaf draws, half the box it is caught through, and how fast it crosses.
 *
 * All three are read by both halves: the authority makes the box a collider an avatar harvests
 * through and moves it at that speed, and the browser hit-tests a click against the same box —
 * offset by the distance the sprite is drawn behind, since it draws one send interval late.
 */
export const LEAF_SCALE = 3;
export const LEAF_HALF = 22;
export const LEAF_SPEED = 240;

/** Degrees per second, CCW-positive. */
export const LEAF_SPIN = 90;

/** How much wider a leaf draws while it is ripe, so `bonus` is legible without a second sprite. */
export const RIPE_SCALE = LEAF_SCALE * 1.35;

/**
 * Half a sprite's width, in world px, used as the off-stage margin.
 *
 * A leaf spawns this far left of the world's left edge and is retired this far right of its right
 * edge, so it slides fully into view and fully out rather than popping.
 */
export const EDGE_MARGIN = 32;

/**
 * The badge parented above each leaf: how big, how far above, and how solid.
 *
 * `marker.png` is 8x8, so scale 2 draws it at 16 world px — a third of a leaf, large enough to read
 * as a colour at a glance without competing with the art. It does not inherit its parent's
 * rotation, so it rides upright over a tumbling leaf.
 */
export const MARKER_SCALE = 2;
export const MARKER_OFFSET_Y = 34;
export const MARKER_OPACITY = 1;

/** Draw order: the badge sits above its leaf. */
export const LEAF_LAYER = 10;
export const MARKER_LAYER = 11;

/** The phases a match moves through. Rounds are the game's, not the engine's. */
export type MatchPhase = 'lobby' | 'playing' | 'results';

/** How long a round runs, and how long its result stays up before the lobby returns. */
export const ROUND_SECONDS = 45;
export const RESULTS_SECONDS = 8;

/** Seconds between the leaves the round drops. The height is `game.random`'s. */
export const LEAF_INTERVAL = 0.9;

/** What a leaf is worth: walked into, ripened in `bonus`, badged for you, or merely clicked. */
export const HARVEST_POINTS = 2;
export const RIPE_MULTIPLIER = 2;
export const BADGE_BONUS = 3;
export const POP_POINTS = 1;

/** How many names the results screen ranks. */
export const BOARD_SIZE = 5;

/**
 * Game-hosted, so every peer sees them.
 *
 * They are constants because the browser reads them off a host record BY NAME — the field is
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
 * Player-hosted, and so replicated only to the player they belong to.
 *
 * `slot` is the palette seat the rules assigned, NOT `player.index`: core allocates indices from a
 * counter a leave never lowers, so after eight tabs have come and gone a ninth would take index 8
 * and share both a hue and a spawn point with whoever still holds index 0.
 */
export const STATE_READY = 'ready';
export const STATE_LIFETIME = 'lifetimeLeaves';
export const STATE_BEST = 'bestRound';
export const STATE_SLOT = 'slot';

/** Entity-hosted, on a leaf. */
export const STATE_RIPE = 'ripe';
export const STATE_BADGE_SLOT = 'badgeSlot';

/**
 * The widgets and screens this game writes.
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
/** This tab's palette seat, so the swatch reads the number the sprite is tinted with. */
export const WIDGET_SLOT = 'slot';

/** One widget per ranked row, so the results table travels through the HUD like everything else. */
export function rankWidget(row: number): string {
    return `rank-${row}`;
}

export const SCREEN_LOBBY = 'lobby';
export const SCREEN_RESULTS = 'results';

/**
 * The wire's `attach` op carries one of these, never a class name: the browser half is minified by
 * Vite and the Node half is not, so `klass.name` agrees across the two only by accident.
 */
export const SCRIPT_RULES = 'rules';
export const SCRIPT_CLICKER = 'clicker';
export const SCRIPT_PROFILE = 'profile';
export const SCRIPT_RUNNER = 'runner';
export const SCRIPT_HARVESTER = 'harvester';
export const SCRIPT_LEAF = 'leaf-script';
export const SCRIPT_LOBBY = 'lobby-screen';
