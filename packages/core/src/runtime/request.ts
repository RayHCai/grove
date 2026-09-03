// A function, not a method, because the destination is always the server. Over a network the
// uplink carries it; with none the loopback sink dispatches to @onRequest in place; with no world
// at all it is a no-op.

import { currentRuntime, hasRuntime } from './runtime.js';

export function request(name: string, payload?: Record<string, unknown>): void {
    if (!hasRuntime()) return;
    const rt = currentRuntime();
    const uplink = rt.requestUplink;
    if (uplink !== undefined) {
        uplink(name, payload);
        return;
    }
    rt.wiredOrNull?.requestSink(name, payload);
}
