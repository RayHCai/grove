// Named rectangles built once at load: point queries against static shapes, kept out of the
// per-tick AABB pass so immovable geometry is not re-indexed sixty times a second.

import type { Bounds, Vec3 } from '@platform/math';
import { boundsContains } from '@platform/math';
import type { EntityId } from '../ids.js';

/** One entity crossing one region's edge on one tick. */
export interface RegionCrossing {
    region: string;
    id: EntityId;
    /** True for an entry, false for an exit — the two edges @onEnter and @onExit name. */
    entered: boolean;
}

export class RegionIndex {
    readonly #regions = new Map<string, Bounds>();
    /** Last tick's membership, per region; an edge is a diff. Not a snapshot store. */
    readonly #occupants = new Map<string, Set<EntityId>>();
    readonly #crossings: RegionCrossing[] = [];
    readonly #present = new Set<EntityId>();

    /** Build-time only — loadGame populates this from the manifest. */
    define(name: string, bounds: Bounds): void {
        this.#regions.set(name, bounds);
        this.#occupants.set(name, new Set());
    }

    contains(name: string, point: Vec3): boolean {
        const region = this.#regions.get(name);
        return region ? boundsContains(region, point.x, point.y) : false;
    }

    bounds(name: string): Bounds | undefined {
        return this.#regions.get(name);
    }

    /** Folds this tick's membership and reports crossings; the returned array is reused. */
    crossings(
        ids: readonly EntityId[],
        posX: (id: EntityId) => number,
        posY: (id: EntityId) => number,
    ): readonly RegionCrossing[] {
        this.#crossings.length = 0;
        for (const [region, bounds] of this.#regions) {
            const was = this.#occupants.get(region)!;
            this.#present.clear();
            for (const id of ids) {
                if (!boundsContains(bounds, posX(id), posY(id))) continue;
                this.#present.add(id);
                if (!was.has(id)) this.#crossings.push({ region, id, entered: true });
            }
            for (const id of was) {
                if (!this.#present.has(id)) this.#crossings.push({ region, id, entered: false });
            }
            // Replaced wholesale rather than mutated during the walk above, which would make the
            // second loop read a set that already holds this tick's arrivals.
            this.#occupants.set(region, new Set(this.#present));
        }
        return this.#crossings;
    }
}
