// The drift rule and the scoring rule, in Node, with no world and no clock.

import { describe, it, expect } from 'vitest';
import { bounds } from '@platform/math';
import {
    clampToWorld,
    dropBand,
    exitX,
    harvestValue,
    hasExited,
    popValue,
    spawnX,
    stepLeaf,
} from '../dist/scripts/templates/leaf/leaf.js';
import {
    AVATAR_HALF,
    BADGE_BONUS,
    EDGE_MARGIN,
    HARVEST_POINTS,
    LEAF_HALF,
    LEAF_SPEED,
    LEAF_SPIN,
    POP_POINTS,
    RIPE_MULTIPLIER,
} from '../src/scripts/globals';

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

describe('dropBand', () => {
    it('insets the stage by the leaf, so nothing rides an edge', () => {
        const band = dropBand(WORLD);
        expect(band.low).toBe(-270 + LEAF_HALF);
        expect(band.high).toBe(270 - LEAF_HALF);
    });

    it('stays inside what an avatar can reach', () => {
        // The avatar clamps its own body onto the stage, so the furthest height it can stand at is
        // an avatar's half-box inside the edge — a leaf dropped past that plus both half-boxes
        // would be uncatchable rather than merely hard.
        const band = dropBand(WORLD);
        const reach = AVATAR_HALF + LEAF_HALF;
        expect(band.high).toBeLessThanOrEqual(WORLD.top - AVATAR_HALF + reach);
        expect(band.low).toBeGreaterThanOrEqual(WORLD.bottom + AVATAR_HALF - reach);
    });
});

describe('harvestValue', () => {
    it('pays the flat rate for an ordinary leaf', () => {
        expect(harvestValue({ ripe: false, badgedForHarvester: false })).toBe(HARVEST_POINTS);
    });

    it('multiplies for ripeness and adds for the badge, in that order', () => {
        // The badge is a flat reward for crossing the stage to the leaf that is yours; multiplying
        // it too would let one lucky leaf decide a round.
        expect(harvestValue({ ripe: true, badgedForHarvester: false })).toBe(
            HARVEST_POINTS * RIPE_MULTIPLIER,
        );
        expect(harvestValue({ ripe: false, badgedForHarvester: true })).toBe(
            HARVEST_POINTS + BADGE_BONUS,
        );
        expect(harvestValue({ ripe: true, badgedForHarvester: true })).toBe(
            HARVEST_POINTS * RIPE_MULTIPLIER + BADGE_BONUS,
        );
    });

    it('is always worth more than the click that steals it', () => {
        expect(popValue()).toBe(POP_POINTS);
        expect(harvestValue({ ripe: false, badgedForHarvester: false })).toBeGreaterThan(
            popValue(),
        );
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
