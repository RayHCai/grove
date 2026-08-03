// The frame-clock helpers. The hook itself needs a browser and is exercised by running the app;
// what is testable in Node is the arithmetic that guards it.

import { describe, it, expect } from 'vitest';
import { clampFrameDt, describePhase } from '../src/use-renderer';

describe('clampFrameDt', () => {
    it('passes an ordinary 60Hz frame through untouched', () => {
        expect(clampFrameDt(1 / 60)).toBeCloseTo(1 / 60, 10);
    });

    it('caps a backgrounded-tab gap instead of teleporting the scene', () => {
        // A tab hidden for three seconds must not advance the sim by three seconds.
        expect(clampFrameDt(3)).toBeCloseTo(1 / 15, 10);
    });

    it('floors a negative or zero dt at zero', () => {
        expect(clampFrameDt(0)).toBe(0);
        expect(clampFrameDt(-1)).toBe(0);
    });

    it('treats NaN and Infinity as zero rather than propagating them', () => {
        expect(clampFrameDt(Number.NaN)).toBe(0);
        expect(clampFrameDt(Number.POSITIVE_INFINITY)).toBe(0);
    });
});

describe('describePhase', () => {
    it('reports each phase', () => {
        expect(describePhase('idle', null)).toMatch(/waiting/);
        expect(describePhase('initializing', null)).toMatch(/initializing/);
        expect(describePhase('ready', null)).toBe('ready');
    });

    it('includes the error message when it failed', () => {
        expect(describePhase('failed', new Error('no webgl'))).toBe('failed: no webgl');
    });

    it('degrades gracefully when a failure carries no error object', () => {
        expect(describePhase('failed', null)).toBe('failed: unknown error');
    });
});
