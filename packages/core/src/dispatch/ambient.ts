// A browser has no AsyncLocalStorage, so the engine's own awaitables restore the ambient as they
// resolve; awaiting a promise core did not hand out loses it and falls back to the host scope.

import type { InvocationScope } from './scope-tree.js';

let current: InvocationScope | null = null;

/** The invocation the currently-running engine code belongs to, or null at top level. */
export function currentInvocation(): InvocationScope | null {
    return current;
}

export function setCurrentInvocation(scope: InvocationScope | null): void {
    current = scope;
}

/** Runs `fn` with `scope` as the ambient invocation, restoring the previous ambient after. */
export function withInvocation<T>(scope: InvocationScope, fn: () => T): T {
    const prev = current;
    current = scope;
    try {
        return fn();
    } finally {
        current = prev;
    }
}

/** Wraps an engine awaitable so it restores `scope` as the ambient when it settles. */
export function resumeWith<T>(scope: InvocationScope | null, promise: Promise<T>): Promise<T> {
    return promise.then(
        (value) => {
            current = scope;
            return value;
        },
        (error) => {
            current = scope;
            throw error;
        },
    );
}
