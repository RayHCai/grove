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
    /**
     * Last tick's membership, per region.
     *
     * An edge is a diff, so the previous set is the whole state — and it lives on the index that
     * owns the geometry rather than on the runtime, because it is rebuilt with the world and is
     * deliberately not a snapshot store: a rewind leaves it describing the tick it was last folded on.
     */
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

    /**
     * Folds this tick's membership and reports every crossing since the last call.
     *
     * The returned array is reused, so a caller that keeps it past the next call reads the next
     * tick's edges: this runs over every live entity every tick, and a fresh array per region would
     * put one allocation per region per tick on the GC.
     */
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
