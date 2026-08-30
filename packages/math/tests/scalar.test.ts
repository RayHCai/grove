// Contract tests for the scalar helpers.
//
// These are on the creator surface, so the edge behaviour is part of
// the public promise rather than an implementation detail: `clamp` normalizes a reversed
// range instead of returning NaN, and `lerp` is deliberately UNCLAMPED so tween code can
// extrapolate. Both `lerp` endpoints are asserted with exact equality rather than a
// tolerance, because a tween that lands at 0.6999999 on its final frame is a real bug.

import { describe, it, expect } from 'vitest';
import { DEG2RAD, RAD2DEG, clamp, lerp } from '../src/scalar.js';
import * as math from '../src/index.js';

describe('clamp', () => {
    it('passes a value already inside the range through unchanged', () => {
        expect(clamp(5, 0, 10)).toBe(5);
        expect(clamp(-5, -10, 10)).toBe(-5);
        expect(clamp(0.25, 0, 1)).toBe(0.25);
    });

    it('clamps to the bounds outside the range', () => {
        expect(clamp(-1, 0, 10)).toBe(0);
        expect(clamp(11, 0, 10)).toBe(10);
        expect(clamp(-100, -10, -5)).toBe(-10);
        expect(clamp(0, -10, -5)).toBe(-5);
    });

    it('is inclusive at both bounds', () => {
        expect(clamp(0, 0, 10)).toBe(0);
        expect(clamp(10, 0, 10)).toBe(10);
    });

    it('normalizes a reversed range instead of returning NaN', () => {
        expect(clamp(5, 10, 0)).toBe(5);
        expect(clamp(-1, 10, 0)).toBe(0);
        expect(clamp(11, 10, 0)).toBe(10);
    });

    it('gives the same answer for a range and its reverse', () => {
        for (const v of [-5, 0, 3, 10, 15]) {
            expect(clamp(v, 0, 10)).toBe(clamp(v, 10, 0));
        }
    });

    it('collapses to the single value when min equals max', () => {
        expect(clamp(-3, 4, 4)).toBe(4);
        expect(clamp(9, 4, 4)).toBe(4);
        expect(clamp(4, 4, 4)).toBe(4);
    });

    it('clamps infinities to the finite bounds', () => {
        expect(clamp(Infinity, 0, 1)).toBe(1);
        expect(clamp(-Infinity, 0, 1)).toBe(0);
    });

    it('leaves an unbounded side alone', () => {
        expect(clamp(1e9, 0, Infinity)).toBe(1e9);
        expect(clamp(-1e9, -Infinity, 0)).toBe(-1e9);
    });

    it('returns NaN for a NaN value', () => {
        // Both comparisons are false for NaN, so it falls through unchanged. Documented
        // here so a future rewrite via Math.min/Math.max does not silently change it.
        expect(clamp(NaN, 0, 10)).toBeNaN();
    });
});

describe('lerp', () => {
    it('returns exactly a at t = 0 and exactly b at t = 1', () => {
        expect(lerp(0.1, 0.7, 0)).toBe(0.1);
        expect(lerp(0.1, 0.7, 1)).toBe(0.7);
        expect(lerp(-5, 5, 0)).toBe(-5);
        expect(lerp(-5, 5, 1)).toBe(5);
        expect(lerp(1 / 3, 2 / 3, 1)).toBe(2 / 3);
    });

    it('interpolates the midpoint', () => {
        expect(lerp(0, 10, 0.5)).toBe(5);
        expect(lerp(-10, 10, 0.5)).toBe(0);
        expect(lerp(20, 30, 0.5)).toBe(25);
    });

    it('interpolates a quarter of the way', () => {
        expect(lerp(-10, 10, 0.25)).toBe(-5);
        expect(lerp(0, 8, 0.75)).toBe(6);
    });

    it('runs downhill when b is below a', () => {
        expect(lerp(10, 0, 0.5)).toBe(5);
        expect(lerp(10, 0, 0.25)).toBe(7.5);
        expect(lerp(100, -100, 1)).toBe(-100);
    });

    it('extrapolates past 1 rather than clamping', () => {
        expect(lerp(0, 10, 1.5)).toBe(15);
        expect(lerp(0, 10, 2)).toBe(20);
        expect(lerp(10, 20, 2)).toBe(30);
    });

    it('extrapolates below 0 rather than clamping', () => {
        expect(lerp(0, 10, -0.5)).toBe(-5);
        expect(lerp(10, 0, 2)).toBe(-10);
    });

    it('is constant when a equals b', () => {
        expect(lerp(5, 5, 0.3)).toBe(5);
        expect(lerp(5, 5, -7)).toBe(5);
        expect(lerp(5, 5, 42)).toBe(5);
    });
});

describe('DEG2RAD / RAD2DEG', () => {
    it('converts the cardinal angles exactly', () => {
        expect(45 * DEG2RAD).toBe(Math.PI / 4);
        expect(90 * DEG2RAD).toBe(Math.PI / 2);
        expect(180 * DEG2RAD).toBe(Math.PI);
        expect(360 * DEG2RAD).toBe(2 * Math.PI);
    });

    it('converts radians back to degrees exactly at the cardinals', () => {
        expect((Math.PI / 4) * RAD2DEG).toBe(45);
        expect((Math.PI / 2) * RAD2DEG).toBe(90);
        expect(Math.PI * RAD2DEG).toBe(180);
    });

    it('is a reciprocal pair', () => {
        expect(DEG2RAD * RAD2DEG).toBe(1);
        expect(1 / DEG2RAD).toBe(RAD2DEG);
    });

    it('round-trips degrees through radians', () => {
        // Angles whose radian form is a clean binary fraction of PI round-trip bit-exact;
        // the rest are only within float epsilon, so they get a tolerance.
        for (const deg of [0, 0.5, 22.5, 45, 90, 180, 270, 360, 720, -90, -180, -37.5]) {
            expect(deg * DEG2RAD * RAD2DEG).toBe(deg);
        }
        for (const deg of [7.5, 15, 30, 60, 120, 137.5, -33]) {
            expect(deg * DEG2RAD * RAD2DEG).toBeCloseTo(deg, 12);
        }
    });

    it('preserves sign, matching the y-up rotation convention', () => {
        expect(-90 * DEG2RAD).toBe(-(Math.PI / 2));
        expect(Math.sign(-1 * DEG2RAD)).toBe(-1);
    });
});

describe('index re-exports', () => {
    it('exposes every scalar symbol', () => {
        expect(math.clamp).toBe(clamp);
        expect(math.lerp).toBe(lerp);
        expect(math.DEG2RAD).toBe(DEG2RAD);
        expect(math.RAD2DEG).toBe(RAD2DEG);
    });
});
