// Delegates to the runtime's PRNG store so every draw is captured by snapshot.

import type { Vec3 } from '@platform/math';
import { vec3 } from '@platform/math';
import { currentRuntime, hasRuntime } from './runtime.js';
import type { Runtime } from './runtime.js';

export interface Random {
    seed(n: number): void;
    between(min: number, max: number): number;
    pick<T>(list: T[]): T;
    chance(probability: number): boolean;
    pointIn(region: string): Vec3;
}

export class RuntimeRandom implements Random {
    readonly #rt: Runtime;

    constructor(rt: Runtime) {
        this.#rt = rt;
    }

    seed(n: number): void {
        this.#rt.prng.stream.seed(n);
    }

    between(min: number, max: number): number {
        return this.#rt.prng.stream.between(min, max);
    }

    pick<T>(list: T[]): T {
        return this.#rt.prng.stream.pick(list);
    }

    chance(probability: number): boolean {
        return this.#rt.prng.stream.chance(probability);
    }

    pointIn(region: string): Vec3 {
        const b = this.#rt.regions?.bounds(region);
        if (!b) return vec3();
        const lo = Math.min(b.left, b.right);
        const hi = Math.max(b.left, b.right);
        const loY = Math.min(b.top, b.bottom);
        const hiY = Math.max(b.top, b.bottom);
        return vec3(this.between(lo, hi), this.between(loY, hiY), 0);
    }
}

/** The creator-facing `random` const — a facade over the current runtime. */
export const random: Random = {
    seed: (n) => resolve().seed(n),
    between: (min, max) => resolve().between(min, max),
    pick: (list) => resolve().pick(list),
    chance: (p) => resolve().chance(p),
    pointIn: (region) => resolve().pointIn(region),
};

function resolve(): Random {
    if (!hasRuntime()) throw new Error('random used before a runtime exists — call loadGame first');
    return currentRuntime().random ?? new RuntimeRandom(currentRuntime());
}
