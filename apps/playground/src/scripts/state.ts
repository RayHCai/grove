// The one place a `@serverState` field is reached by name.
//
// The decorator hoists an accessor onto the host at attach time, but a host facade's TYPE declares
// no such member — so every read and write of a replicated field has to leave the type system. It
// leaves it here and nowhere else, so there is a single audited step to replace when the runtime can
// hand back a typed view.

/** Reads a `@serverState` field off a host facade, which declares no such member. */
export function readState<T = unknown>(host: object, field: string): T | undefined {
    return (host as unknown as Record<string, unknown>)[field] as T | undefined;
}

/** Writes one, for the same reason. */
export function writeState(host: object, field: string, value: unknown): void {
    (host as unknown as Record<string, unknown>)[field] = value;
}
