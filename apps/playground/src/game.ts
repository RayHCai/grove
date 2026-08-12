// The drifter game, now a REAL @platform/core simulation. Each leaf is a core Entity; a
// fixed-step Loop advances its position and rotation one tick at a time. PURE of React,
// DOM and `IRenderer` — it decides WHERE things are, the caller decides what to draw. That
// split is still the whole point: the tick rule is testable in Node with no canvas and no
// clock, exactly as core's own loop tests boot a runtime and step it.
//
// Why the loop lives here and not in decorated @onUpdate scripts: core's script decorators
// are TC39 standard decorators that `tsc` lowers but Vite's esbuild transform does not
// (core DESIGN §3.3). This app is bundled by esbuild, so it drives the loop through the
// non-decorator primitives — loadGame() → Loop → entity transforms — which is the same
// surface the core test suite uses.
//
// Coordinates are WORLD space throughout: origin at stage center, y-UP, world px (§3).

import type { Bounds } from '@platform/math';
import type { Entity, EntityId, TickPasses } from '@platform/core';
import { Loop, loadGame, clearRuntime, DEFAULT_SIM_RATE } from '@platform/core';

/** How a leaf should move, handed to `spawn`. */
export interface LeafSpec {
    /** World px. Spawn point; `x` advances, `y` is held for the leaf's whole life. */
    x: number;
    y: number;
    /** World px per second, positive — every leaf travels left to right. */
    speed: number;
    /** Degrees per second, CCW-positive — the tumble as it crosses. */
    spin: number;
}

/** One live leaf's transform, read off its core entity for the renderer to mirror. */
export interface LeafView {
    /** The core entity handle — also the caller's key back to its renderer node. */
    id: EntityId;
    x: number;
    y: number;
    /** Degrees, kept in [0, 360). */
    rotation: number;
}

/** A frame's-eye view of the fixed-step loop, for the debug panel. */
export interface LoopStats {
    /** The monotonic tick index the loop is at. */
    tick: number;
    /** Ticks per simulated second — the fixed timestep is `1 / simRate`. */
    simRate: number;
    /** Live leaves. */
    live: number;
    /** Ticks executed on the most recent `advance` — 0, 1 or more as fps drifts off simRate. */
    ticksThisFrame: number;
    /** Sub-tick fill, 0..1: the fraction of the next tick already buffered in the accumulator. */
    accumulatorFill: number;
    /** Whether the loop is paused — the render frame keeps running, the sim does not. */
    paused: boolean;
}

/**
 * Half a sprite's width, in world px, used as the off-stage margin.
 *
 * A leaf spawns this far LEFT of the viewport's left edge and is retired this far RIGHT of
 * its right edge, so it slides fully into view and fully out rather than popping.
 */
export const EDGE_MARGIN = 32;

/** Default travel speed, world px per second — about four seconds across a 960px stage. */
export const DEFAULT_SPEED = 240;

/** Default tumble rate, degrees per second. */
export const DEFAULT_SPIN = 90;

/**
 * The world x a leaf enters from: fully off the viewport's left edge.
 *
 * Derived from the LIVE viewport rather than the design stage, so a resized window (or a
 * zoomed camera) spawns at the edge the player can actually see.
 */
export function spawnX(viewport: Bounds): number {
    return viewport.left - EDGE_MARGIN;
}

/** The world x past which a leaf has fully left the stage. */
export function exitX(viewport: Bounds): number {
    return viewport.right + EDGE_MARGIN;
}

interface LeafRecord {
    entity: Entity;
    speed: number;
    spin: number;
}

/**
 * A running game: a core runtime, its loop, and the leaves it simulates.
 *
 * `advance(dt)` is a fixed-step accumulator over `Loop.step`. Core owns no accumulator: only the
 * host knows what its clock means, and here the panel reads the tick count and sub-tick fill.
 */
export class LeafGame {
    readonly #rt;
    readonly #loop: Loop;
    readonly #leaves = new Map<number, LeafRecord>();

    #accumulator = 0;
    #ticksThisFrame = 0;

    constructor(opts: { simRate?: number } = {}) {
        // A game VIEW, so the client role — it skips the server's replication ring.
        this.#rt = loadGame({ role: 'client', simRate: opts.simRate ?? DEFAULT_SIM_RATE });
        this.#loop = new Loop(this.#rt);

        // Advancing every leaf each tick IS the movement pass (§8.2 step 4). Wrap rather
        // than replace so the runtime's own passes still run.
        const inner = this.#rt.passes as TickPasses;
        this.#rt.passes = {
            ...inner,
            movement: (dt, scope) => {
                for (const { entity, speed, spin } of this.#leaves.values()) {
                    entity.setPosition(entity.position.x + speed * dt, entity.position.y);
                    // Kept in [0, 360) so the value stays readable and never drifts toward the
                    // precision loss a monotonically growing angle would eventually hit.
                    entity.setRotation((entity.rotation + spin * dt) % 360);
                }
                inner.movement(dt, scope);
            },
        };
    }

    /** Spawns a leaf as a live entity and returns its handle. */
    spawn(spec: LeafSpec): EntityId {
        const entity = this.#rt.gameInstance!.spawn('leaf', spec.x, spec.y);
        entity.setRotation(0);
        this.#leaves.set(entity.entityId as number, { entity, speed: spec.speed, spin: spec.spin });
        return entity.entityId;
    }

    /**
     * Runs the fixed-step loop for `dtSeconds` of real time.
     *
     * `dtSeconds` is clamped at zero: a backwards or non-finite clock (a paused tab
     * resuming, a NaN frame) must neither drag leaves backwards nor poison the accumulator.
     * The frame loop already caps the upper end.
     */
    advance(dtSeconds: number): void {
        const elapsed = Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : 0;
        this.#accumulator += elapsed;

        const tickDt = 1 / this.#rt.simRate;
        let ticks = 0;
        while (this.#accumulator >= tickDt) {
            this.#accumulator -= tickDt;
            // A paused loop still drains the accumulator, so unpausing does not burst.
            if (!this.#rt.paused) {
                this.#loop.step(this.#rt.tick + 1);
                ticks += 1;
            }
        }
        this.#ticksThisFrame = ticks;
    }

    /** The live leaves' transforms, in spawn order, read straight off the entities. */
    views(): LeafView[] {
        const out: LeafView[] = [];
        for (const { entity } of this.#leaves.values()) {
            const p = entity.position;
            out.push({ id: entity.entityId, x: p.x, y: p.y, rotation: entity.rotation });
        }
        return out;
    }

    /** Destroys and returns every leaf whose x has passed `limitX` (strictly greater). */
    reapPast(limitX: number): EntityId[] {
        const exited: EntityId[] = [];
        for (const { entity } of this.#leaves.values()) {
            if (entity.position.x > limitX) exited.push(entity.entityId);
        }
        for (const id of exited) {
            this.#leaves.get(id as number)!.entity.destroy();
            this.#leaves.delete(id as number);
        }
        // Drain now so the freed slots and the live count are honest before the next frame.
        if (exited.length > 0) this.#rt.entityManager.drainDestroyed();
        return exited;
    }

    /** Destroys every leaf and returns their handles so the caller can drop its nodes. */
    clear(): EntityId[] {
        const ids = [...this.#leaves.values()].map((leaf) => leaf.entity.entityId);
        for (const { entity } of this.#leaves.values()) entity.destroy();
        this.#leaves.clear();
        if (ids.length > 0) this.#rt.entityManager.drainDestroyed();
        return ids;
    }

    /** Retunes the fixed timestep. Motion is time-based, so on-screen speed is unchanged. */
    setSimRate(rate: number): void {
        this.#rt.setSimRate(rate);
    }

    setPaused(paused: boolean): void {
        this.#rt.paused = paused;
    }

    stats(): LoopStats {
        const tickDt = 1 / this.#rt.simRate;
        return {
            tick: this.#rt.tick,
            simRate: this.#rt.simRate,
            live: this.#leaves.size,
            ticksThisFrame: this.#ticksThisFrame,
            accumulatorFill: Math.min(this.#accumulator / tickDt, 1),
            paused: this.#rt.paused,
        };
    }

    /** Tears the game down: destroys every leaf and releases the runtime slot. */
    dispose(): void {
        this.clear();
        clearRuntime();
    }
}
