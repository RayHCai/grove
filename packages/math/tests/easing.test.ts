// Contract tests for the easing curves.
//
// Every timed motion verb in the engine runs through `ease`, and a tween's final frame writes
// `lerp(from, to, ease(1, curve))` — so a curve that does not return exactly 1 at t=1 leaves the
// property short of its target forever, and one that returns undefined writes NaN and keeps
// writing it. Both endpoints are therefore asserted exactly rather than approximately.

import { describe, it, expect } from 'vitest';
import type { Easing } from '../src/easing.js';
import { ease } from '../src/easing.js';
import * as math from '../src/index.js';

const CURVES = [
    'linear',
    'ease',
    'easeIn',
    'easeOut',
    'bounce',
] as const satisfies readonly Easing[];

describe('every curve', () => {
    it('starts at 0 and lands exactly on 1', () => {
        for (const curve of CURVES) {
            expect(ease(0, curve)).toBe(0);
            expect(ease(1, curve)).toBe(1);
        }
    });

    it('is monotone across the interval, bounce excepted', () => {
        for (const curve of CURVES) {
            if (curve === 'bounce') continue;
            let previous = -Infinity;
            for (let i = 0; i <= 1000; i++) {
                const value = ease(i / 1000, curve);
                expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
                previous = value;
            }
        }
    });

    it('bounce is the one that goes backwards, which is what makes it a bounce', () => {
        // Asserted rather than excepted silently: if this curve ever became monotone it would be
        // a different curve wearing the same name, and every screen using it would change quietly.
        let dips = 0;
        let previous = ease(0, 'bounce');
        for (let i = 1; i <= 1000; i++) {
            const value = ease(i / 1000, 'bounce');
            if (value < previous) dips += 1;
            previous = value;
        }
        expect(dips).toBeGreaterThan(0);
    });

    it('stays inside [0, 1]', () => {
        for (const curve of CURVES) {
            for (let i = 0; i <= 1000; i++) {
                const value = ease(i / 1000, curve);
                expect(value).toBeGreaterThanOrEqual(0);
                expect(value).toBeLessThanOrEqual(1);
            }
        }
    });

    it('is a pure function of t', () => {
        for (const curve of CURVES) {
            for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
                expect(ease(t, curve)).toBe(ease(t, curve));
            }
        }
    });
});

describe('the individual shapes', () => {
    it('linear is the identity', () => {
        for (const t of [0, 0.25, 0.5, 0.75, 1]) expect(ease(t, 'linear')).toBe(t);
    });

    it('ease is symmetric smoothstep', () => {
        expect(ease(0.5, 'ease')).toBe(0.5);
        // 3t²−2t³ is antisymmetric about the midpoint, so the two halves mirror.
        for (const t of [0.1, 0.25, 0.4]) {
            expect(ease(t, 'ease') + ease(1 - t, 'ease')).toBeCloseTo(1, 12);
        }
    });

    it('easeIn starts slow and easeOut starts fast', () => {
        expect(ease(0.5, 'easeIn')).toBe(0.125);
        expect(ease(0.5, 'easeOut')).toBe(0.875);
        expect(ease(0.1, 'easeIn')).toBeLessThan(0.1);
        expect(ease(0.1, 'easeOut')).toBeGreaterThan(0.1);
    });

    it('easeIn and easeOut are each other reflected', () => {
        for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
            expect(ease(t, 'easeOut')).toBeCloseTo(1 - ease(1 - t, 'easeIn'), 12);
        }
    });

    it('bounce settles rather than ringing past its last segment', () => {
        expect(ease(1, 'bounce')).toBe(1);
        // The four segments each land on their own floor; the last one is the settle.
        expect(ease(0.99, 'bounce')).toBeGreaterThan(0.98);
        expect(ease(0.5, 'bounce')).toBeGreaterThan(0.5);
    });
});

describe('a curve name off the union', () => {
    it('falls back to linear rather than returning undefined', () => {
        // Reachable: a curve name can arrive from a manifest or the wire, where the type is a
        // claim rather than a check. Returning undefined made `lerp` produce NaN, and a tween that
        // writes NaN once writes it for the rest of its duration.
        const unknown = 'wobble' as Easing;
        expect(ease(0, unknown)).toBe(0);
        expect(ease(0.5, unknown)).toBe(0.5);
        expect(ease(1, unknown)).toBe(1);
        expect(Number.isNaN(ease(0.5, unknown))).toBe(false);
    });
});

describe('the barrel', () => {
    it('re-exports the function this module declares', () => {
        expect(math.ease).toBe(ease);
    });
});
