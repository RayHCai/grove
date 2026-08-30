// Contract tests for vectors.
//
// Two contracts here are invisible in the signatures and are the ones that break
// silently: the `out` helpers must return the very object they were handed (callers
// rely on that to stay allocation-free), and an omitted `Vec3Like.z` must read as 0
// even when it has to overwrite a stale non-zero `z` already sitting in `out`.

import { describe, it, expect } from 'vitest';
import type { MutableVec3 } from '../src/vec3.js';
import {
    vec3,
    vec3Set,
    vec3Copy,
    vec3Dist2D,
    vec3Length,
    vec3LengthSq,
    vec3Normalize,
} from '../src/vec3.js';
import * as math from '../src/index.js';

describe('vec3', () => {
    it('defaults every axis to 0', () => {
        expect(vec3()).toEqual({ x: 0, y: 0, z: 0 });
    });

    it('fills z with 0 when only x and y are given', () => {
        expect(vec3(10, 5)).toEqual({ x: 10, y: 5, z: 0 });
    });

    it('keeps the argument order x, y, z', () => {
        expect(vec3(1, 2, 3)).toEqual({ x: 1, y: 2, z: 3 });
    });

    it('allocates a new object per call', () => {
        const a = vec3(1, 2, 3);
        const b = vec3(1, 2, 3);
        expect(a).not.toBe(b);
        a.x = 99;
        expect(b.x).toBe(1);
    });
});

describe('vec3Set', () => {
    it('returns the object it was handed rather than a copy', () => {
        const out = vec3();
        expect(vec3Set(out, 1, 2, 3)).toBe(out);
    });

    it('writes all three axes into out', () => {
        const out = vec3(-1, -1, -1);
        vec3Set(out, 4, -5, 6);
        expect(out).toEqual({ x: 4, y: -5, z: 6 });
    });

    it('resets a stale z to 0 when z is omitted', () => {
        const out = vec3(1, 2, 3);
        vec3Set(out, 7, 8);
        expect(out.z).toBe(0);
    });
});

describe('vec3Copy', () => {
    it('returns the object it was handed rather than a copy', () => {
        const out = vec3();
        expect(vec3Copy(out, { x: 1, y: 2 })).toBe(out);
    });

    it('fills an omitted src.z with 0', () => {
        const out = vec3();
        vec3Copy(out, { x: 10, y: 5 });
        expect(out).toEqual({ x: 10, y: 5, z: 0 });
    });

    it('overwrites a stale out.z with 0 when src.z is omitted', () => {
        const out = vec3(0, 0, 42);
        vec3Copy(out, { x: 1, y: 2 });
        expect(out.z).toBe(0);
    });

    it('copies an explicit src.z, including 0 and negatives', () => {
        const out = vec3(9, 9, 9);
        vec3Copy(out, { x: 1, y: 2, z: 0 });
        expect(out.z).toBe(0);
        vec3Copy(out, { x: 1, y: 2, z: -3 });
        expect(out.z).toBe(-3);
    });

    it('applies the default only to a missing z, not to a falsy one', () => {
        // `-0` survives `?? 0` but a `|| 0` fallback would flatten it to `+0`, so this
        // pins the nullish default rather than a truthiness test.
        const out = vec3();
        vec3Copy(out, { x: 1, y: 2, z: -0 });
        expect(Object.is(out.z, -0)).toBe(true);
    });

    it('does not alias src', () => {
        const src: MutableVec3 = vec3(1, 2, 3);
        const out = vec3();
        vec3Copy(out, src);
        expect(out).not.toBe(src);
        src.x = 99;
        expect(out.x).toBe(1);
    });

    it('accepts a fully populated Vec3 as src', () => {
        const out = vec3();
        vec3Copy(out, vec3(7, 8, 9));
        expect(out).toEqual({ x: 7, y: 8, z: 9 });
    });
});

describe('vec3Dist2D', () => {
    it('measures the xy plane only, so a pure z separation reads as 0', () => {
        expect(vec3Dist2D({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 })).toBe(0);
    });

    it('disagrees with the length of the difference whenever z differs', () => {
        const a = { x: 0, y: 0, z: 0 };
        const b = { x: 3, y: 4, z: 12 };
        expect(vec3Dist2D(a, b)).toBe(5);
        expect(vec3Length(b)).toBe(13);
    });

    it('is symmetric and reads an omitted z as 0', () => {
        expect(vec3Dist2D({ x: 1, y: 2 }, { x: 4, y: 6 })).toBe(5);
        expect(vec3Dist2D({ x: 4, y: 6 }, { x: 1, y: 2 })).toBe(5);
    });

    it('is 0 for a point against itself', () => {
        expect(vec3Dist2D({ x: -7.5, y: 3 }, { x: -7.5, y: 3 })).toBe(0);
    });
});

describe('vec3LengthSq', () => {
    it('agrees with the square of the length', () => {
        const v = { x: 3, y: 4, z: 12 };
        expect(vec3LengthSq(v)).toBe(vec3Length(v) ** 2);
        expect(vec3LengthSq(v)).toBe(169);
    });

    it('reads an omitted z as 0', () => {
        expect(vec3LengthSq({ x: 3, y: 4 })).toBe(25);
    });

    it('is 0 only for the zero vector', () => {
        expect(vec3LengthSq({ x: 0, y: 0, z: 0 })).toBe(0);
        expect(vec3LengthSq({ x: 0, y: 0, z: -1 })).toBe(1);
    });

    it('ignores sign, so it orders magnitudes without a sqrt', () => {
        expect(vec3LengthSq({ x: -3, y: -4 })).toBe(25);
        expect(vec3LengthSq({ x: 1, y: 1 })).toBeLessThan(vec3LengthSq({ x: 2, y: 0 }));
    });
});

describe('vec3Normalize', () => {
    it('writes into out and returns that same object', () => {
        const out = vec3(99, 99, 99);
        const returned = vec3Normalize(out, { x: 0, y: 5, z: 0 });
        expect(returned).toBe(out);
        expect(out).toEqual({ x: 0, y: 1, z: 0 });
    });

    it('produces a unit-length vector', () => {
        const out = vec3Normalize(vec3(), { x: 3, y: 4, z: 12 });
        expect(vec3Length(out)).toBeCloseTo(1, 12);
        expect(out.x).toBeCloseTo(3 / 13, 12);
        expect(out.y).toBeCloseTo(4 / 13, 12);
        expect(out.z).toBeCloseTo(12 / 13, 12);
    });

    it('normalises a zero-length vector to (0,0,0) instead of NaN', () => {
        const out = vec3Normalize(vec3(1, 2, 3), { x: 0, y: 0, z: 0 });
        expect(out).toEqual({ x: 0, y: 0, z: 0 });
    });

    it('reads an omitted z as 0 and overwrites a stale z in out', () => {
        const out = vec3Normalize(vec3(9, 9, 9), { x: 5, y: 0 });
        expect(out).toEqual({ x: 1, y: 0, z: 0 });
    });

    it('leaves an already-unit vector unchanged', () => {
        expect(vec3Normalize(vec3(), { x: 0, y: 0, z: 1 })).toEqual({ x: 0, y: 0, z: 1 });
    });
});

describe('index re-exports', () => {
    it('exposes every vector symbol', () => {
        expect(math.vec3).toBe(vec3);
        expect(math.vec3Set).toBe(vec3Set);
        expect(math.vec3Copy).toBe(vec3Copy);
        expect(math.vec3Dist2D).toBe(vec3Dist2D);
    });

    it('exposes the Vec3 and Vec3Like types', () => {
        // Type-only: this fails to compile if either name stops being re-exported, and
        // also pins that a Vec3 is usable wherever a Vec3Like is asked for.
        const point: math.Vec3 = vec3(1, 2, 3);
        const like: math.Vec3Like = point;
        expect(vec3Length(like)).toBeCloseTo(Math.sqrt(14), 12);
    });
});
