// Which world a script instance belongs to. Wiring stamps it at attach time so simulation code
// never has to guess from the ambient slot, which names whichever runtime loaded last.

import { currentRuntime } from './runtime.js';
import type { Runtime } from './runtime.js';

const OWNING_RUNTIME = Symbol.for('@platform/core:owning-runtime');

interface Owned {
    [OWNING_RUNTIME]?: Runtime;
}

/** @internal — called by wiring for every attached instance. */
export function setScriptRuntime(instance: object, rt: Runtime): void {
    (instance as Owned)[OWNING_RUNTIME] = rt;
}

/** The runtime that owns `instance`, falling back to the ambient one for an unattached object. */
export function scriptRuntime(instance: object): Runtime {
    return (instance as Owned)[OWNING_RUNTIME] ?? currentRuntime();
}
