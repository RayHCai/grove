// Contract tests for the numeric fallbacks.
//
// These guard values that reach the renderer from outside — a canvas that reports 0 during a
// resize, a camera zoom left NaN by a bad divide. `finiteOr` must keep a legitimate negative or
// zero coordinate, and `positiveOr` must reject 0 and -0, which is the whole difference between
// them.

import { describe, it, expect } from 'vitest';
import { finiteOr, positiveOr } from '../src/numeric.js';
import * as math from '../src/index.js';

describe('finiteOr', () => {
    it('keeps a finite value, sign and zero included', () => {
        expect(finiteOr(5, 1)).toBe(5);
        expect(finiteOr(-5.5, 1)).toBe(-5.5);
        expect(finiteOr(0, 1)).toBe(0);
        expect(finiteOr(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('keeps -0 as -0 rather than flattening it', () => {
        expect(Object.is(finiteOr(-0, 1), -0)).toBe(true);
    });

    it('falls back for NaN and both infinities', () => {
        expect(finiteOr(NaN, 1)).toBe(1);
        expect(finiteOr(Infinity, 1)).toBe(1);
        expect(finiteOr(-Infinity, 1)).toBe(1);
    });

    it('returns the fallback verbatim, even a non-finite one', () => {
        expect(finiteOr(NaN, -3)).toBe(-3);
        expect(Number.isNaN(finiteOr(NaN, NaN))).toBe(true);
    });
});

describe('positiveOr', () => {
    it('keeps a finite positive value', () => {
        expect(positiveOr(5, 1)).toBe(5);
        expect(positiveOr(0.5, 1)).toBe(0.5);
        expect(positiveOr(Number.MIN_VALUE, 1)).toBe(Number.MIN_VALUE);
    });

    it('rejects zero in both signs', () => {
        expect(positiveOr(0, 1)).toBe(1);
        expect(positiveOr(-0, 1)).toBe(1);
    });

    it('rejects negatives, NaN and both infinities', () => {
        expect(positiveOr(-5, 1)).toBe(1);
        expect(positiveOr(NaN, 1)).toBe(1);
        expect(positiveOr(Infinity, 1)).toBe(1);
        expect(positiveOr(-Infinity, 1)).toBe(1);
    });

    it('returns the fallback verbatim, even a non-positive one', () => {
        expect(positiveOr(0, 0)).toBe(0);
        expect(positiveOr(NaN, -2)).toBe(-2);
    });
});

describe('index re-exports', () => {
    it('exposes both fallbacks', () => {
        expect(math.finiteOr).toBe(finiteOr);
        expect(math.positiveOr).toBe(positiveOr);
    });
});
