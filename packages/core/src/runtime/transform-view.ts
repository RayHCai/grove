import type { EntityId } from '../ids.js';
import type { TransformView } from '../world/broadphase.js';
import type { Runtime } from './runtime.js';

/** A read-only view of the live stores; without `halfExtent` every entity is a point. */
export function liveTransformView(
    rt: Runtime,
    halfExtent: (id: EntityId, axis: 'w' | 'h') => number = () => 0,
): TransformView {
    return {
        liveIds: (out?: EntityId[]) => rt.entities.liveIds(out),
        posX: (id) => rt.transforms.posX(id),
        posY: (id) => rt.transforms.posY(id),
        halfWidth: (id) => halfExtent(id, 'w'),
        halfHeight: (id) => halfExtent(id, 'h'),
    };
}
