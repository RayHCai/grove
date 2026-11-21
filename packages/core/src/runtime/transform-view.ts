import type { EntityId } from '../ids.js';
import type { TransformView } from '../world/broadphase.js';
import type { Runtime } from './runtime.js';

/** A read-only view of the live stores; every entity a point and a body unless told otherwise. */
export function liveTransformView(
    rt: Runtime,
    halfExtent: (id: EntityId, axis: 'w' | 'h') => number = () => 0,
    isBody?: (id: EntityId) => boolean,
): TransformView {
    return {
        liveIds: (out?: EntityId[]) => {
            const ids = rt.entities.liveIds(out);
            if (isBody === undefined) return ids;
            // Compacted in place, so the order stays ascending and the scratch array is reused.
            let kept = 0;
            for (const id of ids) if (isBody(id)) ids[kept++] = id;
            ids.length = kept;
            return ids;
        },
        posX: (id) => rt.transforms.posX(id),
        posY: (id) => rt.transforms.posY(id),
        halfWidth: (id) => halfExtent(id, 'w'),
        halfHeight: (id) => halfExtent(id, 'h'),
    };
}
