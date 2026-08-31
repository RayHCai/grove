// The `leaf` template's script, and the arithmetic every other script asks it for.
//
// What a leaf IS lives here: how it is spawned, how it drifts, what it is worth, and what the two
// regions do to it. `Rules` drives the drift and `Harvester` scores a catch, but neither restates
// any of those numbers — they call in.

import type { Ctx, Entity, Game } from '@platform/engine';
import { ServerScript, game, onClick, onEnter, onExit, serverState } from '@platform/engine';
import {
    BADGE_BONUS,
    EDGE_MARGIN,
    HARVEST_POINTS,
    LEAF_HALF,
    LEAF_LAYER,
    LEAF_SCALE,
    LEAF_SPEED,
    LEAF_SPIN,
    LEAF_TAG,
    LEAF_TEMPLATE,
    MARKER_LAYER,
    MARKER_OFFSET_Y,
    MARKER_OPACITY,
    MARKER_SCALE,
    POP_POINTS,
    REGION_BONUS,
    REGION_COMPOST,
    RIPE_MULTIPLIER,
    RIPE_SCALE,
    markerTemplate,
} from '../../globals.js';
import { Rules } from '../../game/rules.js';

/** An axis-aligned rectangle, as the engine's `Bounds` declares one. */
interface Rect {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

/** The world x a leaf enters from, fully off the left edge. */
export function spawnX(bounds: Rect): number {
    return bounds.left - EDGE_MARGIN;
}

/** The world x past which a leaf has fully left the stage. */
export function exitX(bounds: Rect): number {
    return bounds.right + EDGE_MARGIN;
}

/** Clamps a planted leaf to the stage, so one can never enter above or below the visible world. */
export function clampToWorld(y: number, bounds: Rect): number {
    if (!Number.isFinite(y)) return 0;
    return Math.min(Math.max(y, bounds.bottom), bounds.top);
}

/**
 * The band a dropped leaf may enter at.
 *
 * Inset by the harvest half-box: an avatar cannot reach above the world's top edge, so a leaf
 * spawned there would be uncatchable rather than merely hard.
 */
export function dropBand(bounds: Rect): { low: number; high: number } {
    return { low: bounds.bottom + LEAF_HALF, high: bounds.top - LEAF_HALF };
}

export interface LeafStep {
    x: number;
    rotation: number;
}

/** One tick of drift. Rotation stays in [0, 360) rather than growing toward precision loss. */
export function stepLeaf(x: number, rotation: number, dt: number): LeafStep {
    return { x: x + LEAF_SPEED * dt, rotation: (rotation + LEAF_SPIN * dt) % 360 };
}

/** Whether a leaf at `x` has finished crossing and should be destroyed. */
export function hasExited(x: number, bounds: Rect): boolean {
    return x > exitX(bounds);
}

/**
 * What one harvest is worth.
 *
 * Ripening multiplies and the badge adds, in that order: multiplying the badge too would make one
 * lucky leaf decide a round.
 */
export function harvestValue(opts: { ripe: boolean; badgedForHarvester: boolean }): number {
    const base = opts.ripe ? HARVEST_POINTS * RIPE_MULTIPLIER : HARVEST_POINTS;
    return base + (opts.badgedForHarvester ? BADGE_BONUS : 0);
}

export function popValue(): number {
    return POP_POINTS;
}

/**
 * Spawns one leaf, plus the badge parented above it in the seat it is ripe for.
 *
 * Left unowned deliberately: the server destroys every entity whose `ownerId` matches a departing
 * player, and a leaf belongs to the round rather than to a person.
 */
export function spawnLeaf(world: Game, worldY: number, badgeSlot: number): Entity {
    const bounds = world.bounds;
    const leaf = world.spawn(LEAF_TEMPLATE, spawnX(bounds), clampToWorld(worldY, bounds));
    leaf.tag(LEAF_TAG);
    leaf.setRotation(0);
    leaf.setScale(LEAF_SCALE);
    leaf.layer = LEAF_LAYER;
    // Assigned here and nowhere else: nothing in the engine, the manifest or the template system
    // writes a collider, so `@onCollide` and `getTouching` answer nothing at all until one exists.
    leaf.collider = {
        enabled: true,
        isTrigger: true,
        bounds: { left: -LEAF_HALF, right: LEAF_HALF, top: LEAF_HALF, bottom: -LEAF_HALF },
    };
    // The template attached `Leaf` inside `spawn` — attaching is synchronous, and only `@onStart`
    // waits for a pass — so the instance is already here to write through.
    const script = leaf.getScript(Leaf);
    if (script !== null) script.badgeSlot = badgeSlot;

    // Follows its parent's position but inherits neither its rotation nor its scale, which is what
    // keeps the badge upright over a tumbling leaf.
    const badge = world.spawn(markerTemplate(badgeSlot), 0, MARKER_OFFSET_Y);
    badge.setScale(MARKER_SCALE);
    badge.opacity = MARKER_OPACITY;
    badge.layer = MARKER_LAYER;
    badge.attachTo(leaf);
    return leaf;
}

/** Every leaf currently on the stage. The badges are not leaves; the tag is what says so. */
export function liveLeaves(world: Game): Entity[] {
    return world.find({ tag: LEAF_TAG });
}

/**
 * On every leaf: what the two regions do to it, and what a click does.
 *
 * `@onEnter` / `@onExit` dispatch to ENTITY hosts only, so a region handler on a Game-hosted script
 * would never fire.
 */
export class Leaf extends ServerScript<Entity> {
    /** Entity-hosted, so it replicates: the browser reads it to explain why a leaf draws large. */
    @serverState ripe = false;
    @serverState badgeSlot = -1;

    @onEnter(REGION_BONUS)
    ripen(): void {
        this.ripe = true;
        this.host.setScale(RIPE_SCALE);
    }

    @onExit(REGION_BONUS)
    wither(): void {
        this.ripe = false;
        this.host.setScale(LEAF_SCALE);
    }

    /** Destroyed HERE rather than at the world's edge, which makes the drift pass's reap a backstop. */
    @onEnter(REGION_COMPOST)
    compost(): void {
        game.getScript(Rules)?.noteWasted();
        this.host.destroy();
    }

    /**
     * A pointer hit the browser resolved against its own camera, which no authority can recompute.
     *
     * Whether the clicking player could plausibly reach it is deliberately not checked — popping is
     * the long-range steal, and it is worth a point rather than a harvest.
     */
    @onClick
    pop(ctx: Ctx): void {
        const rules = game.getScript(Rules);
        const player = ctx.player;
        if (rules === null || !player || rules.phase !== 'playing' || !this.host.alive) return;
        rules.award(player, popValue());
        this.host.destroy();
    }
}
