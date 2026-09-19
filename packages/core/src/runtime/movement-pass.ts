// Apart from `movement.ts` because a decorator in a module the loop reaches as a VALUE drags
// TC39 decorator syntax into every consumer that transforms `src` rather than `dist`.

import type { EntityId } from '../ids.js';
import { entityKey } from './hosts.js';
import type { BaseMovement } from './movement.js';
import type { Runtime } from './runtime.js';

/** One movement instance's tick, contained the way a handler's body is; both endpoints run it. */
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
