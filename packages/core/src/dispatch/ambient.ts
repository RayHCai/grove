// How an awaitable finds its host (DESIGN §4.3). sleep() must know which invocation
// called it, and an ambient set at dispatch entry is lost after the first await — there
// is no AsyncLocalStorage in a browser. So the engine's own awaitables restore the
// ambient as they resolve, which works because the awaitable surface is closed and
// engine-owned: sleep, the motion verbs, storage reads, send.
//
// LIMIT (§4.3): awaiting a promise core did not hand out loses the ambient, and a later
// sleep falls back to the host scope.

import type { InvocationScope } from './scope-tree.js';

let current: InvocationScope | null = null;

/** The invocation the currently-running engine code belongs to, or null at top level. */
export function currentInvocation(): InvocationScope | null {
    return current;
}

export function setCurrentInvocation(scope: InvocationScope | null): void {
    current = scope;
}

/**
 * Runs `fn` with `scope` as the ambient invocation, restoring the previous ambient after.
 * Synchronous — this establishes the ambient up to the first await inside `fn`.
 */
export function withInvocation<T>(scope: InvocationScope, fn: () => T): T {
    const prev = current;
    current = scope;
    try {
        return fn();
    } finally {
        current = prev;
    }
}

/**
 * Wraps an engine awaitable so it restores `scope` as the ambient when it resolves — the
 * §4.3 mechanism. The continuation after a creator's `await sleep()` therefore runs with
 * the right invocation ambient again.
 */
export function resumeWith<T>(scope: InvocationScope | null, promise: Promise<T>): Promise<T> {
    return promise.then(
        value => {
            current = scope;
            return value;
        },
        error => {
            current = scope;
            throw error;
        },
    );
}
