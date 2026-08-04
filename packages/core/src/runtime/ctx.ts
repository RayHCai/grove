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
    /**
     * Server-side tick the acting client's input references, when there is one — the
     * dispatch context for @onRequest and any future input-originated server handler.
     * `asSeen` queries key against this. Absent for engine events, @onUpdate, and any
     * handler with no viewing client (DESIGN §8.1).
     */
    viewTick?: number;
}
