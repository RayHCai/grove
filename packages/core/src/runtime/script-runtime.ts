// Which world a script instance belongs to. Wiring stamps it at attach time so simulation code
// never has to guess from the ambient slot, which names whichever runtime loaded last.

import { OWNING_RUNTIME, currentRuntime, ownedRuntime } from './runtime.js';
import type { Runtime } from './runtime.js';

/** @internal called by wiring for every attached instance. */
export function setScriptRuntime(instance: object, rt: Runtime): void {
    (instance as { [OWNING_RUNTIME]?: Runtime })[OWNING_RUNTIME] = rt;
}

/** The runtime that owns `instance`, falling back to the ambient one for an unattached object. */
export function scriptRuntime(instance: object): Runtime {
    return ownedRuntime(instance) ?? currentRuntime();
}
