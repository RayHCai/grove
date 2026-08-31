// One host's attached script, by class — the edge that lets a script reach another script.
//
// Without it a game reaches for a module-level `let` to publish its rules object, which is
// per-process rather than per-world: a second world in one process overwrites the first's, and every
// script that read the slot then writes into the wrong game. The lookup below is per-host and holds
// nothing, so there is no slot to overwrite.
//
// Kept here rather than on each facade so the three call sites are one implementation, and so that
// `Entity`, `Player` and `Game` do not each import the instance registry.

import type { BaseScript } from '../script/bases.js';
import type { Runtime } from './runtime.js';

/** A script class, as a caller names one. Abstract-tolerant, so a base class is a legal query. */
export type ScriptQuery<T> = abstract new (...args: never[]) => T;

/**
 * The instance of `klass` attached to `hostKey`, or `null`.
 *
 * Exact class identity, never `instanceof`: two subclasses of one base are different scripts, and a
 * query for the base would otherwise answer with whichever happened to be attached first. A host
 * carries at most one instance of a class — wiring rejects a second, because its `@serverState`
 * names would collide — so the first match is the only match.
 */
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
