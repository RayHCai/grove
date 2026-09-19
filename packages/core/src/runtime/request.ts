// A function, not a method, because the destination is always the server.

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
