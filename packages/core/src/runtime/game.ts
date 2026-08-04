import type { Bounds } from '@platform/math';
import type { BaseScript } from '../script/bases.js';
import type { Entity } from './entity.js';
import type { Player } from './player.js';
import type { Random } from './random.js';

export interface FindQuery {
    tag?: string;
    in?: string;
    near?: { of: Entity | Vec3; within: number };

    /**
     * Resolve against the world as the acting client saw it, not the live present.
     * Only legal in a server-side, input-originated handler (@onRequest); the engine
     * pulls the view tick from the dispatch context, clamps to MAX_REWIND_MS, and
     * validates against its own latency estimate. Load-time errors in a SyncedScript
     * and in handlers with no view tick (§5.4, DESIGN §8.1).
     */
    asSeen?: boolean;
}

export abstract class Game {
    readonly players!: Player[];
    readonly random!: Random;
    readonly entities!: Entity[];
    readonly bounds!: Bounds;

    spawn(_template: string, _x?: number, _y?: number): Entity { return null!; }
    find(_query: FindQuery): Entity[] { return []; }

    pause(): void {}
    resume(): void {}

    addScript(_script: new () => BaseScript<Game>): this { return this; }
}

export const game: Game = null!;

import type { Vec3 } from '@platform/math';
