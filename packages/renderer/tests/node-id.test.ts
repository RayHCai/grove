// NAMED HIGH-RISK TEST (§7, §15): packed-id generation overflow.
//
// `generation * 2^24 + index` must be ARITHMETIC. JavaScript's `<<` and `|` coerce to
// int32, so `generation << 24` goes NEGATIVE at generation 128 and wraps to a value that
// collides with live handles. Every generation asserted below 128 would also pass under a
// bitwise implementation — the cases at and above 128 are the ones that catch it, so they
// are asserted explicitly rather than only inside a loop.

import { describe, it, expect } from 'vitest';
import {
    INDEX_RANGE,
    MAX_GENERATION,
    MAX_INDEX,
    NO_NODE,
    nodeGeneration,
    nodeIndex,
    packNodeId,
    type NodeId,
} from '../src/node-id.js';

describe('node-id constants', () => {
    it('sizes the index field at 2^24', () => {
        expect(INDEX_RANGE).toBe(16_777_216);
        expect(MAX_INDEX).toBe(16_777_215);
    });

    it('caps generations so the largest possible handle is exactly MAX_SAFE_INTEGER', () => {
        expect(MAX_GENERATION).toBe(536_870_911);
        expect(packNodeId(MAX_INDEX, MAX_GENERATION)).toBe(Number.MAX_SAFE_INTEGER);
        expect(Number.isSafeInteger(packNodeId(MAX_INDEX, MAX_GENERATION))).toBe(true);
    });
});

describe('NO_NODE', () => {
    it('is zero, so a zeroed field is never a live handle', () => {
        expect(NO_NODE).toBe(0);
        expect(nodeIndex(NO_NODE)).toBe(0);
        // Generation 0 is unreachable — the store starts at 1 — so index 0 here is not
        // mistakable for slot 0's real handle, which is packNodeId(0, 1).
        expect(nodeGeneration(NO_NODE)).toBe(0);
        expect(packNodeId(0, 1)).not.toBe(NO_NODE);
    });
});

describe('generation 128 and above — the int32 wrap (§7)', () => {
    it('stays positive at generation 128, where `gen << 24` goes negative', () => {
        const id = packNodeId(0, 128);
        expect(id).toBe(2_147_483_648); // 128 * 2^24
        expect(id).toBeGreaterThan(0);
        expect(Number.isSafeInteger(id)).toBe(true);
        expect(nodeGeneration(id)).toBe(128);
        expect(nodeIndex(id)).toBe(0);
    });

    it('does not agree with the bitwise form once the generation crosses 128', () => {
        // 127 is the last generation where int32 shifting happens to be right, so it is
        // asserted as EQUAL to make the 128 divergence unambiguous.
        expect(packNodeId(0, 127)).toBe((127 << 24) >>> 0);
        expect(128 << 24).toBe(-2_147_483_648);
        expect(packNodeId(0, 128)).not.toBe(128 << 24);
        expect(packNodeId(5, 200)).not.toBe((200 << 24) | 5);
        expect(packNodeId(5, 200)).toBe(200 * INDEX_RANGE + 5);
    });

    it('round-trips generations that a bitwise implementation would alias or truncate', () => {
        // 256 and 512 vanish entirely under `<< 24` (the low 8 bits of the generation are
        // all that survive), so they would decode as generation 0.
        const generations = [127, 128, 129, 255, 256, 257, 511, 512, 65_536, 16_777_216];
        for (const generation of generations) {
            for (const index of [0, 1, 12_345, MAX_INDEX]) {
                const id = packNodeId(index, generation);
                expect(Number.isSafeInteger(id)).toBe(true);
                expect(id).toBeGreaterThan(0);
                expect(nodeIndex(id)).toBe(index);
                expect(nodeGeneration(id)).toBe(generation);
            }
        }
    });

    it('keeps handles distinct across the wrap boundary', () => {
        const seen = new Set<number>();
        for (let generation = 120; generation <= 140; generation++) {
            for (const index of [0, 1, MAX_INDEX]) {
                seen.add(packNodeId(index, generation));
            }
        }
        // 21 generations x 3 indices, no collisions. Bitwise packing folds these together.
        expect(seen.size).toBe(21 * 3);
    });
});

describe('index bounds', () => {
    it('round-trips index 0 and MAX_INDEX at the first and last generation', () => {
        const cases: Array<[number, number]> = [
            [0, 1],
            [MAX_INDEX, 1],
            [0, MAX_GENERATION],
            [MAX_INDEX, MAX_GENERATION],
        ];
        for (const [index, generation] of cases) {
            const id = packNodeId(index, generation);
            expect(Number.isSafeInteger(id)).toBe(true);
            expect(nodeIndex(id)).toBe(index);
            expect(nodeGeneration(id)).toBe(generation);
        }
    });

    it('never lets the index field bleed into the generation field', () => {
        const a = packNodeId(MAX_INDEX, 7);
        const b = packNodeId(0, 8);
        expect(a + 1).toBe(b);
        expect(nodeGeneration(a)).toBe(7);
        expect(nodeGeneration(b)).toBe(8);
    });

    it('exhaustively round-trips a sweep of generations', () => {
        for (let generation = 1; generation < 4096; generation++) {
            const index = generation % INDEX_RANGE;
            const id = packNodeId(index, generation);
            expect(nodeIndex(id)).toBe(index);
            expect(nodeGeneration(id)).toBe(generation);
            expect(id).toBeGreaterThan(0);
        }
    });
});

describe('safe-integer guarantees', () => {
    it('keeps every handle in the sweep a safe integer', () => {
        const generations = [1, 2, 128, 1024, 1_000_000, MAX_GENERATION - 1, MAX_GENERATION];
        for (const generation of generations) {
            const id = packNodeId(MAX_INDEX, generation);
            expect(Number.isSafeInteger(id)).toBe(true);
            expect(id).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
        }
    });

    it('decodes with integer arithmetic — no fractional slop at the top of the range', () => {
        const id = (Number.MAX_SAFE_INTEGER - 1) as NodeId;
        expect(Number.isInteger(nodeIndex(id))).toBe(true);
        expect(Number.isInteger(nodeGeneration(id))).toBe(true);
        expect(nodeGeneration(id)).toBe(MAX_GENERATION);
        expect(nodeIndex(id)).toBe(MAX_INDEX - 1);
    });
});
