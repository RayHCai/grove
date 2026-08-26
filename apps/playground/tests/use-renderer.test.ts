// The hook itself needs a browser and is exercised by running the app; what is testable in Node is
// the readout it feeds the HUD. Frame timing is no longer here — `GameClient` owns the frame and
// clamps its own dt.

import { describe, it, expect } from 'vitest';
import { describePhase } from '../src/use-renderer';

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
