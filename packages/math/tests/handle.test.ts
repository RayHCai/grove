// Contract tests for generation-packed handles.
//
// The contract that breaks silently is that the packing is arithmetic. A `generation << 24 | index`
// version of this module round-trips every case below up to generation 127 and then hands back
// negative handles that collide with live ones, so generation 128 is pinned explicitly.

import { describe, it, expect } from 'vitest';
import {
    INDEX_RANGE,
    MAX_INDEX,
    MAX_GENERATION,
    FIRST_GENERATION,
    packHandle,
    handleIndex,
    handleGeneration,
    nextGeneration,
} from '../src/handle.js';
import * as math from '../src/index.js';

describe('handle constants', () => {
    it('addresses 2^24 slots per generation', () => {
        expect(INDEX_RANGE).toBe(16_777_216);
        expect(MAX_INDEX).toBe(16_777_215);
    });

    it('starts generations at 1 so a zeroed field is never a valid handle', () => {
        expect(FIRST_GENERATION).toBe(1);
        expect(packHandle(0, FIRST_GENERATION)).toBeGreaterThan(0);
    });

    it('caps the generation where packing would leave the safe-integer range', () => {
        expect(MAX_GENERATION).toBe(Math.floor(Number.MAX_SAFE_INTEGER / INDEX_RANGE));
        expect(Number.isSafeInteger(packHandle(MAX_INDEX, MAX_GENERATION))).toBe(true);
        expect(Number.isSafeInteger(packHandle(MAX_INDEX, MAX_GENERATION + 1))).toBe(false);
    });
});

describe('packHandle / handleIndex / handleGeneration', () => {
    it('round trips every index and generation pair', () => {
        const pairs: [number, number][] = [
            [0, FIRST_GENERATION],
            [1, FIRST_GENERATION],
            [7, 3],
            [MAX_INDEX, FIRST_GENERATION],
            [0, MAX_GENERATION],
            [MAX_INDEX, MAX_GENERATION],
        ];
        for (const [index, generation] of pairs) {
            const handle = packHandle(index, generation);
            expect(handleIndex(handle)).toBe(index);
            expect(handleGeneration(handle)).toBe(generation);
        }
    });

    it('extracts slot 0 and the highest slot from the same generation', () => {
        expect(packHandle(0, 1)).toBe(INDEX_RANGE);
        expect(handleIndex(packHandle(0, 1))).toBe(0);
        expect(handleIndex(packHandle(MAX_INDEX, 1))).toBe(MAX_INDEX);
        expect(handleGeneration(packHandle(0, 1))).toBe(1);
        expect(handleGeneration(packHandle(MAX_INDEX, 1))).toBe(1);
    });

    it('stays positive at generation 128, where a bitwise pack wraps int32', () => {
        const handle = packHandle(5, 128);
        expect(handle).toBeGreaterThan(0);
        expect(handleIndex(handle)).toBe(5);
        expect(handleGeneration(handle)).toBe(128);
        // What `(128 << 24) | 5` would have produced.
        expect(handle).not.toBe(-2_147_483_643);
    });

    it('never collides across the generations of one slot', () => {
        const seen = new Set<number>();
        for (let generation = 1; generation <= 300; generation++) {
            seen.add(packHandle(9, generation));
        }
        expect(seen.size).toBe(300);
        for (const handle of seen) expect(handle).toBeGreaterThan(0);
    });
});

describe('nextGeneration', () => {
    it('advances by one below the cap', () => {
        expect(nextGeneration(FIRST_GENERATION)).toBe(2);
        expect(nextGeneration(127)).toBe(128);
        expect(nextGeneration(MAX_GENERATION - 1)).toBe(MAX_GENERATION);
    });

    it('wraps to the first generation at the cap rather than leaving the safe range', () => {
        expect(nextGeneration(MAX_GENERATION)).toBe(FIRST_GENERATION);
        expect(nextGeneration(MAX_GENERATION + 1)).toBe(FIRST_GENERATION);
    });
});

describe('index re-exports', () => {
    it('exposes every handle symbol', () => {
        expect(math.INDEX_RANGE).toBe(INDEX_RANGE);
        expect(math.MAX_INDEX).toBe(MAX_INDEX);
        expect(math.MAX_GENERATION).toBe(MAX_GENERATION);
        expect(math.FIRST_GENERATION).toBe(FIRST_GENERATION);
        expect(math.packHandle).toBe(packHandle);
        expect(math.handleIndex).toBe(handleIndex);
        expect(math.handleGeneration).toBe(handleGeneration);
        expect(math.nextGeneration).toBe(nextGeneration);
    });
});
