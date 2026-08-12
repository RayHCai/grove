import type { Entity } from './entity.js';
import type { Player } from './player.js';

export interface Ctx {
    player?: Player;
    other?: Entity;
    value?: number;
    dt: number;
    alive: boolean;
    data: Readonly<Record<string, unknown>>;
    from?: Entity | null;
    /** Server tick the acting client's input referenced — what `asSeen` keys against. */
    viewTick?: number;
}
