// The read-side view of this game's replicated state, named once.
//
// `@serverState` hoists onto its host (§6.1), so `health` declared on Vitals reads as
// `player.health` anywhere — but only the panel knows what is attached, so a plain
// `Player` is untyped today. These accessors are the cast, in one deletable place.
//
// Not the declaration site: `@serverState` is ServerScript-only, so declarations
// live with their hosts — per-player in player.ts, global in game.ts.

import { game } from '@platform/engine';
import type { Game, Player, TopDownMovement } from '@platform/engine';
import type { WeaponKey } from './weapons.js';

/** Per-player state — declared by `Vitals` and `Loadout`. */
export type Fighter = Player & {
    health: number;
    alive: boolean;
    kills: number;
    isReady: boolean;
    equipped: WeaponKey;
    ammo: Record<WeaponKey, number>;
};

/** Global state — declared by `Match`. */
export type World = Game & {
    phase: Phase;
    left: number;
    ring: number;
    standing: number;
    winner: string; // '' while a round is live
    board: Array<{ name: string; wins: number }>;
};

export type Phase = 'lobby' | 'arena' | 'over';

export const fighter = (player: Player) => player as Fighter;
export const world = () => game as World;

// Same wart one level down: knobs live on the attached subclass, `player.movement`
// is typed as the base (§4.1). Optional rather than `!`: absent while spectating.
export const movementOf = (player: Player) => player.movement as TopDownMovement | undefined;
