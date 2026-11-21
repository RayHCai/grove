// Query order is ascending entity id, because the contact set it feeds must be deterministic.
// The transform source is a constructor argument so a historical query can run over a ring.

import { grownCapacity } from '@platform/math';
import type { EntityId } from '../ids.js';

/** The minimal transform read surface a Broadphase needs: the live store or a ring buffer. */
export interface TransformView {
    liveIds(out?: EntityId[]): EntityId[];
    posX(id: EntityId): number;
    posY(id: EntityId): number;
    /** Half-extents of the entity's AABB; a point entity is (0,0). */
    halfWidth(id: EntityId): number;
    halfHeight(id: EntityId): number;
}

export class Broadphase {
    readonly #view: TransformView;
    readonly #ids: EntityId[] = [];
    /** Per-body lanes for the pair walk, indexed by position in `#ids`, not by slot. */
    #posX = new Float64Array(0);
    #posY = new Float64Array(0);
    #halfW = new Float64Array(0);
    #halfH = new Float64Array(0);

    constructor(view: TransformView) {
        this.#view = view;
    }

    /** Entities whose AABB overlaps a circle of `radius` about (x, y). Ascending id order. */
    near(x: number, y: number, radius: number, out: EntityId[] = []): EntityId[] {
        out.length = 0;
        const ids = this.#view.liveIds();
        for (const id of ids) {
            const ex = this.#view.posX(id);
            const ey = this.#view.posY(id);
            const dx = ex - x;
            const dy = ey - y;
            // Ignores z on purpose; proximity is a planar question here.
            const reach = radius + Math.max(this.#view.halfWidth(id), this.#view.halfHeight(id));
            if (dx * dx + dy * dy <= reach * reach) out.push(id);
        }
        return out;
    }

    /** Entities whose AABB overlaps `id`'s AABB, excluding `id` itself. Ascending id order. */
    overlapping(id: EntityId, out: EntityId[] = []): EntityId[] {
        out.length = 0;
        const ax = this.#view.posX(id);
        const ay = this.#view.posY(id);
        const ahw = this.#view.halfWidth(id);
        const ahh = this.#view.halfHeight(id);
        for (const other of this.#view.liveIds()) {
            if (other === id) continue;
            const bx = this.#view.posX(other);
            const by = this.#view.posY(other);
            if (
                Math.abs(ax - bx) <= ahw + this.#view.halfWidth(other) &&
                Math.abs(ay - by) <= ahh + this.#view.halfHeight(other)
            ) {
                out.push(other);
            }
        }
        return out;
    }

    /** Each overlapping pair once, `[earlier, later]` ascending, so every fold of it agrees. */
    pairs(
        out: Array<[EntityId, EntityId]> = [],
        exclude?: (a: EntityId, b: EntityId) => boolean,
    ): Array<[EntityId, EntityId]> {
        out.length = 0;
        const ids = this.#view.liveIds(this.#ids);
        const n = ids.length;
        if (n < 2) return out;
        // Each body's reads happen once into flat lanes: through the view they are closure hops,
        // and the walk below would otherwise pay four of them per candidate pair.
        this.#loadLanes(ids, n);
        const posX = this.#posX;
        const posY = this.#posY;
        const halfW = this.#halfW;
        const halfH = this.#halfH;

        for (let i = 0; i < n; i++) {
            const ax = posX[i]!;
            const ay = posY[i]!;
            const aw = halfW[i]!;
            const ah = halfH[i]!;
            for (let j = i + 1; j < n; j++) {
                if (!(Math.abs(ax - posX[j]!) <= aw + halfW[j]!)) continue;
                if (!(Math.abs(ay - posY[j]!) <= ah + halfH[j]!)) continue;
                const a = ids[i]!;
                const b = ids[j]!;
                if (exclude?.(a, b) === true) continue;
                out.push([a, b]);
            }
        }
        return out;
    }

    #loadLanes(ids: readonly EntityId[], n: number): void {
        if (this.#posX.length < n) {
            const cap = grownCapacity(this.#posX.length, n);
            this.#posX = new Float64Array(cap);
            this.#posY = new Float64Array(cap);
            this.#halfW = new Float64Array(cap);
            this.#halfH = new Float64Array(cap);
        }
        const view = this.#view;
        for (let i = 0; i < n; i++) {
            const id = ids[i]!;
            this.#posX[i] = view.posX(id);
            this.#posY[i] = view.posY(id);
            this.#halfW[i] = view.halfWidth(id);
            this.#halfH[i] = view.halfHeight(id);
        }
    }
}
