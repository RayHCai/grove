// A browser has no AsyncLocalStorage, so this is a module slot the dispatcher saves and restores
// around each handler call, exactly as it does the ambient invocation.
//
// Typed `unknown` to match DispatchCtx.player: a Player type here would point dispatch/ at the
// runtime facades it is meant to stay below.

let current: unknown = null;

/** The player whose input drove the running handler, or null outside one. */
export function currentActingPlayer(): unknown {
    return current;
}

export function setActingPlayer(value: unknown): void {
    current = value;
}
