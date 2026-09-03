// What both ends agree on: ids, the world's extent, the action names, and the numbers the scripts
// tune themselves by.
//
// It imports nothing from the platform and nothing from `scripts/`, so the project file, the two
// registries and every script can read it without either half pulling in the other's.

/** What this project IS, on the handshake. Both composition roots derive their claim from these. */
export const PROJECT_ID = 'grove-integration';
export const PROJECT_HASH = '1';

export const SIM_RATE = 60;
export const SEND_RATE = 20;
export const MAX_PLAYERS = 4;

/** Wide enough that four avatars start clear of each other and of both region edges. */
export const WORLD = { left: -320, right: 320, top: 180, bottom: -180 };

export const REGION_BONUS = 'bonus';
/**
 * The band an orb is worth more inside.
 *
 * Placed across the left of the world, where orbs enter: a region an orb only reaches at the end of
 * its life is one no test can rely on it reaching at all, since anything may take the orb first.
 */
export const BONUS_BOUNDS = { left: -280, right: -60, top: 70, bottom: -70 };

/** The key the roster spawns an avatar from. Named by core, not by this project. */
export const TEMPLATE_AVATAR = 'player';
export const TEMPLATE_SHADOW = 'shadow';
export const TEMPLATE_ORB = 'orb';

export const ASSET_DISC = 'disc';
/** Relative, because the client admits only `http:`, `https:` and paths — and nothing fetches it here. */
export const ASSET_DISC_URL = '/disc.png';
export const ASSET_DISC_PIXELS = { width: 24, height: 24 };

export const SCRIPT_RULES = 'rules';
export const SCRIPT_LEDGER = 'ledger';
export const SCRIPT_MOVER = 'mover';
export const SCRIPT_COLLECTOR = 'collector';
export const SCRIPT_ORB = 'orb';
export const SCRIPT_PROFILE = 'profile';
export const SCRIPT_PANEL = 'panel';

export const TAG_ORB = 'orb';

export const ACTION_LEFT = 'left';
export const ACTION_RIGHT = 'right';
export const ACTION_UP = 'up';
export const ACTION_DOWN = 'down';

export const CODE_LEFT = 'KeyA';
export const CODE_RIGHT = 'KeyD';
export const CODE_UP = 'KeyW';
export const CODE_DOWN = 'KeyS';

/** Structurally assignable to `@platform/client`'s `Binding`, which is what keeps this file free of it. */
export type StageBinding = { kind: 'button'; code: string; action: string };

export const BINDINGS: StageBinding[] = [
    { kind: 'button', code: CODE_LEFT, action: ACTION_LEFT },
    { kind: 'button', code: CODE_RIGHT, action: ACTION_RIGHT },
    { kind: 'button', code: CODE_UP, action: ACTION_UP },
    { kind: 'button', code: CODE_DOWN, action: ACTION_DOWN },
];

export const SCREEN_PANEL = 'panel';
export const WIDGET_SCORE = 'score';
export const WIDGET_SWEEP = 'sweep';

/** World units one held tick moves an avatar. A step, not a speed: both ends run at `simRate`. */
export const AVATAR_STEP = 3;
export const AVATAR_HALF = 12;

/** Seconds between drops, the seconds an undisturbed orb lives, and what one is worth. */
export const ORB_INTERVAL = 0.25;
export const ORB_LIFETIME = 5;
export const ORB_VALUE = 1;
export const ORB_BONUS_VALUE = 3;
export const ORB_HALF = 10;
/** World units an orb drifts per second. */
export const ORB_SPEED = 60;
/**
 * How far above and below the middle an orb may enter.
 *
 * Narrower than the world: an orb entering at the very top crosses at a height no avatar spends
 * time at, and the collision path is then a thing the driver can only reach by luck.
 */
export const ORB_BAND = 110;

/** The replicated field names, as a client reads them off a host facade. */
export const STATE_PHASE = 'phase';
export const STATE_ORBS = 'orbs';
/** Never 'players': a Game-hosted hoist by that name shadows `game.players` itself. */
export const STATE_PLAYERS = 'seated';
export const STATE_COLLECTED = 'collected';
/** The same total, split by how it was earned — walked into, or clicked from across the stage. */
export const STATE_WALKED = 'walked';
export const STATE_POPPED = 'popped';
/** Crossings into the bonus region and back out of it — the region pass's two edges, counted. */
export const STATE_RIPENED = 'ripened';
export const STATE_COOLED = 'cooled';
export const STATE_SWEEPS = 'sweeps';
export const STATE_VALUE = 'value';
export const STATE_RIPE = 'ripe';
/** Player-hosted: this session's take, and the total that outlives every session. */
export const STATE_TAKEN = 'taken';
export const STATE_LIFETIME = 'lifetime';
export const STATE_BEST = 'best';

export type MatchPhase = 'idle' | 'running';

/**
 * Where a player's avatar stands at a spawn, by the palette seat the rules gave them.
 *
 * A pure function of the seat so both a spawn and a respawn land on the same spot, and so a test
 * can say where an avatar should be without reading the world it is asserting on.
 */
export function avatarStart(seat: number): { x: number; y: number } {
    const lane = (WORLD.right - WORLD.left) / (MAX_PLAYERS + 1);
    // On the orbs' own line rather than at the foot of the world: standing still is then a way to
    // meet one, so the collision path does not depend on the driver steering into it.
    return { x: WORLD.left + lane * (seat + 1), y: -AVATAR_HALF * 5 };
}
