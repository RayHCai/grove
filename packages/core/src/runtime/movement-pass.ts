// Apart from `movement.ts` because that module declares `@onEvent('jump')`, and a decorator in a
// module the loop's own graph reaches as a VALUE drags TC39 decorator syntax into every consumer
// that transforms `src` rather than the built `dist`. The movement classes are a type here.

import type { EntityId } from '../ids.js';
import { entityKey } from './hosts.js';
import type { BaseMovement } from './movement.js';
import type { Runtime } from './runtime.js';

/**
 * One movement instance's tick, contained the way a handler's body is.
 *
 * `accelerate` is abstract and `readIntent` / `applyForces` / `clampSpeed` are all overridable, so
 * every stage of `tick` is creator code reached without a dispatch. Exported because both endpoints
 * run this pass and a second copy of the containment would diverge from this one.
 */
export function tickMovement(
    rt: Runtime,
    movement: BaseMovement,
    host: EntityId,
    dt: number,
): void {
    rt.dispatcher.guard(
        rt.instances.forInstance(movement) ?? null,
        { method: 'tick', hostId: entityKey(host as number), tick: rt.tick, event: '@movement' },
        () => movement.tick(dt),
    );
}
