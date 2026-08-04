// Contract tests for vectors.
//
// Two contracts here are invisible in the signatures and are the ones that break
// silently: the `out` helpers must return the very object they were handed (callers
// rely on that to stay allocation-free), and an omitted `Vec3Like.z` must read as 0
// even when it has to overwrite a stale non-zero `z` already sitting in `out`.

import { describe, it, expect } from 'vitest';
import type { MutableVec3, Vec3Like } from '../src/vec3.js';
import { vec3, vec3Set, vec3Copy, vec3Z } from '../src/vec3.js';
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

describe('vec3Z', () => {
    it('reads 0 for an omitted z', () => {
        expect(vec3Z({ x: 1, y: 2 })).toBe(0);
    });

    it('reads an explicit z, including 0 and negatives', () => {
        expect(vec3Z({ x: 1, y: 2, z: 5 })).toBe(5);
        expect(vec3Z({ x: 1, y: 2, z: 0 })).toBe(0);
        expect(vec3Z({ x: 1, y: 2, z: -2.5 })).toBe(-2.5);
    });

    it('applies the default only to a missing z, not to a falsy one', () => {
        // `-0` survives `?? 0` but a `|| 0` fallback would flatten it to `+0`, so this
        // is the assertion that pins the nullish default rather than a truthiness test.
        expect(Object.is(vec3Z({ x: 1, y: 2, z: -0 }), -0)).toBe(true);
    });

    it('agrees with the default vec3Copy applies', () => {
        const src: Vec3Like = { x: 3, y: 4 };
        const out = vec3Copy(vec3(), src);
        expect(out.z).toBe(vec3Z(src));
    });
});

describe('index re-exports', () => {
    it('exposes every vector symbol', () => {
        expect(math.vec3).toBe(vec3);
        expect(math.vec3Set).toBe(vec3Set);
        expect(math.vec3Copy).toBe(vec3Copy);
        expect(math.vec3Z).toBe(vec3Z);
    });

    it('exposes the Vec3 and Vec3Like types', () => {
        // Type-only: this fails to compile if either name stops being re-exported, and
        // also pins that a Vec3 is usable wherever a Vec3Like is asked for.
        const point: math.Vec3 = vec3(1, 2, 3);
        const like: math.Vec3Like = point;
        expect(vec3Z(like)).toBe(3);
    });
});
