// Named rectangles built once at load: point queries against static shapes, kept out of the
// per-tick AABB pass so immovable geometry is not re-indexed sixty times a second.

import type { Bounds, Vec3 } from '@platform/math';
import { boundsContains } from '@platform/math';

export class RegionIndex {
    readonly #regions = new Map<string, Bounds>();

    /** Build-time only — loadGame populates this from the manifest. */
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
