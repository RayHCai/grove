// A world whose whole game is drawing numbers, so nothing but the stream behind `random` is under
// test here.
//
// Every draw happens on the authority inside a press handler and is folded into a replicated string
// of the RAW values: the claim is that two hosts built from one project draw the same numbers in
// the same order, and a digest of many draws is what makes one misplaced draw visible.

import type { Ctx, Game } from '@platform/engine';
import { ServerScript, game, onPlayerJoin, onPress, random, serverState } from '@platform/engine';
import type { ProjectBounds } from '@platform/project';
import { TEMPLATE_AVATAR, attach, defineWorld, sprite } from '../world.js';
import type { World } from '../world.js';

export const SCRIPT_DEALER = 'dealer';

export const REGION_POOL = 'pool';
/** Off the origin on both axes, so a point that fell back to (0, 0) cannot pass for one drawn. */
export const POOL_BOUNDS: ProjectBounds = { left: 100, right: 180, top: 90, bottom: 40 };
/** A name the project never declares — the authoring typo `pointIn` has to answer for. */
export const REGION_ABSENT = 'lagoon';

export const SEED_A = 20260901;
export const SEED_B = 20260902;

/** Enough draws that two streams agreeing by luck is not an explanation for a matching digest. */
export const DRAWS = 16;
export const RANGE = { min: -50, max: 50 };
export const PICKS = 12;
/** Four names, so a `pick` that always answered the same element is visible in one press. */
export const SPECIES: string[] = ['ash', 'birch', 'cedar', 'dogwood'];
export const TRIALS = 64;
export const HEADS = 0.5;
export const SURE_TRIALS = 16;
export const POINTS = 8;

export const W = {
    seedA: 'seed-a',
    seedB: 'seed-b',
    draw: 'draw',
    drawSplit: 'draw-split',
    pick: 'pick',
    chance: 'chance',
    pointIn: 'point-in',
    pointStray: 'point-stray',
} as const;

/**
 * Readings that carry the draws themselves rather than a verdict about them.
 *
 * A field saying "every point was inside the region" would be the world grading its own homework;
 * these let the test do the arithmetic on exactly what a client was told.
 */
export const S = {
    digest: 'digest',
    mixed: 'mixed',
    picked: 'picked',
    spots: 'spots',
    coins: 'coins',
    atOne: 'atOne',
    atZero: 'atZero',
    strayX: 'strayX',
    strayY: 'strayY',
} as const;

export class Dealer extends ServerScript<Game> {
    @serverState digest = '';
    @serverState mixed = '';
    @serverState picked = '';
    @serverState spots = '';
    @serverState coins = '';
    @serverState atOne = '';
    @serverState atZero = '';
    /** Sentinels off the origin, so the origin a missed region answers with is not a default. */
    @serverState strayX = -1;
    @serverState strayY = -1;

    @onPlayerJoin
    join(ctx: Ctx): void {
        ctx.player?.spawn();
    }

    @onPress(W.seedA)
    doSeedA(): void {
        random.seed(SEED_A);
    }

    @onPress(W.seedB)
    doSeedB(): void {
        random.seed(SEED_B);
    }

    @onPress(W.draw)
    doDraw(): void {
        const drawn: string[] = [];
        // Full precision rather than rounded, so a divergence in the low bits is not folded away.
        for (let i = 0; i < DRAWS; i++) drawn.push(String(random.between(RANGE.min, RANGE.max)));
        this.digest = drawn.join('|');
    }

    /** Alternating sources under one seed, which reproduces `draw` only if both share a stream. */
    @onPress(W.drawSplit)
    doDrawSplit(): void {
        const drawn: string[] = [];
        for (let i = 0; i < DRAWS; i++) {
            const source = i % 2 === 0 ? random : game.random;
            drawn.push(String(source.between(RANGE.min, RANGE.max)));
        }
        this.mixed = drawn.join('|');
    }

    @onPress(W.pick)
    doPick(): void {
        const taken: string[] = [];
        for (let i = 0; i < PICKS; i++) taken.push(random.pick(SPECIES));
        this.picked = taken.join(',');
    }

    @onPress(W.chance)
    doChance(): void {
        this.coins = this.#flips(TRIALS, HEADS);
        this.atOne = this.#flips(SURE_TRIALS, 1);
        this.atZero = this.#flips(SURE_TRIALS, 0);
    }

    @onPress(W.pointIn)
    doPointIn(): void {
        const points: string[] = [];
        for (let i = 0; i < POINTS; i++) {
            const point = random.pointIn(REGION_POOL);
            points.push(`${point.x},${point.y}`);
        }
        this.spots = points.join('|');
    }

    @onPress(W.pointStray)
    doPointStray(): void {
        const point = random.pointIn(REGION_ABSENT);
        this.strayX = point.x;
        this.strayY = point.y;
    }

    #flips(count: number, probability: number): string {
        let out = '';
        for (let i = 0; i < count; i++) out += random.chance(probability) ? '1' : '0';
        return out;
    }
}

export const RANDOMNESS_WORLD: World = defineWorld({
    id: 'randomness',
    scripts: [
        {
            id: SCRIPT_DEALER,
            export: 'Dealer',
            path: 'src/worlds/randomness.ts',
            location: 'server',
            host: 'game',
            ctor: Dealer,
        },
    ],
    templates: [sprite(TEMPLATE_AVATAR)],
    regions: [{ name: REGION_POOL, bounds: POOL_BOUNDS }],
    gameScripts: [attach(SCRIPT_DEALER)],
});
