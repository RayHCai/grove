// Reading a `@serverState` field by name, on a client.
//
// The value lives on the host RECORD and the mirror hoists an accessor onto the facade as each diff
// lands, so `game.phase` on the tab drawing it and `this.phase` on the authority that wrote it are
// one slot. What neither end can do is TYPE it: `Player`, `Entity` and `Game` declare no such member.
//
// Where an instance exists — anywhere on the server — use `host.getScript(Profile)?.credits`, which
// is typed. This is for the client, where the state has arrived but the script that declares it
// never attached.

/** A host facade, or nothing — a screen script may run a frame before its player is seated. */
type Host = object | null | undefined;

export function readState<T = unknown>(host: Host, field: string): T | undefined {
    if (host === null || host === undefined) return undefined;
    return (host as Record<string, unknown>)[field] as T | undefined;
}
