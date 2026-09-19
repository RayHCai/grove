// Per-host lookup rather than a module-level slot: a second world in one process would overwrite
// the slot, and every script that read it would then write into the wrong game.

import type { BaseScript } from '../script/bases.js';
import type { Runtime } from './runtime.js';

/** A script class, as a caller names one. Abstract-tolerant, so a base class is a legal query. */
export type ScriptQuery<T> = abstract new (...args: never[]) => T;

/** The instance of `klass` on `hostKey`, or `null`. Exact identity, never `instanceof`. */
export function scriptOnHost<T extends BaseScript<object>>(
    rt: Runtime,
    hostKey: string,
    klass: ScriptQuery<T>,
): T | null {
    for (const si of rt.instances.forHost(hostKey)) {
        if (si.klass === klass) return si.instance as T;
    }
    return null;
}
