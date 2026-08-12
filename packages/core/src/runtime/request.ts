// A function, not a method, because the destination is always the server. Loopback dispatches
// to @onRequest directly; over a network the transport carries it; with neither it is a no-op.

import { currentRuntime, hasRuntime } from './runtime.js';

export function request(name: string, payload?: Record<string, unknown>): void {
    if (!hasRuntime()) return;
    currentRuntime().requestSink?.(name, payload);
}
