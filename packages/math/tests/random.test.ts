// Contract tests for the seeded PRNG.
//
// What breaks silently here is not randomness quality but reproducibility: a client predicting a
// tick draws from its own copy of this stream and reconciles against the authority's, so the
// contract is that one seed plus one call count determines the value exactly. `capture`/`restore`
// carry the same weight — they are what a rewind puts back, and a partial restore desynchronises a
// peer several ticks later, nowhere near the line that caused it.

import { describe, it, expect } from 'vitest';
import { SeededRandom } from '../src/random.js';
import * as math from '../src/index.js';

const drawn = (r: SeededRandom, n: number): number[] => Array.from({ length: n }, () => r.next());

/** How many of `draws` calls to `chance(p)` come up true, from a fixed seed. */
function hits(probability: number, draws = 10_000): number {
    const r = new SeededRandom(29);
    let n = 0;
    for (let i = 0; i < draws; i++) if (r.chance(probability)) n += 1;
    return n;
}

describe('seeding', () => {
    it('gives two generators on one seed the same stream', () => {
        const a = new SeededRandom();
        const b = new SeededRandom();
        a.seed(42);
        b.seed(42);
        expect(drawn(a, 32)).toStrictEqual(drawn(b, 32));
    });

    it('gives different seeds different streams', () => {
        const a = new SeededRandom(1);
        const b = new SeededRandom(2);
        expect(drawn(a, 16)).not.toStrictEqual(drawn(b, 16));
    });

    it('re-seeding rewinds to the same place', () => {
        const r = new SeededRandom();
        r.seed(7);
        const first = drawn(r, 16);
        r.seed(7);
        expect(drawn(r, 16)).toStrictEqual(first);
    });

    it('seeds from the constructor as `seed` would', () => {
        const constructed = new SeededRandom(99);
        const seeded = new SeededRandom();
        seeded.seed(99);
        expect(drawn(constructed, 8)).toStrictEqual(drawn(seeded, 8));
    });

    it('takes a negative or fractional seed without collapsing the state', () => {
        // `seed` truncates to int32, so these are legal inputs rather than errors — but two of them
        // must not land on one stream.
        const a = new SeededRandom(-1);
        const b = new SeededRandom(-2);
        expect(drawn(a, 8)).not.toStrictEqual(drawn(b, 8));
        expect(drawn(new SeededRandom(0), 8).every((v) => v >= 0 && v < 1)).toBe(true);
    });
});

describe('next', () => {
    it('stays inside [0, 1)', () => {
        const r = new SeededRandom(3);
        for (const v of drawn(r, 20_000)) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });

    it('does not repeat itself over a long run', () => {
        const r = new SeededRandom(5);
        const values = drawn(r, 20_000);
        // A state that collapsed to a fixed point still satisfies every bound above; only the
        // count of distinct values catches it.
        expect(new Set(values).size).toBeGreaterThan(19_900);
    });

    it('spreads across the unit interval rather than clustering in one octave', () => {
        // The `*9` half of the xoshiro128** scrambler is what makes this hold; dropping it leaves
        // the state's linear structure in the low bits, which a bucket count is blind to but a
        // per-bucket bound is not.
        const r = new SeededRandom(11);
        const buckets: number[] = Array.from({ length: 10 }, () => 0);
        const draws = 100_000;
        for (const v of drawn(r, draws)) buckets[Math.floor(v * 10)]! += 1;
        for (const count of buckets) {
            expect(count).toBeGreaterThan(draws / 10 - 1500);
            expect(count).toBeLessThan(draws / 10 + 1500);
        }
    });

    it('has a mean near a half, which a stuck high or low bit would move', () => {
        const r = new SeededRandom(13);
        const draws = 100_000;
        let total = 0;
        for (const v of drawn(r, draws)) total += v;
        expect(total / draws).toBeCloseTo(0.5, 2);
    });
});

describe('the derived draws', () => {
    it('between spans the range and includes neither the max nor anything outside it', () => {
        const r = new SeededRandom(17);
        for (const v of Array.from({ length: 5000 }, () => r.between(-10, 10))) {
            expect(v).toBeGreaterThanOrEqual(-10);
            expect(v).toBeLessThan(10);
        }
    });

    it('between with a reversed range walks downward rather than returning NaN', () => {
        const r = new SeededRandom(19);
        for (const v of Array.from({ length: 200 }, () => r.between(10, 0))) {
            expect(v).toBeGreaterThan(0);
            expect(v).toBeLessThanOrEqual(10);
        }
    });

    it('pick answers a member of the list, and reaches every one of them', () => {
        const r = new SeededRandom(23);
        const list = ['a', 'b', 'c', 'd'] as const;
        const seen = new Set<string>();
        for (let i = 0; i < 500; i++) {
            const picked = r.pick(list);
            expect(list).toContain(picked);
            seen.add(picked);
        }
        expect(seen.size).toBe(4);
    });

    it('chance is monotone in its probability, and absolute at the ends', () => {
        expect(hits(0)).toBe(0);
        expect(hits(1)).toBe(10_000);
        expect(hits(0.25)).toBeGreaterThan(hits(0.1));
        expect(hits(0.75)).toBeGreaterThan(hits(0.25));
        expect(hits(0.5)).toBeGreaterThan(4500);
        expect(hits(0.5)).toBeLessThan(5500);
    });
});

describe('capture / restore', () => {
    it('resumes the stream exactly where the capture was taken', () => {
        const r = new SeededRandom(31);
        drawn(r, 10);
        const state = r.capture();
        const expected = drawn(r, 10);

        drawn(r, 50); // carry on past it, the way a mispredicted tick does
        r.restore(state);
        expect(drawn(r, 10)).toStrictEqual(expected);
    });

    it('carries the whole state, not the seed it came from', () => {
        // Restoring by re-seeding would rewind to draw zero; the snapshot is mid-stream.
        const source = new SeededRandom(37);
        drawn(source, 5);
        const target = new SeededRandom(37);
        target.restore(source.capture());
        expect(drawn(target, 5)).toStrictEqual(drawn(source, 5));
    });

    it('captures a value, not a view — drawing after does not disturb it', () => {
        const r = new SeededRandom(41);
        const state = r.capture();
        const copy: [number, number, number, number] = [...state];
        drawn(r, 20);
        expect(state).toStrictEqual(copy);
    });

    it('holds four 32-bit words', () => {
        const state = new SeededRandom(43).capture();
        expect(state).toHaveLength(4);
        for (const word of state) {
            expect(Number.isInteger(word)).toBe(true);
            expect(word).toBeGreaterThanOrEqual(0);
            expect(word).toBeLessThanOrEqual(0xffffffff);
        }
    });
});

describe('the barrel', () => {
    it('re-exports the class this module declares', () => {
        expect(math.SeededRandom).toBe(SeededRandom);
    });
});
