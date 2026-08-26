// The app's own contract between its two halves: the browser bundle and the Node server process.
//
// It is deliberately dependency-free, because the two halves are compiled by different projects —
// `tsconfig.json` for the browser, `tsconfig.server.json` for Node — and this is the one file both
// include.

/** Pressed on `mouse:0`; the server answers by spawning a leaf. */
export const ACTION_SPAWN = 'spawn';

/** An axis carrying the click's world y, biased by {@link AIM_BIAS}. */
export const ACTION_AIM_Y = 'aimY';

/** Pressed on `keys:KeyC`; the server destroys every leaf, for everyone. */
export const ACTION_CLEAR = 'clear';

/** Held on `keys:KeyA` / `keys:KeyD`; both ends run the same script and move the avatar. */
export const ACTION_LEFT = 'left';
export const ACTION_RIGHT = 'right';

/** Device codes the bindings resolve against. */
export const CODE_SPAWN = 'mouse:0';
export const CODE_AIM_Y = 'cursor:y';
export const CODE_CLEAR = 'keys:KeyC';
export const CODE_LEFT = 'keys:KeyA';
export const CODE_RIGHT = 'keys:KeyD';

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
    // A plain axis rather than `cursorY`: the value is already world space by the time the device
    // emits it, and `cursorY` would quantize it against a viewport it no longer measures.
    { kind: 'axis', code: CODE_AIM_Y, action: ACTION_AIM_Y },
];

/** The leaf itself, drawn the same for everyone. */
export const LEAF_TEMPLATE = 'leaf';
export const LEAF_ASSET = 'leaf';
export const LEAF_URL = '/leaf.png';

/** The badge parented above each leaf, tinted to say who spawned it. */
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
 * of red. Eight hues, well separated on a dark stage; a ninth player repeats the first rather than
 * inventing a colour nobody could tell from it.
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

/** The same tint as CSS, for the swatch that tells a tab which leaves are its own. */
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

/** World units one held tick moves the avatar. Constant, so both ends land on the same number. */
export const AVATAR_STEP = 4;

/** Where an avatar stands, so two tabs do not spawn inside each other. */
export const AVATAR_Y = -200;

export function avatarX(playerIndex: number): number {
    return (playerIndex - 3.5) * 48;
}

/** `leaf.png` on disk, declared so the renderer's cull bounds match the art. */
export const LEAF_PIXELS = { width: 16, height: 16 } as const;

/** What this app is, on the handshake. Both halves read it from here, which is the whole point. */
export const PROJECT_ID = 'grove-playground';

/**
 * The build of the contract in this file, bumped by hand when it changes incompatibly.
 *
 * A tab left open across a `dev` restart holds the old bundle, and the constants below — action
 * names, templates, tints, the world extent — are what both ends agree on. A mismatch used to show
 * up as leaves drawn in the wrong place; now the server refuses the join and the tab says to reload.
 */
export const PROJECT_HASH = '1';

/** The authoritative world, and the stage the browser draws it on. */
export const WORLD = { left: -480, right: 480, top: 270, bottom: -270 } as const;
export const DESIGN = { width: 960, height: 540 } as const;

/** Where the game server listens, and what a browser dials when nothing overrides it. */
export const DEFAULT_GAME_PORT = 5174;

export function defaultGameUrl(hostname: string): string {
    return `ws://${hostname}:${DEFAULT_GAME_PORT}`;
}
