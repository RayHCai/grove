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

/** Wraps an engine awaitable so whatever resumes behind it runs under the ambient it was made in. */
export function resumeWith<T>(promise: Promise<T>): Promise<T> {
    // Saved here rather than named by the caller: assigning a fixed scope left a settled handler's
    // dead invocation ambient at top level, where the next `every` inherited it.
    const made = current;
    return promise.then(
        (value) => {
            current = made;
            return value;
        },
        (error) => {
            current = made;
            throw error;
        },
    );
}
