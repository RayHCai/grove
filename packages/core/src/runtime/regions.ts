// Panel-authored regions: named rectangles built once at load and never updated (DESIGN
// §8.2). Each tick is a point query per entity against static shapes — routing this through
// the per-tick AABB pass would rebuild an index over immovable geometry sixty times a
// second. `find({ in })` resolves against it, and it is where the region enter/exit pass
// and checkpoint update happen (§8.2 step 6).

import type { Bounds, Vec3 } from '@platform/math';
import { boundsContains } from '@platform/math';

export class RegionIndex {
    readonly #regions = new Map<string, Bounds>();

    /** Build-time only — loadGame populates this from the manifest; no runtime API adds one. */
    define(name: string, bounds: Bounds): void {
        this.#regions.set(name, bounds);
    }

    contains(name: string, point: Vec3): boolean {
        const region = this.#regions.get(name);
        return region ? boundsContains(region, point.x, point.y) : false;
    }

    bounds(name: string): Bounds | undefined {
        return this.#regions.get(name);
    }

    get names(): string[] {
        return [...this.#regions.keys()];
    }
}
