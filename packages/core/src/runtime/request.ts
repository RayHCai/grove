// request() is the whole client→server vocabulary (tier C — needs transport, DESIGN §12.6).
// A function, not a method: the destination is always "the server". In a loopback/local
// run the runtime can dispatch it to @onRequest handlers directly; over a network the
// transport layer carries it. With no transport wired it is a documented no-op.

import { currentRuntime, hasRuntime } from './runtime.js';

export function request(name: string, payload?: Record<string, unknown>): void {
    if (!hasRuntime()) return;
    currentRuntime().requestSink?.(name, payload);
}
