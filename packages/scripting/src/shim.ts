// Defense in depth, and nothing more: the static pass is the mechanism, and it is the only one of
// the two that can see `SyncedScript` scope. This shim guards a whole realm, so it belongs on the
// realm a chunk is evaluated in — never on the host application's, where a ClientScript's `Date` is
// perfectly legal and this would break it.

import { DENIED_GLOBALS, DENIED_MATH } from './policy.js';
import { DeterminismError } from './errors.js';

export interface ShimOptions {
    /** The realm to guard — a `vm` context's global, or a worker's. Defaults to `globalThis`. */
    readonly target?: object;
    /** Names to leave as they are. */
    readonly allow?: Iterable<string>;
}

export interface Shim {
    /** The names this shim replaced, sorted. */
    readonly guarded: readonly string[];
    /** Puts every original back, including the ones that were absent. */
    dispose(): void;
}

/** Replaces the denied globals with accessors that throw, and `Math` with one that keeps its exact members. */
export function installDeterminismShim(options: ShimOptions = {}): Shim {
    const target = (options.target ?? globalThis) as Record<string, unknown>;
    const allow = new Set(options.allow ?? []);
    const saved = new Map<string, PropertyDescriptor | undefined>();

    for (const [name, redirect] of DENIED_GLOBALS) {
        if (allow.has(name)) continue;
        saved.set(name, Object.getOwnPropertyDescriptor(target, name));
        Object.defineProperty(target, name, {
            configurable: true,
            enumerable: false,
            get(): never {
                throw new DeterminismError(
                    `${name} is not reachable from a synced script — use ${redirect.use}; ${redirect.because}.`,
                );
            },
        });
    }

    if (!allow.has('Math')) {
        saved.set('Math', Object.getOwnPropertyDescriptor(target, 'Math'));
        Object.defineProperty(target, 'Math', {
            configurable: true,
            enumerable: false,
            writable: true,
            value: guardedMath(),
        });
    }

    return {
        guarded: [...saved.keys()].toSorted(),
        dispose(): void {
            for (const [name, descriptor] of saved) {
                if (descriptor) Object.defineProperty(target, name, descriptor);
                else delete target[name];
            }
            saved.clear();
        },
    };
}

// Inherits from the real Math, so `floor`, `abs`, `min` and the other exact members still answer.
function guardedMath(): typeof Math {
    const guarded = Object.create(Math) as typeof Math;
    for (const [name, redirect] of DENIED_MATH) {
        Object.defineProperty(guarded, name, {
            configurable: true,
            enumerable: false,
            get(): never {
                throw new DeterminismError(
                    `Math.${name} is not reachable from a synced script — use ${redirect.use}; ${redirect.because}.`,
                );
            },
        });
    }
    return guarded;
}
