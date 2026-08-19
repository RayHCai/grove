// Contract tests for typed-array growth.
//
// The subtle one is `fill`: it defaults the NEW tail only. A `fill` that started at 0 would erase
// the copied values with a plausible-looking default — scale 1, or the -1 the tree sentinels use —
// and every downstream read would still look sane, so each case below seeds the source with values
// that differ from the fill.

import { describe, it, expect } from 'vitest';
import { growF64, growI32, growU8, grownCapacity } from '../src/typed-array.js';
import * as math from '../src/index.js';

describe('growF64', () => {
    it('preserves the contents and zeroes the tail by default', () => {
        const src = Float64Array.from([1.5, -2.5, 3.5]);
        const next = growF64(src, 6);
        expect(next).not.toBe(src);
        expect(next.length).toBe(6);
        expect([...next]).toEqual([1.5, -2.5, 3.5, 0, 0, 0]);
    });

    it('applies the fill to the tail only', () => {
        const src = Float64Array.from([0, 0.25]);
        const next = growF64(src, 5, 1);
        expect([...next]).toEqual([0, 0.25, 1, 1, 1]);
    });

    it('leaves a zero fill as the plain zeroed tail', () => {
        const src = Float64Array.from([7, 8]);
        expect([...growF64(src, 4, 0)]).toEqual([7, 8, 0, 0]);
    });

    it('copies everything when the capacity does not change', () => {
        const src = Float64Array.from([1, 2, 3]);
        const next = growF64(src, 3, 1);
        expect([...next]).toEqual([1, 2, 3]);
    });
});

describe('growI32', () => {
    it('preserves the contents and zeroes the tail by default', () => {
        const src = Int32Array.from([4, -5]);
        const next = growI32(src, 4);
        expect(next).not.toBe(src);
        expect([...next]).toEqual([4, -5, 0, 0]);
    });

    it('applies a sentinel fill to the tail only', () => {
        const src = Int32Array.from([0, 2]);
        expect([...growI32(src, 5, -1)]).toEqual([0, 2, -1, -1, -1]);
    });

    it('leaves a zero fill as the plain zeroed tail', () => {
        expect([...growI32(Int32Array.from([9]), 3, 0)]).toEqual([9, 0, 0]);
    });
});

describe('growU8', () => {
    it('preserves the contents and zeroes the tail by default', () => {
        const src = Uint8Array.from([1, 0, 1]);
        const next = growU8(src, 5);
        expect(next).not.toBe(src);
        expect([...next]).toEqual([1, 0, 1, 0, 0]);
    });

    it('applies the fill to the tail only', () => {
        const src = Uint8Array.from([0, 0]);
        expect([...growU8(src, 4, 1)]).toEqual([0, 0, 1, 1]);
    });

    it('leaves a zero fill as the plain zeroed tail', () => {
        expect([...growU8(Uint8Array.from([1]), 3, 0)]).toEqual([1, 0, 0]);
    });
});

describe('grownCapacity', () => {
    it('doubles until it holds what is needed', () => {
        expect(grownCapacity(64, 65)).toBe(128);
        expect(grownCapacity(64, 129)).toBe(256);
        expect(grownCapacity(64, 1000)).toBe(1024);
    });

    it('never shrinks', () => {
        expect(grownCapacity(64, 64)).toBe(64);
        expect(grownCapacity(64, 1)).toBe(64);
        expect(grownCapacity(64, 0)).toBe(64);
    });

    it('always reaches at least the need, and always by doubling', () => {
        for (const needed of [1, 2, 63, 64, 65, 100, 4097]) {
            const capacity = grownCapacity(64, needed);
            expect(capacity).toBeGreaterThanOrEqual(needed);
            expect(capacity % 64).toBe(0);
        }
    });

    it('grows from an empty start rather than doubling zero forever', () => {
        expect(grownCapacity(0, 5)).toBe(8);
        expect(grownCapacity(0, 0)).toBe(1);
    });
});

describe('index re-exports', () => {
    it('exposes every growth helper', () => {
        expect(math.growF64).toBe(growF64);
        expect(math.growI32).toBe(growI32);
        expect(math.growU8).toBe(growU8);
        expect(math.grownCapacity).toBe(grownCapacity);
    });
});
