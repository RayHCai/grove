// Game is the session and the world. `abstract` so `new Game()` is a compile error while the
// engine still builds the one instance.

import type { Bounds, Vec3 } from '@platform/math';
import { bounds as makeBounds } from '@platform/math';
import type { EntityId } from '../ids.js';
import type { ScriptProps } from '@platform/project';
import type { BaseScript } from '../script/bases.js';
import { instantiate } from '../world/templates.js';
import type { Runtime } from './runtime.js';
import { currentRuntime } from './runtime.js';
import type { ScriptQuery } from './get-script.js';
import { scriptOnHost } from './get-script.js';
import { GAME_KEY } from './hosts.js';
import type { Entity } from './entity.js';
import type { Player } from './player.js';
import type { Random } from './random.js';

export interface FindQuery {
    tag?: string;
    in?: string;
    near?: { of: Entity | Vec3; within: number };
    /**
     * Resolve against the world as the acting client saw it — server-side, input-originated
     * handlers only. `find` reads it on a `near` query alone; a tag- or region-only one is live.
     */
    asSeen?: boolean;
}

export abstract class Game {
    /** @internal — the concrete runtime-backed subclass sets this. */
    protected rt!: Runtime;

    get players(): Player[] {
        return this.rt.wired.playerManager.players;
    }

    get random(): Random {
        return this.rt.wired.random;
    }

    get entities(): Entity[] {
        return this.rt.entities.liveIds().map((id) => this.rt.entityManager.facade(id));
    }

    get bounds(): Bounds {
        return this.rt.worldBounds ?? makeBounds(-1000, 1000, 1000, -1000);
    }

    /** Instantiates a template: its scripts and its subtree, journaled as one. */
    spawn(template: string, x?: number, y?: number): Entity {
        return instantiate(this.rt, template, { x: x ?? 0, y: y ?? 0 });
    }

    find(query: FindQuery): Entity[] {
        return this.rt.wired.query.find(query);
    }

    pause(): void {
        this.rt.paused = true;
    }

    resume(): void {
        this.rt.paused = false;
    }

    addScript(script: new (props?: ScriptProps) => BaseScript<Game>, props?: ScriptProps): this {
        this.rt.wired.wiring.attachToGame(this, script as never, props);
        return this;
    }

    /**
     * The Game's instance of `script`, or `null` when none is attached.
     *
     * This is how a script on any other host reaches the session's rules — `game.getScript(Rules)`
     * rather than a module-level slot the Game publishes itself into, which is per-process and so
     * belongs to whichever world loaded last.
     */
    getScript<T extends BaseScript<Game>>(script: ScriptQuery<T>): T | null {
        return scriptOnHost(this.rt, GAME_KEY, script);
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
        const g = currentRuntime().wired.gameInstance;
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
                (query.asSeen ? this.#rt.wired.lagRing.broadphaseAtLatest() : null) ??
                this.#rt.wired.broadphase;
            ids = bp.near(p.x, p.y, query.near.within);
        } else {
            ids = this.#rt.entities.liveIds();
        }

        return ids
            .map((id) => this.#rt.entityManager.facade(id))
            .filter((e) => {
                if (query.tag !== undefined && !e.hasTag(query.tag)) return false;
                if (
                    query.in !== undefined &&
                    !this.#rt.wired.regions.contains(query.in, e.position)
                )
                    return false;
                return true;
            });
    }
}
