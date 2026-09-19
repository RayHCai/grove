// Reading a `@serverState` field by name, on a client: the value lives on the host RECORD and the
// mirror hoists an accessor as each diff lands. What neither end can do is TYPE it.
// Where an instance exists — anywhere on the server — `host.getScript(Profile)` is typed instead.

/** A host facade, or nothing — a screen script may run a frame before its player is seated. */
type Host = object | null | undefined;

export function readState<T = unknown>(host: Host, field: string): T | undefined {
    if (host === null || host === undefined) return undefined;
    return (host as Record<string, unknown>)[field] as T | undefined;
}
