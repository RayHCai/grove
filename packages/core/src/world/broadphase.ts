// Query order is ascending entity id because the contact set it feeds must be deterministic.
// The transform source is a constructor argument so a historical query can run over a ring
// buffer instead of the live store.

import type { EntityId } from '../ids.js';

/** The minimal transform read surface a Broadphase needs — the live store or a ring buffer. */
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
            // Ignores z on purpose — proximity is a planar question here.
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
}
