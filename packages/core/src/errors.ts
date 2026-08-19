// A handler throw is caught and logged because the tick stays coherent either way; wiring and
// the destroy drain abort instead, since a half-mutated structure only fails again later.

/** A load-time / structural rejection. Fatal — fails the load or aborts the run. */
export class LoadError extends Error {
    override readonly name = 'LoadError';
}

/** The fixed fields a caught handler throw is logged with. */
export interface HandlerErrorRecord {
    scriptClass: string;
    method: string;
    hostId: string;
    tick: number;
    event: string;
    stack: string;
}
