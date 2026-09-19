// A module slot the dispatcher saves and restores around each handler call; a browser has no
// AsyncLocalStorage. Typed `unknown` so dispatch/ stays below the runtime facades.

let current: unknown = null;

/** The player whose input drove the running handler, or null outside one. */
export function currentActingPlayer(): unknown {
    return current;
}

export function setActingPlayer(value: unknown): void {
    current = value;
}
