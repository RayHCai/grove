// Seeded PRNG, so a prediction on the client draws the same numbers in the same order as the
// authority and reconciles. xoshiro128**: four 32-bit words, advanced with exact integer
// arithmetic only, period 2^128-1.

function rotl(x: number, k: number): number {
    return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function splitmix32(seed: number): number {
    seed = (seed + 0x9e3779b9) | 0;
    let z = seed;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
}

export class SeededRandom {
    #s0 = 0;
    #s1 = 0;
    #s2 = 0;
    #s3 = 0;

    constructor(seed = 1) {
        this.seed(seed);
    }

    seed(n: number): void {
        let s = n | 0;
        this.#s0 = splitmix32(s);
        s = (s + 0x9e3779b9) | 0;
        this.#s1 = splitmix32(s);
        s = (s + 0x9e3779b9) | 0;
        this.#s2 = splitmix32(s);
        s = (s + 0x9e3779b9) | 0;
        this.#s3 = splitmix32(s);
    }

    /** Returns a float in [0, 1). */
    next(): number {
        // Both multiplies: the `*9` is the second half of xoshiro128**'s scrambler, and without it
        // the low bits of the output carry the state's own linear structure straight through.
        const result = Math.imul(rotl(Math.imul(this.#s1, 5), 7), 9) >>> 0;
        const t = (this.#s1 << 9) >>> 0;

        this.#s2 ^= this.#s0;
        this.#s3 ^= this.#s1;
        this.#s1 ^= this.#s2;
        this.#s0 ^= this.#s3;

        this.#s2 ^= t;
        this.#s3 = rotl(this.#s3, 11);

        return result / 0x1_0000_0000;
    }

    between(min: number, max: number): number {
        return min + this.next() * (max - min);
    }

    pick<T>(list: readonly T[]): T {
        return list[Math.floor(this.next() * list.length)]!;
    }

    chance(probability: number): boolean {
        return this.next() < probability;
    }

    /** Captures the full state for snapshot/restore. */
    capture(): [number, number, number, number] {
        return [this.#s0, this.#s1, this.#s2, this.#s3];
    }

    /** Restores from a captured state. */
    restore(state: [number, number, number, number]): void {
        [this.#s0, this.#s1, this.#s2, this.#s3] = state;
    }
}
