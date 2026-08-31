// Contract tests for the deterministic transcendentals.
//
// Two separate promises live here and only one of them is about accuracy. The load-bearing one is
// that a result is a pure function of its input — two machines running the same simulation must
// draw the same number — and the built-ins are exempted from that by ECMA-262, which is why this
// module exists at all. The second is that the replacement is close enough to the built-in to be
// usable, and every bound below is asserted rather than described, because a mistyped coefficient
// produces plausible values everywhere and is invisible without a number to fail against.

import { describe, it, expect } from 'vitest';
import {
    acos,
    acosh,
    asin,
    asinh,
    atan,
    atan2,
    atanh,
    cbrt,
    cos,
    cosh,
    exp,
    expm1,
    hypot,
    log,
    log10,
    log1p,
    log2,
    pow,
    sin,
    sinh,
    tan,
    tanh,
} from '../src/deterministic-math.js';
import * as math from '../src/index.js';

/**
 * The accuracy bound every function here is held to, as a multiple of the value's own magnitude.
 *
 * 1e-13 rather than a double's 2.2e-16: these are polynomial approximations, and the last two or
 * three bits are what is being traded for reproducibility. A regression that loses more than that
 * is a broken coefficient rather than a rounding difference.
 */
const TOLERANCE = 1e-13;

/** Worst relative error of `actual` against `expected` over `samples`, and where it happened. */
function worst(
    samples: readonly number[],
    actual: (x: number) => number,
    expected: (x: number) => number,
): { error: number; at: number } {
    let error = 0;
    let at = samples[0] ?? 0;
    for (const x of samples) {
        const want = expected(x);
        const got = actual(x);
        const scale = Math.max(Math.abs(want), 1);
        const relative = Math.abs(got - want) / scale;
        if (relative > error) {
            error = relative;
            at = x;
        }
    }
    return { error, at };
}

/** How many units-in-the-last-place `actual` sits from `expected`. */
function ulps(actual: number, expected: number): number {
    return Math.abs(actual - expected) / Math.max(Math.abs(expected) * Number.EPSILON, 5e-324);
}

/** `count` evenly spaced samples across [lo, hi], endpoints included. */
function sweep(lo: number, hi: number, count = 2000): number[] {
    return Array.from({ length: count + 1 }, (_, i) => lo + ((hi - lo) * i) / count);
}

function agrees(
    samples: readonly number[],
    actual: (x: number) => number,
    expected: (x: number) => number,
    tolerance = TOLERANCE,
): void {
    const { error, at } = worst(samples, actual, expected);
    // The failure message carries the input, because a bound this tight is only actionable with one.
    expect({ error: error <= tolerance, at }).toStrictEqual({ error: true, at });
    expect(error).toBeLessThanOrEqual(tolerance);
}

describe('sin / cos', () => {
    it('is exact at the quadrant boundaries', () => {
        // The reason cosine has its own kernel rather than being spelled `sin(x + π/2)`: that
        // spelling lands x = 0 — by far the most common argument — on the least accurate point of
        // the sine kernel's range, and returned 0.9999999439 for cos(0).
        expect(cos(0)).toBe(1);
        expect(sin(0)).toBe(0);
        expect(Object.is(sin(-0), -0)).toBe(true);
        expect(cos(-0)).toBe(1);
        expect(sin(Math.PI / 2)).toBe(1);
        expect(sin(-Math.PI / 2)).toBe(-1);
        expect(cos(Math.PI)).toBe(-1);
        expect(cos(-Math.PI)).toBe(-1);
    });

    it('tracks the built-ins across a full turn', () => {
        agrees(sweep(-Math.PI, Math.PI), sin, Math.sin);
        agrees(sweep(-Math.PI, Math.PI), cos, Math.cos);
    });

    it('is within one ulp of the built-ins, not merely close to them', () => {
        // The tight bound, kept separate because it is the one that catches a mistyped kernel
        // coefficient. A relative-error bound of 1e-13 passes with a coefficient wrong in its
        // eighth digit; this does not. Deriving cosine as `sin(x + π/2)` scored ~5e8 ulp here.
        let worstSin = 0;
        let worstCos = 0;
        for (const x of sweep(-100, 100, 20_000)) {
            worstSin = Math.max(worstSin, ulps(sin(x), Math.sin(x)));
            worstCos = Math.max(worstCos, ulps(cos(x), Math.cos(x)));
        }
        expect(worstSin).toBeLessThanOrEqual(1);
        expect(worstCos).toBeLessThanOrEqual(1);
    });

    it('holds accuracy where the argument needs real range reduction', () => {
        // Angles arrive as accumulated time, so a long-running orbit is thousands of turns in.
        agrees(sweep(-10_000, 10_000, 5000), sin, Math.sin);
        agrees(sweep(-10_000, 10_000, 5000), cos, Math.cos);
    });

    it('selects the right quadrant past the int32 wrap', () => {
        // The quadrant count is arithmetic rather than bitwise: `n & 3` wraps at 2^31 quadrants,
        // which is a reachable double, and would pick the wrong kernel — a sign error, not a
        // precision one.
        for (const x of [4e9, -4e9, 1e10, -1e10]) {
            expect(Math.abs(sin(x))).toBeLessThanOrEqual(1);
            expect(Math.abs(cos(x))).toBeLessThanOrEqual(1);
            expect(Math.abs(sin(x) * sin(x) + cos(x) * cos(x) - 1)).toBeLessThan(1e-9);
        }
    });

    it('keeps the Pythagorean identity everywhere', () => {
        for (const x of sweep(-50, 50, 4000)) {
            expect(Math.abs(sin(x) * sin(x) + cos(x) * cos(x) - 1)).toBeLessThan(TOLERANCE);
        }
    });

    it('stays inside [-1, 1]', () => {
        for (const x of sweep(-100, 100, 4000)) {
            expect(sin(x)).toBeGreaterThanOrEqual(-1);
            expect(sin(x)).toBeLessThanOrEqual(1);
            expect(cos(x)).toBeGreaterThanOrEqual(-1);
            expect(cos(x)).toBeLessThanOrEqual(1);
        }
    });

    it('returns NaN for every non-finite input', () => {
        for (const f of [sin, cos]) {
            expect(f(NaN)).toBeNaN();
            expect(f(Infinity)).toBeNaN();
            expect(f(-Infinity)).toBeNaN();
        }
    });
});

describe('tan', () => {
    it('tracks Math.tan away from the poles', () => {
        agrees(sweep(-1.5, 1.5), tan, Math.tan, 1e-12);
    });

    it('is exact at zero', () => {
        expect(tan(0)).toBe(0);
    });
});

describe('atan / atan2', () => {
    it('tracks Math.atan across the reciprocal and the half-angle switches', () => {
        agrees(sweep(-50, 50, 5000), atan, Math.atan);
    });

    it('is exact at the anchors', () => {
        expect(atan(0)).toBe(0);
        expect(atan(Infinity)).toBe(Math.PI / 2);
        expect(atan(-Infinity)).toBe(-Math.PI / 2);
        expect(atan2(0, 1)).toBe(0);
        expect(atan2(1, 0)).toBe(Math.PI / 2);
        expect(atan2(-1, 0)).toBe(-Math.PI / 2);
    });

    it('picks the quadrant from both signs', () => {
        const pairs: Array<[number, number]> = [
            [1, 1],
            [1, -1],
            [-1, -1],
            [-1, 1],
            [3, -4],
            [-3, -4],
        ];
        for (const [y, x] of pairs) {
            expect(Math.abs(atan2(y, x) - Math.atan2(y, x))).toBeLessThan(TOLERANCE);
        }
    });

    it('carries the sign of a zero, which is what separates the two π branches', () => {
        expect(Object.is(atan2(0, 1), 0)).toBe(true);
        expect(Object.is(atan2(-0, 1), -0)).toBe(true);
        expect(atan2(0, -1)).toBe(Math.PI);
        expect(atan2(-0, -1)).toBe(-Math.PI);
    });

    it('answers the infinite corners the way Math.atan2 does', () => {
        expect(atan2(Infinity, Infinity)).toBeCloseTo(Math.PI / 4, 15);
        expect(atan2(Infinity, -Infinity)).toBeCloseTo((3 * Math.PI) / 4, 15);
        expect(atan2(-Infinity, Infinity)).toBeCloseTo(-Math.PI / 4, 15);
        expect(atan2(1, Infinity)).toBe(0);
        expect(atan2(1, -Infinity)).toBe(Math.PI);
        expect(atan2(NaN, 1)).toBeNaN();
    });
});

describe('asin / acos', () => {
    it('tracks the built-ins over the whole domain', () => {
        agrees(sweep(-1, 1, 4000), asin, Math.asin);
        agrees(sweep(-1, 1, 4000), acos, Math.acos);
    });

    it('is exact at the endpoints', () => {
        expect(asin(0)).toBe(0);
        expect(asin(1)).toBe(Math.PI / 2);
        expect(asin(-1)).toBe(-Math.PI / 2);
        expect(acos(1)).toBe(0);
        expect(acos(-1)).toBe(Math.PI);
    });

    it('is NaN outside it, rather than clamping to the edge', () => {
        expect(asin(1.0001)).toBeNaN();
        expect(acos(-1.0001)).toBeNaN();
    });
});

describe('exp / log', () => {
    it('tracks the built-ins', () => {
        agrees(sweep(-30, 30, 6000), exp, Math.exp);
        agrees(sweep(1e-6, 1e6, 6000), log, Math.log);
    });

    it('is exact at the identities', () => {
        expect(exp(0)).toBe(1);
        expect(log(1)).toBe(0);
        expect(log(Math.E)).toBe(1);
    });

    it('round-trips through each other', () => {
        for (const x of sweep(-20, 20, 2000)) {
            expect(Math.abs(log(exp(x)) - x)).toBeLessThan(1e-12);
        }
    });

    it('saturates rather than returning NaN at the representable edges', () => {
        expect(exp(710)).toBe(Infinity);
        expect(exp(-746)).toBe(0);
        expect(exp(Infinity)).toBe(Infinity);
        expect(exp(-Infinity)).toBe(0);
        expect(log(0)).toBe(-Infinity);
        expect(log(-1)).toBeNaN();
        expect(log(Infinity)).toBe(Infinity);
    });

    it('handles a subnormal, which takes the scaled branch of the frexp', () => {
        expect(Math.abs(log(5e-324) - Math.log(5e-324))).toBeLessThan(1e-12);
        expect(Math.abs(log(1e-310) - Math.log(1e-310))).toBeLessThan(1e-12);
    });

    it('derives log2 and log10 from it', () => {
        expect(log2(8)).toBeCloseTo(3, 12);
        expect(log10(1000)).toBeCloseTo(3, 12);
    });
});

describe('pow', () => {
    it('is exact for a small integer exponent, which is the binary-power branch', () => {
        expect(pow(2, 10)).toBe(1024);
        expect(pow(10, 3)).toBe(1000);
        expect(pow(3, 4)).toBe(81);
        expect(pow(2, -3)).toBe(0.125);
        expect(pow(-2, 3)).toBe(-8);
        expect(pow(-2, 4)).toBe(16);
    });

    it('tracks Math.pow for a fractional exponent', () => {
        const bases = [0.5, 1.5, 2, 7, 100];
        for (const b of bases) {
            for (const e of [0.5, 1.5, 2.25, -0.75]) {
                const scale = Math.max(Math.abs(Math.pow(b, e)), 1);
                expect(Math.abs(pow(b, e) - Math.pow(b, e)) / scale).toBeLessThan(TOLERANCE);
            }
        }
    });

    it('answers the special cases the way Math.pow does', () => {
        expect(pow(5, 0)).toBe(1);
        expect(pow(NaN, 0)).toBe(1);
        // NaN, not 1: the ES5 "base of 1 is always 1" rule was dropped, and Math.pow agrees.
        expect(pow(1, NaN)).toBeNaN();
        expect(pow(0, 2)).toBe(0);
        expect(pow(0, -2)).toBe(Infinity);
        expect(pow(-8, 0.5)).toBeNaN();
        expect(pow(Infinity, 2)).toBe(Infinity);
        expect(pow(-Infinity, 3)).toBe(-Infinity);
        expect(pow(-Infinity, 2)).toBe(Infinity);
        expect(Object.is(pow(-Infinity, -3), -0)).toBe(true);
    });
});

describe('the derived functions', () => {
    it('tracks the built-ins', () => {
        agrees(sweep(-5, 5, 2000), sinh, Math.sinh);
        agrees(sweep(-5, 5, 2000), cosh, Math.cosh);
        agrees(sweep(-5, 5, 2000), tanh, Math.tanh);
        agrees(sweep(-5, 5, 2000), asinh, Math.asinh);
        agrees(sweep(1, 50, 2000), acosh, Math.acosh);
        agrees(sweep(-0.999, 0.999, 2000), atanh, Math.atanh);
        agrees(sweep(-100, 100, 2000), cbrt, Math.cbrt);
        agrees(sweep(-1, 1, 2000), expm1, Math.expm1);
        agrees(sweep(-0.9, 10, 2000), log1p, Math.log1p);
    });

    it('keeps the small-argument branches that exist to avoid cancellation', () => {
        // expm1 and log1p both switch to a series near zero; taking exp(x)-1 there loses every
        // significant digit, so the switch is the whole point of having them.
        expect(Math.abs(expm1(1e-9) - Math.expm1(1e-9)) / 1e-9).toBeLessThan(1e-9);
        expect(Math.abs(log1p(1e-9) - Math.log1p(1e-9)) / 1e-9).toBeLessThan(1e-9);
        expect(sinh(1e-9)).toBe(1e-9);
        expect(tanh(0)).toBe(0);
    });

    it('saturates tanh rather than dividing infinities', () => {
        expect(tanh(50)).toBe(1);
        expect(tanh(-50)).toBe(-1);
    });

    it('acosh is NaN below its domain', () => {
        expect(acosh(0.5)).toBeNaN();
        expect(atanh(1)).toBe(Infinity);
        expect(atanh(-1)).toBe(-Infinity);
        expect(atanh(2)).toBeNaN();
    });

    it('cbrt keeps the sign and the zeroes', () => {
        expect(cbrt(-27)).toBeCloseTo(-3, 12);
        expect(Object.is(cbrt(-0), -0)).toBe(true);
        expect(cbrt(0)).toBe(0);
        expect(cbrt(NaN)).toBeNaN();
    });

    it('hypot scales so a representable result never overflows on the way', () => {
        expect(hypot(3, 4)).toBe(5);
        expect(hypot(0, 5)).toBe(5);
        expect(hypot(5, 0)).toBe(5);
        // 1e200² is Infinity; the answer is not, and a naive √(x²+y²) returns Infinity anyway.
        expect(hypot(3e200, 4e200)).toBeCloseTo(5e200, -190);
        expect(hypot(Infinity, 1)).toBe(Infinity);
        expect(hypot(NaN, 1)).toBeNaN();
    });
});

describe('determinism', () => {
    // The actual contract. Accuracy is negotiable between releases; this is not, because two peers
    // disagreeing by one bit diverge and never reconcile.
    const every = [
        sin,
        cos,
        tan,
        atan,
        asin,
        acos,
        exp,
        log,
        log2,
        log10,
        sinh,
        cosh,
        tanh,
        asinh,
        acosh,
        atanh,
        cbrt,
        expm1,
        log1p,
    ];

    it('returns bit-identical results for a repeated argument', () => {
        for (const f of every) {
            for (const x of [0.5, 1, 2, 7.25, 100.125, -3.5, 1e-7, 12345.6789]) {
                expect(f(x)).toBe(f(x));
            }
        }
    });

    it('does not depend on the order arguments arrive in', () => {
        const xs = sweep(-20, 20, 500);
        const forwards = xs.map(sin);
        const backwards = xs.toReversed().map(sin).toReversed();
        expect(forwards).toStrictEqual(backwards);
    });
});

describe('the barrel re-exports every replacement', () => {
    it('names the same functions this module declares', () => {
        expect(math.sin).toBe(sin);
        expect(math.cos).toBe(cos);
        expect(math.atan2).toBe(atan2);
        expect(math.exp).toBe(exp);
        expect(math.log).toBe(log);
        expect(math.pow).toBe(pow);
    });
});
