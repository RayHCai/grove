// One Broadphase, three consumers (DESIGN §2): the contact set, find({ near }), and
// per-player interest scoping. The naive implementation is O(n²) per query over entity
// AABBs; a grid or Rapier-backed index substitutes behind the same interface later. Its
// iteration order is stable (ascending entity id) for determinism (§1.2).
//
// Constructible over a SUPPLIED transform source, not only the live store (§8.1), so a
// historical query builds a throwaway index over a ring buffer without disturbing the
// present.

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
            // Euclidean over x/y, ignoring z (§12.13); AABB half-extent slack included.
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
            if (Math.abs(ax - bx) <= ahw + this.#view.halfWidth(other) && Math.abs(ay - by) <= ahh + this.#view.halfHeight(other)) {
                out.push(other);
            }
        }
        return out;
    }
}
