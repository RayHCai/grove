import type { Entity } from '../src/runtime/entity.js';
import type { Runtime } from '../src/runtime/runtime.js';
import { entityKey } from '../src/runtime/hosts.js';

/** The instance of `className` attached to `entity`; throws rather than returning undefined. */
export function instanceOf<T>(rt: Runtime, entity: Entity, className: string): T {
    for (const si of rt.instances.forHost(entityKey(entity.entityId as number))) {
        if (si.className === className) return si.instance as T;
    }
    throw new Error(`${className} not attached`);
}
