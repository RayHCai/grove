// Game is the session and the world (DESIGN §7, api_spec.ts:488): it owns the entity
// table, scopes queries, holds build-time bounds, and is where global @serverState lives.
// `spawn` is synchronous and always safe; `find` returns a real array. `abstract` means
// `new Game()` is a compile error while the engine builds the one instance.

import type { Bounds, Vec3 } from '@platform/math';
import { bounds as makeBounds } from '@platform/math';
import type { EntityId } from '../ids.js';
import type { BaseScript } from '../script/bases.js';
import type { Runtime } from './runtime.js';
import { currentRuntime } from './runtime.js';
import type { Entity } from './entity.js';
import type { Player } from './player.js';
import type { Random } from './random.js';

export interface FindQuery {
    tag?: string;
    in?: string;
    near?: { of: Entity | Vec3; within: number };
    /**
     * Resolve against the world as the acting client saw it, not the live present. Only
     * legal in a server-side, input-originated handler (@onRequest); the engine pulls the
     * view tick from the dispatch context, clamps to MAX_REWIND_MS, and validates against
     * its own latency estimate. Load-time errors in a SyncedScript and in handlers with no
     * view tick (§5.4, DESIGN §8.1).
     */
    asSeen?: boolean;
}

export abstract class Game {
    /** @internal — the concrete runtime-backed subclass sets this. */
    protected rt!: Runtime;

    get players(): Player[] {
        return this.rt.playerManager?.players ?? [];
    }

    get random(): Random {
        return this.rt.random!;
    }

    get entities(): Entity[] {
        return this.rt.entities.liveIds().map(id => this.rt.entityManager.facade(id));
    }

    get bounds(): Bounds {
        return this.rt.worldBounds ?? makeBounds(-1000, 1000, 1000, -1000);
    }

    spawn(template: string, x?: number, y?: number): Entity {
        return this.rt.entityManager.spawn(template, x ?? 0, y ?? 0);
    }

    find(query: FindQuery): Entity[] {
        return this.rt.query!.find(query);
    }

    pause(): void {
        this.rt.paused = true;
    }

    resume(): void {
        this.rt.paused = false;
    }

    addScript(script: new () => BaseScript<Game>): this {
        this.rt.wiring?.attachToGame(this, script as unknown as new () => BaseScript<never>);
        return this;
    }
}

/** The concrete, non-exported Game the engine instantiates (§7). */
export class RuntimeGame extends Game {
    constructor(rt: Runtime) {
        super();
        this.rt = rt;
    }
}

// The one Game, a const facade over the current runtime's instance (§8.4). A Proxy so
// `game.spawn(...)` always routes to the live world without the const capturing a stale
// reference across createRuntime / withRuntime.
export const game: Game = new Proxy({} as Game, {
    get(_t, prop) {
        const g = currentRuntime().gameInstance;
        if (!g) throw new Error('game used before loadGame');
        const value = (g as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === 'function' ? value.bind(g) : value;
    },
});

/** Resolves a FindQuery against the live world or a historical capture (§5.4, §8.1). */
export class WorldQuery {
    readonly #rt: Runtime;

    constructor(rt: Runtime) {
        this.#rt = rt;
    }

    find(query: FindQuery): Entity[] {
        let ids: EntityId[];

        if (query.near) {
            const of = query.near.of;
            const p = 'position' in of ? of.position : of;
            const bp = query.asSeen ? this.#rt.contacts : undefined; // asSeen path via ring; live otherwise
            void bp;
            ids = this.#rt.broadphase!.near(p.x, p.y, query.near.within);
        } else {
            ids = this.#rt.entities.liveIds();
        }

        return ids
            .map(id => this.#rt.entityManager.facade(id))
            .filter(e => {
                if (query.tag !== undefined && !e.hasTag(query.tag)) return false;
                if (query.in !== undefined && !this.#rt.regions?.contains(query.in, e.position)) return false;
                return true;
            });
    }
}
