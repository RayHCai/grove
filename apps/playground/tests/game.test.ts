// The leaf game, driven by a real @platform/core fixed-step loop. No canvas, no renderer,
// no wall clock — `advance(dt)` is a plain function of time, so the tick rule is testable in
// Node exactly the way core's own loop tests boot a runtime and step it.

import { afterEach, describe, expect, it } from 'vitest';
import { bounds } from '@platform/math';
import { DEFAULT_SPEED, DEFAULT_SPIN, LeafGame, exitX, spawnX } from '../src/game';

/** A 960x540 stage at the origin, y-up: `top > bottom` (§4.2). */
const VIEWPORT = bounds(-480, 480, 270, -270);

// Each game holds the process-global runtime slot; dispose after every test so the next one
// boots clean.
const games: LeafGame[] = [];
function makeGame(opts?: { simRate?: number }): LeafGame {
    const game = new LeafGame(opts);
    games.push(game);
    return game;
}
afterEach(() => {
    while (games.length > 0) games.pop()!.dispose();
});

/**
 * Advance `game` by `ticks` whole fixed ticks at `rate`.
 *
 * One `advance(1/rate)` steps exactly one tick and resets the accumulator to zero, so this
 * is drift-free — unlike a single `advance(seconds)`, which the fixed-step accumulator
 * quantizes and can leave a tick short at an exact boundary.
 */
function advanceTicks(game: LeafGame, ticks: number, rate: number): void {
    for (let i = 0; i < ticks; i++) game.advance(1 / rate);
}

describe('spawnX / exitX', () => {
    it('places the spawn fully off the left edge and the exit fully off the right', () => {
        expect(spawnX(VIEWPORT)).toBe(-480 - 32);
        expect(exitX(VIEWPORT)).toBe(480 + 32);
    });

    it('tracks the live viewport rather than a fixed design stage', () => {
        const wider = bounds(-960, 960, 540, -540);
        expect(spawnX(wider)).toBe(-960 - 32);
        expect(exitX(wider)).toBe(960 + 32);
    });
});

describe('advance — travel', () => {
    it('advances x by speed over one simulated second of whole ticks', () => {
        const game = makeGame({ simRate: 60 });
        const id = game.spawn({ x: 0, y: 40, speed: 100, spin: 0 });
        advanceTicks(game, 60, 60);
        const view = game.views().find((v) => v.id === id)!;
        expect(view.x).toBeCloseTo(100, 6);
    });

    it('advances rotation by spin and wraps into [0, 360)', () => {
        const game = makeGame({ simRate: 60 });
        const id = game.spawn({ x: 0, y: 0, speed: 0, spin: 350 });
        advanceTicks(game, 60, 60); // 350 deg over one second -> 350, still under a full turn
        expect(game.views().find((v) => v.id === id)!.rotation).toBeCloseTo(350, 4);

        advanceTicks(game, 60, 60); // another 350 -> 700 -> 340
        const rot = game.views().find((v) => v.id === id)!.rotation;
        expect(rot).toBeCloseTo(340, 4);
        expect(rot).toBeGreaterThanOrEqual(0);
        expect(rot).toBeLessThan(360);
    });

    it('holds y for the leaf whole life — only x advances', () => {
        const game = makeGame({ simRate: 60 });
        const id = game.spawn({ x: 0, y: 137.5, speed: DEFAULT_SPEED, spin: DEFAULT_SPIN });
        game.advance(0.5);
        expect(game.views().find((v) => v.id === id)!.y).toBe(137.5);
    });

    it('steps a whole number of fixed ticks, leaving the remainder in the accumulator', () => {
        const game = makeGame({ simRate: 60 });
        game.spawn({ x: 0, y: 0, speed: 0, spin: 0 });

        game.advance(1 / 60 + 1 / 240); // one whole tick plus a quarter tick
        const stats = game.stats();
        expect(stats.tick).toBe(1);
        expect(stats.ticksThisFrame).toBe(1);
        expect(stats.accumulatorFill).toBeCloseTo(0.25, 5);
    });
});

describe('advance — degenerate dt', () => {
    it.each([
        ['zero', 0],
        ['negative', -5],
        ['NaN', Number.NaN],
        ['infinite', Number.POSITIVE_INFINITY],
    ])('treats a %s dt as a no-op that never moves or ticks', (_label, dt) => {
        const game = makeGame({ simRate: 60 });
        const id = game.spawn({ x: 12, y: 0, speed: 100, spin: 90 });
        game.advance(dt as number);
        const view = game.views().find((v) => v.id === id)!;
        expect(view.x).toBe(12);
        expect(view.rotation).toBe(0);
        expect(game.stats().tick).toBe(0);
    });
});

describe('reapPast', () => {
    it('destroys and returns leaves past the limit, keeping the rest', () => {
        const game = makeGame({ simRate: 60 });
        const gone = game.spawn({ x: 0, y: 0, speed: 1000, spin: 0 });
        const near = game.spawn({ x: 0, y: 0, speed: 10, spin: 0 });
        game.advance(1); // gone -> ~1000, near -> ~10

        const exited = game.reapPast(exitX(VIEWPORT));
        expect(exited).toEqual([gone]);
        expect(game.views().map((v) => v.id)).toEqual([near]);
        expect(game.stats().live).toBe(1);
    });

    it('holds a leaf sitting short of the limit', () => {
        const game = makeGame({ simRate: 60 });
        game.spawn({ x: 0, y: 0, speed: 0, spin: 0 });
        expect(game.reapPast(exitX(VIEWPORT))).toEqual([]);
        expect(game.stats().live).toBe(1);
    });

    it('crosses the full stage in a little over four seconds at the default speed', () => {
        const game = makeGame({ simRate: 60 });
        game.spawn({ x: spawnX(VIEWPORT), y: 0, speed: DEFAULT_SPEED, spin: DEFAULT_SPIN });
        const limit = exitX(VIEWPORT);

        let seconds = 0;
        while (game.reapPast(limit).length === 0 && seconds < 10) {
            game.advance(1 / 60);
            seconds += 1 / 60;
        }
        expect(seconds).toBeGreaterThan(4);
        expect(seconds).toBeLessThan(4.5);
        expect(game.stats().live).toBe(0);
    });
});

describe('clear', () => {
    it('destroys every leaf and returns their ids', () => {
        const game = makeGame({ simRate: 60 });
        const a = game.spawn({ x: 0, y: 0, speed: 0, spin: 0 });
        const b = game.spawn({ x: 0, y: 0, speed: 0, spin: 0 });
        expect(new Set(game.clear())).toEqual(new Set([a, b]));
        expect(game.views()).toEqual([]);
        expect(game.stats().live).toBe(0);
    });
});

describe('pause', () => {
    it('drains the accumulator without stepping the tick, so unpausing does not burst', () => {
        const game = makeGame({ simRate: 60 });
        const id = game.spawn({ x: 0, y: 0, speed: 100, spin: 0 });

        game.setPaused(true);
        game.advance(1);
        expect(game.stats().tick).toBe(0);
        expect(game.stats().paused).toBe(true);
        expect(game.views().find((v) => v.id === id)!.x).toBe(0);

        game.setPaused(false);
        game.advance(1 / 60); // a single fresh tick, not a second's worth of backlog
        expect(game.stats().tick).toBe(1);
        expect(game.views().find((v) => v.id === id)!.x).toBeCloseTo(100 / 60, 6);
    });
});

describe('setSimRate', () => {
    it('keeps on-screen travel time-based — a finer rate covers the same distance', () => {
        const game = makeGame({ simRate: 30 });
        const id = game.spawn({ x: 0, y: 0, speed: 240, spin: 0 });
        game.setSimRate(60);
        expect(game.stats().simRate).toBe(60);
        advanceTicks(game, 60, 60); // one simulated second, now at 60 Hz
        expect(game.views().find((v) => v.id === id)!.x).toBeCloseTo(240, 5);
    });
});
