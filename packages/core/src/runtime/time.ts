// Time primitives (DESIGN §9). Each registers with the innermost live scope (§4.3): the
// ambient invocation if one is running, else the host scope, so it auto-cancels when its
// host dies. The loop ticks the timer heap at step 7.

import { currentInvocation } from '../dispatch/ambient.js';
import { currentRuntime } from './runtime.js';

function hostScope(): number {
    const inv = currentInvocation();
    return inv ? inv.hostId : -1;
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
