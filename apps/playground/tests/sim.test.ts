// The drifter rule, in plain Node. No canvas, no clock, no renderer — which is why `sim.ts` holds
// no `IRenderer` reference at all.

import { describe, it, expect } from 'vitest';
import { bounds } from '@platform/math';
import type { Drifter } from '../src/sim';
import { DEFAULT_SPEED, DEFAULT_SPIN, EDGE_MARGIN, exitX, spawnX, step } from '../src/sim';

/** A 960x540 stage at the origin, y-up: `top > bottom` (§4.2). */
const VIEWPORT = bounds(-480, 480, 270, -270);

/** A drifter with the defaults, overridable per test. `id` is a plain number here. */
function drifter(overrides: Partial<Drifter<number>> = {}): Drifter<number> {
    return {
        id: 1,
        x: spawnX(VIEWPORT),
        y: 0,
        speed: DEFAULT_SPEED,
        rotation: 0,
        spin: DEFAULT_SPIN,
        ...overrides,
    };
}

describe('spawnX / exitX', () => {
    it('places the spawn fully off the left edge and the exit fully off the right', () => {
        expect(spawnX(VIEWPORT)).toBe(-480 - EDGE_MARGIN);
        expect(exitX(VIEWPORT)).toBe(480 + EDGE_MARGIN);
    });

    it('tracks the live viewport rather than a fixed design stage', () => {
        // A zoomed-out camera sees more world, so the entry point moves further out with it.
        const wider = bounds(-960, 960, 540, -540);
        expect(spawnX(wider)).toBe(-960 - EDGE_MARGIN);
        expect(exitX(wider)).toBe(960 + EDGE_MARGIN);
    });
});

describe('step — travel', () => {
    it('advances x by speed * dt', () => {
        const d = drifter({ x: 0, speed: 100 });
        step([d], 0.5, VIEWPORT);
        expect(d.x).toBe(50);
    });

    it('advances rotation by spin * dt', () => {
        const d = drifter({ x: 0, rotation: 0, spin: 90 });
        step([d], 2, VIEWPORT);
        expect(d.rotation).toBe(180);
    });

    it('wraps rotation into [0, 360) instead of growing without bound', () => {
        const d = drifter({ x: 0, rotation: 350, spin: 90 });
        step([d], 1, VIEWPORT);
        // 350 + 90 = 440 -> 80
        expect(d.rotation).toBe(80);
        expect(d.rotation).toBeGreaterThanOrEqual(0);
        expect(d.rotation).toBeLessThan(360);
    });

    it('mutates in place rather than reallocating, so ids and identity survive a frame', () => {
        const d = drifter({ x: 0 });
        const { alive } = step([d], 0.1, VIEWPORT);
        expect(alive[0]).toBe(d);
    });

    it('leaves y untouched — a drifter holds the height it was clicked at', () => {
        const d = drifter({ x: 0, y: 137.5 });
        step([d], 1, VIEWPORT);
        expect(d.y).toBe(137.5);
    });
});

describe('step — retirement', () => {
    it('keeps a drifter that is still short of the exit', () => {
        const d = drifter({ x: exitX(VIEWPORT) - 1, speed: 0 });
        const { alive, exited } = step([d], 0.016, VIEWPORT);
        expect(alive).toEqual([d]);
        expect(exited).toEqual([]);
    });

    it('retires a drifter once it passes the exit', () => {
        const d = drifter({ x: exitX(VIEWPORT), speed: 1 });
        const { alive, exited } = step([d], 1, VIEWPORT);
        expect(alive).toEqual([]);
        expect(exited).toEqual([d]);
    });

    it('holds a drifter sitting exactly on the exit — the test is strictly greater', () => {
        const d = drifter({ x: exitX(VIEWPORT), speed: 0 });
        const { alive, exited } = step([d], 1, VIEWPORT);
        expect(alive).toEqual([d]);
        expect(exited).toEqual([]);
    });

    it('partitions a mixed population, preserving order within each group', () => {
        const near = drifter({ id: 1, x: 0 });
        const gone = drifter({ id: 2, x: exitX(VIEWPORT) + 10 });
        const alsoGone = drifter({ id: 3, x: exitX(VIEWPORT) + 20 });
        const alsoNear = drifter({ id: 4, x: 100 });

        const { alive, exited } = step([near, gone, alsoGone, alsoNear], 0.016, VIEWPORT);
        expect(alive.map((d) => d.id)).toEqual([1, 4]);
        expect(exited.map((d) => d.id)).toEqual([2, 3]);
    });

    it('crosses the full stage in the expected time at the default speed', () => {
        const d = drifter();
        const width = exitX(VIEWPORT) - spawnX(VIEWPORT);
        const frames = Math.ceil(width / (DEFAULT_SPEED * (1 / 60)));

        let retired = false;
        for (let i = 0; i < frames + 1 && !retired; i++) {
            retired = step([d], 1 / 60, VIEWPORT).exited.length === 1;
        }
        expect(retired).toBe(true);
        // ~1024 world px at 240 px/s is a little over four seconds.
        expect(frames / 60).toBeGreaterThan(4);
        expect(frames / 60).toBeLessThan(4.5);
    });
});

describe('step — degenerate dt', () => {
    it('treats a zero dt as a no-op', () => {
        const d = drifter({ x: 12, rotation: 34 });
        step([d], 0, VIEWPORT);
        expect(d.x).toBe(12);
        expect(d.rotation).toBe(34);
    });

    it('never drags a drifter backwards on a negative dt', () => {
        const d = drifter({ x: 12, rotation: 34 });
        step([d], -5, VIEWPORT);
        expect(d.x).toBe(12);
        expect(d.rotation).toBe(34);
    });

    it('ignores a NaN dt rather than poisoning the position', () => {
        const d = drifter({ x: 12, rotation: 34 });
        step([d], Number.NaN, VIEWPORT);
        expect(d.x).toBe(12);
        expect(d.rotation).toBe(34);
    });

    it('ignores an infinite dt', () => {
        const d = drifter({ x: 12 });
        step([d], Number.POSITIVE_INFINITY, VIEWPORT);
        expect(d.x).toBe(12);
        expect(Number.isFinite(d.x)).toBe(true);
    });

    it('handles an empty population', () => {
        const { alive, exited } = step<number>([], 0.016, VIEWPORT);
        expect(alive).toEqual([]);
        expect(exited).toEqual([]);
    });
});

describe('DEFAULT_SPIN', () => {
    it('is a quarter turn per second, so a crossing tumbles visibly but not dizzyingly', () => {
        expect(DEFAULT_SPIN).toBe(90);
    });
});
