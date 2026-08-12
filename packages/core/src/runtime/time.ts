// Each timer registers with the ambient invocation's host scope, so it auto-cancels when that
// host dies.

import { currentInvocation } from '../dispatch/ambient.js';
import { currentRuntime } from './runtime.js';
import { NO_SCOPE } from '../dispatch/scope-tree.js';

function hostScope(): number {
    return currentInvocation()?.hostId ?? NO_SCOPE;
}

export function sleep(seconds: number): Promise<void> {
    return currentRuntime().timers.sleep(seconds, hostScope());
}

export function every(seconds: number, fn: () => void): () => void {
    return currentRuntime().timers.every(seconds, hostScope(), fn);
}

export function after(seconds: number, fn: () => void): () => void {
    return currentRuntime().timers.after(seconds, hostScope(), fn);
}
