// Game is the session and the world. `abstract` so `new Game()` is a compile error while the
// engine still builds the one instance.

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
     * Resolve against the world as the acting client saw it — server-side, input-originated
     * handlers only. `WorldQuery.find` does not honour it yet; only `Entity.getTouching` does.
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
        return this.rt.entities.liveIds().map((id) => this.rt.entityManager.facade(id));
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

/** The concrete Game the engine instantiates. */
export class RuntimeGame extends Game {
    constructor(rt: Runtime) {
        super();
        this.rt = rt;
    }
}

// A Proxy so the const never captures a stale instance across createRuntime / withRuntime.
export const game: Game = new Proxy({} as Game, {
    get(_t, prop) {
        const g = currentRuntime().gameInstance;
        if (!g) throw new Error('game used before loadGame');
        // Unbound on purpose: a bound copy pins the runtime it was read from, while `this` on a
        // `game.spawn(...)` call is this proxy and so resolves again through here.
        return (g as unknown as Record<string | symbol, unknown>)[prop];
    },
});

/** Resolves a FindQuery against the live world. */
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
            // asSeen resolves against the lag ring's latest capture, which marks nothing, so a
            // historical query stays invisible to replication.
            const bp =
                (query.asSeen ? this.#rt.lagRing?.broadphaseAtLatest() : null) ??
                this.#rt.broadphase!;
            ids = bp.near(p.x, p.y, query.near.within);
        } else {
            ids = this.#rt.entities.liveIds();
        }

        return ids
            .map((id) => this.#rt.entityManager.facade(id))
            .filter((e) => {
                if (query.tag !== undefined && !e.hasTag(query.tag)) return false;
                if (query.in !== undefined && !this.#rt.regions?.contains(query.in, e.position))
                    return false;
                return true;
            });
    }
}
