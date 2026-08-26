// The drift rule, in Node, with no world and no clock.

import { describe, it, expect } from 'vitest';
import { bounds } from '@platform/math';
import {
    EDGE_MARGIN,
    LEAF_SPEED,
    LEAF_SPIN,
    clampToWorld,
    exitX,
    hasExited,
    spawnX,
    stepLeaf,
} from '../src/server/leaf';

const WORLD = bounds(-480, 480, 270, -270);

describe('spawnX / exitX', () => {
    it('enters fully off the left edge and retires fully past the right', () => {
        expect(spawnX(WORLD)).toBe(-480 - EDGE_MARGIN);
        expect(exitX(WORLD)).toBe(480 + EDGE_MARGIN);
    });

    it('spans the whole world plus both margins', () => {
        expect(exitX(WORLD) - spawnX(WORLD)).toBe(960 + 2 * EDGE_MARGIN);
    });
});

describe('stepLeaf', () => {
    it('advances one second of travel and tumble', () => {
        const next = stepLeaf(0, 0, 1);
        expect(next.x).toBeCloseTo(LEAF_SPEED, 10);
        expect(next.rotation).toBeCloseTo(LEAF_SPIN, 10);
    });

    it('only ever travels left to right', () => {
        expect(stepLeaf(-100, 0, 1 / 60).x).toBeGreaterThan(-100);
    });

    it('keeps rotation inside one turn rather than growing without bound', () => {
        let rotation = 0;
        for (let i = 0; i < 600; i++) rotation = stepLeaf(0, rotation, 1 / 60).rotation;
        expect(rotation).toBeGreaterThanOrEqual(0);
        expect(rotation).toBeLessThan(360);
    });
});

describe('hasExited', () => {
    it('holds a leaf that is still crossing', () => {
        expect(hasExited(spawnX(WORLD), WORLD)).toBe(false);
        expect(hasExited(0, WORLD)).toBe(false);
        expect(hasExited(exitX(WORLD), WORLD)).toBe(false);
    });

    it('retires one that has cleared the margin', () => {
        expect(hasExited(exitX(WORLD) + 0.001, WORLD)).toBe(true);
    });

    it('is reached in a bounded number of ticks from the spawn point', () => {
        let x = spawnX(WORLD);
        let ticks = 0;
        while (!hasExited(x, WORLD)) {
            x = stepLeaf(x, 0, 1 / 60).x;
            ticks += 1;
            if (ticks > 10_000) break;
        }
        // 1024 world px at 240 px/s is a shade over four seconds.
        expect(ticks).toBeGreaterThan(200);
        expect(ticks).toBeLessThan(300);
    });
});

describe('clampToWorld', () => {
    it('passes a click inside the stage through', () => {
        expect(clampToWorld(100, WORLD)).toBe(100);
    });

    it('holds a click past an edge at that edge', () => {
        expect(clampToWorld(9999, WORLD)).toBe(270);
        expect(clampToWorld(-9999, WORLD)).toBe(-270);
    });

    it('reads a non-finite click as the middle rather than poisoning the world', () => {
        // The server writes this straight into a Float64Array; one NaN would be permanent.
        expect(clampToWorld(Number.NaN, WORLD)).toBe(0);
        expect(clampToWorld(Number.POSITIVE_INFINITY, WORLD)).toBe(0);
    });
});
